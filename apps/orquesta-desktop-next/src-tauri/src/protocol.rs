use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

include!("../../../../packages/contracts/generated/desktop/native_bridge_contract.rs");

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const NATIVE_BRIDGE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBridgeResponseContract {
    schema_version: u32,
    result_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBridgeTauriContract {
    argument_key: String,
    reject_unknown_commands: bool,
    response_envelope: NativeBridgeResponseContract,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBridgeBinaryTransportContract {
    request: String,
    response: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBridgeContractDocument {
    schema_version: u32,
    tauri: NativeBridgeTauriContract,
    content_policy: Value,
    commands: HashMap<String, String>,
    binary_transports: HashMap<String, NativeBridgeBinaryTransportContract>,
    events: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBridgeFixturesDocument {
    schema_version: u32,
    commands: HashMap<String, Value>,
    events: HashMap<String, Value>,
    scenarios: Value,
}

pub fn validate_native_bridge_contract() -> AppResult<()> {
    let document: NativeBridgeContractDocument = serde_json::from_str(include_str!(
        "../../../../packages/contracts/desktop/native-bridge-manifest.v1.json"
    ))
    .map_err(|error| AppError::new("native_bridge_contract_invalid", error.to_string()))?;
    let fixtures: NativeBridgeFixturesDocument = serde_json::from_str(include_str!(
        "../../../../packages/contracts/desktop/fixtures/native-bridge-fixtures.v1.json"
    ))
    .map_err(|error| AppError::new("native_bridge_fixtures_invalid", error.to_string()))?;
    let expected_commands = GENERATED_NATIVE_BRIDGE_COMMANDS
        .iter()
        .copied()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect::<HashMap<_, _>>();
    let expected_events = GENERATED_NATIVE_BRIDGE_EVENTS
        .iter()
        .copied()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect::<HashMap<_, _>>();
    let expected_binary_transports = GENERATED_NATIVE_BRIDGE_BINARY_TRANSPORTS
        .iter()
        .copied()
        .map(|(key, request, response)| {
            (
                key.to_owned(),
                NativeBridgeBinaryTransportContract {
                    request: request.to_owned(),
                    response: response.to_owned(),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let expected_content_policy = serde_json::json!({
        "schemaVersion": GENERATED_CONTENT_POLICY_SCHEMA_VERSION,
        "message": {
            "maxUtf8Bytes": GENERATED_MESSAGE_TEXT_MAX_UTF8_BYTES,
        },
        "voice": {
            "transcriptMaxUtf8Bytes": GENERATED_VOICE_TRANSCRIPT_MAX_UTF8_BYTES,
        },
        "attachments": {
            "maxPerDispatch": GENERATED_ATTACHMENT_MAX_PER_DISPATCH,
            "maxImageBytes": GENERATED_ATTACHMENT_MAX_IMAGE_BYTES,
            "maxTextBytes": GENERATED_ATTACHMENT_MAX_TEXT_BYTES,
            "maxTextBytesPerDispatch": GENERATED_ATTACHMENT_MAX_TEXT_BYTES_PER_DISPATCH,
            "maxImagePreviewBytes": GENERATED_ATTACHMENT_MAX_IMAGE_PREVIEW_BYTES,
            "formats": GENERATED_ATTACHMENT_FORMATS
                .iter()
                .map(|(extension, kind, media_type)| serde_json::json!({
                    "extension": extension,
                    "kind": kind,
                    "mediaType": media_type,
                }))
                .collect::<Vec<_>>(),
        },
    });
    let cleanup_scenario_valid = fixtures
        .scenarios
        .pointer("/cleanupPendingReconcile")
        .is_some_and(|fixture| {
            fixture.get("command").and_then(Value::as_str) == Some("dispatch_recovery_reconcile")
                && fixture
                    .pointer("/args/input/schemaVersion")
                    .and_then(Value::as_u64)
                    == Some(1)
                && fixture
                    .pointer("/response/schemaVersion")
                    .and_then(Value::as_u64)
                    == Some(1)
        });
    let read_only_ready_scenario_valid = fixtures
        .scenarios
        .pointer("/readOnlyReadyStatus/status")
        .is_some_and(|status| {
            status.get("phase").and_then(Value::as_str) == Some("ready")
                && status
                    .get("runtimeGeneration")
                    .and_then(Value::as_str)
                    .is_some()
                && status.get("activeProjectId").is_some_and(Value::is_null)
                && status
                    .get("authorityActivationToken")
                    .is_some_and(Value::is_null)
                && status
                    .get("authorityRendererSessionId")
                    .is_some_and(Value::is_null)
                && status
                    .get("authorityRendererGeneration")
                    .is_some_and(Value::is_null)
                && status
                    .get("processTerminationConfirmed")
                    .and_then(Value::as_bool)
                    == Some(false)
        });
    let command_fixtures_valid = fixtures.commands.iter().all(|(command, fixture)| {
        (match document.binary_transports.get(command) {
            Some(transport) if transport.request == "raw_octet_stream" => {
                fixture
                    .pointer("/args/rawHeaders")
                    .is_some_and(Value::is_object)
                    && fixture
                        .pointer("/args/rawBodyBase64")
                        .and_then(Value::as_str)
                        .is_some()
                    && fixture
                        .get("args")
                        .and_then(Value::as_object)
                        .is_some_and(|args| {
                            args.len() == 2
                                && args.contains_key("rawHeaders")
                                && args.contains_key("rawBodyBase64")
                        })
            }
            _ => fixture
                .get("args")
                .and_then(Value::as_object)
                .is_some_and(|args| {
                    args.len() == 1
                        && args
                            .get("input")
                            .and_then(Value::as_object)
                            .is_some_and(|input| {
                                input.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                            })
                }),
        }) && (match document.binary_transports.get(command) {
            Some(transport) if transport.response == "raw_octet_stream" => fixture
                .get("response")
                .and_then(Value::as_object)
                .is_some_and(|response| {
                    response.len() == 1
                        && response
                            .get("rawBodyBase64")
                            .and_then(Value::as_str)
                            .is_some()
                }),
            _ => fixture
                .get("response")
                .and_then(Value::as_object)
                .is_some_and(|response| {
                    response.len() == 2
                        && response.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                        && response.contains_key("result")
                }),
        })
    });
    let fixture_sets_match = fixtures.commands.len() == document.commands.len()
        && document
            .commands
            .keys()
            .all(|key| fixtures.commands.contains_key(key))
        && command_fixtures_valid
        && fixtures.events.len() == document.events.len()
        && document
            .events
            .keys()
            .all(|key| fixtures.events.contains_key(key))
        && fixtures
            .events
            .values()
            .all(|fixture| fixture.get("schemaVersion").and_then(Value::as_u64) == Some(1));
    if document.schema_version != NATIVE_BRIDGE_SCHEMA_VERSION
        || fixtures.schema_version != NATIVE_BRIDGE_SCHEMA_VERSION
        || document.tauri.argument_key != "input"
        || !document.tauri.reject_unknown_commands
        || document.tauri.response_envelope.schema_version != NATIVE_BRIDGE_SCHEMA_VERSION
        || document.tauri.response_envelope.result_key != "result"
        || document.content_policy != expected_content_policy
        || document.commands != expected_commands
        || document.binary_transports != expected_binary_transports
        || document.events != expected_events
        || !fixture_sets_match
        || !cleanup_scenario_valid
        || !read_only_ready_scenario_valid
    {
        return Err(AppError::new(
            "native_bridge_contract_mismatch",
            "Native bridge manifest does not match the compiled v1 boundary",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMethodPolicyDocument {
    pub schema_version: u32,
    pub methods: HashMap<String, RuntimeMethodPolicy>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMethodPolicy {
    pub response_type: Option<String>,
    pub renderer_exposed: bool,
    pub mutation_kind: MutationKind,
    pub project_requirement: ProjectRequirement,
    pub attachments_allowed: bool,
    pub recovery_strategy: RecoveryStrategy,
    pub default_timeout_ms: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MutationKind {
    ReadOnly,
    Lifecycle,
    Dispatch,
    Interrupt,
    Steer,
    Approval,
    Inspection,
    Bootstrap,
    Projection,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRequirement {
    None,
    Activated,
    InternalRoot,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStrategy {
    None,
    NativeLifecycle,
    DispatchOutbox,
    NativeExactApproval,
    CoreInspectionOperation,
    ProjectBootstrapSaga,
    ProjectionInternal,
    ExactTurnInterrupt,
    ExactTurnSteer,
    InternalUnavailable,
}

impl RuntimeMethodPolicyDocument {
    const ROOT_KEYS: [&'static str; 2] = ["schemaVersion", "methods"];
    const METHOD_KEYS: [&'static str; 7] = [
        "responseType",
        "rendererExposed",
        "mutationKind",
        "projectRequirement",
        "attachmentsAllowed",
        "recoveryStrategy",
        "defaultTimeoutMs",
    ];

    pub fn source_sha256() -> String {
        hex::encode(Sha256::digest(include_bytes!(
            "../../../../packages/contracts/desktop/runtime-method-policy.v1.json"
        )))
    }

    pub fn load() -> AppResult<Self> {
        let value: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/desktop/runtime-method-policy.v1.json"
        ))
        .map_err(|error| AppError::new("runtime_method_policy_invalid", error.to_string()))?;
        Self::parse_and_validate_value(value)
    }

    fn parse_and_validate_value(value: Value) -> AppResult<Self> {
        Self::validate_exact_shape(&value)?;
        let document: Self = serde_json::from_value(value)
            .map_err(|error| AppError::new("runtime_method_policy_invalid", error.to_string()))?;
        document.validate()
    }

    fn validate_exact_shape(value: &Value) -> AppResult<()> {
        if !Self::has_exact_keys(value, &Self::ROOT_KEYS) {
            return Err(AppError::new(
                "runtime_method_policy_invalid",
                "Runtime method policy root must contain exactly schemaVersion and methods",
            ));
        }
        let methods = value
            .get("methods")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                AppError::new(
                    "runtime_method_policy_invalid",
                    "Runtime method policy methods must be an object",
                )
            })?;
        for (method, policy) in methods {
            if !Self::has_exact_keys(policy, &Self::METHOD_KEYS) {
                return Err(AppError::new(
                    "runtime_method_policy_invalid",
                    format!("Policy for {method} must contain the exact method fields"),
                ));
            }
        }
        Ok(())
    }

    fn has_exact_keys(value: &Value, expected: &[&str]) -> bool {
        value.as_object().is_some_and(|object| {
            object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
        })
    }

    fn valid_method_name(method: &str) -> bool {
        let bytes = method.as_bytes();
        (2..=128).contains(&bytes.len())
            && bytes.first().is_some_and(u8::is_ascii_lowercase)
            && bytes[1..].iter().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'.' || *byte == b'-'
            })
    }

    fn validate(self) -> AppResult<Self> {
        if self.schema_version != 1 {
            return Err(AppError::new(
                "runtime_method_policy_schema_unsupported",
                "Runtime method policy schema is unsupported",
            ));
        }
        for (method, policy) in &self.methods {
            if !Self::valid_method_name(method)
                || policy
                    .response_type
                    .as_ref()
                    .is_some_and(|response_type| response_type.trim().is_empty())
                || policy.default_timeout_ms < 1_000
                || policy.default_timeout_ms > 600_000
            {
                return Err(AppError::new(
                    "runtime_method_policy_invalid",
                    format!("Invalid policy for {method}"),
                ));
            }
            if policy.renderer_exposed
                && policy.recovery_strategy == RecoveryStrategy::InternalUnavailable
            {
                return Err(AppError::new(
                    "runtime_method_policy_unavailable_exposed",
                    format!("Renderer-exposed method cannot be unavailable: {method}"),
                ));
            }
            let expected = match policy.mutation_kind {
                MutationKind::ReadOnly => RecoveryStrategy::None,
                MutationKind::Lifecycle => RecoveryStrategy::NativeLifecycle,
                MutationKind::Dispatch => RecoveryStrategy::DispatchOutbox,
                MutationKind::Interrupt => RecoveryStrategy::ExactTurnInterrupt,
                MutationKind::Steer => RecoveryStrategy::ExactTurnSteer,
                MutationKind::Approval => RecoveryStrategy::NativeExactApproval,
                MutationKind::Inspection => RecoveryStrategy::CoreInspectionOperation,
                MutationKind::Bootstrap => RecoveryStrategy::ProjectBootstrapSaga,
                MutationKind::Projection => RecoveryStrategy::ProjectionInternal,
            };
            if policy.recovery_strategy != expected
                && !(!policy.renderer_exposed
                    && policy.recovery_strategy == RecoveryStrategy::InternalUnavailable)
            {
                return Err(AppError::new(
                    "runtime_method_policy_recovery_mismatch",
                    format!("Invalid recovery strategy for {method}"),
                ));
            }
            if policy.attachments_allowed
                && !(policy.mutation_kind == MutationKind::Dispatch
                    && policy.recovery_strategy == RecoveryStrategy::DispatchOutbox)
            {
                return Err(AppError::new(
                    "runtime_method_policy_attachment_mismatch",
                    format!("Invalid attachment policy for {method}"),
                ));
            }
        }

        let runtime_send = self.methods.get("runtime.send").ok_or_else(|| {
            AppError::new(
                "runtime_send_must_be_typed_native_dispatch",
                "runtime.send policy is required",
            )
        })?;
        if runtime_send.response_type.as_deref() != Some("runtime.dispatch.accepted")
            || runtime_send.renderer_exposed
            || runtime_send.mutation_kind != MutationKind::Dispatch
            || runtime_send.project_requirement != ProjectRequirement::Activated
            || !runtime_send.attachments_allowed
            || runtime_send.recovery_strategy != RecoveryStrategy::DispatchOutbox
            || runtime_send.default_timeout_ms != 180_000
        {
            return Err(AppError::new(
                "runtime_send_must_be_typed_native_dispatch",
                "runtime.send must remain the typed native dispatch boundary",
            ));
        }

        Ok(self)
    }

    pub fn renderer_method(&self, method: &str) -> AppResult<&RuntimeMethodPolicy> {
        let policy = self.methods.get(method).ok_or_else(|| {
            AppError::new(
                "runtime_method_unknown",
                format!("Unknown runtime method: {method}"),
            )
        })?;
        if !policy.renderer_exposed {
            return Err(AppError::new(
                "runtime_method_not_exposed",
                format!("Runtime method is not renderer-exposed: {method}"),
            ));
        }
        if matches!(
            policy.recovery_strategy,
            RecoveryStrategy::DispatchOutbox
                | RecoveryStrategy::NativeLifecycle
                | RecoveryStrategy::ExactTurnInterrupt
                | RecoveryStrategy::ExactTurnSteer
                | RecoveryStrategy::InternalUnavailable
        ) {
            return Err(AppError::new(
                "runtime_method_requires_typed_boundary",
                format!("Runtime method requires a typed native command: {method}"),
            ));
        }
        Ok(policy)
    }
}

#[cfg(test)]
mod runtime_method_policy_tests {
    use serde_json::{json, Value};

    use super::RuntimeMethodPolicyDocument;

    fn canonical_policy() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/desktop/runtime-method-policy.v1.json"
        ))
        .expect("canonical runtime method policy must be JSON")
    }

    fn assert_invalid(mutate: impl FnOnce(&mut Value)) {
        let mut value = canonical_policy();
        mutate(&mut value);
        assert!(RuntimeMethodPolicyDocument::parse_and_validate_value(value).is_err());
    }

    #[test]
    fn canonical_runtime_method_policy_is_valid() {
        RuntimeMethodPolicyDocument::parse_and_validate_value(canonical_policy())
            .expect("canonical runtime method policy must validate");
    }

    #[test]
    fn rejects_shape_name_response_enum_timeout_and_cross_field_mutations() {
        assert_invalid(|value| value["unexpectedRoot"] = json!(true));
        assert_invalid(|value| value["schemaVersion"] = json!(2));
        assert_invalid(|value| value["methods"]["runtime.info"]["unexpectedEntry"] = json!(true));
        assert_invalid(|value| {
            value["methods"]["runtime.info"]
                .as_object_mut()
                .expect("runtime.info policy")
                .remove("responseType");
        });
        assert_invalid(|value| {
            let methods = value["methods"].as_object_mut().expect("methods object");
            let policy = methods.remove("runtime.info").expect("runtime.info policy");
            methods.insert("Runtime.info".to_owned(), policy);
        });
        assert_invalid(|value| value["methods"]["runtime.info"]["responseType"] = json!("  "));
        assert_invalid(|value| value["methods"]["runtime.info"]["responseType"] = json!(7));
        assert_invalid(|value| value["methods"]["runtime.info"]["rendererExposed"] = json!("true"));
        assert_invalid(|value| value["methods"]["runtime.info"]["mutationKind"] = json!("other"));
        assert_invalid(|value| {
            value["methods"]["runtime.info"]["projectRequirement"] = json!("other")
        });
        assert_invalid(|value| {
            value["methods"]["runtime.info"]["recoveryStrategy"] = json!("other")
        });
        assert_invalid(|value| value["methods"]["runtime.info"]["defaultTimeoutMs"] = json!(999));
        assert_invalid(|value| {
            value["methods"]["runtime.info"]["defaultTimeoutMs"] = json!(1_500.5)
        });
        assert_invalid(|value| {
            value["methods"]["runtime.info"]["recoveryStrategy"] = json!("dispatch_outbox")
        });
        assert_invalid(|value| {
            value["methods"]["runtime.info"]["attachmentsAllowed"] = json!(true)
        });
        assert_invalid(|value| {
            value["methods"]["repository.get-snapshot"]["recoveryStrategy"] =
                json!("internal_unavailable")
        });
    }

    #[test]
    fn rejects_every_runtime_send_invariant_mutation() {
        assert_invalid(|value| {
            value["methods"]
                .as_object_mut()
                .expect("methods object")
                .remove("runtime.send");
        });
        assert_invalid(|value| {
            value["methods"]["runtime.send"]["responseType"] = json!("runtime.info.result")
        });
        assert_invalid(|value| value["methods"]["runtime.send"]["rendererExposed"] = json!(true));
        assert_invalid(|value| {
            value["methods"]["runtime.send"]["mutationKind"] = json!("inspection")
        });
        assert_invalid(|value| {
            value["methods"]["runtime.send"]["projectRequirement"] = json!("none")
        });
        assert_invalid(|value| {
            value["methods"]["runtime.send"]["attachmentsAllowed"] = json!(false)
        });
        assert_invalid(|value| {
            value["methods"]["runtime.send"]["recoveryStrategy"] = json!("internal_unavailable")
        });
        assert_invalid(|value| {
            value["methods"]["runtime.send"]["defaultTimeoutMs"] = json!(179_999)
        });
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessWorkOrdersCapability {
    pub name: String,
    pub major: u32,
    // Minor revisions are forward-compatible when the required feature set is present.
    #[serde(rename = "minor")]
    pub _minor: u32,
    pub features: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRequest<'a> {
    pub protocol_version: u32,
    pub id: &'a str,
    pub method: &'a str,
    pub params: &'a Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarResponse {
    pub protocol_version: u32,
    pub id: Option<String>,
    pub ok: Option<bool>,
    pub result: Option<Value>,
    pub error: Option<SidecarError>,
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub event: Option<Value>,
    pub policy_schema_version: Option<u32>,
    pub policy_digest_sha256: Option<String>,
    pub business_work_orders_capability: Option<BusinessWorkOrdersCapability>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub outcome_unknown: bool,
    pub details: Option<Value>,
}

impl From<SidecarError> for AppError {
    fn from(value: SidecarError) -> Self {
        AppError {
            code: value.code,
            message: value.message,
            retryable: value.retryable,
            outcome_unknown: value.outcome_unknown,
            details: value.details,
        }
    }
}
