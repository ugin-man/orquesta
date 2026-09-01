use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::error::{AppError, AppResult};
use crate::process_containment::{ContainedProcessSpec, ContainedStdinMode};
use crate::storage::private_directory;

use super::install::verify_regular_metadata;
use super::{direct_child, open_regular_read_nofollow};

pub(super) const PCM_SAMPLE_RATE_HZ: u32 = 16_000;
pub(super) const PCM_CHANNEL_COUNT: u16 = 1;
pub(super) const PCM_BITS_PER_SAMPLE: u16 = 16;
pub(super) const MIN_PCM_SAMPLES: u32 = 1_600;
pub(super) const MAX_PCM_SAMPLES: u32 = PCM_SAMPLE_RATE_HZ * 120;
pub(super) const TRANSCRIPT_MAX_BYTES: usize =
    crate::protocol::GENERATED_VOICE_TRANSCRIPT_MAX_UTF8_BYTES;
const WHISPER_JSON_MAX_BYTES: u64 = 4 * 1024 * 1024;
const DIAGNOSTIC_DRAIN_MAX_BYTES: usize = 64 * 1024;
const WAV_FILE_NAME: &str = "input.wav";
const WHISPER_JSON_FILE_NAME: &str = "input.wav.json";

#[derive(Debug, Clone)]
pub(super) struct OperationPaths {
    pub(super) root: PathBuf,
    pub(super) wav: PathBuf,
    pub(super) json: PathBuf,
}

pub(super) fn pcm_sha256(pcm: &[u8]) -> String {
    format!("{:x}", Sha256::digest(pcm))
}

pub(super) fn validate_pcm(pcm: &[u8], sample_count: u32) -> AppResult<u64> {
    if !(MIN_PCM_SAMPLES..=MAX_PCM_SAMPLES).contains(&sample_count)
        || pcm.len() != sample_count as usize * (PCM_BITS_PER_SAMPLE as usize / 8)
    {
        return Err(AppError::new(
            "voice_pcm_invalid",
            "Voice PCM must be bounded 16 kHz mono signed 16-bit little-endian audio",
        ));
    }
    Ok((sample_count as u64 * 1_000) / PCM_SAMPLE_RATE_HZ as u64)
}

pub(super) fn operation_paths(root: &Path, operation_ref: &str) -> AppResult<OperationPaths> {
    let operation_root = direct_child(root, operation_ref, "Voice operation root")?;
    Ok(OperationPaths {
        wav: direct_child(&operation_root, WAV_FILE_NAME, "Voice WAV")?,
        json: direct_child(&operation_root, WHISPER_JSON_FILE_NAME, "Whisper JSON")?,
        root: operation_root,
    })
}

pub(super) fn stage_pcm_wav(
    operations_root: &Path,
    operation_ref: &str,
    pcm: &[u8],
    sample_count: u32,
) -> AppResult<OperationPaths> {
    validate_pcm(pcm, sample_count)?;
    let paths = operation_paths(operations_root, operation_ref)?;
    if paths.root.exists() {
        return Err(AppError::new(
            "voice_operation_conflict",
            "Voice operation staging directory already exists",
        )
        .outcome_unknown(true));
    }
    private_directory(&paths.root)?;
    let result = write_pcm_wav(&paths.wav, pcm);
    if let Err(error) = result {
        let _ = remove_operation_directory(&paths);
        return Err(error);
    }
    Ok(paths)
}

fn write_pcm_wav(path: &Path, pcm: &[u8]) -> AppResult<()> {
    let data_size = u32::try_from(pcm.len())
        .map_err(|_| AppError::new("voice_pcm_invalid", "Voice PCM is oversized"))?;
    let riff_size = data_size
        .checked_add(36)
        .ok_or_else(|| AppError::new("voice_pcm_invalid", "Voice WAV is oversized"))?;
    let byte_rate = PCM_SAMPLE_RATE_HZ * PCM_CHANNEL_COUNT as u32 * PCM_BITS_PER_SAMPLE as u32 / 8;
    let block_align = PCM_CHANNEL_COUNT * PCM_BITS_PER_SAMPLE / 8;
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
    let mut file = options
        .open(path)
        .map_err(|error| AppError::io("create voice WAV", error))?;
    verify_regular_metadata(
        &file
            .metadata()
            .map_err(|error| AppError::io("inspect voice WAV", error))?,
        "Voice WAV",
    )?;
    file.write_all(b"RIFF")
        .and_then(|_| file.write_all(&riff_size.to_le_bytes()))
        .and_then(|_| file.write_all(b"WAVEfmt "))
        .and_then(|_| file.write_all(&16_u32.to_le_bytes()))
        .and_then(|_| file.write_all(&1_u16.to_le_bytes()))
        .and_then(|_| file.write_all(&PCM_CHANNEL_COUNT.to_le_bytes()))
        .and_then(|_| file.write_all(&PCM_SAMPLE_RATE_HZ.to_le_bytes()))
        .and_then(|_| file.write_all(&byte_rate.to_le_bytes()))
        .and_then(|_| file.write_all(&block_align.to_le_bytes()))
        .and_then(|_| file.write_all(&PCM_BITS_PER_SAMPLE.to_le_bytes()))
        .and_then(|_| file.write_all(b"data"))
        .and_then(|_| file.write_all(&data_size.to_le_bytes()))
        .and_then(|_| file.write_all(pcm))
        .map_err(|error| AppError::io("write voice WAV", error))?;
    file.sync_all()
        .map_err(|error| AppError::io("sync voice WAV", error))
}

pub(super) fn whisper_process_spec(
    executable: &Path,
    model: &Path,
    binary_root: &Path,
    wav: &Path,
) -> ContainedProcessSpec {
    let mut spec = ContainedProcessSpec::new(executable);
    spec.arg("-m")
        .arg(model.as_os_str())
        .arg("-l")
        .arg("ja")
        .arg("-t")
        .arg("8")
        .arg("-ng")
        .arg("-oj")
        .arg(wav.as_os_str())
        .current_dir(binary_root)
        .stdin_mode(ContainedStdinMode::Null);
    spec
}

pub(super) fn read_transcript(path: &Path) -> AppResult<String> {
    let file = open_regular_read_nofollow(path, "Whisper JSON")?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect Whisper JSON", error))?;
    verify_regular_metadata(&metadata, "Whisper JSON")?;
    if metadata.len() == 0 || metadata.len() > WHISPER_JSON_MAX_BYTES {
        return Err(AppError::new(
            "voice_transcript_invalid",
            "Whisper JSON is empty or oversized",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(WHISPER_JSON_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::io("read Whisper JSON", error))?;
    if bytes.len() as u64 > WHISPER_JSON_MAX_BYTES {
        return Err(AppError::new(
            "voice_transcript_invalid",
            "Whisper JSON exceeded its bounded size",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new("voice_transcript_invalid", "Whisper JSON is malformed"))?;
    if value
        .get("result")
        .and_then(|result| result.get("language"))
        .and_then(Value::as_str)
        != Some("ja")
    {
        return Err(AppError::new(
            "voice_transcript_invalid",
            "Whisper returned an unexpected language",
        ));
    }
    let segments = value
        .get("transcription")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::new("voice_transcript_invalid", "Whisper transcript is missing")
        })?;
    let mut transcript = String::new();
    for segment in segments {
        let text = segment.get("text").and_then(Value::as_str).ok_or_else(|| {
            AppError::new(
                "voice_transcript_invalid",
                "Whisper segment text is invalid",
            )
        })?;
        if text
            .chars()
            .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
        {
            return Err(AppError::new(
                "voice_transcript_invalid",
                "Whisper transcript contains unsupported control characters",
            ));
        }
        transcript.push_str(text);
        if transcript.len() > TRANSCRIPT_MAX_BYTES {
            return Err(AppError::new(
                "voice_transcript_invalid",
                "Whisper transcript exceeds the Composer limit",
            ));
        }
    }
    let transcript = transcript.trim().to_owned();
    if transcript.is_empty() {
        return Err(AppError::new(
            "voice_transcript_empty",
            "Whisper returned no editable transcript",
        ));
    }
    Ok(transcript)
}

pub(super) async fn drain_bounded<R: AsyncRead + Unpin>(mut reader: R) -> AppResult<()> {
    let mut retained = 0_usize;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::io("drain contained voice process output", error))?;
        if read == 0 {
            return Ok(());
        }
        retained = retained
            .saturating_add(read)
            .min(DIAGNOSTIC_DRAIN_MAX_BYTES);
        // Output is intentionally discarded. stdout duplicates transcript and
        // stderr contains Native filesystem paths and runtime diagnostics.
        std::hint::black_box(retained);
    }
}

pub(super) fn remove_operation_directory(paths: &OperationPaths) -> AppResult<()> {
    let metadata = match fs::symlink_metadata(&paths.root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::io("inspect voice operation directory", error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::new(
            "voice_path_identity_invalid",
            "Voice operation root is not a regular directory",
        )
        .outcome_unknown(true));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "voice_path_identity_invalid",
                "Voice operation root is a reparse point",
            )
            .outcome_unknown(true));
        }
    }
    for entry in fs::read_dir(&paths.root)
        .map_err(|error| AppError::io("list voice operation directory", error))?
    {
        let entry = entry.map_err(|error| AppError::io("read voice operation entry", error))?;
        let name = entry.file_name();
        if name != WAV_FILE_NAME && name != WHISPER_JSON_FILE_NAME {
            return Err(AppError::new(
                "voice_cleanup_uncertain",
                "Voice operation directory contains an unexpected entry",
            )
            .outcome_unknown(true));
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| AppError::io("inspect voice operation entry", error))?;
        verify_regular_metadata(&metadata, "Voice operation entry")?;
        fs::remove_file(entry.path())
            .map_err(|error| AppError::io("remove voice operation entry", error))?;
    }
    fs::remove_dir(&paths.root)
        .map_err(|error| AppError::io("remove voice operation directory", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "orquesta-voice-transcription-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&path).expect("test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path())
                && self
                    .0
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with("orquesta-voice-transcription-test-"))
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn writes_exact_16khz_mono_pcm16_wav_and_cleans_it() {
        let root = TestRoot::new();
        let operation_ref = "88888888-8888-4888-8888-888888888888";
        let pcm = vec![0_u8; MIN_PCM_SAMPLES as usize * 2];
        let paths = stage_pcm_wav(&root.0, operation_ref, &pcm, MIN_PCM_SAMPLES)
            .expect("stage bounded PCM");
        let bytes = fs::read(&paths.wav).expect("WAV");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            16_000
        );
        assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
            pcm.len() as u32
        );
        assert_eq!(&bytes[44..], pcm);
        remove_operation_directory(&paths).expect("cleanup");
        assert!(!paths.root.exists());
    }

    #[test]
    fn rejects_mismatched_or_unbounded_pcm() {
        assert_eq!(
            validate_pcm(&[0; 8], 4).expect_err("too short").code,
            "voice_pcm_invalid"
        );
        assert_eq!(
            validate_pcm(&vec![0; MIN_PCM_SAMPLES as usize * 2 - 1], MIN_PCM_SAMPLES)
                .expect_err("odd/mismatched bytes")
                .code,
            "voice_pcm_invalid"
        );
    }

    #[test]
    fn extracts_only_bounded_japanese_transcript_text() {
        let root = TestRoot::new();
        let operation_ref = "88888888-8888-4888-8888-888888888888";
        let pcm = vec![0_u8; MIN_PCM_SAMPLES as usize * 2];
        let paths = stage_pcm_wav(&root.0, operation_ref, &pcm, MIN_PCM_SAMPLES).unwrap();
        fs::write(
            &paths.json,
            r#"{"result":{"language":"ja","model":"C:\\private\\model.bin"},"transcription":[{"text":" テスト"},{"text":"音声です。 "}]}"#.as_bytes(),
        )
        .unwrap();
        assert_eq!(read_transcript(&paths.json).unwrap(), "テスト音声です。");
        remove_operation_directory(&paths).unwrap();
    }
}
