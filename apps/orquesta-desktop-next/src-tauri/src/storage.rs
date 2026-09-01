use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, AppResult};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub fn private_directory(path: &Path) -> AppResult<()> {
    let mut missing = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        missing.push(cursor.to_path_buf());
        cursor = cursor.parent().ok_or_else(|| {
            AppError::new("invalid_native_path", "Private directory has no parent")
        })?;
    }
    for item in missing.into_iter().rev() {
        fs::create_dir(&item).map_err(|error| AppError::io("create private directory", error))?;
        #[cfg(unix)]
        fs::set_permissions(&item, fs::Permissions::from_mode(0o700))
            .map_err(|error| AppError::io("chmod private directory", error))?;
        if let Some(parent) = item.parent() {
            sync_directory(parent)?;
        }
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AppError::io("inspect private directory", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::new(
            "native_path_identity_invalid",
            format!(
                "Private directory is a link, reparse point, or non-directory: {}",
                path.display()
            ),
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "native_path_identity_invalid",
                "Private directory is a reparse point",
            ));
        }
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| AppError::io("chmod private directory", error))?;
    Ok(())
}

fn private_write_file(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| AppError::io("open private state file", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect private state file", error))?;
    if !metadata.is_file() {
        return Err(AppError::new(
            "native_state_identity_invalid",
            "State path is not a regular file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "native_state_identity_invalid",
                "State path is a reparse point",
            ));
        }
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| AppError::io("chmod private state file", error))?;
    Ok(file)
}

pub fn sync_directory(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| AppError::io("sync state directory", error))?;
    }
    #[cfg(windows)]
    {
        let _ = path;
        // Windows directory FlushFileBuffers is not exposed by std. File contents and
        // rename ordering are flushed; current-user DACL hardening remains unverified.
    }
    Ok(())
}

fn sibling(path: &Path, suffix: &str) -> AppResult<PathBuf> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::new("invalid_native_path", "State filename is invalid"))?;
    Ok(path.with_file_name(format!("{name}{suffix}")))
}

pub fn backup_path(path: &Path) -> AppResult<PathBuf> {
    sibling(path, ".bak")
}

pub fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("invalid_native_path", "State file has no parent"))?;
    private_directory(parent)?;
    let temporary = sibling(path, ".tmp")?;
    let backup = backup_path(path)?;
    let bytes = serde_json::to_vec(value)
        .map_err(|error| AppError::new("state_encode_failed", error.to_string()))?;
    {
        let mut file = private_write_file(&temporary)?;
        file.write_all(&bytes)
            .map_err(|error| AppError::io("write state temp", error))?;
        file.write_all(b"\n")
            .map_err(|error| AppError::io("write state newline", error))?;
        file.sync_all()
            .map_err(|error| AppError::io("sync state temp", error))?;
    }
    if path.exists() {
        let primary_metadata = fs::symlink_metadata(path)
            .map_err(|error| AppError::io("inspect state primary", error))?;
        if primary_metadata.file_type().is_symlink() || !primary_metadata.is_file() {
            return Err(AppError::new(
                "native_state_identity_invalid",
                "State primary is not a regular private file",
            ));
        }
        let bytes =
            fs::read(path).map_err(|error| AppError::io("read state backup source", error))?;
        let mut backup_file = private_write_file(&backup)?;
        backup_file
            .write_all(&bytes)
            .map_err(|error| AppError::io("write state backup", error))?;
        backup_file
            .sync_all()
            .map_err(|error| AppError::io("sync state backup", error))?;
        #[cfg(unix)]
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o600))
            .map_err(|error| AppError::io("chmod state backup", error))?;
    }
    atomic_write_failpoint("before_replace")?;
    fs::rename(&temporary, path).map_err(|error| AppError::io("commit state file", error))?;
    atomic_write_failpoint("after_replace")?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| AppError::io("chmod state file", error))?;
    sync_directory(parent)
}

/// Restores a primary from a separately validated backup without rotating the
/// unusable primary over that backup.  The backup remains the recovery source
/// until the replacement primary has been written, renamed, and synced.
pub fn restore_primary_preserving_backup<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("invalid_native_path", "State file has no parent"))?;
    private_directory(parent)?;
    let temporary = sibling(path, ".tmp")?;
    let bytes = serde_json::to_vec(value)
        .map_err(|error| AppError::new("state_encode_failed", error.to_string()))?;
    {
        let mut file = private_write_file(&temporary)?;
        file.write_all(&bytes)
            .map_err(|error| AppError::io("write restored state temp", error))?;
        file.write_all(b"\n")
            .map_err(|error| AppError::io("write restored state newline", error))?;
        file.sync_all()
            .map_err(|error| AppError::io("sync restored state temp", error))?;
    }
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| AppError::io("inspect invalid state primary", error))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AppError::new(
                "native_state_identity_invalid",
                "Invalid state primary is not a regular private file",
            ));
        }
    }
    restore_failpoint("before_replace")?;
    replace_primary_preserving_backup(&temporary, path)?;
    restore_failpoint("after_replace")?;
    sync_directory(parent)
}

#[cfg(test)]
thread_local! {
    static TEST_RESTORE_FAILPOINT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_restore_failpoint(name: Option<&'static str>) {
    TEST_RESTORE_FAILPOINT.with(|current| *current.borrow_mut() = name);
}

#[cfg(test)]
pub(crate) fn restore_failpoint(name: &'static str) -> AppResult<()> {
    let active = TEST_RESTORE_FAILPOINT.with(|current| *current.borrow());
    if active == Some(name) {
        return Err(AppError::new(
            "state_restore_test_failpoint",
            format!("State restore failpoint: {name}"),
        )
        .outcome_unknown(true));
    }
    Ok(())
}

#[cfg(not(test))]
pub(crate) fn restore_failpoint(_name: &'static str) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
thread_local! {
    static TEST_ATOMIC_WRITE_FAILPOINT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_atomic_write_failpoint(name: Option<&'static str>) {
    TEST_ATOMIC_WRITE_FAILPOINT.with(|current| *current.borrow_mut() = name);
}

#[cfg(test)]
fn atomic_write_failpoint(name: &'static str) -> AppResult<()> {
    let active = TEST_ATOMIC_WRITE_FAILPOINT.with(|current| *current.borrow());
    if active == Some(name) {
        return Err(AppError::new(
            "state_commit_test_failpoint",
            format!("State commit failpoint: {name}"),
        )
        .outcome_unknown(true));
    }
    Ok(())
}

#[cfg(not(test))]
fn atomic_write_failpoint(_name: &'static str) -> AppResult<()> {
    Ok(())
}

#[cfg(windows)]
fn replace_primary_preserving_backup(temporary: &Path, path: &Path) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(AppError::io(
            "atomically restore state primary",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_primary_preserving_backup(temporary: &Path, path: &Path) -> AppResult<()> {
    fs::rename(temporary, path).map_err(|error| AppError::io("restore state primary", error))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    match File::open(path) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| AppError::io("read state file", error))?;
            serde_json::from_slice(&bytes).map(Some).map_err(|error| {
                AppError::new("state_corrupt", format!("{}: {error}", path.display()))
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io("open state file", error)),
    }
}

pub fn materialize_sentinel<T: Serialize + DeserializeOwned>(
    path: &Path,
    initial: &T,
) -> AppResult<()> {
    if path.exists() {
        return Ok(());
    }
    let backup = backup_path(path)?;
    if backup.exists() {
        return Err(AppError::new(
            "state_identity_uncertain",
            format!("{} is missing while its backup exists", path.display()),
        )
        .outcome_unknown(true));
    }
    atomic_write_json(path, initial)?;
    // A second identical commit materializes an explicit empty backup. A later
    // missing primary can therefore never be confused with never-used state.
    atomic_write_json(path, initial)
}

pub fn load_primary_or_backup<T: DeserializeOwned>(
    path: &Path,
    identity_code: &str,
) -> AppResult<T> {
    match read_json(path) {
        Ok(Some(value)) => Ok(value),
        primary => {
            let backup = backup_path(path)?;
            match read_json(&backup) {
                Ok(Some(value)) => Ok(value),
                _ => Err(AppError::new(
                    identity_code,
                    match primary {
                        Ok(None) => format!("{} is missing", path.display()),
                        Err(error) => error.message,
                        Ok(Some(_)) => unreachable!(),
                    },
                )
                .outcome_unknown(true)),
            }
        }
    }
}
