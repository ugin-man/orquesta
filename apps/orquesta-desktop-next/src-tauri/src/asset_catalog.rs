use std::collections::HashSet;

use serde::Deserialize;
use url::Url;

use crate::error::{AppError, AppResult};

const DESKTOP_ASSET_CATALOG: &str =
    include_str!("../../../../docs/dependencies/desktop-assets.json");
const MAX_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub(crate) struct AssetCatalog {
    document: DesktopAssetCatalogDocument,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopAssetCatalogDocument {
    schema_version: u32,
    authority_kind: String,
    catalog_scope: CatalogScope,
    update_authority: UpdateAuthority,
    voice: VoiceCatalog,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogScope {
    includes: Vec<String>,
    excludes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAuthority {
    owner: String,
    discovery_sources: Vec<String>,
    automatic_runtime_update: bool,
    required_review: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VoiceCatalog {
    pub(crate) provider_id: String,
    pub(crate) binary_asset_id: String,
    pub(crate) initial_model_asset_id: String,
    pub(crate) comparison_model_asset_id: String,
    automatic_fallback: bool,
    assets: Vec<DesktopAsset>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopAssetKind {
    NativeBinaryBundle,
    Model,
}

impl DesktopAssetKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::NativeBinaryBundle => "native_binary_bundle",
            Self::Model => "model",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopAsset {
    pub(crate) asset_id: String,
    pub(crate) kind: DesktopAssetKind,
    purpose: String,
    owner_layer: String,
    release_tag: Option<String>,
    source_commit: Option<String>,
    github_asset_id: Option<u64>,
    pub(crate) file_name: String,
    pub(crate) source_url: String,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
    authenticode: Option<String>,
    archive_inspection: Option<ArchiveInspection>,
    #[serde(default)]
    licenses: Vec<LicenseRecord>,
    repository: Option<String>,
    revision: Option<String>,
    multilingual: Option<bool>,
    english_only: Option<bool>,
    license: Option<LicenseRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveInspection {
    entry_count: usize,
    license_file_present: bool,
    allowlisted_entries: Vec<String>,
    excluded_examples: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LicenseRecord {
    spdx: String,
    component: Option<String>,
    source_commit: Option<String>,
    pub(crate) source_url: String,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
}

impl AssetCatalog {
    pub(crate) fn load() -> AppResult<Self> {
        Self::parse(DESKTOP_ASSET_CATALOG)
    }

    fn parse(source: &str) -> AppResult<Self> {
        let document: DesktopAssetCatalogDocument = serde_json::from_str(source)
            .map_err(|error| AppError::new("asset_catalog_invalid", error.to_string()))?;
        validate_document(&document)?;
        Ok(Self { document })
    }

    pub(crate) fn voice(&self) -> &VoiceCatalog {
        &self.document.voice
    }

    pub(crate) fn asset(&self, asset_id: &str) -> AppResult<&DesktopAsset> {
        self.document
            .voice
            .assets
            .iter()
            .find(|asset| asset.asset_id == asset_id)
            .ok_or_else(|| {
                AppError::new(
                    "voice_asset_unknown",
                    "Voice asset ID is not present in the immutable catalog",
                )
            })
    }

    pub(crate) fn assets(&self) -> impl Iterator<Item = &DesktopAsset> {
        self.document.voice.assets.iter()
    }
}

impl DesktopAsset {
    pub(crate) fn archive_entry_count(&self) -> Option<usize> {
        self.archive_inspection
            .as_ref()
            .map(|inspection| inspection.entry_count)
    }

    pub(crate) fn archive_allowlist(&self) -> Option<&[String]> {
        self.archive_inspection
            .as_ref()
            .map(|inspection| inspection.allowlisted_entries.as_slice())
    }

    pub(crate) fn licenses(&self) -> Vec<&LicenseRecord> {
        let mut values: Vec<&LicenseRecord> = self.licenses.iter().collect();
        if let Some(license) = &self.license {
            values.push(license);
        }
        values
    }
}

fn validate_document(document: &DesktopAssetCatalogDocument) -> AppResult<()> {
    if document.schema_version != 1
        || document.authority_kind != "immutable_desktop_asset_catalog"
        || document.voice.provider_id != "whisper.cpp-local"
        || document.voice.automatic_fallback
        || document.update_authority.automatic_runtime_update
        || document.update_authority.owner != "source_controlled_independent_review"
        || document.catalog_scope.includes.is_empty()
        || document.catalog_scope.excludes.is_empty()
        || document.update_authority.discovery_sources.is_empty()
        || document.update_authority.required_review.is_empty()
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            "Desktop asset catalog authority or update policy is unsupported",
        ));
    }

    let mut ids = HashSet::new();
    for asset in &document.voice.assets {
        validate_asset(asset)?;
        if !ids.insert(asset.asset_id.as_str()) {
            return Err(AppError::new(
                "asset_catalog_invalid",
                "Desktop asset catalog contains a duplicate asset ID",
            ));
        }
    }
    if document.voice.assets.len() != 3
        || !ids.contains(document.voice.binary_asset_id.as_str())
        || !ids.contains(document.voice.initial_model_asset_id.as_str())
        || !ids.contains(document.voice.comparison_model_asset_id.as_str())
        || document.voice.binary_asset_id == document.voice.initial_model_asset_id
        || document.voice.binary_asset_id == document.voice.comparison_model_asset_id
        || document.voice.initial_model_asset_id == document.voice.comparison_model_asset_id
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            "Voice catalog asset roles are incomplete or ambiguous",
        ));
    }
    if document
        .voice
        .assets
        .iter()
        .find(|asset| asset.asset_id == document.voice.binary_asset_id)
        .is_none_or(|asset| asset.kind != DesktopAssetKind::NativeBinaryBundle)
        || document
            .voice
            .assets
            .iter()
            .filter(|asset| {
                asset.asset_id == document.voice.initial_model_asset_id
                    || asset.asset_id == document.voice.comparison_model_asset_id
            })
            .any(|asset| asset.kind != DesktopAssetKind::Model)
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            "Voice binary or model role has the wrong immutable asset kind",
        ));
    }
    Ok(())
}

fn validate_asset(asset: &DesktopAsset) -> AppResult<()> {
    validate_component(&asset.asset_id, "asset ID")?;
    validate_component(&asset.file_name, "asset file name")?;
    validate_sha256(&asset.sha256, "asset SHA256")?;
    validate_https_url(&asset.source_url, "asset source URL")?;
    if asset.size_bytes == 0
        || asset.size_bytes > MAX_ASSET_BYTES
        || asset.owner_layer != "tauri_native_voice"
        || asset.purpose.trim().is_empty()
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            "Desktop asset size, purpose, or owner is invalid",
        ));
    }

    match asset.kind {
        DesktopAssetKind::NativeBinaryBundle => {
            let Some(inspection) = &asset.archive_inspection else {
                return Err(AppError::new(
                    "asset_catalog_invalid",
                    "Native binary bundle is missing its static extraction allowlist",
                ));
            };
            if inspection.entry_count == 0
                || inspection.license_file_present
                || inspection.allowlisted_entries.is_empty()
                || inspection.excluded_examples.is_empty()
                || asset.release_tag.as_deref().is_none_or(str::is_empty)
                || asset.source_commit.as_deref().is_none_or(str::is_empty)
                || asset.github_asset_id.is_none()
                || asset.authenticode.as_deref() != Some("not_signed")
                || asset.licenses.is_empty()
                || asset.license.is_some()
                || asset.repository.is_some()
                || asset.revision.is_some()
                || asset.multilingual.is_some()
                || asset.english_only.is_some()
            {
                return Err(AppError::new(
                    "asset_catalog_invalid",
                    "Native binary bundle metadata is incomplete or mixed with model metadata",
                ));
            }
            let mut entries = HashSet::new();
            let mut leaves = HashSet::new();
            for entry in &inspection.allowlisted_entries {
                let Some(leaf) = entry.strip_prefix("Release/") else {
                    return Err(AppError::new(
                        "asset_catalog_invalid",
                        "Binary extraction allowlist must contain exact Release children",
                    ));
                };
                validate_component(leaf, "binary extraction leaf")?;
                if !entries.insert(entry.as_str()) || !leaves.insert(leaf) {
                    return Err(AppError::new(
                        "asset_catalog_invalid",
                        "Binary extraction allowlist contains a duplicate entry or leaf",
                    ));
                }
            }
        }
        DesktopAssetKind::Model => {
            if asset.archive_inspection.is_some()
                || !asset.licenses.is_empty()
                || asset.license.is_none()
                || asset.repository.as_deref().is_none_or(str::is_empty)
                || asset.revision.as_deref().is_none_or(str::is_empty)
                || asset.multilingual != Some(true)
                || asset.english_only != Some(false)
                || asset.release_tag.is_some()
                || asset.github_asset_id.is_some()
                || asset.authenticode.is_some()
            {
                return Err(AppError::new(
                    "asset_catalog_invalid",
                    "Voice model metadata is incomplete or mixed with binary metadata",
                ));
            }
        }
    }
    for license in asset.licenses() {
        validate_license(license)?;
    }
    Ok(())
}

fn validate_license(license: &LicenseRecord) -> AppResult<()> {
    if license.spdx != "MIT"
        || license.size_bytes == 0
        || license.size_bytes > 64 * 1024
        || license.component.as_deref().is_some_and(str::is_empty)
        || license.source_commit.as_deref().is_some_and(str::is_empty)
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            "Desktop asset license metadata is invalid",
        ));
    }
    validate_sha256(&license.sha256, "license SHA256")?;
    validate_https_url(&license.source_url, "license source URL")
}

fn validate_component(value: &str, field: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 160
        || value == "."
        || value == ".."
        || value
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            format!("Desktop {field} is not a safe direct-child component"),
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> AppResult<()> {
    if value.len() != 64
        || value
            .bytes()
            .any(|byte| !(byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            format!("Desktop {field} is not a lowercase SHA256"),
        ));
    }
    Ok(())
}

fn validate_https_url(value: &str, field: &str) -> AppResult<()> {
    let parsed = Url::parse(value)
        .map_err(|error| AppError::new("asset_catalog_invalid", error.to_string()))?;
    if parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.host_str().is_none()
        || parsed.fragment().is_some()
    {
        return Err(AppError::new(
            "asset_catalog_invalid",
            format!("Desktop {field} is not an exact HTTPS origin"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_catalog_is_strict_and_complete() {
        let catalog = AssetCatalog::load().expect("canonical catalog");
        assert_eq!(catalog.assets().count(), 3);
        assert_eq!(catalog.voice().provider_id, "whisper.cpp-local");
        assert_eq!(
            catalog
                .asset(&catalog.voice().binary_asset_id)
                .expect("binary")
                .archive_allowlist()
                .expect("allowlist")
                .len(),
            13
        );
    }

    #[test]
    fn catalog_rejects_unknown_fields_and_unsafe_components() {
        let unknown = DESKTOP_ASSET_CATALOG.replacen(
            "\"schemaVersion\": 1,",
            "\"schemaVersion\": 1, \"shadowAuthority\": true,",
            1,
        );
        assert!(AssetCatalog::parse(&unknown).is_err());
        let unsafe_id =
            DESKTOP_ASSET_CATALOG.replacen("whisper.cpp-model-base-multilingual", "../outside", 1);
        assert!(AssetCatalog::parse(&unsafe_id).is_err());
    }
}
