use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const MAX_IMAGE_BYTES: u64 = crate::protocol::GENERATED_ATTACHMENT_MAX_IMAGE_BYTES;
pub const MAX_TEXT_BYTES: u64 = crate::protocol::GENERATED_ATTACHMENT_MAX_TEXT_BYTES;
pub const MAX_TEXT_BYTES_PER_DISPATCH: u64 =
    crate::protocol::GENERATED_ATTACHMENT_MAX_TEXT_BYTES_PER_DISPATCH;
pub const MAX_ATTACHMENTS_PER_DISPATCH: usize =
    crate::protocol::GENERATED_ATTACHMENT_MAX_PER_DISPATCH;
pub const MAX_IMAGE_PREVIEW_BYTES: u64 =
    crate::protocol::GENERATED_ATTACHMENT_MAX_IMAGE_PREVIEW_BYTES;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    Text,
}

impl Default for AttachmentKind {
    fn default() -> Self {
        Self::Image
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AttachmentEncoding {
    #[serde(rename = "utf-8", alias = "utf8")]
    Utf8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentClassification {
    pub kind: AttachmentKind,
    pub media_type: String,
    pub encoding: Option<AttachmentEncoding>,
}

fn extension(display_name: &str) -> Option<String> {
    Path::new(display_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
}

fn image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn expected_image_media_type(extension: &str) -> Option<&'static str> {
    crate::protocol::GENERATED_ATTACHMENT_FORMATS
        .iter()
        .find_map(|(candidate, kind, media_type)| {
            (*candidate == extension && *kind == "image").then_some(*media_type)
        })
}

fn text_media_type(extension: &str) -> Option<&'static str> {
    crate::protocol::GENERATED_ATTACHMENT_FORMATS
        .iter()
        .find_map(|(candidate, kind, media_type)| {
            (*candidate == extension && *kind == "text").then_some(*media_type)
        })
}

pub fn validate_declared_attachment(
    display_name: &str,
    size_bytes: u64,
) -> AppResult<AttachmentKind> {
    if size_bytes == 0 {
        return Err(AppError::new(
            "attachment_empty_unsupported",
            "Empty files are not currently supported",
        ));
    }
    let extension = extension(display_name).ok_or_else(|| {
        AppError::new(
            "attachment_format_unsupported",
            "This file type is not currently supported",
        )
    })?;
    if expected_image_media_type(&extension).is_some() {
        if size_bytes > MAX_IMAGE_BYTES {
            return Err(AppError::new(
                "attachment_size_invalid",
                "The image exceeds the configured attachment limit",
            ));
        }
        return Ok(AttachmentKind::Image);
    }
    if text_media_type(&extension).is_some() {
        if size_bytes > MAX_TEXT_BYTES {
            return Err(AppError::new(
                "attachment_text_size_invalid",
                "The text attachment exceeds the configured attachment limit",
            ));
        }
        return Ok(AttachmentKind::Text);
    }
    Err(AppError::new(
        "attachment_format_unsupported",
        "This file type is not currently supported",
    ))
}

pub fn classify_bytes(display_name: &str, bytes: &[u8]) -> AppResult<AttachmentClassification> {
    if bytes.is_empty() {
        return Err(AppError::new(
            "attachment_empty_unsupported",
            "Empty files are not currently supported",
        ));
    }
    let extension = extension(display_name).ok_or_else(|| {
        AppError::new(
            "attachment_format_unsupported",
            "This file type is not currently supported",
        )
    })?;
    if let Some(expected) = expected_image_media_type(&extension) {
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(AppError::new(
                "attachment_size_invalid",
                "The image exceeds the configured attachment limit",
            ));
        }
        if image_media_type(bytes) != Some(expected) {
            return Err(AppError::new(
                "attachment_format_mismatch",
                "The image bytes do not match the selected file type",
            ));
        }
        return Ok(AttachmentClassification {
            kind: AttachmentKind::Image,
            media_type: expected.into(),
            encoding: None,
        });
    }
    let media_type = text_media_type(&extension).ok_or_else(|| {
        AppError::new(
            "attachment_format_unsupported",
            "This file type is not currently supported",
        )
    })?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(AppError::new(
            "attachment_text_size_invalid",
            "The text attachment exceeds the configured attachment limit",
        ));
    }
    if bytes.contains(&0) || std::str::from_utf8(bytes).is_err() {
        return Err(AppError::new(
            "attachment_text_encoding_unsupported",
            "Only strict UTF-8 text files without NUL bytes are currently supported",
        ));
    }
    Ok(AttachmentClassification {
        kind: AttachmentKind::Text,
        media_type: media_type.into(),
        encoding: Some(AttachmentEncoding::Utf8),
    })
}

pub fn classify_reader<R: Read + Seek>(
    display_name: &str,
    size_bytes: u64,
    reader: &mut R,
) -> AppResult<AttachmentClassification> {
    if size_bytes == 0 || size_bytes > MAX_IMAGE_BYTES {
        return Err(AppError::new(
            "attachment_size_invalid",
            "The attachment is empty or exceeds the configured limit",
        ));
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| AppError::io("rewind sealed attachment", error))?;
    let mut bytes = Vec::with_capacity(size_bytes as usize);
    reader
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::io("read sealed attachment classification", error))?;
    if bytes.len() as u64 != size_bytes {
        return Err(AppError::new(
            "attachment_identity_changed",
            "Sealed attachment size changed while it was classified",
        )
        .outcome_unknown(true));
    }
    classify_bytes(display_name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_text_allowlist_accepts_bom_and_rejects_nul_or_spoofing() {
        let accepted = classify_bytes("設計 メモ.md", b"\xef\xbb\xbf# title\r\nbody")
            .expect("strict UTF-8 markdown");
        assert_eq!(accepted.kind, AttachmentKind::Text);
        assert_eq!(accepted.encoding, Some(AttachmentEncoding::Utf8));
        assert_eq!(
            serde_json::to_value(AttachmentEncoding::Utf8).expect("wire encoding"),
            serde_json::json!("utf-8")
        );
        assert_eq!(
            serde_json::from_value::<AttachmentEncoding>(serde_json::json!("utf8"))
                .expect("legacy persisted encoding"),
            AttachmentEncoding::Utf8
        );
        assert_eq!(
            classify_bytes("bad.txt", b"a\0b")
                .expect_err("NUL must fail")
                .code,
            "attachment_text_encoding_unsupported"
        );
        assert_eq!(
            classify_bytes("spoof.png", b"plain text")
                .expect_err("image extension spoof must fail")
                .code,
            "attachment_format_mismatch"
        );
    }

    #[test]
    fn unsupported_binary_is_reported_as_unsupported_not_corrupt() {
        assert_eq!(
            classify_bytes("document.pdf", b"%PDF-1.7")
                .expect_err("PDF is outside this slice")
                .code,
            "attachment_format_unsupported"
        );
    }
}
