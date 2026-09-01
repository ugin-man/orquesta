use super::*;

impl VoiceService {
    pub(super) fn install_asset(
        &self,
        asset: &DesktopAsset,
        operation_ref: &str,
        part_path: &Path,
        licenses: &[VerifiedLicense],
        cancelled: &watch::Receiver<bool>,
    ) -> AppResult<InstallReceipt> {
        let temporary = direct_child(
            &self.inner.installed_root,
            &format!(".install-{}-{operation_ref}", asset.asset_id),
            "Voice temporary install",
        )?;
        remove_flat_asset_directory(&temporary)?;
        private_directory(&temporary)?;
        let result = (|| {
            ensure_not_cancelled(cancelled)?;
            match asset.kind {
                DesktopAssetKind::NativeBinaryBundle => {
                    extract_allowlisted_binary(asset, part_path, &temporary, cancelled)?;
                }
                DesktopAssetKind::Model => {
                    let target = direct_child(&temporary, &asset.file_name, "Voice model file")?;
                    copy_regular_file_cancel_safe(part_path, &target, cancelled)?;
                }
            }
            ensure_not_cancelled(cancelled)?;
            for license in licenses {
                let target = direct_child(&temporary, &license.file_name, "Voice license file")?;
                let mut file = create_private_new_file(&target)?;
                file.write_all(&license.bytes)
                    .map_err(|error| AppError::io("write voice license", error))?;
                file.sync_all()
                    .map_err(|error| AppError::io("sync voice license", error))?;
            }
            ensure_not_cancelled(cancelled)?;
            let receipt = build_install_receipt(asset, operation_ref, &temporary)?;
            let receipt_path =
                direct_child(&temporary, INSTALL_RECEIPT_FILE, "Voice install receipt")?;
            atomic_write_json(&receipt_path, &receipt)?;
            verify_install_receipt(asset, &temporary)?;
            remove_regular_file_if_exists(part_path, "Verified voice transfer")?;
            let final_root = direct_child(
                &self.inner.installed_root,
                &asset.asset_id,
                "Installed voice asset",
            )?;
            promote_flat_install(
                &self.inner.installed_root,
                &temporary,
                &final_root,
                &asset.asset_id,
            )?;
            Ok(receipt)
        })();
        match result {
            Ok(receipt) => Ok(receipt),
            Err(error) => {
                if remove_flat_asset_directory(&temporary).is_err()
                    || sync_directory(&self.inner.installed_root).is_err()
                {
                    return Err(AppError::new(
                        "voice_install_cleanup_unconfirmed",
                        "Voice install failed and staging cleanup could not be confirmed",
                    )
                    .outcome_unknown(true));
                }
                Err(error)
            }
        }
    }
}

pub(super) fn reconcile_document(
    catalog: &AssetCatalog,
    transfers_root: &Path,
    installed_root: &Path,
    document: &mut VoiceStateDocument,
) -> AppResult<()> {
    if document.schema_version != VOICE_STATE_SCHEMA_VERSION {
        return Err(AppError::new(
            "voice_state_schema_unsupported",
            "Voice state was written by a newer Desktop Next",
        ));
    }
    let expected: HashSet<&str> = catalog
        .assets()
        .map(|asset| asset.asset_id.as_str())
        .collect();
    if document.assets.len() != expected.len()
        || document
            .assets
            .keys()
            .any(|asset_id| !expected.contains(asset_id.as_str()))
    {
        return Err(AppError::new(
            "voice_state_invalid",
            "Voice state does not match the immutable asset catalog",
        )
        .outcome_unknown(true));
    }
    for asset in catalog.assets() {
        let record = document
            .assets
            .get_mut(&asset.asset_id)
            .ok_or_else(|| AppError::new("voice_state_invalid", "Voice asset record is missing"))?;
        if record.asset_id != asset.asset_id
            || record.kind != asset.kind.as_str()
            || record.expected_bytes != asset.size_bytes
        {
            return Err(AppError::new(
                "voice_state_invalid",
                "Voice asset record conflicts with the immutable catalog",
            )
            .outcome_unknown(true));
        }
        record.operation_ref = None;
        let part = transfer_part_path(transfers_root, &asset.asset_id)?;
        if record.phase == VoiceAssetPhase::Deleting {
            let installed = direct_child(installed_root, &asset.asset_id, "Installed voice asset")?;
            remove_flat_asset_directory(&installed)?;
            remove_regular_file_if_exists(&part, "Voice partial transfer")?;
            record.phase = VoiceAssetPhase::Absent;
            record.downloaded_bytes = 0;
            record.installed_source_sha256 = None;
            record.installed_at_ms = None;
            record.last_error_code = None;
            continue;
        }
        let partial_len = regular_file_len_or_zero(&part, "Voice partial transfer")?;
        let installed = direct_child(installed_root, &asset.asset_id, "Installed voice asset")?;
        if installed.exists() {
            let receipt = verify_install_receipt(asset, &installed)?;
            record.phase = VoiceAssetPhase::Installed;
            record.downloaded_bytes = asset.size_bytes;
            record.installed_source_sha256 = Some(receipt.source_sha256);
            record.installed_at_ms = Some(receipt.installed_at_ms);
        } else if partial_len > 0 && partial_len <= asset.size_bytes {
            record.phase = VoiceAssetPhase::Paused;
            record.downloaded_bytes = partial_len;
            record.installed_source_sha256 = None;
            record.installed_at_ms = None;
        } else {
            record.phase = VoiceAssetPhase::Absent;
            record.downloaded_bytes = 0;
            record.installed_source_sha256 = None;
            record.installed_at_ms = None;
        }
        record.last_error_code = None;
    }
    document.revision = document.revision.saturating_add(1);
    Ok(())
}

pub(super) fn recover_install_directories(
    catalog: &AssetCatalog,
    installed_root: &Path,
) -> AppResult<()> {
    for asset in catalog.assets() {
        let final_root = direct_child(installed_root, &asset.asset_id, "Installed voice asset")?;
        let retired = direct_child(
            installed_root,
            &format!(".retired-{}", asset.asset_id),
            "Retired voice install",
        )?;
        if retired.exists() {
            verify_install_receipt(asset, &retired)?;
            if final_root.exists() {
                verify_install_receipt(asset, &final_root)?;
                remove_flat_asset_directory(&retired)?;
            } else {
                fs::rename(&retired, &final_root)
                    .map_err(|error| AppError::io("restore retired voice install", error))?;
                sync_directory(installed_root)?;
            }
        }
    }
    for entry in fs::read_dir(installed_root)
        .map_err(|error| AppError::io("list voice installed root", error))?
    {
        let entry = entry.map_err(|error| AppError::io("read voice installed entry", error))?;
        let name = entry.file_name().into_string().map_err(|_| {
            AppError::new("voice_state_invalid", "Voice install name is not Unicode")
        })?;
        if name.starts_with(".install-") {
            remove_flat_asset_directory(&entry.path())?;
        } else if name.starts_with(".retired-") {
            return Err(AppError::new(
                "voice_install_recovery_uncertain",
                "Voice install recovery found an unknown retired asset",
            )
            .outcome_unknown(true));
        }
    }
    Ok(())
}

fn build_install_receipt(
    asset: &DesktopAsset,
    operation_ref: &str,
    install_root: &Path,
) -> AppResult<InstallReceipt> {
    let expected = expected_install_files(asset)?;
    let mut files = BTreeMap::new();
    for file_name in expected {
        let path = direct_child(install_root, &file_name, "Installed voice file")?;
        files.insert(file_name, hash_regular_file(&path, "Installed voice file")?);
    }
    Ok(InstallReceipt {
        schema_version: 1,
        asset_id: asset.asset_id.clone(),
        source_sha256: asset.sha256.clone(),
        operation_ref: operation_ref.to_owned(),
        installed_at_ms: now_ms(),
        files,
    })
}

pub(super) fn verify_install_receipt(
    asset: &DesktopAsset,
    install_root: &Path,
) -> AppResult<InstallReceipt> {
    verify_flat_asset_directory(install_root)?;
    let receipt_path = direct_child(install_root, INSTALL_RECEIPT_FILE, "Voice install receipt")?;
    let receipt: InstallReceipt = read_json(&receipt_path)?.ok_or_else(|| {
        AppError::new(
            "voice_install_receipt_missing",
            "Installed voice asset has no durable receipt",
        )
        .outcome_unknown(true)
    })?;
    if receipt.schema_version != 1
        || receipt.asset_id != asset.asset_id
        || receipt.source_sha256 != asset.sha256
        || uuid::Uuid::parse_str(&receipt.operation_ref).is_err()
        || receipt.installed_at_ms == 0
    {
        return Err(AppError::new(
            "voice_install_receipt_invalid",
            "Installed voice asset receipt conflicts with the immutable catalog",
        )
        .outcome_unknown(true));
    }
    let expected = expected_install_files(asset)?;
    if receipt.files.keys().cloned().collect::<HashSet<_>>() != expected {
        return Err(AppError::new(
            "voice_install_receipt_invalid",
            "Installed voice asset receipt has an unexpected file inventory",
        )
        .outcome_unknown(true));
    }
    let mut actual_names = HashSet::new();
    for entry in fs::read_dir(install_root)
        .map_err(|error| AppError::io("list installed voice asset", error))?
    {
        let entry = entry.map_err(|error| AppError::io("read installed voice entry", error))?;
        let name = entry.file_name().into_string().map_err(|_| {
            AppError::new(
                "voice_install_receipt_invalid",
                "Installed voice asset filename is not Unicode",
            )
        })?;
        actual_names.insert(name);
    }
    let mut expected_names = receipt.files.keys().cloned().collect::<HashSet<_>>();
    expected_names.insert(INSTALL_RECEIPT_FILE.into());
    if actual_names != expected_names {
        return Err(AppError::new(
            "voice_install_receipt_invalid",
            "Installed voice asset contains files outside its durable receipt",
        )
        .outcome_unknown(true));
    }
    for (file_name, expected_file) in &receipt.files {
        let path = direct_child(install_root, file_name, "Installed voice file")?;
        if hash_regular_file(&path, "Installed voice file")? != *expected_file {
            return Err(AppError::new(
                "voice_install_content_mismatch",
                "Installed voice asset content does not match its durable receipt",
            )
            .outcome_unknown(true));
        }
    }
    Ok(receipt)
}

fn expected_install_files(asset: &DesktopAsset) -> AppResult<HashSet<String>> {
    let mut expected = HashSet::new();
    match asset.kind {
        DesktopAssetKind::NativeBinaryBundle => {
            for entry in asset.archive_allowlist().ok_or_else(|| {
                AppError::new(
                    "asset_catalog_invalid",
                    "Binary archive allowlist is missing",
                )
            })? {
                let leaf = entry.strip_prefix("Release/").ok_or_else(|| {
                    AppError::new("asset_catalog_invalid", "Invalid binary allowlist")
                })?;
                expected.insert(leaf.to_owned());
            }
        }
        DesktopAssetKind::Model => {
            expected.insert(asset.file_name.clone());
        }
    }
    for index in 0..asset.licenses().len() {
        expected.insert(format!("LICENSE-{:02}.txt", index + 1));
    }
    Ok(expected)
}

fn hash_regular_file(path: &Path, label: &str) -> AppResult<InstalledFileReceipt> {
    let mut file = open_regular_read_nofollow(path, label)?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect installed voice file", error))?;
    verify_regular_metadata(&metadata, label)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| AppError::io("hash installed voice file", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(InstalledFileReceipt {
        size_bytes: metadata.len(),
        sha256: format!("{:x}", digest.finalize()),
    })
}

fn extract_allowlisted_binary(
    asset: &DesktopAsset,
    archive_path: &Path,
    target_root: &Path,
    cancelled: &watch::Receiver<bool>,
) -> AppResult<()> {
    let allowlist = asset.archive_allowlist().ok_or_else(|| {
        AppError::new(
            "asset_catalog_invalid",
            "Binary archive allowlist is missing",
        )
    })?;
    let file = open_regular_read_nofollow(archive_path, "Voice binary archive")?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::new("voice_archive_invalid", error.to_string()))?;
    if asset.archive_entry_count() != Some(archive.len()) {
        return Err(AppError::new(
            "voice_archive_entry_count_mismatch",
            "Voice archive entry count does not match the immutable catalog",
        ));
    }
    let expected: HashSet<&str> = allowlist.iter().map(String::as_str).collect();
    let mut extracted = HashSet::new();
    for index in 0..archive.len() {
        ensure_not_cancelled(cancelled)?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| AppError::new("voice_archive_invalid", error.to_string()))?;
        let name = entry.name().to_owned();
        if !expected.contains(name.as_str()) {
            continue;
        }
        if !entry.is_file()
            || entry.enclosed_name().as_deref() != Some(Path::new(&name))
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || !matches!(
                entry.compression(),
                zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
            )
            || entry.size() > 64 * 1024 * 1024
        {
            return Err(AppError::new(
                "voice_archive_entry_rejected",
                "Allowlisted voice archive entry is not a bounded regular file",
            ));
        }
        let leaf = name
            .strip_prefix("Release/")
            .ok_or_else(|| AppError::new("asset_catalog_invalid", "Invalid binary allowlist"))?;
        let target = direct_child(target_root, leaf, "Voice binary entry")?;
        let mut output = create_private_new_file(&target)?;
        let copied = copy_reader_cancel_safe(&mut entry, &mut output, cancelled)?;
        if copied != entry.size() {
            return Err(AppError::new(
                "voice_archive_entry_size_mismatch",
                "Voice archive entry ended before its declared size",
            ));
        }
        output
            .sync_all()
            .map_err(|error| AppError::io("sync voice binary entry", error))?;
        if !extracted.insert(name) {
            return Err(AppError::new(
                "voice_archive_entry_rejected",
                "Voice archive contains a duplicate allowlisted entry",
            ));
        }
    }
    if extracted.len() != expected.len() {
        return Err(AppError::new(
            "voice_archive_entry_missing",
            "Voice archive is missing an allowlisted runtime entry",
        ));
    }
    Ok(())
}

fn create_private_new_file(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| AppError::io("create private voice file", error))?;
    verify_regular_metadata(
        &file
            .metadata()
            .map_err(|error| AppError::io("inspect private voice file", error))?,
        "Private voice file",
    )?;
    Ok(file)
}

fn promote_flat_install(
    installed_root: &Path,
    temporary: &Path,
    final_root: &Path,
    asset_id: &str,
) -> AppResult<()> {
    let retired = direct_child(
        installed_root,
        &format!(".retired-{asset_id}"),
        "Retired voice install",
    )?;
    remove_flat_asset_directory(&retired)?;
    let had_previous = final_root.exists();
    if had_previous {
        verify_flat_asset_directory(final_root)?;
        fs::rename(final_root, &retired)
            .map_err(|error| AppError::io("retire previous voice install", error))?;
        sync_directory(installed_root)?;
    }
    if let Err(error) = fs::rename(temporary, final_root) {
        if had_previous {
            let _ = fs::rename(&retired, final_root);
        }
        return Err(AppError::io("promote verified voice install", error));
    }
    sync_directory(installed_root)?;
    remove_flat_asset_directory(&retired)?;
    sync_directory(installed_root)
}

fn copy_regular_file_cancel_safe(
    source: &Path,
    target: &Path,
    cancelled: &watch::Receiver<bool>,
) -> AppResult<()> {
    let mut input = open_regular_read_nofollow(source, "Verified voice model")?;
    let mut output = create_private_new_file(target)?;
    copy_reader_cancel_safe(&mut input, &mut output, cancelled)?;
    output
        .sync_all()
        .map_err(|error| AppError::io("sync installed voice model", error))
}

fn copy_reader_cancel_safe(
    input: &mut impl Read,
    output: &mut impl Write,
    cancelled: &watch::Receiver<bool>,
) -> AppResult<u64> {
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        ensure_not_cancelled(cancelled)?;
        let read = input
            .read(&mut buffer)
            .map_err(|error| AppError::io("read verified voice asset", error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| AppError::io("write installed voice asset", error))?;
        copied = copied.saturating_add(read as u64);
    }
    Ok(copied)
}

fn verify_flat_asset_directory(path: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AppError::io("inspect voice asset directory", error))?;
    verify_directory_metadata(&metadata, "Voice asset directory")?;
    for entry in fs::read_dir(path).map_err(|error| AppError::io("list voice asset", error))? {
        let entry = entry.map_err(|error| AppError::io("read voice asset entry", error))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| AppError::io("inspect voice asset entry", error))?;
        verify_regular_metadata(&metadata, "Voice asset entry")?;
    }
    Ok(())
}

pub(super) fn remove_flat_asset_directory(path: &Path) -> AppResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::io("inspect voice asset directory", error)),
    };
    verify_directory_metadata(&metadata, "Voice asset directory")?;
    for entry in fs::read_dir(path).map_err(|error| AppError::io("list voice asset", error))? {
        let entry = entry.map_err(|error| AppError::io("read voice asset entry", error))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| AppError::io("inspect voice asset entry", error))?;
        verify_regular_metadata(&metadata, "Voice asset entry")?;
        fs::remove_file(entry.path())
            .map_err(|error| AppError::io("remove voice asset entry", error))?;
    }
    fs::remove_dir(path).map_err(|error| AppError::io("remove empty voice asset directory", error))
}

pub(super) fn remove_regular_file_if_exists(path: &Path, label: &str) -> AppResult<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::io("inspect voice file for removal", error)),
    };
    verify_regular_metadata(&metadata, label)?;
    fs::remove_file(path).map_err(|error| AppError::io("remove voice file", error))
}

pub(super) fn verify_regular_metadata(metadata: &fs::Metadata, label: &str) -> AppResult<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::new(
            "voice_path_identity_invalid",
            format!("{label} is not a regular file"),
        )
        .outcome_unknown(true));
    }
    reject_windows_reparse(metadata, label)
}

fn verify_directory_metadata(metadata: &fs::Metadata, label: &str) -> AppResult<()> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::new(
            "voice_path_identity_invalid",
            format!("{label} is not a regular directory"),
        )
        .outcome_unknown(true));
    }
    reject_windows_reparse(metadata, label)
}

fn reject_windows_reparse(metadata: &fs::Metadata, label: &str) -> AppResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "voice_path_identity_invalid",
                format!("{label} is a reparse point"),
            )
            .outcome_unknown(true));
        }
    }
    #[cfg(not(windows))]
    let _ = (metadata, label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_MODEL_ID: &str = "whisper.cpp-model-base-multilingual";
    const TEST_OPERATION_REF: &str = "77777777-7777-4777-8777-777777777777";

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "orquesta-voice-install-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&root).expect("create isolated voice test root");
            Self(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let temp = std::env::temp_dir();
            let is_owned_test_root = self.0.parent() == Some(temp.as_path())
                && self
                    .0
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("orquesta-voice-install-test-"));
            if is_owned_test_root {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn materialize_valid_install(asset: &DesktopAsset, root: &Path) -> InstallReceipt {
        fs::create_dir(root).expect("create install directory");
        for file_name in expected_install_files(asset).expect("expected files") {
            fs::write(
                root.join(&file_name),
                format!("test voice asset content for {file_name}").as_bytes(),
            )
            .expect("write installed file");
        }
        let receipt =
            build_install_receipt(asset, TEST_OPERATION_REF, root).expect("build durable receipt");
        atomic_write_json(&root.join(INSTALL_RECEIPT_FILE), &receipt)
            .expect("persist durable receipt");
        receipt
    }

    #[test]
    fn durable_receipt_detects_installed_content_tampering() {
        let catalog = AssetCatalog::load().expect("catalog");
        let asset = catalog.asset(TEST_MODEL_ID).expect("model asset");
        let test_root = TestRoot::new();
        let install_root = test_root.path().join("installed-model");
        let expected = materialize_valid_install(asset, &install_root);

        assert_eq!(
            verify_install_receipt(asset, &install_root).expect("valid receipt"),
            expected
        );
        fs::write(install_root.join(&asset.file_name), b"tampered model bytes")
            .expect("tamper model");
        assert_eq!(
            verify_install_receipt(asset, &install_root)
                .expect_err("tampering must fail closed")
                .code,
            "voice_install_content_mismatch"
        );
    }

    #[test]
    fn deleting_state_resumes_without_requiring_a_valid_receipt() {
        let catalog = AssetCatalog::load().expect("catalog");
        let asset = catalog.asset(TEST_MODEL_ID).expect("model asset");
        let test_root = TestRoot::new();
        let transfers = test_root.path().join("transfers");
        let installed = test_root.path().join("installed");
        fs::create_dir(&transfers).expect("transfers root");
        fs::create_dir(&installed).expect("installed root");
        let final_root = installed.join(&asset.asset_id);
        fs::create_dir(&final_root).expect("partial final install");
        fs::write(final_root.join("partial.bin"), b"partial install").expect("partial final file");
        let part = transfer_part_path(&transfers, &asset.asset_id).expect("partial path");
        fs::write(&part, b"partial transfer").expect("partial transfer");

        let mut document = VoiceStateDocument::from_catalog(&catalog);
        let record = document
            .assets
            .get_mut(&asset.asset_id)
            .expect("asset record");
        record.phase = VoiceAssetPhase::Deleting;
        record.operation_ref = Some(TEST_OPERATION_REF.into());
        record.installed_source_sha256 = Some(asset.sha256.clone());
        record.installed_at_ms = Some(1);

        reconcile_document(&catalog, &transfers, &installed, &mut document)
            .expect("resume durable deletion");

        let record = document.assets.get(&asset.asset_id).expect("asset record");
        assert_eq!(record.phase, VoiceAssetPhase::Absent);
        assert!(record.operation_ref.is_none());
        assert!(record.installed_source_sha256.is_none());
        assert!(record.installed_at_ms.is_none());
        assert!(!final_root.exists());
        assert!(!part.exists());
    }

    #[test]
    fn downloading_state_reconciles_from_the_durable_partial_file() {
        let catalog = AssetCatalog::load().expect("catalog");
        let asset = catalog.asset(TEST_MODEL_ID).expect("model asset");

        for (partial_bytes, expected_phase, expected_downloaded_bytes) in [
            (None, VoiceAssetPhase::Absent, 0),
            (
                Some(b"durable partial transfer".as_slice()),
                VoiceAssetPhase::Paused,
                b"durable partial transfer".len() as u64,
            ),
        ] {
            let test_root = TestRoot::new();
            let transfers = test_root.path().join("transfers");
            let installed = test_root.path().join("installed");
            fs::create_dir(&transfers).expect("transfers root");
            fs::create_dir(&installed).expect("installed root");
            let part = transfer_part_path(&transfers, &asset.asset_id).expect("partial path");
            if let Some(bytes) = partial_bytes {
                fs::write(&part, bytes).expect("persist partial transfer");
            }

            let mut document = VoiceStateDocument::from_catalog(&catalog);
            let record = document
                .assets
                .get_mut(&asset.asset_id)
                .expect("asset record");
            record.phase = VoiceAssetPhase::Downloading;
            record.downloaded_bytes = asset.size_bytes;
            record.operation_ref = Some(TEST_OPERATION_REF.into());
            record.installed_source_sha256 = Some(asset.sha256.clone());
            record.installed_at_ms = Some(1);
            record.last_error_code = Some("stale_error".into());

            reconcile_document(&catalog, &transfers, &installed, &mut document)
                .expect("reconcile interrupted download");

            let record = document.assets.get(&asset.asset_id).expect("asset record");
            assert_eq!(record.phase, expected_phase);
            assert_eq!(record.downloaded_bytes, expected_downloaded_bytes);
            assert!(record.operation_ref.is_none());
            assert!(record.installed_source_sha256.is_none());
            assert!(record.installed_at_ms.is_none());
            assert!(record.last_error_code.is_none());
        }
    }

    #[test]
    fn retired_install_is_restored_or_removed_deterministically() {
        let catalog = AssetCatalog::load().expect("catalog");
        let asset = catalog.asset(TEST_MODEL_ID).expect("model asset");
        let test_root = TestRoot::new();
        let installed = test_root.path().join("installed");
        fs::create_dir(&installed).expect("installed root");
        let final_root = installed.join(&asset.asset_id);
        let retired = installed.join(format!(".retired-{}", asset.asset_id));

        materialize_valid_install(asset, &retired);
        recover_install_directories(&catalog, &installed).expect("restore retired install");
        assert!(final_root.exists());
        assert!(!retired.exists());
        verify_install_receipt(asset, &final_root).expect("restored receipt");

        materialize_valid_install(asset, &retired);
        recover_install_directories(&catalog, &installed)
            .expect("remove redundant retired install");
        assert!(final_root.exists());
        assert!(!retired.exists());
    }

    #[test]
    fn unknown_retired_install_fails_closed() {
        let catalog = AssetCatalog::load().expect("catalog");
        let test_root = TestRoot::new();
        let installed = test_root.path().join("installed");
        fs::create_dir(&installed).expect("installed root");
        fs::create_dir(installed.join(".retired-unknown-asset")).expect("unknown retired install");

        assert_eq!(
            recover_install_directories(&catalog, &installed)
                .expect_err("unknown retired install must fail closed")
                .code,
            "voice_install_recovery_uncertain"
        );
    }

    #[test]
    fn install_copy_honors_cancellation_before_writing() {
        let (_cancel, cancelled) = watch::channel(true);
        let mut input = std::io::Cursor::new(vec![7_u8; 1024]);
        let mut output = Vec::new();
        let error = copy_reader_cancel_safe(&mut input, &mut output, &cancelled)
            .expect_err("cancelled copy must not begin");
        assert_eq!(error.code, "voice_operation_cancelled");
        assert!(output.is_empty());
    }

    #[test]
    #[ignore = "requires ORQUESTA_P2_008_VOICE_BINARY_ARCHIVE"]
    fn pinned_binary_archive_live_canary_uses_the_exact_catalog_allowlist() {
        let archive = PathBuf::from(
            std::env::var("ORQUESTA_P2_008_VOICE_BINARY_ARCHIVE")
                .expect("set the reviewed P2-007 binary archive path"),
        );
        let catalog = AssetCatalog::load().expect("catalog");
        let asset = catalog
            .asset("whisper.cpp-windows-x64-b4938-spike")
            .expect("binary asset");
        verify_regular_file_exact(&archive, asset.size_bytes, &asset.sha256)
            .expect("pinned binary archive identity");
        let test_root = TestRoot::new();
        let extracted = test_root.path().join("extracted");
        fs::create_dir(&extracted).expect("extraction root");
        let (_cancel, cancelled) = watch::channel(false);

        extract_allowlisted_binary(asset, &archive, &extracted, &cancelled)
            .expect("allowlisted extraction");

        let expected: HashSet<String> = asset
            .archive_allowlist()
            .expect("archive allowlist")
            .iter()
            .map(|entry| {
                entry
                    .strip_prefix("Release/")
                    .expect("validated catalog prefix")
                    .to_owned()
            })
            .collect();
        let actual: HashSet<String> = fs::read_dir(&extracted)
            .expect("extracted directory")
            .map(|entry| {
                entry
                    .expect("extracted entry")
                    .file_name()
                    .into_string()
                    .expect("Unicode extracted name")
            })
            .collect();
        assert_eq!(actual, expected);
    }
}
