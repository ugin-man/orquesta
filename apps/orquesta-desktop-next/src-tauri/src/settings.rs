use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::storage::{
    atomic_write_json, backup_path, materialize_sentinel, read_json,
    restore_primary_preserving_backup,
};

const SETTINGS_SCHEMA_VERSION: u32 = 2;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSettings {
    pub schema_version: u32,
    pub revision: u64,
    pub locale: Option<String>,
    pub theme: String,
    pub reduced_motion: bool,
    pub notifications_enabled: bool,
    #[serde(default = "default_true")]
    pub navigation_compact: bool,
    #[serde(default = "default_true")]
    pub work_ledger_open: bool,
}

impl Default for NativeSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            revision: 0,
            locale: None,
            theme: "system".into(),
            reduced_motion: false,
            notifications_enabled: false,
            navigation_compact: true,
            work_ledger_open: true,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySettingsV1 {
    schema_version: u32,
    theme: String,
    reduced_motion: bool,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SettingsUpdate {
    pub expected_revision: u64,
    pub locale: String,
    pub theme: String,
    pub reduced_motion: bool,
    pub notifications_enabled: bool,
    pub navigation_compact: bool,
    pub work_ledger_open: bool,
}

pub struct SettingsStore {
    path: PathBuf,
    current: NativeSettings,
    mutation_poisoned: bool,
}

impl SettingsStore {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        if !path.exists() && !backup_path(&path)?.exists() {
            materialize_sentinel(&path, &NativeSettings::default())?;
        }

        let (current, from_backup, migrated) = match read_settings_value(&path) {
            Ok(Some(value)) => {
                let (settings, migrated) = decode_settings(value)?;
                (settings, false, migrated)
            }
            primary => {
                let backup = backup_path(&path)?;
                let value = read_settings_value(&backup)?.ok_or_else(|| {
                    AppError::new(
                        "settings_identity_uncertain",
                        match primary {
                            Ok(None) => "Settings primary is missing".into(),
                            Err(error) => error.message,
                            Ok(Some(_)) => unreachable!(),
                        },
                    )
                    .outcome_unknown(true)
                })?;
                let (settings, migrated) = decode_settings(value)?;
                (settings, true, migrated)
            }
        };

        if from_backup {
            restore_primary_preserving_backup(&path, &current)?;
            confirm_exact(&path, &current)?;
        } else if migrated {
            atomic_write_json(&path, &current)?;
            confirm_exact(&path, &current)?;
        }

        Ok(Self {
            path,
            current,
            mutation_poisoned: false,
        })
    }

    pub fn current(&self) -> NativeSettings {
        self.current.clone()
    }

    pub fn update(&mut self, update: SettingsUpdate) -> AppResult<NativeSettings> {
        validate_locale(Some(update.locale.as_str()))?;
        validate_theme(&update.theme)?;
        let revision = update.expected_revision.checked_add(1).ok_or_else(|| {
            AppError::new(
                "settings_revision_exhausted",
                "Settings revision is exhausted",
            )
        })?;
        let next = NativeSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            revision,
            locale: Some(update.locale),
            theme: update.theme,
            reduced_motion: update.reduced_motion,
            notifications_enabled: update.notifications_enabled,
            navigation_compact: update.navigation_compact,
            work_ledger_open: update.work_ledger_open,
        };
        if let Some(saved) = self.reconcile_poisoned_authority(&next)? {
            return Ok(saved);
        }
        if update.expected_revision != self.current.revision {
            return Err(AppError::new(
                "settings_revision_conflict",
                "Settings changed before this update",
            ));
        }
        let write_result = atomic_write_json(&self.path, &next);
        match confirm_exact(&self.path, &next) {
            Ok(persisted) => {
                // A post-rename transport/sync error is still a committed update
                // when the exact primary revision can be read back.
                self.current = persisted.clone();
                Ok(persisted)
            }
            Err(_) => match Self::open(self.path.clone()) {
                Ok(fresh) => {
                    let persisted = fresh.current();
                    *self = fresh;
                    if persisted == next {
                        Ok(persisted)
                    } else {
                        Err(match write_result {
                            Err(write_error) => write_error.outcome_unknown(false),
                            Ok(()) => AppError::new(
                                "settings_commit_not_observed",
                                "Settings write returned successfully but the committed revision was not observed",
                            )
                            .outcome_unknown(false),
                        })
                    }
                }
                Err(_) => {
                    self.mutation_poisoned = true;
                    Err(AppError::new(
                        "settings_reopen_required",
                        "Settings authority must be reopened before another mutation",
                    )
                    .outcome_unknown(true))
                }
            },
        }
    }

    fn reconcile_poisoned_authority(
        &mut self,
        desired: &NativeSettings,
    ) -> AppResult<Option<NativeSettings>> {
        if !self.mutation_poisoned {
            return Ok(None);
        }
        let fresh = Self::open(self.path.clone()).map_err(|_| {
            AppError::new(
                "settings_reopen_required",
                "Settings authority could not be reopened for this retry",
            )
            .outcome_unknown(true)
        })?;
        let observed = fresh.current();
        *self = fresh;
        if observed.revision == desired.revision.saturating_sub(1) {
            return Ok(None);
        }
        if observed.revision == desired.revision && observed == *desired {
            return Ok(Some(observed));
        }
        Err(AppError::new(
            "settings_revision_conflict",
            "Settings changed before this retry could be reconciled",
        ))
    }
}

fn decode_settings(value: Value) -> AppResult<(NativeSettings, bool)> {
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AppError::new(
                "settings_schema_invalid",
                "Settings schemaVersion is missing",
            )
        })?;
    match version {
        1 => {
            let legacy: LegacySettingsV1 = serde_json::from_value(value)
                .map_err(|error| AppError::new("settings_schema_invalid", error.to_string()))?;
            if legacy.schema_version != 1 {
                return Err(AppError::new(
                    "settings_schema_invalid",
                    "Legacy settings schema is invalid",
                ));
            }
            validate_theme(&legacy.theme)?;
            // These fields never had a consumer. Reading them proves that the v1
            // document is exact; migration intentionally does not carry them forward.
            let _retired_preferences = (legacy.provider_id, legacy.model_id);
            Ok((
                NativeSettings {
                    schema_version: SETTINGS_SCHEMA_VERSION,
                    revision: 0,
                    locale: None,
                    theme: legacy.theme,
                    reduced_motion: legacy.reduced_motion,
                    notifications_enabled: false,
                    navigation_compact: true,
                    work_ledger_open: true,
                },
                true,
            ))
        }
        2 => {
            let current: NativeSettings = serde_json::from_value(value)
                .map_err(|error| AppError::new("settings_schema_invalid", error.to_string()))?;
            validate_document(&current)?;
            Ok((current, false))
        }
        _ => Err(AppError::new(
            "settings_schema_unsupported",
            "Settings were written by a newer Orquesta Next",
        )),
    }
}

fn validate_document(settings: &NativeSettings) -> AppResult<()> {
    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(AppError::new(
            "settings_schema_invalid",
            "Settings schema is invalid",
        ));
    }
    validate_locale(settings.locale.as_deref())?;
    validate_theme(&settings.theme)
}

fn validate_locale(locale: Option<&str>) -> AppResult<()> {
    if locale.is_none() || matches!(locale, Some("ja" | "en")) {
        return Ok(());
    }
    Err(AppError::new(
        "settings_locale_invalid",
        "Locale must be ja or en",
    ))
}

fn validate_theme(theme: &str) -> AppResult<()> {
    if matches!(theme, "system" | "light" | "dark") {
        return Ok(());
    }
    Err(AppError::new(
        "settings_theme_invalid",
        "Theme must be system, light, or dark",
    ))
}

fn confirm_exact(path: &Path, expected: &NativeSettings) -> AppResult<NativeSettings> {
    let observed = read_settings_document(path)?.ok_or_else(|| {
        AppError::new("settings_readback_failed", "Saved settings are missing")
            .outcome_unknown(true)
    })?;
    validate_document(&observed)?;
    if &observed != expected {
        return Err(AppError::new(
            "settings_readback_mismatch",
            "Saved settings do not match the committed revision",
        )
        .outcome_unknown(true));
    }
    Ok(observed)
}

fn read_settings_value(path: &Path) -> AppResult<Option<Value>> {
    #[cfg(test)]
    if TEST_SETTINGS_READBACK_FAILPOINT.with(|current| *current.borrow())
        == Some("fresh_open_error")
    {
        return Err(AppError::new(
            "settings_test_fresh_open_failed",
            "Injected settings authority refresh failure",
        )
        .outcome_unknown(true));
    }
    read_json(path)
}

fn read_settings_document(path: &Path) -> AppResult<Option<NativeSettings>> {
    #[cfg(test)]
    if matches!(
        TEST_SETTINGS_READBACK_FAILPOINT.with(|current| *current.borrow()),
        Some("readback_error" | "fresh_open_error")
    ) {
        return Err(AppError::new(
            "settings_test_readback_failed",
            "Injected settings readback failure",
        )
        .outcome_unknown(true));
    }
    read_json(path)
}

#[cfg(test)]
thread_local! {
    static TEST_SETTINGS_READBACK_FAILPOINT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn set_settings_readback_failpoint(name: Option<&'static str>) {
    TEST_SETTINGS_READBACK_FAILPOINT.with(|current| *current.borrow_mut() = name);
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "orquesta-settings-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create temp root");
        root.join("settings.json")
    }

    #[test]
    fn migrates_v1_without_retaining_dormant_provider_preferences() {
        let path = test_path("migrate-v1");
        atomic_write_json(
            &path,
            &serde_json::json!({
                "schemaVersion": 1,
                "theme": "dark",
                "reducedMotion": true,
                "providerId": "unused-provider",
                "modelId": "unused-model"
            }),
        )
        .expect("write legacy settings");
        let store = SettingsStore::open(path.clone()).expect("migrate settings");
        assert_eq!(
            store.current(),
            NativeSettings {
                schema_version: 2,
                revision: 0,
                locale: None,
                theme: "dark".into(),
                reduced_motion: true,
                notifications_enabled: false,
                navigation_compact: true,
                work_ledger_open: true,
            }
        );
        let persisted: Value = read_json(&path)
            .expect("read settings")
            .expect("settings exist");
        assert!(persisted.get("providerId").is_none());
        assert!(persisted.get("modelId").is_none());
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn opens_existing_v2_settings_with_safe_layout_defaults() {
        let path = test_path("v2-layout-defaults");
        atomic_write_json(
            &path,
            &serde_json::json!({
                "schemaVersion": 2,
                "revision": 8,
                "locale": "ja",
                "theme": "system",
                "reducedMotion": false,
                "notificationsEnabled": true
            }),
        )
        .expect("write existing settings");
        let store = SettingsStore::open(path.clone()).expect("open existing settings");
        assert!(store.current().navigation_compact);
        assert!(store.current().work_ledger_open);
        assert_eq!(store.current().revision, 8);
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn serializes_updates_with_revision_and_exact_readback() {
        let path = test_path("update");
        let mut store = SettingsStore::open(path.clone()).expect("open settings");
        let saved = store
            .update(SettingsUpdate {
                expected_revision: 0,
                locale: "ja".into(),
                theme: "system".into(),
                reduced_motion: true,
                notifications_enabled: true,
                navigation_compact: false,
                work_ledger_open: false,
            })
            .expect("save settings");
        assert_eq!(saved.revision, 1);
        assert_eq!(
            read_json::<NativeSettings>(&path)
                .expect("read")
                .expect("exists"),
            saved
        );
        assert_eq!(
            store
                .update(SettingsUpdate {
                    expected_revision: 0,
                    locale: "en".into(),
                    theme: "light".into(),
                    reduced_motion: false,
                    notifications_enabled: false,
                    navigation_compact: true,
                    work_ledger_open: true,
                })
                .expect_err("stale revision must fail")
                .code,
            "settings_revision_conflict"
        );
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn restores_a_valid_backup_without_rotating_the_broken_primary_over_it() {
        let path = test_path("backup");
        let expected = NativeSettings {
            locale: Some("en".into()),
            revision: 7,
            ..NativeSettings::default()
        };
        atomic_write_json(&path, &expected).expect("write primary");
        atomic_write_json(&path, &expected).expect("materialize backup");
        fs::write(&path, b"not json\n").expect("break primary");
        let store = SettingsStore::open(path.clone()).expect("recover settings");
        assert_eq!(store.current(), expected);
        assert_eq!(
            read_json::<NativeSettings>(&path)
                .expect("read")
                .expect("exists"),
            expected
        );
        assert_eq!(
            read_json::<NativeSettings>(&backup_path(&path).expect("backup path"))
                .expect("read backup")
                .expect("backup exists"),
            expected
        );
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn adopts_an_exact_commit_when_the_write_reports_after_replace_failure() {
        let path = test_path("after-replace");
        let mut store = SettingsStore::open(path.clone()).expect("open settings");
        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        let saved = store
            .update(SettingsUpdate {
                expected_revision: 0,
                locale: "ja".into(),
                theme: "dark".into(),
                reduced_motion: true,
                notifications_enabled: false,
                navigation_compact: true,
                work_ledger_open: true,
            })
            .expect("exact primary proves commit");
        crate::storage::set_atomic_write_failpoint(None);
        assert_eq!(saved.revision, 1);
        assert_eq!(store.current(), saved);
        assert_eq!(
            read_json::<NativeSettings>(&path)
                .expect("read")
                .expect("exists"),
            saved
        );
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn refreshes_authority_when_the_first_exact_readback_is_unavailable() {
        let path = test_path("readback-refresh");
        let mut store = SettingsStore::open(path.clone()).expect("open settings");
        set_settings_readback_failpoint(Some("readback_error"));
        let saved = store
            .update(SettingsUpdate {
                expected_revision: 0,
                locale: "ja".into(),
                theme: "light".into(),
                reduced_motion: false,
                notifications_enabled: false,
                navigation_compact: true,
                work_ledger_open: true,
            })
            .expect("fresh open proves the exact commit");
        set_settings_readback_failpoint(None);
        assert_eq!(saved.revision, 1);
        assert_eq!(store.current(), saved);
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn same_instance_retry_adopts_an_uncertain_commit_after_authority_recovers() {
        let path = test_path("readback-poison");
        let mut store = SettingsStore::open(path.clone()).expect("open settings");
        let update = SettingsUpdate {
            expected_revision: 0,
            locale: "ja".into(),
            theme: "dark".into(),
            reduced_motion: true,
            notifications_enabled: true,
            navigation_compact: false,
            work_ledger_open: false,
        };
        set_settings_readback_failpoint(Some("fresh_open_error"));
        let error = store
            .update(update.clone())
            .expect_err("unprovable authority must fail closed");
        set_settings_readback_failpoint(None);
        assert_eq!(error.code, "settings_reopen_required");
        assert!(error.outcome_unknown);
        let saved = store
            .update(update)
            .expect("the same instance must reconcile the committed retry");
        assert_eq!(saved.revision, 1);
        assert_eq!(store.current(), saved);
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn same_instance_retry_commits_when_the_uncertain_write_was_not_applied() {
        let path = test_path("readback-poison-uncommitted");
        let mut store = SettingsStore::open(path.clone()).expect("open settings");
        let update = SettingsUpdate {
            expected_revision: 0,
            locale: "en".into(),
            theme: "light".into(),
            reduced_motion: false,
            notifications_enabled: true,
            navigation_compact: true,
            work_ledger_open: true,
        };
        crate::storage::set_atomic_write_failpoint(Some("before_replace"));
        set_settings_readback_failpoint(Some("fresh_open_error"));
        let error = store
            .update(update.clone())
            .expect_err("unprovable authority must fail closed");
        crate::storage::set_atomic_write_failpoint(None);
        set_settings_readback_failpoint(None);
        assert_eq!(error.code, "settings_reopen_required");
        let saved = store
            .update(update)
            .expect("the same instance must retry an uncommitted write");
        assert_eq!(saved.revision, 1);
        assert_eq!(store.current(), saved);
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }

    #[test]
    fn same_instance_retry_rejects_a_different_value_after_uncertain_commit() {
        let path = test_path("readback-poison-conflict");
        let mut store = SettingsStore::open(path.clone()).expect("open settings");
        set_settings_readback_failpoint(Some("fresh_open_error"));
        store
            .update(SettingsUpdate {
                expected_revision: 0,
                locale: "ja".into(),
                theme: "dark".into(),
                reduced_motion: true,
                notifications_enabled: true,
                navigation_compact: false,
                work_ledger_open: false,
            })
            .expect_err("unprovable authority must fail closed");
        set_settings_readback_failpoint(None);
        let conflict = store
            .update(SettingsUpdate {
                expected_revision: 0,
                locale: "en".into(),
                theme: "system".into(),
                reduced_motion: false,
                notifications_enabled: false,
                navigation_compact: true,
                work_ledger_open: true,
            })
            .expect_err("a different retry must not overwrite the committed value");
        assert_eq!(conflict.code, "settings_revision_conflict");
        assert_eq!(store.current().revision, 1);
        fs::remove_dir_all(path.parent().expect("parent")).expect("cleanup");
    }
}
