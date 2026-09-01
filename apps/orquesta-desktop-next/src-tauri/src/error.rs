use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub outcome_unknown: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            outcome_unknown: false,
            details: None,
        }
    }

    pub fn retryable(mut self, value: bool) -> Self {
        self.retryable = value;
        self
    }
    pub fn outcome_unknown(mut self, value: bool) -> Self {
        self.outcome_unknown = value;
        self
    }
    pub fn with_details(mut self, value: serde_json::Value) -> Self {
        self.details = Some(value);
        self
    }

    pub fn io(context: &str, error: std::io::Error) -> Self {
        Self::new("native_io_failed", format!("{context}: {error}"))
    }

    pub fn recovery_lock(message_id: &str, cause: impl Into<String>) -> Self {
        Self::new("dispatch_recovery_lock_retained", cause)
            .outcome_unknown(true)
            .with_details(serde_json::json!({
                "recoveryLockRetained": true,
                "messageId": message_id
            }))
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;
