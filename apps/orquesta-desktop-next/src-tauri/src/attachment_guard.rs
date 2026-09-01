use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::attachment_classification::{
    classify_reader, AttachmentClassification, MAX_IMAGE_BYTES,
};
use crate::error::{AppError, AppResult};

#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_READ,
};

#[derive(Debug)]
pub struct SealedAttachmentGuard {
    // The open handle is the lifetime guard. It is intentionally never read
    // after verification; dropping it is the explicit guard-close operation.
    _file: File,
    path: PathBuf,
}

impl SealedAttachmentGuard {
    pub fn absolute_path(&self) -> &Path {
        &self.path
    }
}

fn reject_reparse(
    metadata: &fs::Metadata,
    code: &'static str,
    message: &'static str,
) -> AppResult<()> {
    if !metadata.file_type().is_file() {
        return Err(AppError::new(code, message).outcome_unknown(true));
    }
    #[cfg(windows)]
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AppError::new(code, message).outcome_unknown(true));
    }
    Ok(())
}

fn open_read_guard(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        options
            .access_mode(FILE_GENERIC_READ)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|error| AppError::io("open sealed attachment guard", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect sealed attachment guard", error))?;
    reject_reparse(
        &metadata,
        "attachment_guard_identity_invalid",
        "Sealed attachment guard did not open a regular non-reparse file",
    )?;
    Ok(file)
}

fn hash_guarded_file(file: &mut File) -> AppResult<String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| AppError::io("rewind sealed attachment guard", error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| AppError::io("hash sealed attachment guard", error))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub fn open_sealed_attachment_guard(
    sealed_root: &Path,
    staged_name: &str,
    display_name: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> AppResult<(SealedAttachmentGuard, AttachmentClassification)> {
    if staged_name.is_empty()
        || Path::new(staged_name).components().count() != 1
        || !matches!(
            Path::new(staged_name).components().next(),
            Some(Component::Normal(_))
        )
    {
        return Err(AppError::new(
            "attachment_guard_path_invalid",
            "Sealed attachment identity must be one store-local name",
        )
        .outcome_unknown(true));
    }
    let root_metadata = fs::symlink_metadata(sealed_root)
        .map_err(|error| AppError::io("inspect sealed attachment root", error))?;
    if !root_metadata.is_dir() {
        return Err(AppError::new(
            "attachment_guard_root_invalid",
            "Attachment store root is not a directory",
        )
        .outcome_unknown(true));
    }
    #[cfg(windows)]
    if root_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AppError::new(
            "attachment_guard_root_reparse",
            "Attachment store root may not be a reparse point",
        )
        .outcome_unknown(true));
    }
    let path = sealed_root.join(staged_name);
    let path_metadata = fs::symlink_metadata(&path)
        .map_err(|error| AppError::io("inspect sealed attachment path", error))?;
    reject_reparse(
        &path_metadata,
        "attachment_guard_path_reparse",
        "Sealed attachment path must remain a regular non-reparse file",
    )?;
    if expected_size == 0 || expected_size > MAX_IMAGE_BYTES || path_metadata.len() != expected_size
    {
        return Err(AppError::new(
            "attachment_guard_size_mismatch",
            "Sealed attachment size no longer matches its durable identity",
        )
        .outcome_unknown(true));
    }
    let mut file = open_read_guard(&path)?;
    let opened_metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect opened sealed attachment", error))?;
    if opened_metadata.len() != expected_size {
        return Err(AppError::new(
            "attachment_guard_identity_changed",
            "Sealed attachment identity changed while its guard was opened",
        )
        .outcome_unknown(true));
    }
    let classification = classify_reader(display_name, expected_size, &mut file)?;
    let digest = hash_guarded_file(&mut file)?;
    if digest != expected_sha256 {
        return Err(AppError::new(
            "attachment_guard_digest_mismatch",
            "Sealed attachment digest no longer matches its durable identity",
        )
        .outcome_unknown(true));
    }
    let final_metadata = file
        .metadata()
        .map_err(|error| AppError::io("recheck sealed attachment guard", error))?;
    if final_metadata.len() != expected_size {
        return Err(AppError::new(
            "attachment_guard_identity_changed",
            "Sealed attachment identity changed while it was verified",
        )
        .outcome_unknown(true));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| AppError::io("rewind verified sealed attachment", error))?;
    Ok((SealedAttachmentGuard { _file: file, path }, classification))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_rejects_nested_store_names_before_opening() {
        let root = std::env::temp_dir();
        let error =
            open_sealed_attachment_guard(&root, "nested/file.txt", "file.txt", 1, &"0".repeat(64))
                .expect_err("nested path must not enter the store");
        assert_eq!(error.code, "attachment_guard_path_invalid");
    }

    #[test]
    fn guard_keeps_the_verified_file_identity_when_the_final_path_is_replaced() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-guard-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create guard root");
        let path = root.join("sealed.txt");
        let moved = root.join("verified.txt");
        let bytes = b"verified attachment";
        fs::write(&path, bytes).expect("write guarded file");
        let digest = hex::encode(Sha256::digest(bytes));
        let (mut guard, _) = open_sealed_attachment_guard(
            &root,
            "sealed.txt",
            "sealed.txt",
            bytes.len() as u64,
            &digest,
        )
        .expect("open sealed guard");

        #[cfg(windows)]
        {
            assert!(fs::rename(&path, &moved).is_err());
            let mut observed = Vec::new();
            guard
                ._file
                .read_to_end(&mut observed)
                .expect("read guarded file");
            assert_eq!(observed, bytes);
            drop(guard);
            fs::rename(&path, &moved).expect("move after guard closes");
            fs::write(&path, b"replacement").expect("write replacement");
            assert_eq!(fs::read(&moved).unwrap(), bytes);
            assert_eq!(fs::read(&path).unwrap(), b"replacement");
        }

        #[cfg(unix)]
        {
            fs::rename(&path, &moved).expect("replace visible final path");
            fs::write(&path, b"replacement").expect("write replacement");
            let mut observed = Vec::new();
            guard
                ._file
                .read_to_end(&mut observed)
                .expect("read guarded file");
            assert_eq!(observed, bytes);
            assert_eq!(fs::read(&path).unwrap(), b"replacement");
        }

        #[cfg(unix)]
        drop(guard);
        let _ = fs::remove_dir_all(root);
    }
}
