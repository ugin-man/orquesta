use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::error::{AppError, AppResult};

pub struct InstanceLock {
    file: File,
    state_root: PathBuf,
}

impl InstanceLock {
    pub fn acquire(state: &Path) -> AppResult<Self> {
        let path = state.join("desktop-next.lock");
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| AppError::io("open instance lock", error))?;
        file.try_lock_exclusive().map_err(|_| {
            AppError::new(
                "desktop_next_already_running",
                "Another Orquesta Next instance owns this data directory",
            )
        })?;
        Ok(Self {
            file,
            state_root: state.to_path_buf(),
        })
    }

    pub(crate) fn require_state_root(&self, state: &Path) -> AppResult<()> {
        if self.state_root != state {
            return Err(AppError::new(
                "desktop_next_lock_scope_mismatch",
                "Instance lock does not own this Desktop data root",
            ));
        }
        Ok(())
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}
