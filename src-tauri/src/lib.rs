// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
mod update_canary;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};
use tauri_plugin_shell::ShellExt;

#[derive(Serialize)]
struct PortableDiskSpace {
    data_dir: String,
    total_bytes: u64,
    free_bytes: u64,
    used_bytes: u64,
    free_percent: f64,
    warning_level: String,
}

/// Sidecar child process handle
struct SidecarState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Per-application bearer token shared only with the spawned sidecar and the
/// trusted XiaoJuClaw webviews. It is never persisted or written to logs.
struct LocalApiToken(String);

/// Sidecar readiness state: 0 = pending, 1 = ready, 2 = error, 3 = port-conflict
struct SidecarReadyState {
    state: AtomicU8,
    generation: AtomicU64,
    transition: Mutex<()>,
    port: Mutex<u16>,
    message: Mutex<String>,
}

struct SidecarLaunch {
    port: u16,
    generation: u64,
}

const SIDECAR_STATE_PENDING: u8 = 0;
const SIDECAR_STATE_READY: u8 = 1;
const SIDECAR_STATE_ERROR: u8 = 2;
const SIDECAR_STATE_PORT_CONFLICT: u8 = 3;
const SIDECAR_HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
const SIDECAR_HEALTH_RETRY_INTERVAL: Duration = Duration::from_millis(500);
const SIDECAR_HEALTH_IO_TIMEOUT: Duration = Duration::from_millis(750);
const PORTABLE_LAYOUT_FILE: &str = "portable-layout.json";
const INSTALLED_LAYOUT_FILE: &str = "installed-layout.json";
const PORTABLE_DATA_DIR: &str = "XiaoJuClawData";
const PORTABLE_RUNTIME_DIR: &str = "XiaoJuClawRuntime";

fn generate_local_api_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "OS random source unavailable".to_string())?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut token, "{byte:02x}")
            .map_err(|_| "Failed to encode local API token".to_string())?;
    }
    Ok(token)
}

/// Deep-link delivery state shared between startup and the running frontend.
struct DeepLinkState {
    pending: Mutex<Vec<String>>,
    frontend_ready: AtomicBool,
}

impl DeepLinkState {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            frontend_ready: AtomicBool::new(false),
        }
    }
}

impl SidecarReadyState {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(SIDECAR_STATE_PENDING),
            generation: AtomicU64::new(0),
            transition: Mutex::new(()),
            port: Mutex::new(62601),
            message: Mutex::new(String::new()),
        }
    }

    fn begin_launch(&self) -> u64 {
        let _transition = self.transition.lock().unwrap();
        let generation = self
            .generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        *self.message.lock().unwrap() = String::new();
        self.state.store(SIDECAR_STATE_PENDING, Ordering::SeqCst);
        generation
    }

    #[cfg_attr(debug_assertions, allow(dead_code))]
    fn invalidate_and_mark_pending(&self) {
        let _transition = self.transition.lock().unwrap();
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.message.lock().unwrap() = String::new();
        self.state.store(SIDECAR_STATE_PENDING, Ordering::SeqCst);
    }

    #[cfg_attr(debug_assertions, allow(dead_code))]
    fn mark_error(&self, message: String) {
        let _transition = self.transition.lock().unwrap();
        *self.message.lock().unwrap() = message;
        self.state.store(SIDECAR_STATE_ERROR, Ordering::SeqCst);
    }

    fn update_if_current(
        &self,
        generation: u64,
        state: u8,
        port: Option<u16>,
        message: String,
    ) -> bool {
        let _transition = self.transition.lock().unwrap();
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        if let Some(port) = port {
            *self.port.lock().unwrap() = port;
        }
        *self.message.lock().unwrap() = message;
        self.state.store(state, Ordering::SeqCst);
        true
    }

    fn snapshot(&self) -> SidecarEvent {
        let _transition = self.transition.lock().unwrap();
        let state = self.state.load(Ordering::SeqCst);
        let port = *self.port.lock().unwrap();
        let message = self.message.lock().unwrap().clone();
        match state {
            SIDECAR_STATE_READY => SidecarEvent {
                status: "ready".into(),
                message: format!("Backend ready on port {}", port),
            },
            SIDECAR_STATE_ERROR => SidecarEvent {
                status: "error".into(),
                message,
            },
            SIDECAR_STATE_PORT_CONFLICT => SidecarEvent {
                status: "port-conflict".into(),
                message,
            },
            _ => SidecarEvent {
                status: "pending".into(),
                message: "Backend starting...".into(),
            },
        }
    }
}

fn normalize_path(path: PathBuf) -> String {
    let mut value = path.to_string_lossy().to_string();
    if value.starts_with("\\\\?\\") {
        value = value[4..].to_string();
    }
    value
}

fn is_writable_dir(dir: &PathBuf) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(
        ".XiaoJuClaw-write-test-{}-{}",
        std::process::id(),
        chrono_like_timestamp()
    ));
    if std::fs::write(&probe, b"ok").is_err() {
        return false;
    }
    std::fs::remove_file(probe).is_ok()
}

fn chrono_like_timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableLayout {
    schema_version: u32,
    data_dir: String,
    runtime_dir: String,
}

fn nonempty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn read_portable_layout(exe_dir: &Path) -> Option<PortableLayout> {
    let content = std::fs::read_to_string(exe_dir.join(PORTABLE_LAYOUT_FILE)).ok()?;
    let layout = serde_json::from_str::<PortableLayout>(&content).ok()?;
    (layout.schema_version == 1).then_some(layout)
}

fn resolve_layout_dir(exe_dir: &Path, value: &str, expected_name: &str) -> Option<PathBuf> {
    let normalized = value.replace('\\', "/");
    if normalized == expected_name {
        return Some(exe_dir.join(expected_name));
    }
    if normalized == format!("../{expected_name}") {
        return exe_dir.parent().map(|parent| parent.join(expected_name));
    }
    None
}

fn resolve_marked_portable_dir(exe_dir: &Path, runtime: bool) -> Option<PathBuf> {
    let marker = exe_dir.join(PORTABLE_LAYOUT_FILE);
    if !marker.is_file() {
        return None;
    }

    let expected_name = if runtime {
        PORTABLE_RUNTIME_DIR
    } else {
        PORTABLE_DATA_DIR
    };
    if let Some(layout) = read_portable_layout(exe_dir) {
        let value = if runtime {
            &layout.runtime_dir
        } else {
            &layout.data_dir
        };
        if let Some(path) = resolve_layout_dir(exe_dir, value, expected_name) {
            return Some(path);
        }
    }

    // A malformed marker must never make a portable build silently switch to
    // AppData. Fall back to the v1 sibling layout and log the packaging error.
    log::error!(
        "Invalid {}: using safe sibling {} fallback",
        PORTABLE_LAYOUT_FILE,
        expected_name
    );
    Some(exe_dir.parent().unwrap_or(exe_dir).join(expected_name))
}

fn has_legacy_portable_layout(exe_dir: &Path) -> bool {
    // Historical portable packages always pre-created XiaoJuClawData, even
    // lightweight variants without a bundled tools manifest.
    exe_dir.join(PORTABLE_DATA_DIR).is_dir()
}

fn has_installed_layout(exe_dir: &Path) -> bool {
    exe_dir.join(INSTALLED_LAYOUT_FILE).is_file()
        // Tauri's NSIS package leaves an uninstaller in $INSTDIR. This detects
        // old user-level installs that were previously misclassified as
        // portable merely because their install directory was writable.
        || exe_dir.join("uninstall.exe").is_file()
        || exe_dir.join("unins000.exe").is_file()
}

fn is_portable_install_at(exe_dir: &Path) -> bool {
    if has_installed_layout(exe_dir) {
        return false;
    }
    exe_dir.join(PORTABLE_LAYOUT_FILE).is_file() || has_legacy_portable_layout(exe_dir)
}

fn is_portable_install() -> bool {
    if nonempty_env_path("XiaoJuClaw_PORTABLE_DATA_DIR").is_some() {
        return true;
    }
    current_exe_dir()
        .as_deref()
        .map(is_portable_install_at)
        .unwrap_or(false)
}

fn resolve_portable_data_dir(app: &AppHandle) -> PathBuf {
    if let Some(path) = nonempty_env_path("XiaoJuClaw_PORTABLE_DATA_DIR") {
        return path;
    }

    if let Some(exe_dir) = current_exe_dir() {
        if let Some(path) = resolve_marked_portable_dir(&exe_dir, false) {
            return path;
        }
        if !has_installed_layout(&exe_dir) && has_legacy_portable_layout(&exe_dir) {
            return exe_dir.join(PORTABLE_DATA_DIR);
        }
    }

    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join(PORTABLE_DATA_DIR))
}

fn resolve_portable_runtime_dir() -> Option<PathBuf> {
    if let Some(path) = nonempty_env_path("XiaoJuClaw_RUNTIME_DIR") {
        return Some(path);
    }

    let exe_dir = current_exe_dir()?;
    if let Some(path) = resolve_marked_portable_dir(&exe_dir, true) {
        return Some(path);
    }
    if !has_installed_layout(&exe_dir) && has_legacy_portable_layout(&exe_dir) {
        // New installs write here. The sidecar keeps the old
        // XiaoJuClawData/tools directory as a read-only fallback.
        return Some(exe_dir.join(PORTABLE_RUNTIME_DIR));
    }
    None
}

fn legacy_sibling_data_dir_for_installed() -> Option<PathBuf> {
    let exe_dir = current_exe_dir()?;
    if is_portable_install_at(&exe_dir) {
        return None;
    }
    let candidate = exe_dir.join(PORTABLE_DATA_DIR);
    candidate.exists().then_some(candidate)
}

fn portable_settings_path(app: &AppHandle) -> PathBuf {
    let data_dir = resolve_portable_data_dir(app);
    let _ = std::fs::create_dir_all(&data_dir);
    data_dir.join("settings.json")
}

fn portable_secrets_path(app: &AppHandle) -> PathBuf {
    let data_dir = resolve_portable_data_dir(app);
    let _ = std::fs::create_dir_all(&data_dir);
    data_dir.join("secrets.json")
}

fn read_json_object(path: &PathBuf) -> Option<Map<String, Value>> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content)
        .ok()?
        .as_object()
        .cloned()
}

fn read_portable_settings(app: &AppHandle) -> Map<String, Value> {
    let settings_path = portable_settings_path(app);
    if let Some(settings) = read_json_object(&settings_path) {
        return settings;
    }

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let legacy_path = app_data_dir.join("settings.json");
        if legacy_path != settings_path {
            if let Some(settings) = read_json_object(&legacy_path) {
                let _ = write_portable_settings(app, &settings);
                return settings;
            }
        }
    }

    Map::new()
}

fn write_portable_settings(app: &AppHandle, settings: &Map<String, Value>) -> Result<(), String> {
    let settings_path = portable_settings_path(app);
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path, content).map_err(|e| e.to_string())
}

fn read_portable_secrets(app: &AppHandle) -> Map<String, Value> {
    read_json_object(&portable_secrets_path(app)).unwrap_or_else(Map::new)
}

fn write_portable_secrets(app: &AppHandle, secrets: &Map<String, Value>) -> Result<(), String> {
    let secrets_path = portable_secrets_path(app);
    if let Some(parent) = secrets_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(secrets).map_err(|e| e.to_string())?;
    std::fs::write(secrets_path, content).map_err(|e| e.to_string())
}

fn validate_portable_secret_key(key: &str) -> Result<(), String> {
    let is_valid = !key.is_empty()
        && key.len() <= 80
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if is_valid {
        Ok(())
    } else {
        Err("Invalid secret key".into())
    }
}

fn read_portable_setting(app: &AppHandle, key: &str) -> Option<String> {
    read_portable_settings(app)
        .get(key)
        .and_then(|value| value.as_str().map(str::to_owned))
}

#[cfg(target_os = "windows")]
fn query_disk_space_for_path(path: &PathBuf) -> Result<(u64, u64), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }

    let mut free_available = 0u64;
    let mut total_bytes = 0u64;
    let mut total_free = 0u64;
    let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    path_wide.push(0);

    let ok = unsafe {
        GetDiskFreeSpaceExW(
            path_wide.as_ptr(),
            &mut free_available,
            &mut total_bytes,
            &mut total_free,
        )
    };

    if ok == 0 {
        Err("Failed to query disk space".into())
    } else {
        Ok((total_bytes, free_available))
    }
}

#[cfg(not(target_os = "windows"))]
fn query_disk_space_for_path(_path: &PathBuf) -> Result<(u64, u64), String> {
    Err("Disk space query is not supported on this platform".into())
}

fn read_close_action_setting(app: &AppHandle) -> Option<String> {
    if let Some(value) = read_portable_setting(app, "close_action") {
        return Some(value);
    }

    let preferences = read_portable_setting(app, "XiaoJuClaw-app-preferences")?;
    let parsed = serde_json::from_str::<Value>(&preferences).ok()?;
    parsed
        .get("state")
        .and_then(|state| state.get("closeAction"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

#[derive(Clone, Serialize)]
struct SidecarEvent {
    status: String,
    message: String,
}

fn enqueue_deep_link(app: &AppHandle, url: String) {
    let state = app.state::<DeepLinkState>();
    let mut guard = state.pending.lock().unwrap();
    if !guard.contains(&url) {
        guard.push(url);
    }
}

fn normalize_deep_link(raw: &str) -> Option<String> {
    let start = raw.find("XiaoJuClaw://")?;
    let candidate = raw[start..]
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c.is_whitespace())
        .trim_end_matches(|c: char| c == '"' || c == '\'' || c.is_whitespace())
        .to_string();

    if candidate.starts_with("XiaoJuClaw://") {
        Some(candidate)
    } else {
        None
    }
}

fn forward_deep_link(app: &AppHandle, url: String) {
    let state = app.state::<DeepLinkState>();
    let ready = state.frontend_ready.load(Ordering::SeqCst);
    log::info!("forward_deep_link: url={}, frontend_ready={}", url, ready);
    if ready {
        match app.emit("deep-link-received", &url) {
            Ok(_) => log::info!("Emitted deep-link-received event to frontend"),
            Err(e) => log::error!("Failed to emit deep-link-received: {}", e),
        }
        return;
    }
    log::info!("Frontend not ready, enqueuing deep link");
    enqueue_deep_link(app, url);
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    Ask,
    Minimize,
    Quit,
}

fn get_close_action(app: &AppHandle) -> CloseAction {
    match read_close_action_setting(app).as_deref() {
        Some("minimize") => CloseAction::Minimize,
        Some("quit") => CloseAction::Quit,
        _ => CloseAction::Ask,
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn quit_application(app: &AppHandle) {
    kill_sidecar(app);
    app.exit(0);
}

fn find_windows_git_bash() -> Option<String> {
    use std::path::Path;

    let mut candidates: Vec<String> = vec![];

    if let Ok(path) = std::env::var("CLAUDE_CODE_GIT_BASH_PATH") {
        candidates.push(path);
    }

    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let program_files_x86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());

    candidates.extend([
        format!("{}\\Git\\bin\\bash.exe", program_files),
        format!("{}\\Git\\bin\\bash.exe", program_files_x86),
        format!("{}\\Programs\\Git\\bin\\bash.exe", local_app_data),
        format!("{}\\scoop\\apps\\git\\current\\bin\\bash.exe", user_profile),
    ]);

    #[cfg(target_os = "windows")]
    let where_result = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("where")
            .arg("bash")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    #[cfg(not(target_os = "windows"))]
    let where_result = std::process::Command::new("where").arg("bash").output();

    if let Ok(output) = where_result {
        if output.status.success() {
            let content = String::from_utf8_lossy(&output.stdout);
            for line in content.lines() {
                let candidate = line.trim();
                if !candidate.is_empty() {
                    candidates.push(candidate.to_string());
                }
            }
        }
    }

    for candidate in candidates {
        if Path::new(&candidate).exists() {
            return Some(candidate);
        }
    }

    None
}

fn add_windows_git_paths(extra_paths: &mut Vec<String>, bash_path: &str) {
    use std::path::{Path, PathBuf};

    fn push_if_exists(extra_paths: &mut Vec<String>, path: PathBuf) {
        if path.exists() {
            let path_str = path.to_string_lossy().to_string();
            if !extra_paths.contains(&path_str) {
                extra_paths.push(path_str);
            }
        }
    }

    let bash_path = Path::new(bash_path);
    let Some(bash_dir) = bash_path.parent() else {
        return;
    };

    // For ...\\usr\\bin\\bash.exe -> git root is parent of usr
    // For ...\\bin\\bash.exe -> git root is parent of bin
    let git_root = if bash_dir
        .to_string_lossy()
        .to_ascii_lowercase()
        .ends_with("\\usr\\bin")
    {
        bash_dir.parent().and_then(|usr| usr.parent())
    } else {
        bash_dir.parent()
    };

    let Some(git_root) = git_root else { return };
    push_if_exists(extra_paths, git_root.join("bin"));
    push_if_exists(extra_paths, git_root.join("cmd"));
    push_if_exists(extra_paths, git_root.join("usr").join("bin"));
    push_if_exists(extra_paths, git_root.join("mingw64").join("bin"));
}

/// Kill any process occupying the given TCP port (Windows only).
/// Prevents startup failures caused by zombie sidecar processes from a previous session.
#[cfg(target_os = "windows")]
fn kill_process_on_port(port: u16) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Use netstat to find the PID listening on the target port
    let output = match std::process::Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let addr_patterns = [format!("127.0.0.1:{}", port), format!("0.0.0.0:{}", port)];

    let mut killed_pids = std::collections::HashSet::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        // Match lines with LISTENING state that contain our port
        if !trimmed.contains("LISTENING") {
            continue;
        }
        let has_match = addr_patterns
            .iter()
            .any(|pat| trimmed.contains(pat.as_str()));
        if !has_match {
            continue;
        }
        // PID is the last whitespace-separated token
        if let Some(pid_str) = trimmed.split_whitespace().last() {
            if let Ok(pid) = pid_str.parse::<u32>() {
                if pid > 0 && !killed_pids.contains(&pid) {
                    killed_pids.insert(pid);
                    log::warn!("Killing stale process {} occupying port {}", pid, port);
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
            }
        }
    }

    if !killed_pids.is_empty() {
        // Brief delay to let the OS release the port
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Spawn the sidecar backend
#[allow(dead_code)]
fn spawn_sidecar(app: &AppHandle) -> Result<SidecarLaunch, String> {
    let state = app.state::<SidecarState>();

    // Read preferred port from Tauri Store, default 62601
    let portable_install = is_portable_install();
    let data_dir = resolve_portable_data_dir(app);
    let data_dir_str = normalize_path(data_dir.clone());
    let settings_path = portable_settings_path(app);
    let settings_path_str = normalize_path(settings_path);

    let port: u16 = read_portable_setting(app, "preferred_port")
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(62601);
    log::info!("Using port {} (from store or default)", port);

    // Windows: kill any zombie process occupying the target port from a previous session.
    // This is the #1 cause of "backend failed to start" on Windows — when the app crashes
    // or is force-killed, taskkill cleanup may not run, leaving the old sidecar holding the port.
    #[cfg(target_os = "windows")]
    kill_process_on_port(port);

    // Model config (API Key, Base URL, Model ID) is now managed by the backend
    // via Settings API (SQLite kv_state), no longer injected from Tauri Store.
    let mut env_vars: Vec<(String, String)> = vec![];
    env_vars.push(("PORT".into(), port.to_string()));
    env_vars.push(("DATA_DIR".into(), data_dir_str.clone()));
    env_vars.push(("XiaoJuClaw_SETTINGS_FILE".into(), settings_path_str));
    env_vars.push((
        "XiaoJuClaw_PORTABLE".into(),
        if portable_install { "1" } else { "0" }.into(),
    ));
    if let Some(runtime_dir) = resolve_portable_runtime_dir() {
        env_vars.push(("XiaoJuClaw_RUNTIME_DIR".into(), normalize_path(runtime_dir)));
    }
    if !portable_install {
        if let Some(legacy_dir) = legacy_sibling_data_dir_for_installed() {
            if legacy_dir != data_dir {
                // Old builds classified any writable install directory as
                // portable. Let the sidecar copy that complete data tree into
                // AppData once, while retaining the source as a rollback copy.
                env_vars.push((
                    "XiaoJuClaw_LEGACY_DATA_DIR".into(),
                    normalize_path(legacy_dir),
                ));
            }
        }
    }
    env_vars.push((
        "XiaoJuClaw_LOCAL_API_TOKEN".into(),
        app.state::<LocalApiToken>().0.clone(),
    ));
    log::info!(
        "Storage layout: portable={}, data={}",
        portable_install,
        data_dir_str
    );

    // Ensure PATH includes common bun/node install paths (PATH is minimal when launched from Finder/Explorer)
    {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| {
                if cfg!(target_os = "windows") {
                    "C:\\Users\\Default".into()
                } else {
                    "/Users/default".into()
                }
            });

        let mut extra_paths: Vec<String> = if cfg!(target_os = "windows") {
            vec![
                format!("{}\\.bun\\bin", home),
                format!("{}\\.cargo\\bin", home),
                format!("{}\\scoop\\shims", home),
            ]
        } else {
            vec![
                format!("{}/.bun/bin", home),
                format!("{}/.cargo/bin", home),
                "/usr/local/bin".into(),
                "/opt/homebrew/bin".into(),
            ]
        };

        if cfg!(target_os = "windows") {
            // nvm-windows uses NVM_HOME and NVM_SYMLINK env vars
            if let Ok(nvm_home) = std::env::var("NVM_HOME") {
                extra_paths.push(nvm_home);
            }
            if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
                extra_paths.push(nvm_symlink);
            } else {
                // Fallback: standard Node.js install location
                let program_files =
                    std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
                let nodejs_dir = format!("{}\\nodejs", program_files);
                if std::path::Path::new(&nodejs_dir).exists() {
                    extra_paths.push(nodejs_dir);
                }
            }
            if let Some(git_bash_path) = find_windows_git_bash() {
                log::info!("Git Bash found at: {}", git_bash_path);
                env_vars.push(("CLAUDE_CODE_GIT_BASH_PATH".into(), git_bash_path.clone()));
                add_windows_git_paths(&mut extra_paths, &git_bash_path);
            } else {
                log::warn!("Git Bash not found on Windows — shell commands may fail");
            }
        } else {
            // Resolve nvm's actual node bin path (nvm does not create ~/.nvm/current)
            let nvm_alias_path = format!("{}/.nvm/alias/default", home);
            if let Ok(alias) = std::fs::read_to_string(&nvm_alias_path) {
                let version_prefix = alias.trim();
                let nvm_versions_dir = format!("{}/.nvm/versions/node", home);
                if let Ok(entries) = std::fs::read_dir(&nvm_versions_dir) {
                    let mut matched: Option<String> = None;
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let stripped = name.strip_prefix('v').unwrap_or(&name);
                        if stripped.starts_with(version_prefix)
                            || name == version_prefix
                            || name == format!("v{}", version_prefix)
                        {
                            matched = Some(name);
                        }
                    }
                    if let Some(ver) = matched {
                        extra_paths.push(format!("{}/{}/bin", nvm_versions_dir, ver));
                    }
                }
            }
        }

        let path_sep = if cfg!(target_os = "windows") {
            ";"
        } else {
            ":"
        };
        let mut path_parts: Vec<&str> = current_path.split(path_sep).collect();
        for p in &extra_paths {
            if !path_parts.contains(&p.as_str()) {
                path_parts.push(p.as_str());
            }
        }
        env_vars.push(("PATH".into(), path_parts.join(path_sep)));
    }

    // Ensure HOME and USERPROFILE are available for subprocess (cli.js needs them)
    if cfg!(target_os = "windows") {
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            env_vars.push(("USERPROFILE".into(), userprofile.clone()));
            if std::env::var("HOME").is_err() {
                env_vars.push(("HOME".into(), userprofile));
            }
        }
        // Inject TEMP/TMP/BUN_TMPDIR so Bun uses the correct temp directory on Windows.
        // Without these, Bun may fall back to an unexpected drive (e.g. B:\~BUN\root)
        // which can cause port binding failures if that drive has restricted permissions.
        if let Ok(temp) = std::env::var("TEMP") {
            env_vars.push(("TEMP".into(), temp.clone()));
            env_vars.push(("TMP".into(), temp.clone()));
            env_vars.push(("BUN_TMPDIR".into(), temp));
        }
    }

    // Set resource directory (read-only templates for agents/skills/prompts)
    match app.path().resource_dir() {
        Ok(resource_dir) => {
            let mut resource_str = resource_dir.to_string_lossy().to_string();
            // Strip Windows extended-length path prefix (\\?\)
            if resource_str.starts_with("\\\\?\\") {
                resource_str = resource_str[4..].to_string();
            }
            log::info!("Resource dir: {}", resource_str);
            env_vars.push(("RESOURCES_DIR".into(), resource_str));
        }
        Err(e) => {
            log::warn!("Failed to get resource_dir: {}, falling back to exe dir", e);
            // Fallback: Resources directory relative to the executable
            if let Ok(exe) = std::env::current_exe() {
                if let Some(exe_dir) = exe.parent() {
                    // Windows: resources are in the same directory as the exe
                    // macOS: exe -> MacOS/ -> Contents/ -> Resources/
                    let resources = if cfg!(target_os = "windows") {
                        exe_dir.to_path_buf()
                    } else {
                        exe_dir.parent().unwrap_or(exe_dir).join("Resources")
                    };
                    if resources.exists() {
                        env_vars.push((
                            "RESOURCES_DIR".into(),
                            resources.to_string_lossy().to_string(),
                        ));
                    }
                }
            }
        }
    }

    // package.json is immutable program payload. Never repair it by writing into
    // APP_DIR: that would blur the program/data boundary and can fail under
    // Program Files. A damaged package must be reinstalled.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let pkg_json = exe_dir.join("package.json");
            if !pkg_json.exists() {
                return Err(format!(
                    "Program payload is incomplete: missing {}. Reinstall XiaoJuClaw.",
                    normalize_path(pkg_json)
                ));
            }
        }
    }

    let shell = app.shell();
    let mut cmd = shell
        .sidecar("XiaoJuClaw-server")
        .map_err(|e| e.to_string())?;

    for (key, val) in env_vars {
        cmd = cmd.env(key, val);
    }

    let app_handle = app.clone();
    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;
    let generation = app.state::<SidecarReadyState>().begin_launch();

    // Store child process handle
    let mut guard = state.0.lock().unwrap();
    *guard = Some(child);

    // Listen to sidecar output
    let app_for_events = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    log::info!("[sidecar] {}", String::from_utf8_lossy(&line));
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    log::warn!("[sidecar] {}", line_str);
                    if line_str.contains("[PORT_CONFLICT]") {
                        let message = line_str.to_string();
                        let ready_state = app_for_events.state::<SidecarReadyState>();
                        if ready_state.update_if_current(
                            generation,
                            SIDECAR_STATE_PORT_CONFLICT,
                            None,
                            message.clone(),
                        ) {
                            let _ = app_for_events.emit(
                                "sidecar-event",
                                SidecarEvent {
                                    status: "port-conflict".into(),
                                    message,
                                },
                            );
                        }
                    }
                }
                tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                    log::error!("[sidecar] terminated with code: {:?}", payload.code);
                    let message = format!("Sidecar exited with code: {:?}", payload.code);
                    let ready_state = app_for_events.state::<SidecarReadyState>();
                    // Query callers consume "error" for startup-race compatibility, while
                    // the live event keeps the more specific "terminated" status.
                    if ready_state.update_if_current(
                        generation,
                        SIDECAR_STATE_ERROR,
                        None,
                        message.clone(),
                    ) {
                        let _ = app_for_events.emit(
                            "sidecar-event",
                            SidecarEvent {
                                status: "terminated".into(),
                                message,
                            },
                        );
                    }
                }
                _ => {}
            }
        }
    });

    Ok(SidecarLaunch { port, generation })
}

/// Wait for backend health check using stdlib TCP (no reqwest dependency)
async fn wait_for_health(port: u16, max_wait: Duration) -> Result<(), String> {
    let addr = format!("127.0.0.1:{}", port)
        .parse()
        .map_err(|e| format!("Invalid backend address: {}", e))?;
    let started = Instant::now();
    let mut attempts = 0u32;

    while started.elapsed() < max_wait {
        attempts += 1;
        if let Ok(mut stream) =
            std::net::TcpStream::connect_timeout(&addr, SIDECAR_HEALTH_IO_TIMEOUT)
        {
            use std::io::{Read, Write};
            let _ = stream.set_read_timeout(Some(SIDECAR_HEALTH_IO_TIMEOUT));
            let _ = stream.set_write_timeout(Some(SIDECAR_HEALTH_IO_TIMEOUT));
            let req = format!(
                "GET /api/health HTTP/1.0\r\nHost: localhost:{}\r\n\r\n",
                port
            );
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut buf = [0u8; 256];
                if let Ok(n) = stream.read(&mut buf) {
                    let resp = String::from_utf8_lossy(&buf[..n]);
                    if resp.starts_with("HTTP/1.0 200") || resp.starts_with("HTTP/1.1 200") {
                        log::info!("Backend health check passed after {} attempts", attempts);
                        return Ok(());
                    }
                }
            }
        }

        let remaining = max_wait.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(SIDECAR_HEALTH_RETRY_INTERVAL.min(remaining)).await;
    }

    Err(format!(
        "Backend health check failed after {} seconds",
        max_wait.as_secs()
    ))
}

/// Kill the sidecar process
fn kill_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut guard = state.0.lock().unwrap();
    if let Some(child) = guard.take() {
        let pid = child.pid();
        // Windows: use taskkill /T to kill entire process tree (including bun child processes)
        // CREATE_NO_WINDOW prevents a console window from flashing on screen
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            log::info!("Sidecar process tree killed (PID: {})", pid);
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = child.kill();
            // Also kill any child processes to prevent port leaks
            let _ = std::process::Command::new("pkill")
                .args(["-KILL", "-P", &pid.to_string()])
                .output();
            log::info!("Sidecar process tree killed (PID: {})", pid);
        }
    }
}

// ===== Portable in-place updater (two-exe swap) =====
//
// 便携版（免安装 / U 盘）无法用安装包 updater 就地更新，这里只替换两个核心 exe：
//   XiaoJuClaw.exe（主程序 + 内嵌前端） + XiaoJuClaw-server.exe（后端 sidecar）。
// 客户端拉 MVP 的 manifest，逐文件比对 sha256，只下载「变了的那个 exe」，落到
// XiaoJuClawData\updates\<version>，再起一个「分离的」.bat：等主进程退出后覆盖
// 文件并重启（规避 Windows 运行中 exe 的占用锁 + 单实例插件冲突）。
// 其余 _up_ / resources 等内容不走自更新（变动时重新制盘）。

const PORTABLE_MAIN_EXE: &str = "XiaoJuClaw.exe";
const PORTABLE_SERVER_EXE: &str = "XiaoJuClaw-server.exe";

/// 离线版编译期开关：Tauri 构建时设环境变量 XJC_OFFLINE_BUILD=1，把「禁用自动
/// 更新」直接烧死进二进制（面向访问不到香港服务器的大陆用户的离线交付，
/// 运行期不发起任何更新请求）。
/// 注意：option_env! 只在重新编译该 crate 时取值，增量缓存不会因环境变量变化
/// 而失效——离线构建必须是干净的 release 构建（由构建脚本保证）。
/// （const 上下文不允许对 &str 做模式匹配/相等比较，故用字节比较实现 == "1"。）
const OFFLINE_BUILD: bool = match option_env!("XJC_OFFLINE_BUILD") {
    Some(v) => {
        let b = v.as_bytes();
        b.len() == 1 && b[0] == b'1'
    }
    None => false,
};

fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

type PortableManifestFile = update_canary::PortableManifestFile;
type PortableManifest = update_canary::PortableManifest;

#[derive(Serialize, Default)]
struct PortableUpdateCheck {
    available: bool,
    version: String,
    notes: String,
    force_update: bool,
    main_needs_update: bool,
    server_needs_update: bool,
    total_bytes: u64,
    release_id: String,
    release_channel: String,
    cohort: update_canary::UpdateCohort,
    signature_verification: String,
}

#[derive(Clone, Serialize)]
struct PortableUpdateProgress {
    phase: String, // "downloading" | "applying"
    percent: u32,
    downloaded: u64,
    total: u64,
}

fn sha256_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// semver 数值比较（与 MVP releaseService.compareVersions 对齐）：预发布标签低于同数值正式版。
fn portable_version_cmp(a: &str, b: &str) -> i32 {
    fn parse(v: &str) -> (Vec<i64>, String) {
        let mut it = v.splitn(2, '-');
        let core = it.next().unwrap_or("");
        let pre = it.next().unwrap_or("").to_string();
        let mut nums: Vec<i64> = core
            .split('.')
            .map(|n| n.parse::<i64>().unwrap_or(0))
            .collect();
        while nums.len() < 3 {
            nums.push(0);
        }
        (nums, pre)
    }
    let (na, pa) = parse(a);
    let (nb, pb) = parse(b);
    for i in 0..3 {
        if na[i] > nb[i] {
            return 1;
        }
        if na[i] < nb[i] {
            return -1;
        }
    }
    match (pa.is_empty(), pb.is_empty()) {
        (true, false) => 1,
        (false, true) => -1,
        _ => {
            if pa < pb {
                -1
            } else if pa > pb {
                1
            } else {
                0
            }
        }
    }
}

/// [XJC-PATCH] 安全：严格校验便携版更新清单里的版本号，只接受
/// `\d+.\d+.\d+(-[0-9A-Za-z-.]+)?`（如 0.0.178 / 1.2.3-rc.1）。
/// manifest.version 会被逐字拼进 staging 目录路径（updates\<version>），随后被
/// apply-update.bat 用 `rmdir /s /q` 删除。若不校验，被攻陷/损坏的 manifest 可用
/// `..`、盘符、路径分隔符等触发「任意目录删除 / 路径穿越」。此处只放行数字段与
/// 受限的预发布字符集，从源头挡掉危险字符。
fn is_valid_portable_version(v: &str) -> bool {
    if v.is_empty() || v.len() > 64 {
        return false;
    }
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    // core：恰好三段，每段非空、纯数字、长度受限（避免异常/超长输入）。
    let mut segments = 0usize;
    for seg in core.split('.') {
        segments += 1;
        if seg.is_empty() || seg.len() > 9 || !seg.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    if segments != 3 {
        return false;
    }
    // pre（可选）：非空，仅允许 [0-9A-Za-z-.]（禁止 / \ : 等路径分隔符）。
    if let Some(pre) = pre {
        if pre.is_empty()
            || !pre
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        {
            return false;
        }
    }
    true
}

fn portable_fetch_manifest(
    app: &AppHandle,
    current: &str,
    channel: Option<&str>,
) -> Result<Option<PortableManifest>, String> {
    update_canary::fetch_portable_manifest(app, current, channel)
}

fn portable_update_check_blocking(
    app: &AppHandle,
    current: &str,
    channel: Option<&str>,
) -> Result<PortableUpdateCheck, String> {
    let dir = current_exe_dir().ok_or("无法定位程序目录")?;
    let manifest = match portable_fetch_manifest(app, current, channel)? {
        Some(m) => m,
        None => return Ok(PortableUpdateCheck::default()),
    };
    // [XJC-PATCH] 安全：严格校验清单版本号（详见 is_valid_portable_version），与
    // apply 保持一致，避免被攻陷/损坏的 manifest 进入后续流程。
    if !is_valid_portable_version(&manifest.version) {
        return Err("更新清单版本号非法".into());
    }
    // 防降级：清单版本低于当前版本则不提示更新。
    if !current.is_empty() && portable_version_cmp(&manifest.version, current) < 0 {
        return Ok(PortableUpdateCheck {
            version: manifest.version.clone(),
            notes: manifest.notes.clone(),
            force_update: manifest.force_update,
            release_id: manifest.release_id.clone(),
            release_channel: manifest.channel.clone(),
            cohort: manifest.cohort.clone(),
            signature_verification: "verified".to_string(),
            ..Default::default()
        });
    }
    let local_main = sha256_file(&dir.join(PORTABLE_MAIN_EXE)).unwrap_or_default();
    let local_server = sha256_file(&dir.join(PORTABLE_SERVER_EXE)).unwrap_or_default();
    let mut main_needs = false;
    let mut server_needs = false;
    let mut total = 0u64;
    for f in &manifest.files {
        if f.name == PORTABLE_MAIN_EXE && !f.sha256.is_empty() && f.sha256 != local_main {
            main_needs = true;
            total += f.size;
        } else if f.name == PORTABLE_SERVER_EXE && !f.sha256.is_empty() && f.sha256 != local_server
        {
            server_needs = true;
            total += f.size;
        }
    }
    Ok(PortableUpdateCheck {
        available: main_needs || server_needs,
        version: manifest.version.clone(),
        notes: manifest.notes.clone(),
        force_update: manifest.force_update,
        main_needs_update: main_needs,
        server_needs_update: server_needs,
        total_bytes: total,
        release_id: manifest.release_id,
        release_channel: manifest.channel,
        cohort: manifest.cohort,
        signature_verification: "verified".to_string(),
    })
}

#[allow(clippy::too_many_arguments)]
fn portable_download(
    client: &reqwest::blocking::Client,
    manifest: &PortableManifest,
    manifest_file: &PortableManifestFile,
    current: &str,
    dest: &Path,
    app: &AppHandle,
    downloaded_total: &mut u64,
    grand_total: u64,
    last_percent: &mut u32,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut resp =
        update_canary::send_portable_download(client, app, manifest, manifest_file, current)?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    if let Some(content_length) = resp.content_length() {
        if content_length != manifest_file.size {
            return Err("下载文件大小与签名清单不匹配".to_string());
        }
    }
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65536];
    let mut file_total = 0u64;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file_total = file_total.saturating_add(n as u64);
        if file_total > manifest_file.size {
            return Err("下载文件大小与签名清单不匹配".to_string());
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        *downloaded_total += n as u64;
        let percent = if grand_total > 0 {
            ((*downloaded_total as f64 / grand_total as f64) * 100.0) as u32
        } else {
            0
        };
        if percent != *last_percent {
            *last_percent = percent;
            let _ = app.emit(
                "portable-update-progress",
                PortableUpdateProgress {
                    phase: "downloading".into(),
                    percent,
                    downloaded: *downloaded_total,
                    total: grand_total,
                },
            );
        }
    }
    if file_total != manifest_file.size {
        return Err("下载文件大小与签名清单不匹配".to_string());
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Windows：写一个分离的 .bat，等主进程退出后覆盖 exe 并重启，最后自删。
#[cfg(target_os = "windows")]
fn portable_spawn_swap_windows(
    app: &AppHandle,
    staging: &Path,
    copies: &[(PathBuf, PathBuf)],
    applied_version: &str,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;

    let pid = std::process::id();
    let bat_path = resolve_portable_data_dir(app)
        .join("updates")
        .join("apply-update.bat");
    if let Some(parent) = bat_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let main_exe = normalize_path(
        current_exe_dir()
            .ok_or("无法定位程序目录")?
            .join(PORTABLE_MAIN_EXE),
    );

    // [XJC-PATCH] 失败标记文件：原子替换失败（备份失败或替换回滚）时写入，供下次
    // 启动侧检测并提示用户「上次更新失败，已保留旧版本」（前端读取属后续工作）。
    // 成功路径会删除它，避免残留造成误报。
    let marker = normalize_path(
        resolve_portable_data_dir(app)
            .join("updates")
            .join("last-update-failed.txt"),
    );
    let applied_marker = normalize_path(update_canary::applied_marker_path(app));

    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("chcp 65001 >nul\r\n");
    // 等主进程（PID）完全退出，避免占用锁。
    script.push_str(":waitloop\r\n");
    script.push_str(&format!(
        "tasklist /FI \"PID eq {}\" 2>nul | find \"{}\" >nul\r\n",
        pid, pid
    ));
    script.push_str("if not errorlevel 1 (\r\n");
    script.push_str("  ping -n 2 127.0.0.1 >nul\r\n");
    script.push_str("  goto waitloop\r\n");
    script.push_str(")\r\n");
    script.push_str("ping -n 2 127.0.0.1 >nul\r\n");
    // [XJC-PATCH] 全或无原子替换（修复「双 exe 部分替换 -> 版本错配」）：
    //   阶段1 先把每个目标 exe 备份为 .bak；
    //   阶段2 逐个带重试覆盖，任一失败 -> 用 .bak 回滚全部目标、不重启、写失败标记；
    //   全部成功才重启并清理 .bak / staging。
    // 保证：要么两个都换、要么都不换，绝不带「new main + old server」的错配组合重启。
    // 说明：bat 内容保持纯 ASCII（含 rem 注释），路径可能含非 ASCII，靠开头 chcp 65001
    // + UTF-8 文件解决（与既有实现一致）。
    // --- stage 1: backup existing targets to .bak ---
    script.push_str("rem backup current exe files\r\n");
    for (_staged, dest) in copies {
        let d = normalize_path(dest.clone());
        script.push_str(&format!("copy /y \"{}\" \"{}.bak\" >nul\r\n", d, d));
        script.push_str("if errorlevel 1 goto backupfail\r\n");
    }
    // --- stage 2: apply staged files with retry; any failure -> rollback ---
    script.push_str("rem apply staged files (all-or-nothing)\r\n");
    for (staged, dest) in copies {
        script.push_str(&format!(
            "call :docopy \"{}\" \"{}\"\r\n",
            normalize_path(staged.clone()),
            normalize_path(dest.clone())
        ));
        script.push_str("if errorlevel 1 goto rollback\r\n");
    }
    // --- success: clear marker, drop .bak, restart, clean staging, self-delete ---
    script.push_str(&format!("del /f /q \"{}\" >nul 2>nul\r\n", marker));
    script.push_str(&format!(
        "echo {}>\"{}\"\r\n",
        applied_version, applied_marker
    ));
    for (_staged, dest) in copies {
        script.push_str(&format!(
            "del /f /q \"{}.bak\" >nul 2>nul\r\n",
            normalize_path(dest.clone())
        ));
    }
    script.push_str(&format!("start \"\" \"{}\"\r\n", main_exe));
    script.push_str(&format!(
        "rmdir /s /q \"{}\"\r\n",
        normalize_path(staging.to_path_buf())
    ));
    // del 与 exit 必须同一行：整行先被 cmd 解析完再执行，删掉自身后不再读文件。
    script.push_str("del \"%~f0\" & exit /b 0\r\n");
    script.push_str("\r\n");
    // backup failed: no target modified yet, just drop any .bak, mark and abort (no restart).
    script.push_str(":backupfail\r\n");
    for (_staged, dest) in copies {
        script.push_str(&format!(
            "del /f /q \"{}.bak\" >nul 2>nul\r\n",
            normalize_path(dest.clone())
        ));
    }
    script.push_str(&format!("echo update-failed>\"{}\"\r\n", marker));
    script.push_str("del \"%~f0\" & exit /b 1\r\n");
    script.push_str("\r\n");
    // rollback: restore every target from .bak (reuse retrying docopy), drop .bak,
    // mark and abort (no restart) so we never boot a mismatched combo.
    script.push_str(":rollback\r\n");
    for (_staged, dest) in copies {
        let d = normalize_path(dest.clone());
        script.push_str(&format!(
            "if exist \"{}.bak\" call :docopy \"{}.bak\" \"{}\"\r\n",
            d, d, d
        ));
    }
    for (_staged, dest) in copies {
        script.push_str(&format!(
            "del /f /q \"{}.bak\" >nul 2>nul\r\n",
            normalize_path(dest.clone())
        ));
    }
    script.push_str(&format!("echo update-failed>\"{}\"\r\n", marker));
    script.push_str("del \"%~f0\" & exit /b 1\r\n");
    script.push_str("\r\n");
    // docopy: overwrite one file with retry (taskkill 后文件锁释放可能滞后 / 杀毒短暂占用).
    script.push_str(":docopy\r\n");
    script.push_str("set /a _tries=0\r\n");
    script.push_str(":retrycopy\r\n");
    script.push_str("copy /y %1 %2 >nul\r\n");
    script.push_str("if not errorlevel 1 exit /b 0\r\n");
    script.push_str("set /a _tries+=1\r\n");
    script.push_str("if %_tries% GEQ 15 exit /b 1\r\n");
    script.push_str("ping -n 2 127.0.0.1 >nul\r\n");
    script.push_str("goto retrycopy\r\n");

    std::fs::write(&bat_path, script).map_err(|e| e.to_string())?;

    std::process::Command::new("cmd")
        .args(["/C", &normalize_path(bat_path.clone())])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("启动更新脚本失败：{}", e))?;
    Ok(())
}

/// [XJC-PATCH] 清理 updates/ 下的旧版本暂存目录，仅保留 keep_version（即将使用的
/// 当前目标版本）。下载/校验失败留下的半成品不会被自动删除，跨版本累积会占盘；
/// apply 入口在建 staging 前调用一次即可自愈。只删目录，apply-update.bat / 失败标记
/// 等文件天然跳过。
fn portable_prune_stale_staging(updates_root: &Path, keep_version: &str) {
    let entries = match std::fs::read_dir(updates_root) {
        Ok(e) => e,
        Err(_) => return, // updates/ 尚不存在或不可读，无需清理
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match path.file_name().and_then(|n| n.to_str()) {
            Some(name) if name != keep_version => {
                let _ = std::fs::remove_dir_all(&path);
            }
            _ => {}
        }
    }
}

fn portable_update_apply_blocking(
    app: &AppHandle,
    expected_offer: &update_canary::UpdateOfferContext,
) -> Result<(), String> {
    if !is_portable_install() {
        return Err("当前为安装版，请通过安装包更新".into());
    }
    let dir = current_exe_dir().ok_or("无法定位程序目录")?;
    if !is_writable_dir(&dir) {
        return Err("便携版程序目录不可写，无法执行就地更新".into());
    }
    let current = app.config().version.clone().unwrap_or_default();
    let manifest = portable_fetch_manifest(app, &current, Some(&expected_offer.channel))?
        .ok_or("暂无可用更新")?;
    if manifest.release_id != expected_offer.release_id
        || manifest.version != expected_offer.release_version
    {
        return Err("更新清单已变化，请重新检查更新".to_string());
    }
    let offer_context = update_canary::offer_context_from_portable(&manifest);

    // [XJC-PATCH] 安全：manifest.version 会被逐字拼进 staging 目录路径，随后被
    // apply-update.bat `rmdir /s /q` 删除；先做严格 semver 校验，防止被攻陷/损坏的
    // manifest 借 `..`、路径分隔符等触发「任意目录删除 / 路径穿越 / 降级」。
    if !is_valid_portable_version(&manifest.version) {
        return Err("更新清单版本号非法，已中止更新".into());
    }

    // 与 check 同样的防降级门：apply 被直接调用（绕过 check）时也不允许装回旧版本。
    if !current.is_empty() && portable_version_cmp(&manifest.version, &current) < 0 {
        return Err("服务器上的版本低于当前版本，已取消更新".into());
    }

    let local_main = sha256_file(&dir.join(PORTABLE_MAIN_EXE)).unwrap_or_default();
    let local_server = sha256_file(&dir.join(PORTABLE_SERVER_EXE)).unwrap_or_default();

    // 逐文件 sha256 比对，挑出需要下载替换的 exe。
    let mut targets: Vec<(&PortableManifestFile, PathBuf)> = vec![];
    let mut grand_total = 0u64;
    for f in &manifest.files {
        let (local, dest) = if f.name == PORTABLE_MAIN_EXE {
            (&local_main, dir.join(PORTABLE_MAIN_EXE))
        } else if f.name == PORTABLE_SERVER_EXE {
            (&local_server, dir.join(PORTABLE_SERVER_EXE))
        } else {
            continue;
        };
        if f.sha256.is_empty() || f.sha256.eq_ignore_ascii_case(local) {
            continue;
        }
        // URL origin/path and this hash were already bound to the verified
        // Ed25519 signed payload by fetch_portable_manifest.
        grand_total += f.size;
        targets.push((f, dest));
    }
    if targets.is_empty() {
        return Err("没有需要更新的文件".into());
    }

    // [XJC-PATCH] 建 staging 前先清理旧版本暂存目录（保留即将使用的当前版本），
    // 避免下载/校验失败留下的半成品跨版本累积占盘。
    let updates_root = resolve_portable_data_dir(app).join("updates");
    portable_prune_stale_staging(&updates_root, &manifest.version);

    let staging = updates_root.join(&manifest.version);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    // [XJC-PATCH] 下载 + 校验 + 应用整段封装，任一步失败都尽力清理 staging（忽略
    // 清理错误），避免半成品残留。Windows 成功路径不在这里清理——staging 要留给
    // apply-update.bat 覆盖完再自行 rmdir。
    let outcome = (|| -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(1800))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;

        update_canary::queue_lifecycle_event(
            app,
            &offer_context,
            update_canary::LifecycleStage::DownloadStarted,
        );
        update_canary::flush_update_telemetry(app.clone());
        let mut downloaded_total = 0u64;
        let mut last_percent = 0u32;
        let mut copies: Vec<(PathBuf, PathBuf)> = vec![];
        for (f, dest) in &targets {
            let staged = staging.join(&f.name);
            portable_download(
                &client,
                &manifest,
                f,
                &current,
                &staged,
                app,
                &mut downloaded_total,
                grand_total,
                &mut last_percent,
            )?;
            let got = sha256_file(&staged).ok_or("下载文件校验失败")?;
            if !got.eq_ignore_ascii_case(&f.sha256) {
                return Err(format!("{} 校验失败，已中止更新", f.name));
            }
            copies.push((staged, dest.clone()));
        }
        update_canary::queue_lifecycle_event(
            app,
            &offer_context,
            update_canary::LifecycleStage::DownloadCompleted,
        );

        let _ = app.emit(
            "portable-update-progress",
            PortableUpdateProgress {
                phase: "applying".into(),
                percent: 100,
                downloaded: downloaded_total,
                total: grand_total,
            },
        );
        update_canary::queue_lifecycle_event(
            app,
            &offer_context,
            update_canary::LifecycleStage::ApplyStarted,
        );
        update_canary::write_pending_update(app, &offer_context);
        update_canary::flush_update_telemetry(app.clone());

        #[cfg(target_os = "windows")]
        {
            // [XJC-PATCH] 高危修复：先确认更新脚本 spawn 成功（bat 已在后台等待主进程
            // PID 退出），再杀 sidecar 释放 server exe 占用，最后退出主进程；bat 侦测到
            // 主进程退出后开始原子替换并重启。若像原来那样「先 kill_sidecar，再 spawn 且
            // spawn 失败」，sidecar 已死却无 bat 兜底，应用会变成没有后端的空壳。故顺序
            // 必须是：spawn 成功 -> kill_sidecar -> app.exit。spawn 失败则原样返回 Err，
            // sidecar 未被动过，应用继续可用。
            portable_spawn_swap_windows(app, &staging, &copies, &manifest.version)?;
            kill_sidecar(app);
            std::thread::sleep(Duration::from_millis(300));
            app.exit(0);
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            // 类 Unix：运行中的可执行文件可被替换（inode 保留），直接覆盖后重启。
            kill_sidecar(app);
            for (staged, dest) in &copies {
                std::fs::copy(staged, dest).map_err(|e| e.to_string())?;
            }
            std::fs::write(update_canary::applied_marker_path(app), &manifest.version)
                .map_err(|e| e.to_string())?;
            let _ = std::fs::remove_dir_all(&staging);
            app.restart();
        }
    })();

    if outcome.is_err() {
        // [XJC-PATCH] 失败清理暂存（尽力，忽略错误）。
        let _ = std::fs::remove_dir_all(&staging);
        update_canary::clear_pending_update(app);
        let message = outcome.as_ref().err().map(String::as_str).unwrap_or("");
        let (code, reason) = if message.contains("校验") {
            ("PORTABLE_HASH_MISMATCH", "download verification failed")
        } else if message.contains("下载") || message.contains("网络") {
            ("PORTABLE_DOWNLOAD_FAILED", "network unavailable")
        } else {
            ("PORTABLE_APPLY_FAILED", "update apply failed")
        };
        update_canary::queue_lifecycle_event(
            app,
            &offer_context,
            update_canary::LifecycleStage::Failure {
                stage: "apply",
                error_code: code,
                reason,
            },
        );
        update_canary::flush_update_telemetry(app.clone());
    }
    outcome
}

// ===== Tauri Commands =====

/// 返回当前更新通道："portable"（便携版，走双 exe 就地替换）| "installer"（安装版，
/// 走 Tauri updater）| "disabled"（离线版，编译期烧死，不提供自动更新）。
#[tauri::command]
fn get_update_channel() -> String {
    update_canary::current_update_type().to_string()
}

#[tauri::command]
async fn portable_update_check(
    app: AppHandle,
    channel: Option<String>,
    state: tauri::State<'_, update_canary::PortableOfferState>,
) -> Result<PortableUpdateCheck, String> {
    // 防御纵深：离线版前端不会调到这里，即使被误调也直接拒绝。
    if OFFLINE_BUILD {
        return Err("离线版不提供自动更新".to_string());
    }
    if update_canary::current_update_type() != "portable" {
        return Err("当前为安装版，请通过安装包更新".to_string());
    }
    let current = app.config().version.clone().unwrap_or_default();
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        portable_update_check_blocking(&app2, &current, channel.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Ok(mut current_offer) = state.0.lock() {
        *current_offer = if result.available {
            Some(update_canary::UpdateOfferContext {
                release_id: result.release_id.clone(),
                release_kind: "portable".to_string(),
                release_version: result.version.clone(),
                channel: result.release_channel.clone(),
                cohort: result.cohort.name.clone(),
            })
        } else {
            None
        };
    }
    Ok(result)
}

#[tauri::command]
async fn portable_update_apply(
    app: AppHandle,
    state: tauri::State<'_, update_canary::PortableOfferState>,
) -> Result<(), String> {
    // 防御纵深：离线版前端不会调到这里，即使被误调也直接拒绝。
    if OFFLINE_BUILD {
        return Err("离线版不提供自动更新".to_string());
    }
    if update_canary::current_update_type() != "portable" {
        return Err("当前版本不使用便携版更新".to_string());
    }
    let expected_offer = state
        .0
        .lock()
        .map_err(|_| "便携版更新状态不可用".to_string())?
        .clone()
        .ok_or_else(|| "请先检查更新".to_string())?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        portable_update_apply_blocking(&app2, &expected_offer)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_portable_data_dir(app: AppHandle) -> String {
    normalize_path(resolve_portable_data_dir(&app))
}

#[tauri::command]
fn get_portable_disk_space(app: AppHandle) -> Result<PortableDiskSpace, String> {
    let data_dir = resolve_portable_data_dir(&app);
    let _ = std::fs::create_dir_all(&data_dir);
    let (total_bytes, free_bytes) = query_disk_space_for_path(&data_dir)?;
    let used_bytes = total_bytes.saturating_sub(free_bytes);
    let free_percent = if total_bytes > 0 {
        (free_bytes as f64 / total_bytes as f64) * 100.0
    } else {
        0.0
    };
    let warning_level = if free_bytes < 512 * 1024 * 1024 || free_percent < 5.0 {
        "critical"
    } else if free_bytes < 2 * 1024 * 1024 * 1024 || free_percent < 10.0 {
        "low"
    } else {
        "ok"
    };

    Ok(PortableDiskSpace {
        data_dir: normalize_path(data_dir),
        total_bytes,
        free_bytes,
        used_bytes,
        free_percent,
        warning_level: warning_level.into(),
    })
}

#[tauri::command]
fn portable_setting_get(app: AppHandle, key: String) -> Option<String> {
    read_portable_setting(&app, &key)
}

#[tauri::command]
fn portable_setting_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let mut settings = read_portable_settings(&app);
    if key == "XiaoJuClaw-app-preferences" {
        if let Ok(parsed) = serde_json::from_str::<Value>(&value) {
            if let Some(close_action) = parsed
                .get("state")
                .and_then(|state| state.get("closeAction"))
                .and_then(|value| value.as_str())
            {
                settings.insert(
                    "close_action".into(),
                    Value::String(close_action.to_string()),
                );
            }
        }
    }
    settings.insert(key, Value::String(value));
    write_portable_settings(&app, &settings)
}

#[tauri::command]
fn portable_setting_delete(app: AppHandle, key: String) -> Result<(), String> {
    let mut settings = read_portable_settings(&app);
    settings.remove(&key);
    write_portable_settings(&app, &settings)
}

#[tauri::command]
fn portable_secret_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    validate_portable_secret_key(&key)?;
    Ok(read_portable_secrets(&app)
        .get(&key)
        .and_then(|value| value.as_str().map(str::to_owned)))
}

#[tauri::command]
fn portable_secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    validate_portable_secret_key(&key)?;
    let mut secrets = read_portable_secrets(&app);
    secrets.insert(key, Value::String(value));
    write_portable_secrets(&app, &secrets)
}

#[tauri::command]
fn portable_secret_delete(app: AppHandle, key: String) -> Result<(), String> {
    validate_portable_secret_key(&key)?;
    let mut secrets = read_portable_secrets(&app);
    secrets.remove(&key);
    write_portable_secrets(&app, &secrets)
}

#[tauri::command]
fn get_version(app: AppHandle) -> String {
    app.config()
        .version
        .clone()
        .unwrap_or_else(|| "unknown".into())
}

#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

/// Return the runtime-only sidecar token only to application-owned webviews.
/// Debug Tauri uses an independently started Bun server, so it intentionally
/// falls back to the server's no-token development mode.
#[tauri::command]
fn get_local_api_token(
    window: tauri::WebviewWindow,
    token: tauri::State<'_, LocalApiToken>,
) -> Result<Option<String>, String> {
    if window.label() != "main" && window.label() != "floating" {
        return Err("Local API token is unavailable to this window".to_string());
    }

    #[cfg(debug_assertions)]
    {
        let _ = token;
        Ok(None)
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(Some(token.0.clone()))
    }
}

/// Query current sidecar status (for frontend to check on startup, avoiding race condition)
#[tauri::command]
fn get_sidecar_status(app: AppHandle) -> SidecarEvent {
    app.state::<SidecarReadyState>().snapshot()
}

#[tauri::command]
fn take_pending_deep_links(app: AppHandle) -> Vec<String> {
    let state = app.state::<DeepLinkState>();
    let mut guard = state.pending.lock().unwrap();
    std::mem::take(&mut *guard)
}

#[tauri::command]
fn set_deep_link_frontend_ready(app: AppHandle, ready: bool) {
    let state = app.state::<DeepLinkState>();
    state.frontend_ready.store(ready, Ordering::SeqCst);
}

#[tauri::command]
async fn restart_sidecar(#[allow(unused)] app: AppHandle) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        return Err(
            "Dev mode: please restart 'bun dev:tauri' manually to apply port changes.".into(),
        );
    }
    #[cfg(not(debug_assertions))]
    {
        // Invalidate the old process before killing it, so its delayed Terminated
        // event cannot overwrite the replacement process's ready state.
        app.state::<SidecarReadyState>()
            .invalidate_and_mark_pending();

        kill_sidecar(&app);
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let launch = match spawn_sidecar(&app) {
            Ok(launch) => launch,
            Err(error) => {
                app.state::<SidecarReadyState>().mark_error(error.clone());
                let _ = app.emit(
                    "sidecar-event",
                    SidecarEvent {
                        status: "error".into(),
                        message: error.clone(),
                    },
                );
                return Err(error);
            }
        };
        if let Err(error) = wait_for_health(launch.port, SIDECAR_HEALTH_TIMEOUT).await {
            let ready_state = app.state::<SidecarReadyState>();
            if ready_state.update_if_current(
                launch.generation,
                SIDECAR_STATE_ERROR,
                None,
                error.clone(),
            ) {
                let _ = app.emit(
                    "sidecar-event",
                    SidecarEvent {
                        status: "error".into(),
                        message: error.clone(),
                    },
                );
            }
            return Err(error);
        }

        let message = format!("Backend ready on port {}", launch.port);
        let ready_state = app.state::<SidecarReadyState>();
        if ready_state.update_if_current(
            launch.generation,
            SIDECAR_STATE_READY,
            Some(launch.port),
            message.clone(),
        ) {
            let _ = app.emit(
                "sidecar-event",
                SidecarEvent {
                    status: "ready".into(),
                    message,
                },
            );
        }
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let local_api_token =
        generate_local_api_token().expect("failed to generate per-application local API token");

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                ])
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .max_file_size(5_000_000) // 5 MB per log file, auto-rotates
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Windows: when a second instance is launched, args contain deep link URL
            // Forward the URL to the running instance and bring its window to front
            log::info!("Single instance callback, args: {:?}", args);
            for arg in &args {
                if let Some(url) = normalize_deep_link(arg) {
                    forward_deep_link(app, url);
                    break;
                }
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
                let _ = win.unminimize();
            }
        }))
        .manage(SidecarState(Mutex::new(None)))
        .manage(LocalApiToken(local_api_token))
        .manage(SidecarReadyState::new())
        .manage(DeepLinkState::new())
        .manage(update_canary::InstallerUpdateState::default())
        .manage(update_canary::PortableOfferState::default())
        .manage(update_canary::UpdateStartupState::default())
        .invoke_handler(tauri::generate_handler![
            get_portable_data_dir,
            get_portable_disk_space,
            portable_setting_get,
            portable_setting_set,
            portable_setting_delete,
            portable_secret_get,
            portable_secret_set,
            portable_secret_delete,
            get_version,
            get_platform,
            get_local_api_token,
            get_sidecar_status,
            take_pending_deep_links,
            set_deep_link_frontend_ready,
            restart_sidecar,
            get_update_channel,
            portable_update_check,
            portable_update_apply,
            update_canary::installer_update_check,
            update_canary::installer_update_apply,
            update_canary::flush_update_telemetry,
            update_canary::get_update_startup_status,
            update_canary::get_update_diagnostics,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let update_startup = update_canary::process_update_startup(&handle);
            if let Ok(mut state) = app.state::<update_canary::UpdateStartupState>().0.lock() {
                *state = update_startup;
            }

            for arg in std::env::args().skip(1) {
                if let Some(url) = normalize_deep_link(&arg) {
                    enqueue_deep_link(&handle, url);
                }
            }

            // macOS: overlay titlebar style (traffic lights over content, hidden title)
            #[cfg(target_os = "macos")]
            {
                use tauri::TitleBarStyle;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title_bar_style(TitleBarStyle::Overlay);
                    let _ = win.set_title("");
                }
            }

            // Show main window after window-state plugin has restored position/size
            // (window starts hidden via tauri.conf.json to prevent flicker on Windows)
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }

            // Create system tray (i18n based on system locale)
            let is_zh = sys_locale::get_locale()
                .map(|l| l.starts_with("zh"))
                .unwrap_or(false);
            let show_label = if is_zh { "显示窗口" } else { "Show Window" };
            let quit_label = if is_zh { "退出" } else { "Quit" };
            let show_item = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            // Tray icon.
            //  - macOS: monochrome "template" image the OS recolors for the
            //    light/dark menu bar (icon_as_template = true).
            //  - Windows/Linux: template mode is NOT honored there and renders
            //    the monochrome image as an unrecognizable black blob, so ship
            //    the full-color app icon instead.
            #[cfg(target_os = "macos")]
            let tray_icon = Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png"))
                .expect("failed to load tray icon");
            #[cfg(not(target_os = "macos"))]
            let tray_icon = Image::from_bytes(include_bytes!("../icons/64x64.png"))
                .expect("failed to load tray icon");

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        quit_application(app);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_main_window(app);
                    }
                })
                .build(app)?;

            // Listen for deep link events and forward to frontend
            let dl_handle = handle.clone();
            app.listen("deep-link://new-url", move |event: tauri::Event| {
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                    for url in urls {
                        forward_deep_link(&dl_handle, url);
                    }
                    // Bring window to foreground
                    if let Some(win) = dl_handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            });

            let minimize_handle = handle.clone();
            app.listen("close-action-minimize", move |_| {
                hide_main_window(&minimize_handle);
            });

            let quit_handle = handle.clone();
            app.listen("close-action-quit", move |_| {
                quit_application(&quit_handle);
            });

            // Start backend (dev mode uses beforeDevCommand, release mode uses sidecar)
            let app_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let launch: SidecarLaunch;

                #[cfg(not(debug_assertions))]
                {
                    match spawn_sidecar(&app_handle) {
                        Ok(sidecar_launch) => launch = sidecar_launch,
                        Err(e) => {
                            log::error!("Failed to spawn sidecar: {}", e);
                            app_handle
                                .state::<SidecarReadyState>()
                                .mark_error(e.clone());
                            let _ = app_handle.emit(
                                "sidecar-event",
                                SidecarEvent {
                                    status: "error".into(),
                                    message: e,
                                },
                            );
                            return;
                        }
                    }
                }
                #[cfg(debug_assertions)]
                {
                    // Dev mode: use .env PORT, then default.
                    // Do not reuse the persisted preferred_port from the desktop app.
                    let port = std::fs::read_to_string(
                        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env"),
                    )
                    .ok()
                    .and_then(|content| {
                        content
                            .lines()
                            .find(|l| l.starts_with("PORT="))
                            .and_then(|l| l.strip_prefix("PORT="))
                            .and_then(|v| v.trim().parse::<u16>().ok())
                    })
                    .unwrap_or(62601);

                    log::info!(
                        "Dev mode: skipping sidecar, using bun dev server on port {}",
                        port
                    );
                    let generation = app_handle.state::<SidecarReadyState>().begin_launch();
                    launch = SidecarLaunch { port, generation };
                }

                match wait_for_health(launch.port, SIDECAR_HEALTH_TIMEOUT).await {
                    Ok(_) => {
                        // Update ready state before emitting event (frontend can query this)
                        let ready_state = app_handle.state::<SidecarReadyState>();
                        let message = format!("Backend ready on port {}", launch.port);
                        if ready_state.update_if_current(
                            launch.generation,
                            SIDECAR_STATE_READY,
                            Some(launch.port),
                            message.clone(),
                        ) {
                            let _ = app_handle.emit(
                                "sidecar-event",
                                SidecarEvent {
                                    status: "ready".into(),
                                    message,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        log::error!("Health check failed: {}", e);
                        let ready_state = app_handle.state::<SidecarReadyState>();
                        if ready_state.update_if_current(
                            launch.generation,
                            SIDECAR_STATE_ERROR,
                            None,
                            e.clone(),
                        ) {
                            let _ = app_handle.emit(
                                "sidecar-event",
                                SidecarEvent {
                                    status: "error".into(),
                                    message: e,
                                },
                            );
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();

                let handle = window.app_handle().clone();
                match get_close_action(&handle) {
                    CloseAction::Minimize => hide_main_window(&handle),
                    CloseAction::Quit => quit_application(&handle),
                    CloseAction::Ask => {
                        let _ = handle.emit("close-requested", ());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                kill_sidecar(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod portable_layout_tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "xiaojuclaw-{name}-{}-{}",
            std::process::id(),
            chrono_like_timestamp()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn explicit_marker_resolves_sibling_data_and_runtime() {
        let root = temp_root("portable-marker");
        let app_dir = root.join("XiaoJuClaw");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(
            app_dir.join(PORTABLE_LAYOUT_FILE),
            r#"{
  "schemaVersion": 1,
  "dataDir": "../XiaoJuClawData",
  "runtimeDir": "../XiaoJuClawRuntime"
}"#,
        )
        .unwrap();

        assert!(is_portable_install_at(&app_dir));
        assert_eq!(
            resolve_marked_portable_dir(&app_dir, false),
            Some(root.join(PORTABLE_DATA_DIR))
        );
        assert_eq!(
            resolve_marked_portable_dir(&app_dir, true),
            Some(root.join(PORTABLE_RUNTIME_DIR))
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_usb_data_directory_remains_a_portable_signal() {
        let root = temp_root("portable-legacy");
        std::fs::create_dir_all(root.join(PORTABLE_DATA_DIR)).unwrap();

        assert!(has_legacy_portable_layout(&root));
        assert!(is_portable_install_at(&root));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writable_directory_without_marker_is_not_portable() {
        let root = temp_root("installed-writable");
        assert!(is_writable_dir(&root));
        assert!(!is_portable_install_at(&root));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_marker_overrides_legacy_data_signal() {
        let root = temp_root("installed-marker");
        let tools = root.join(PORTABLE_DATA_DIR).join("tools");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::write(tools.join("manifest.json"), "{}").unwrap();
        std::fs::write(root.join(INSTALLED_LAYOUT_FILE), "{}").unwrap();

        assert!(has_legacy_portable_layout(&root));
        assert!(!is_portable_install_at(&root));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_nsis_uninstaller_overrides_sibling_data_signal() {
        let root = temp_root("installed-uninstaller");
        std::fs::create_dir_all(root.join(PORTABLE_DATA_DIR)).unwrap();
        std::fs::write(root.join("uninstall.exe"), "stub").unwrap();

        assert!(has_legacy_portable_layout(&root));
        assert!(has_installed_layout(&root));
        assert!(!is_portable_install_at(&root));

        std::fs::remove_dir_all(root).unwrap();
    }
}
