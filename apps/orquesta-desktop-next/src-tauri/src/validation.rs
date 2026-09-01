use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

pub fn bounded_id(value: &str, label: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(AppError::new(
            "invalid_identifier",
            format!("{label} is invalid"),
        ));
    }
    Ok(value.to_owned())
}

pub fn canonical_uuid(value: &str, label: &str) -> AppResult<String> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| AppError::new("invalid_identifier", format!("{label} must be a UUID")))?;
    if parsed.hyphenated().to_string() != value.to_ascii_lowercase() {
        return Err(AppError::new(
            "invalid_identifier",
            format!("{label} must use canonical UUID form"),
        ));
    }
    Ok(parsed.hyphenated().to_string())
}

pub fn bounded_text(value: &str, label: &str, max: usize) -> AppResult<String> {
    if value.trim().is_empty() || value.len() > max {
        return Err(AppError::new(
            "invalid_text",
            format!("{label} is empty or too long"),
        ));
    }
    Ok(value.to_owned())
}

pub fn normalized_project_name(value: &str) -> AppResult<String> {
    let normalized = value.trim();
    if normalized != value {
        return Err(AppError::new(
            "project_name_invalid",
            "Project name cannot start or end with whitespace",
        ));
    }
    let value = normalized;
    let utf16_len = value.encode_utf16().count();
    let invalid_windows_character = value.chars().any(|character| {
        matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        )
    });
    let path = Path::new(value);
    let one_normal_component = {
        let mut components = path.components();
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
    };
    let reserved_base: String = value
        .trim_end_matches(['.', ' '])
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase()
        .chars()
        .map(|character| match character {
            '¹' => '1',
            '²' => '2',
            '³' => '3',
            other => other,
        })
        .collect();
    let reserved = matches!(
        reserved_base.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if value.is_empty()
        || value == "."
        || value == ".."
        || utf16_len > 160
        || value.chars().any(char::is_control)
        || value.contains('\0')
        || invalid_windows_character
        || value.ends_with('.')
        || value.ends_with(' ')
        || reserved
        || path.is_absolute()
        || !one_normal_component
    {
        return Err(AppError::new(
            "project_name_invalid",
            "Project name is empty, reserved, too long, or cannot be used as one folder name",
        ));
    }
    Ok(value.to_owned())
}

pub fn platform_name_eq(left: &OsStr, right: &OsStr) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "Kernel32")]
        extern "system" {
            fn CompareStringOrdinal(
                string1: *const u16,
                count1: i32,
                string2: *const u16,
                count2: i32,
                ignore_case: i32,
            ) -> i32;
        }
        const CSTR_EQUAL: i32 = 2;
        let left: Vec<u16> = left.encode_wide().collect();
        let right: Vec<u16> = right.encode_wide().collect();
        let Ok(left_len) = i32::try_from(left.len()) else {
            return false;
        };
        let Ok(right_len) = i32::try_from(right.len()) else {
            return false;
        };
        return unsafe {
            CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1)
        } == CSTR_EQUAL;
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub fn platform_path_eq(left: &Path, right: &Path) -> bool {
    platform_name_eq(left.as_os_str(), right.as_os_str())
}

pub fn canonical_directory(path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::new(
            "invalid_project_path",
            "Project path is invalid",
        ));
    }
    let requested = Path::new(path);
    if !requested.is_absolute()
        || requested
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(AppError::new(
            "invalid_project_path",
            "Project path must be absolute and normalized",
        ));
    }
    let canonical = std::fs::canonicalize(requested)
        .map_err(|error| AppError::io("canonicalize project", error))?;
    if !canonical.is_dir() {
        return Err(AppError::new(
            "invalid_project_path",
            "Project path is not a directory",
        ));
    }
    canonical.to_str().ok_or_else(|| {
        AppError::new(
            "project_path_not_utf8",
            "Desktop Next cannot persist this project path as UTF-8",
        )
    })?;
    Ok(canonical)
}

pub fn canonical_path_string(path: &Path) -> AppResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("project_path_not_utf8", "Path is not valid UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_project_names_reject_all_windows_invalid_and_reserved_forms() {
        let too_long = "あ".repeat(161);
        let invalid = [
            "",
            ".",
            "..",
            "child/name",
            "child\\name",
            r"C:\absolute",
            "bad\nname",
            "bad\0name",
            "CON",
            "con.txt",
            "COM1",
            "LPT9.log",
            "name.",
            "name ",
            "COM¹",
            "com².txt",
            "COM³.log",
            "LPT¹",
            "lpt².txt",
            "LPT³.log",
            too_long.as_str(),
        ];
        for candidate in invalid {
            assert_eq!(
                normalized_project_name(candidate)
                    .expect_err("reject invalid Starter name")
                    .code,
                "project_name_invalid",
                "candidate={candidate:?}"
            );
        }
    }

    #[test]
    fn starter_project_names_keep_bounded_unicode() {
        assert_eq!(
            normalized_project_name("顧客管理").expect("valid name"),
            "顧客管理"
        );
        assert!(normalized_project_name(&"あ".repeat(160)).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn windows_platform_comparison_is_unicode_case_insensitive() {
        assert!(platform_name_eq(
            OsStr::new("Ångström"),
            OsStr::new("ångström")
        ));
        assert!(platform_name_eq(OsStr::new("ČESKÝ"), OsStr::new("český")));
    }
}
