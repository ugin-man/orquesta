use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use crate::error::{AppError, AppResult};

const LAUNCHER_FLAG: &str = "--orquesta-contained-launcher-v1";
const LAUNCHER_SPEC_ENV: &str = "ORQUESTA_CONTAINED_PROCESS_SPEC_V1";
const LAUNCHER_GATE_PREFIX: &[u8] = b"ORQUESTA-CONTAINED-GATE-V1\0";
const LAUNCHER_SPEC_MAX_BYTES: usize = 16 * 1024;
const LAUNCHER_ARG_MAX_BYTES: usize = 8 * 1024;
const LAUNCHER_ARG_MAX_COUNT: usize = 64;
#[cfg(all(windows, debug_assertions))]
const CANARY_FLAG: &str = "--orquesta-containment-canary-v1";
#[cfg(all(windows, debug_assertions))]
const CANARY_QUERY_FLAG: &str = "--orquesta-containment-canary-query-v1";

#[cfg(all(test, windows))]
static TEST_WINDOWS_LAUNCHER_EXECUTABLE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(windows)]
fn windows_background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn windows_background_std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    use std::os::windows::process::CommandExt;

    let mut command = std::process::Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(all(test, windows))]
pub(crate) fn set_test_windows_launcher_once(executable: PathBuf) -> AppResult<PathBuf> {
    if !executable.is_absolute()
        || executable.file_name() != Some(OsStr::new("orquesta-desktop-next.exe"))
    {
        return Err(AppError::new(
            "process_test_launcher_invalid",
            "Test contained launcher must be the absolute Desktop executable",
        ));
    }
    let metadata = std::fs::symlink_metadata(&executable)
        .map_err(|error| AppError::io("inspect test contained launcher", error))?;
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(AppError::new(
            "process_test_launcher_invalid",
            "Test contained launcher is not a regular non-reparse Desktop executable",
        ));
    }
    let canonical = std::fs::canonicalize(&executable)
        .map_err(|error| AppError::io("canonicalize test contained launcher", error))?;
    if canonical.file_name() != Some(OsStr::new("orquesta-desktop-next.exe")) {
        return Err(AppError::new(
            "process_test_launcher_invalid",
            "Canonical test contained launcher has an unexpected filename",
        ));
    }
    TEST_WINDOWS_LAUNCHER_EXECUTABLE
        .set(canonical.clone())
        .map_err(|_| {
            AppError::new(
                "process_test_launcher_already_set",
                "Test contained launcher is immutable once selected",
            )
        })?;
    Ok(canonical)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContainedStdinMode {
    ProtocolPipe,
    Null,
}

/// Native-only process description. It is deliberately absent from every
/// Renderer bridge: the owning Native subsystem validates its own executable,
/// model, or asset path and hands this transport layer the resulting command.
pub(crate) struct ContainedProcessSpec {
    program: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, Option<OsString>)>,
    current_dir: Option<PathBuf>,
    stdin_mode: ContainedStdinMode,
}

impl ContainedProcessSpec {
    pub(crate) fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
            current_dir: None,
            stdin_mode: ContainedStdinMode::Null,
        }
    }

    pub(crate) fn arg(&mut self, value: impl Into<OsString>) -> &mut Self {
        self.args.push(value.into());
        self
    }

    pub(crate) fn env(
        &mut self,
        key: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> &mut Self {
        self.env.push((key.into(), Some(value.into())));
        self
    }

    #[allow(dead_code)]
    pub(crate) fn env_remove(&mut self, key: impl Into<OsString>) -> &mut Self {
        self.env.push((key.into(), None));
        self
    }

    #[allow(dead_code)]
    pub(crate) fn current_dir(&mut self, value: impl Into<PathBuf>) -> &mut Self {
        self.current_dir = Some(value.into());
        self
    }

    pub(crate) fn stdin_mode(&mut self, value: ContainedStdinMode) -> &mut Self {
        self.stdin_mode = value;
        self
    }
}

pub(crate) struct SpawnedContainedProcess {
    pub(crate) child: Child,
    pub(crate) stdin: Option<ChildStdin>,
    pub(crate) containment: ProcessContainment,
}

pub(crate) async fn spawn_contained(
    spec: ContainedProcessSpec,
    namespace: &str,
    owner_id: &str,
) -> AppResult<SpawnedContainedProcess> {
    validate_component(namespace, "namespace")?;
    validate_component(owner_id, "ownerId")?;
    reject_reserved_environment(&spec)?;
    reject_launcher_recursion(&spec.program)?;

    #[cfg(unix)]
    {
        spawn_unix(spec).await
    }
    #[cfg(windows)]
    {
        let wire = LauncherProcessSpec::try_from(&spec)?;
        spawn_windows(spec, wire, namespace, owner_id).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (spec, namespace, owner_id);
        Err(AppError::new(
            "process_containment_unsupported",
            "Process containment is unsupported on this platform",
        ))
    }
}

/// This branch runs before Tauri, plugins, storage, or the Desktop instance
/// lock. `None` means a normal Desktop invocation. A malformed private launch
/// fails closed instead of falling through into a second Desktop instance.
pub(crate) fn run_contained_launcher_if_requested() -> Option<i32> {
    let token = match parse_launcher_invocation(std::env::args_os().skip(1)) {
        LauncherInvocation::Desktop => return None,
        LauncherInvocation::Invalid => return Some(126),
        LauncherInvocation::Contained { token } => token,
    };

    #[cfg(windows)]
    {
        return Some(run_windows_launcher(&token).unwrap_or(126));
    }
    #[cfg(not(windows))]
    {
        let _ = token;
        Some(126)
    }
}

#[cfg(all(windows, debug_assertions))]
pub(crate) fn run_containment_canary_if_requested() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    let Some(flag) = args.next() else {
        return None;
    };
    if flag == OsStr::new(CANARY_QUERY_FLAG) {
        let Some(owner_id) = args.next().and_then(|value| value.into_string().ok()) else {
            return Some(126);
        };
        if args.next().is_some() || validate_component(&owner_id, "ownerId").is_err() {
            return Some(126);
        }
        let containment_id = format!("Local\\Orquesta.Next.Process.containment-canary.{owner_id}");
        return Some(
            if containment_definitively_gone_after_instance_lock(
                "windows_named_job_v1",
                &containment_id,
                "containment-canary",
                &owner_id,
                0,
            ) {
                0
            } else {
                2
            },
        );
    }
    if flag != OsStr::new(CANARY_FLAG) {
        return None;
    }
    let Some(owner_id) = args.next().and_then(|value| value.into_string().ok()) else {
        return Some(126);
    };
    let Some(root) = args.next().map(PathBuf::from) else {
        return Some(126);
    };
    if args.next().is_some()
        || validate_component(&owner_id, "ownerId").is_err()
        || validate_canary_root(&root).is_err()
    {
        return Some(126);
    }
    std::env::set_var("ORQUESTA_CONTAINMENT_CANARY_ROOT", &root);
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return Some(125),
    };
    Some(
        if runtime
            .block_on(run_containment_canary(&owner_id, &root))
            .is_ok()
        {
            0
        } else {
            125
        },
    )
}

#[cfg(all(windows, debug_assertions))]
fn validate_canary_root(root: &Path) -> AppResult<()> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| AppError::io("canonicalize containment canary root", error))?;
    let temp = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|error| AppError::io("canonicalize system temp root", error))?;
    let leaf = root.file_name().and_then(OsStr::to_str).unwrap_or_default();
    if root.parent() != Some(temp.as_path()) || !leaf.starts_with("orquesta-containment-canary-") {
        return Err(AppError::new(
            "containment_canary_root_invalid",
            "Containment canary root must be a direct prefixed child of system temp",
        ));
    }
    Ok(())
}

#[cfg(all(windows, debug_assertions))]
async fn run_containment_canary(owner_id: &str, root: &Path) -> AppResult<()> {
    let missing_target = std::env::var("ORQUESTA_CONTAINMENT_CANARY_TARGET")
        .ok()
        .as_deref()
        == Some("missing");
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "$root=$env:ORQUESTA_CONTAINMENT_CANARY_ROOT;",
        "[IO.File]::WriteAllText((Join-Path $root 'target.started'),$PID.ToString());",
        "$child=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','ping -n 120 127.0.0.1 >nul') -WindowStyle Hidden -PassThru;",
        "[IO.File]::WriteAllText((Join-Path $root 'grandchild.pid'),$child.Id.ToString());",
        "Start-Sleep -Seconds 120"
    );
    let mut spec = if missing_target {
        ContainedProcessSpec::new(root.join("missing-contained-target.exe"))
    } else {
        let mut spec = ContainedProcessSpec::new("powershell.exe");
        spec.arg("-NoLogo")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-WindowStyle")
            .arg("Hidden")
            .arg("-Command")
            .arg(script);
        spec
    };
    spec.env("ORQUESTA_CONTAINMENT_CANARY_ROOT", root.as_os_str())
        .stdin_mode(ContainedStdinMode::Null);
    let mut process = spawn_contained(spec, "containment-canary", owner_id).await?;
    if let Some(stdout) = process.child.stdout.take() {
        tokio::spawn(async move {
            let mut stdout = stdout;
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
        });
    }
    if let Some(stderr) = process.child.stderr.take() {
        tokio::spawn(async move {
            let mut stderr = stderr;
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
    if missing_target {
        let status = tokio::time::timeout(Duration::from_secs(5), process.child.wait())
            .await
            .map_err(|_| {
                AppError::new(
                    "containment_canary_target_failure_timeout",
                    "Launcher did not report the missing target before the deadline",
                )
            })?
            .map_err(|error| AppError::io("wait missing contained target", error))?;
        let active_after = process.containment.active_processes_for_canary()?;
        if status.success() || active_after != 0 {
            return Err(AppError::new(
                "containment_canary_target_failure_invalid",
                "Missing target did not fail nonzero with an empty Job",
            ));
        }
        std::fs::write(
            root.join("result.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "targetSpawnFailed": true,
                "launcherExitCode": status.code(),
                "activeAfterFailure": active_after,
                "terminationConfirmed": true
            }))
            .map_err(|error| AppError::new("containment_canary_write_failed", error.to_string()))?,
        )
        .map_err(|error| AppError::io("write containment canary result", error))?;
        return Ok(());
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        if root.join("target.started").is_file() && root.join("grandchild.pid").is_file() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !root.join("target.started").is_file() || !root.join("grandchild.pid").is_file() {
        let child = Arc::new(Mutex::new(process.child));
        let _ = process.containment.terminate_and_confirm(&child).await;
        return Err(AppError::new(
            "containment_canary_target_missing",
            "Canary target or grandchild did not start before the deadline",
        ));
    }
    let active_before = process.containment.active_processes_for_canary()?;
    if active_before < 3 {
        let child = Arc::new(Mutex::new(process.child));
        let _ = process.containment.terminate_and_confirm(&child).await;
        return Err(AppError::new(
            "containment_canary_descendant_escaped",
            "Canary launcher, target, and grandchild were not all present in the shared Job",
        ));
    }
    let child = Arc::new(Mutex::new(process.child));
    process.containment.terminate_and_confirm(&child).await?;
    let _ = child.lock().await.wait().await;
    std::fs::write(
        root.join("result.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "activeBeforeTermination": active_before,
            "terminationConfirmed": true
        }))
        .map_err(|error| AppError::new("containment_canary_write_failed", error.to_string()))?,
    )
    .map_err(|error| AppError::io("write containment canary result", error))?;
    Ok(())
}

enum LauncherInvocation {
    Desktop,
    Invalid,
    Contained { token: String },
}

fn parse_launcher_invocation(mut args: impl Iterator<Item = OsString>) -> LauncherInvocation {
    let Some(flag) = args.next() else {
        return LauncherInvocation::Desktop;
    };
    if flag != OsStr::new(LAUNCHER_FLAG) {
        return LauncherInvocation::Desktop;
    }
    let Some(token) = args.next().and_then(|value| value.into_string().ok()) else {
        return LauncherInvocation::Invalid;
    };
    if args.next().is_some() || canonical_gate_token(&token).as_deref() != Some(token.as_str()) {
        return LauncherInvocation::Invalid;
    }
    LauncherInvocation::Contained { token }
}

fn canonical_gate_token(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|token| token.hyphenated().to_string())
}

fn gate_frame(token: &str) -> Vec<u8> {
    let mut frame = Vec::with_capacity(LAUNCHER_GATE_PREFIX.len() + token.len());
    frame.extend_from_slice(LAUNCHER_GATE_PREFIX);
    frame.extend_from_slice(token.as_bytes());
    frame
}

fn validate_component(value: &str, field: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppError::new(
            "process_containment_identity_invalid",
            format!("{field} is not a bounded process containment identifier"),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LauncherProcessSpec {
    schema_version: u32,
    program: String,
    args: Vec<String>,
    stdin_mode: ContainedStdinMode,
}

impl TryFrom<&ContainedProcessSpec> for LauncherProcessSpec {
    type Error = AppError;

    fn try_from(value: &ContainedProcessSpec) -> Result<Self, Self::Error> {
        if value.args.len() > LAUNCHER_ARG_MAX_COUNT {
            return Err(AppError::new(
                "process_spec_invalid",
                "Contained process has too many arguments",
            ));
        }
        let program = exact_unicode(value.program.as_os_str(), "program")?;
        let args = value
            .args
            .iter()
            .map(|arg| exact_unicode(arg, "argument"))
            .collect::<AppResult<Vec<_>>>()?;
        if program.len() > LAUNCHER_ARG_MAX_BYTES
            || args.iter().any(|arg| arg.len() > LAUNCHER_ARG_MAX_BYTES)
        {
            return Err(AppError::new(
                "process_spec_invalid",
                "Contained process path or argument exceeds the bounded launcher contract",
            ));
        }
        let wire = Self {
            schema_version: 1,
            program,
            args,
            stdin_mode: value.stdin_mode,
        };
        let encoded = serde_json::to_vec(&wire)
            .map_err(|error| AppError::new("process_spec_invalid", error.to_string()))?;
        if encoded.len() > LAUNCHER_SPEC_MAX_BYTES {
            return Err(AppError::new(
                "process_spec_invalid",
                "Contained process specification exceeds the bounded launcher contract",
            ));
        }
        Ok(wire)
    }
}

fn exact_unicode(value: &OsStr, field: &str) -> AppResult<String> {
    value.to_str().map(str::to_owned).ok_or_else(|| {
        AppError::new(
            "process_spec_invalid",
            format!("Contained process {field} is not exact Unicode"),
        )
    })
}

fn reject_reserved_environment(spec: &ContainedProcessSpec) -> AppResult<()> {
    for (key, _) in &spec.env {
        let key = exact_unicode(key, "environment key")?;
        if key
            .get(.."ORQUESTA_CONTAINED_".len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("ORQUESTA_CONTAINED_"))
        {
            return Err(AppError::new(
                "process_spec_invalid",
                "Contained process cannot set or remove launcher-reserved environment keys",
            ));
        }
    }
    Ok(())
}

fn reject_launcher_recursion(program: &Path) -> AppResult<()> {
    let Ok(current_exe) = std::env::current_exe() else {
        return Ok(());
    };
    let current = std::fs::canonicalize(current_exe).ok();
    let proposed = std::fs::canonicalize(program).ok();
    if current.is_some() && current == proposed {
        return Err(AppError::new(
            "process_launcher_recursion",
            "Desktop executable cannot be its own contained target",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn build_direct_command(spec: &ContainedProcessSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    for (key, value) in &spec.env {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
    if let Some(current_dir) = &spec.current_dir {
        command.current_dir(current_dir);
    }
    match spec.stdin_mode {
        ContainedStdinMode::ProtocolPipe => command.stdin(Stdio::piped()),
        ContainedStdinMode::Null => command.stdin(Stdio::null()),
    };
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

#[cfg(unix)]
async fn spawn_unix(spec: ContainedProcessSpec) -> AppResult<SpawnedContainedProcess> {
    let stdin_mode = spec.stdin_mode;
    let mut command = build_direct_command(&spec);
    unsafe {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn().map_err(|error| {
        AppError::io("spawn contained process", error)
            .with_details(serde_json::json!({ "terminationConfirmed": true }))
    })?;
    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let confirmed = stop_direct_child(&mut child).await;
            return Err(
                AppError::new("process_spawn_failed", "Contained process id is missing")
                    .outcome_unknown(!confirmed)
                    .with_details(serde_json::json!({ "terminationConfirmed": confirmed })),
            );
        }
    };
    let containment = ProcessContainment::Unix { pgid: pid as i32 };
    let stdin = child.stdin.take();
    if stdin_mode == ContainedStdinMode::ProtocolPipe && stdin.is_none() {
        // `setsid` made this child the leader of a new process group.  Once
        // that boundary exists, every rollback must use the same group-wide
        // termination primitive as normal shutdown; killing only the direct
        // child could abandon a descendant created immediately after spawn.
        let child = Arc::new(Mutex::new(child));
        let confirmed = containment.terminate_and_confirm(&child).await.is_ok();
        return Err(AppError::new(
            "process_spawn_failed",
            "Contained process stdin is unavailable",
        )
        .outcome_unknown(!confirmed)
        .with_details(serde_json::json!({ "terminationConfirmed": confirmed })));
    }
    Ok(SpawnedContainedProcess {
        child,
        stdin,
        containment,
    })
}

#[cfg(windows)]
async fn spawn_windows(
    spec: ContainedProcessSpec,
    wire: LauncherProcessSpec,
    namespace: &str,
    owner_id: &str,
) -> AppResult<SpawnedContainedProcess> {
    let encoded = serde_json::to_string(&wire)
        .map_err(|error| AppError::new("process_spec_invalid", error.to_string()))?;
    let token = uuid::Uuid::new_v4().hyphenated().to_string();
    let job = WindowsJob::create(namespace, owner_id)?;
    let containment = ProcessContainment::Windows(Arc::new(job));
    #[cfg(test)]
    let test_launcher = TEST_WINDOWS_LAUNCHER_EXECUTABLE.get().cloned();
    #[cfg(test)]
    let executable = match test_launcher {
        Some(executable) => executable,
        None => std::env::current_exe().map_err(|error| {
            AppError::io("resolve contained launcher executable", error)
                .with_details(serde_json::json!({ "terminationConfirmed": true }))
        })?,
    };
    #[cfg(not(test))]
    let executable = std::env::current_exe().map_err(|error| {
        AppError::io("resolve contained launcher executable", error)
            .with_details(serde_json::json!({ "terminationConfirmed": true }))
    })?;
    let mut command = windows_background_command(executable);
    command
        .arg(LAUNCHER_FLAG)
        .arg(&token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &spec.env {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
    if let Some(current_dir) = &spec.current_dir {
        command.current_dir(current_dir);
    }
    // Internal control metadata is written last so no caller-owned environment
    // entry can shadow the launcher contract.
    command.env(LAUNCHER_SPEC_ENV, encoded);
    let mut child = command.spawn().map_err(|error| {
        AppError::io("spawn contained process launcher", error)
            .with_details(serde_json::json!({ "terminationConfirmed": true }))
    })?;
    let stdin = child.stdin.take();
    if child.id().is_none() || stdin.is_none() {
        let confirmed = stop_unassigned_launcher(&mut child, stdin).await;
        return Err(AppError::new(
            "process_spawn_failed",
            "Contained launcher handles are unavailable",
        )
        .outcome_unknown(!confirmed)
        .with_details(serde_json::json!({ "terminationConfirmed": confirmed })));
    }
    let mut stdin = stdin.expect("checked above");
    maybe_abort_containment_canary(namespace, "before_assign", child.id());
    if let Err(error) = containment.assign_windows_child(&child) {
        let confirmed = stop_unassigned_launcher(&mut child, Some(stdin)).await;
        return Err(
            AppError::new("process_containment_unverified", error.message)
                .outcome_unknown(!confirmed)
                .with_details(serde_json::json!({ "terminationConfirmed": confirmed })),
        );
    }
    maybe_abort_containment_canary(namespace, "after_assign", child.id());
    let frame = gate_frame(&token);
    if let Err(error) = async {
        stdin.write_all(&frame).await?;
        stdin.flush().await
    }
    .await
    {
        drop(stdin);
        let child = Arc::new(Mutex::new(child));
        let confirmed = containment.terminate_and_confirm(&child).await.is_ok();
        return Err(
            AppError::io("release contained process launcher gate", error)
                .outcome_unknown(!confirmed)
                .with_details(serde_json::json!({ "terminationConfirmed": confirmed })),
        );
    }
    maybe_abort_containment_canary(namespace, "after_gate", child.id());
    let stdin = match wire.stdin_mode {
        ContainedStdinMode::ProtocolPipe => Some(stdin),
        ContainedStdinMode::Null => {
            drop(stdin);
            None
        }
    };
    Ok(SpawnedContainedProcess {
        child,
        stdin,
        containment,
    })
}

#[cfg(all(windows, debug_assertions))]
fn maybe_abort_containment_canary(namespace: &str, point: &str, pid: Option<u32>) {
    if namespace != "containment-canary"
        || std::env::var("ORQUESTA_CONTAINMENT_CANARY_CRASH_AT")
            .ok()
            .as_deref()
            != Some(point)
    {
        return;
    }
    if let Some(root) = std::env::var_os("ORQUESTA_CONTAINMENT_CANARY_ROOT").map(PathBuf::from) {
        let _ = std::fs::write(
            root.join("launcher.pid"),
            pid.unwrap_or_default().to_string(),
        );
        let _ = std::fs::write(root.join("crash.point"), point);
    }
    std::process::abort();
}

#[cfg(not(all(windows, debug_assertions)))]
fn maybe_abort_containment_canary(_namespace: &str, _point: &str, _pid: Option<u32>) {}

async fn stop_direct_child(child: &mut Child) -> bool {
    let _ = child.start_kill();
    matches!(
        tokio::time::timeout(Duration::from_secs(5), child.wait()).await,
        Ok(Ok(_))
    )
}

#[cfg(windows)]
async fn stop_unassigned_launcher(child: &mut Child, stdin: Option<ChildStdin>) -> bool {
    drop(stdin);
    if matches!(
        tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    ) {
        return true;
    }
    stop_direct_child(child).await
}

#[cfg(windows)]
fn run_windows_launcher(token: &str) -> std::io::Result<i32> {
    let encoded = std::env::var(LAUNCHER_SPEC_ENV).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "contained process specification is missing",
        )
    })?;
    if encoded.len() > LAUNCHER_SPEC_MAX_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "contained process specification is oversized",
        ));
    }
    let spec: LauncherProcessSpec = serde_json::from_str(&encoded)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    if spec.schema_version != 1
        || spec.args.len() > LAUNCHER_ARG_MAX_COUNT
        || spec.program.len() > LAUNCHER_ARG_MAX_BYTES
        || spec
            .args
            .iter()
            .any(|arg| arg.len() > LAUNCHER_ARG_MAX_BYTES)
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "contained process specification is outside its contract",
        ));
    }
    reject_launcher_recursion(Path::new(&spec.program))
        .map_err(|error| std::io::Error::other(error.message))?;

    let expected = gate_frame(token);
    let actual = read_exact_raw_stdin(expected.len())?;
    if actual != expected {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "contained launcher gate mismatch",
        ));
    }

    let mut command = windows_background_std_command(&spec.program);
    command
        .args(&spec.args)
        .env_remove(LAUNCHER_SPEC_ENV)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    match spec.stdin_mode {
        ContainedStdinMode::ProtocolPipe => command.stdin(Stdio::inherit()),
        ContainedStdinMode::Null => command.stdin(Stdio::null()),
    };
    let status = command.status()?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(windows)]
fn read_exact_raw_stdin(length: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    use std::mem::ManuallyDrop;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};

    // `Stdin` is internally buffered. Reading through it could consume the
    // first Runtime JSONL frame together with the gate. A non-owning File view
    // issues an exact unbuffered read against the inherited pipe handle.
    let stdin = std::io::stdin();
    let handle = stdin.as_raw_handle();
    let mut raw = ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(handle) });
    let mut bytes = vec![0_u8; length];
    raw.read_exact(&mut bytes)?;
    Ok(bytes)
}

#[derive(Clone)]
pub(crate) enum ProcessContainment {
    #[cfg(unix)]
    Unix { pgid: i32 },
    #[cfg(windows)]
    Windows(Arc<WindowsJob>),
}

impl ProcessContainment {
    #[cfg(windows)]
    fn assign_windows_child(&self, child: &Child) -> AppResult<()> {
        let Self::Windows(job) = self;
        job.assign(child)
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            #[cfg(unix)]
            Self::Unix { .. } => "unix_process_group",
            #[cfg(windows)]
            Self::Windows(_) => "windows_named_job_v1",
        }
    }

    pub(crate) fn id(&self) -> String {
        match self {
            #[cfg(unix)]
            Self::Unix { pgid } => pgid.to_string(),
            #[cfg(windows)]
            Self::Windows(job) => job.handle_id(),
        }
    }

    pub(crate) async fn terminate_and_confirm(&self, child: &Arc<Mutex<Child>>) -> AppResult<()> {
        #[cfg(unix)]
        {
            let Self::Unix { pgid } = self;
            unsafe {
                libc::kill(-*pgid, libc::SIGTERM);
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            while tokio::time::Instant::now() < deadline {
                if unsafe { libc::kill(-*pgid, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    let _ = child.lock().await.wait().await;
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            unsafe {
                libc::kill(-*pgid, libc::SIGKILL);
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while tokio::time::Instant::now() < deadline {
                if unsafe { libc::kill(-*pgid, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    let _ = child.lock().await.wait().await;
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            return Err(AppError::new(
                "process_group_alive",
                "Process group did not terminate before the hard deadline",
            )
            .outcome_unknown(true));
        }
        #[cfg(windows)]
        {
            let Self::Windows(job) = self;
            let _ = child;
            return job.terminate_and_wait_zero().await;
        }
        #[allow(unreachable_code)]
        Ok(())
    }

    #[cfg(all(windows, debug_assertions))]
    fn active_processes_for_canary(&self) -> AppResult<u32> {
        let Self::Windows(job) = self;
        job.active_processes()
    }
}

pub(crate) fn containment_definitively_gone_after_instance_lock(
    containment_kind: &str,
    containment_id: &str,
    namespace: &str,
    owner_id: &str,
    expected_pid: u32,
) -> bool {
    if validate_component(namespace, "namespace").is_err()
        || validate_component(owner_id, "ownerId").is_err()
    {
        return false;
    }
    #[cfg(unix)]
    {
        let _ = (namespace, owner_id);
        if containment_kind != "unix_process_group" {
            return false;
        }
        let Ok(pgid) = containment_id.parse::<i32>() else {
            return false;
        };
        if pgid <= 0 || pgid as u32 != expected_pid {
            return false;
        }
        unsafe {
            libc::kill(-pgid, 0) == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        let _ = expected_pid;
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND};
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, OpenJobObjectW, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        use windows_sys::Win32::System::SystemServices::JOB_OBJECT_QUERY;

        // Anonymous legacy Jobs cannot be reopened, so reacquiring the Desktop
        // lock alone cannot prove their process tree reached zero.
        if containment_kind == "windows_job" {
            return false;
        }
        if containment_kind != "windows_named_job_v1" {
            return false;
        }
        let expected_id = format!("Local\\Orquesta.Next.Process.{namespace}.{owner_id}");
        if containment_id != expected_id {
            return false;
        }
        let name = containment_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            let handle = OpenJobObjectW(JOB_OBJECT_QUERY, 0, name.as_ptr());
            if handle.is_null() {
                return std::io::Error::last_os_error().raw_os_error()
                    == Some(ERROR_FILE_NOT_FOUND as i32);
            }
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let queried = QueryInformationJobObject(
                handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            );
            CloseHandle(handle);
            queried != 0 && info.ActiveProcesses == 0
        }
    }
}

#[cfg(windows)]
pub(crate) struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
    name: String,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn create(namespace: &str, owner_id: &str) -> AppResult<Self> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::JobObjects::*;

        validate_component(namespace, "namespace")?;
        validate_component(owner_id, "ownerId")?;
        let name = format!("Local\\Orquesta.Next.Process.{namespace}.{owner_id}");
        let wide_name = name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), wide_name.as_ptr());
            if handle.is_null() {
                return Err(AppError::io(
                    "create process containment Job",
                    std::io::Error::last_os_error(),
                ));
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                CloseHandle(handle);
                return Err(AppError::new(
                    "process_containment_collision",
                    "Process containment identity already owns a Windows Job",
                )
                .outcome_unknown(true));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(AppError::io("configure process containment Job", error));
            }
            Ok(Self { handle, name })
        }
    }

    fn assign(&self, child: &Child) -> AppResult<()> {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let process_handle = child.raw_handle().ok_or_else(|| {
            AppError::new(
                "process_handle_unavailable",
                "Contained launcher process handle is unavailable",
            )
            .outcome_unknown(true)
        })?;
        unsafe {
            if AssignProcessToJobObject(self.handle, process_handle as _) == 0 {
                return Err(AppError::io(
                    "assign contained launcher to Job",
                    std::io::Error::last_os_error(),
                )
                .outcome_unknown(true));
            }
        }
        Ok(())
    }

    fn handle_id(&self) -> String {
        self.name.clone()
    }

    fn active_processes(&self) -> AppResult<u32> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            if QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(AppError::io(
                    "query process containment Job",
                    std::io::Error::last_os_error(),
                )
                .outcome_unknown(true));
            }
            Ok(info.ActiveProcesses)
        }
    }

    async fn terminate_and_wait_zero(&self) -> AppResult<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe {
            if TerminateJobObject(self.handle, 1) == 0 {
                return Err(AppError::io(
                    "terminate process containment Job",
                    std::io::Error::last_os_error(),
                )
                .outcome_unknown(true));
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        while tokio::time::Instant::now() < deadline {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Err(AppError::new(
            "process_containment_alive",
            "Windows Job still has active processes after the termination deadline",
        )
        .outcome_unknown(true))
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    const WINDOWS_CONSOLE_PROBE_SCRIPT: &str = concat!(
        "Add-Type -Namespace Orquesta -Name ConsoleProbe -MemberDefinition '",
        "[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();';",
        "[Console]::Out.Write([Orquesta.ConsoleProbe]::GetConsoleWindow().ToInt64())"
    );

    #[cfg(windows)]
    fn assert_console_probe_is_hidden(output: std::process::Output) {
        assert!(
            output.status.success(),
            "console probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    #[cfg(windows)]
    #[test]
    fn contained_target_process_does_not_allocate_a_windows_console() {
        let mut command = windows_background_std_command("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                WINDOWS_CONSOLE_PROBE_SCRIPT,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        assert_console_probe_is_hidden(command.output().expect("run contained target probe"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn contained_launcher_process_does_not_allocate_a_windows_console() {
        let mut command = windows_background_command("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                WINDOWS_CONSOLE_PROBE_SCRIPT,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        assert_console_probe_is_hidden(
            command
                .output()
                .await
                .expect("run contained launcher probe"),
        );
    }

    #[test]
    fn rejects_unbounded_or_ambiguous_containment_identity() {
        assert!(validate_component("runtime", "namespace").is_ok());
        assert!(validate_component("operation-123", "ownerId").is_ok());
        assert!(validate_component("../runtime", "namespace").is_err());
        assert!(validate_component("", "ownerId").is_err());
        assert!(validate_component(&"a".repeat(81), "ownerId").is_err());
    }

    #[test]
    fn private_launcher_requires_exact_invocation() {
        let token = uuid::Uuid::new_v4().hyphenated().to_string();
        assert!(matches!(
            parse_launcher_invocation(Vec::<OsString>::new().into_iter()),
            LauncherInvocation::Desktop
        ));
        assert!(matches!(
            parse_launcher_invocation(vec![LAUNCHER_FLAG.into(), token.clone().into()].into_iter()),
            LauncherInvocation::Contained { .. }
        ));
        assert!(matches!(
            parse_launcher_invocation(vec![LAUNCHER_FLAG.into(), "not-a-token".into()].into_iter()),
            LauncherInvocation::Invalid
        ));
        assert!(matches!(
            parse_launcher_invocation(
                vec![LAUNCHER_FLAG.into(), token.into(), "extra".into()].into_iter()
            ),
            LauncherInvocation::Invalid
        ));
    }

    #[test]
    fn launcher_wire_is_exact_unicode_bounded_and_versioned() {
        let mut spec = ContainedProcessSpec::new("日本語-runtime.exe");
        spec.arg("日本語-project")
            .stdin_mode(ContainedStdinMode::ProtocolPipe);
        let wire = LauncherProcessSpec::try_from(&spec).expect("valid spec");
        assert_eq!(wire.schema_version, 1);
        assert_eq!(wire.program, "日本語-runtime.exe");
        assert_eq!(wire.args, vec!["日本語-project"]);
        let encoded = serde_json::to_string(&wire).expect("encode");
        let decoded: LauncherProcessSpec = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, wire);
    }

    #[test]
    fn launcher_gate_is_versioned_and_fixed_length() {
        let first = gate_frame("00000000-0000-0000-0000-000000000001");
        let second = gate_frame("00000000-0000-0000-0000-000000000002");
        assert_eq!(first.len(), LAUNCHER_GATE_PREFIX.len() + 36);
        assert_eq!(first.len(), second.len());
        assert_ne!(first, second);
        assert!(first.starts_with(LAUNCHER_GATE_PREFIX));
    }

    #[cfg(windows)]
    #[test]
    fn prior_anonymous_windows_job_stays_fail_closed_after_instance_lock() {
        assert!(!containment_definitively_gone_after_instance_lock(
            "windows_job",
            "600",
            "runtime",
            "generation-1",
            600,
        ));
        assert!(!containment_definitively_gone_after_instance_lock(
            "unverified",
            "42",
            "runtime",
            "generation-1",
            42,
        ));
        assert!(!containment_definitively_gone_after_instance_lock(
            "windows_named_job_v1",
            "Local\\missing",
            "runtime",
            "generation-1",
            42,
        ));
    }
}
