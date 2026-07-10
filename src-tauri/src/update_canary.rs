//! [XJC-PATCH] Privacy-safe canary updater support.
//!
//! The raw installation identifier is generated from OS randomness and stays in
//! the user-owned data directory. It is sent only to fixed XiaoJuClaw update
//! endpoints; the MVP hashes it with its own HMAC secret.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::{current_exe_dir, is_portable_install, resolve_portable_data_dir, OFFLINE_BUILD};

const DEFAULT_UPDATE_BASE: &str = "https://www.xiaojuclaw.top";
const DEVICE_ID_PREFIX: &str = "xjc-install-";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_TELEMETRY_EVENTS: usize = 200;
const UPDATE_DEVICE_HEADER: &str = "x-xjc-device-id";
const PORTABLE_MANIFEST_PATH: &str = "/api/client/portable/manifest.json";
const INSTALLER_MANIFEST_PATH: &str = "/api/client/releases/latest.json";
const UPDATE_TELEMETRY_PATH: &str = "/api/client/update-telemetry";
const PORTABLE_DOWNLOAD_PREFIX: &str = "/api/client/portable/download/";
const BUILD_COMMIT: &str = env!("XJC_BUILD_COMMIT");
const BUILD_DIRTY: &str = env!("XJC_BUILD_DIRTY");

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCohort {
    pub name: String,
    pub bucket: u32,
    pub identity: String,
    pub source: String,
    pub partial: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PortableManifestFile {
    pub name: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    pub url: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableManifestSignature {
    #[serde(default)]
    pub algorithm: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub signed_payload_sha256: String,
    #[serde(default)]
    pub signed_payload: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableManifest {
    #[serde(default)]
    pub release_id: String,
    pub version: String,
    #[serde(default = "default_stable_channel")]
    pub channel: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub force_update: bool,
    #[serde(default)]
    pub cohort: UpdateCohort,
    #[serde(default)]
    pub signature: PortableManifestSignature,
    #[serde(default)]
    pub files: Vec<PortableManifestFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SignedPortableFile {
    name: String,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedPortablePayload {
    schema: String,
    release_id: String,
    version: String,
    channel: String,
    notes: String,
    force_update: bool,
    emergency_policy: bool,
    files: Vec<SignedPortableFile>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOfferContext {
    pub release_id: String,
    pub release_kind: String,
    pub release_version: String,
    pub channel: String,
    pub cohort: String,
}

impl UpdateOfferContext {
    pub fn is_usable(&self) -> bool {
        !self.release_id.is_empty()
            && matches!(self.release_kind.as_str(), "installer" | "portable")
            && !self.release_version.is_empty()
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct InstallerUpdateCheck {
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub force_update: bool,
    pub release_id: String,
    pub release_channel: String,
    pub cohort: UpdateCohort,
    pub signature_verification: String,
}

pub struct InstallerOffer {
    update: Update,
    context: UpdateOfferContext,
}

#[derive(Default)]
pub struct InstallerUpdateState(pub Mutex<Option<InstallerOffer>>);

#[derive(Default)]
pub struct PortableOfferState(pub Mutex<Option<UpdateOfferContext>>);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStartupStatus {
    pub previous_failure: bool,
    pub relaunch_success: bool,
    pub version: String,
    pub update_type: String,
}

#[derive(Default)]
pub struct UpdateStartupState(pub Mutex<UpdateStartupStatus>);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDiagnostics {
    pub version: String,
    pub release_channel: String,
    pub update_type: String,
    pub commit: String,
    pub provenance_status: String,
    pub provenance_variant: String,
    pub provenance_dirty: Option<bool>,
    pub signature_verification: String,
    pub signature_key_id: String,
    pub signature_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureStatus {
    status: String,
    key_id: String,
    version: String,
    update_type: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingUpdate {
    context: UpdateOfferContext,
    #[serde(default)]
    apply_success_reported: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TelemetryPayload {
    stage: String,
    ok: bool,
    duration_ms: Option<u64>,
    error_code: String,
    reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct QueuedTelemetryEvent {
    id: String,
    app_version: String,
    platform: String,
    event_type: String,
    release_id: String,
    release_kind: String,
    release_version: String,
    channel: String,
    cohort: String,
    payload: TelemetryPayload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutgoingTelemetry<'a> {
    device_id: &'a str,
    app_version: &'a str,
    platform: &'a str,
    event_type: &'a str,
    release_id: &'a str,
    release_kind: &'a str,
    cohort: &'a str,
    payload: &'a TelemetryPayload,
}

#[derive(Clone, Copy)]
pub enum LifecycleStage {
    DownloadStarted,
    DownloadCompleted,
    ApplyStarted,
    ApplySuccess,
    RelaunchSuccess,
    Failure {
        stage: &'static str,
        error_code: &'static str,
        reason: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ManifestSignatureError {
    MissingKey,
    UnknownKey,
    UnsupportedAlgorithm,
    InvalidEncoding,
    PayloadHashMismatch,
    InvalidSignature,
    PayloadMismatch,
    UntrustedDownloadUrl,
}

impl ManifestSignatureError {
    fn status(&self) -> &'static str {
        match self {
            Self::MissingKey => "missing-key",
            Self::UnknownKey => "unknown-key",
            Self::UnsupportedAlgorithm => "unsupported-algorithm",
            Self::InvalidEncoding => "invalid-encoding",
            Self::PayloadHashMismatch => "payload-hash-mismatch",
            Self::InvalidSignature => "invalid-signature",
            Self::PayloadMismatch => "payload-mismatch",
            Self::UntrustedDownloadUrl => "untrusted-download-url",
        }
    }
}

fn default_stable_channel() -> String {
    "stable".to_string()
}

pub fn normalize_release_channel(value: Option<&str>) -> String {
    match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("beta") => "beta".to_string(),
        _ => "stable".to_string(),
    }
}

pub fn effective_update_type(offline: bool, debug: bool, portable: bool) -> &'static str {
    if offline {
        "disabled"
    } else if !debug && portable {
        "portable"
    } else {
        "installer"
    }
}

pub fn current_update_type() -> &'static str {
    effective_update_type(OFFLINE_BUILD, cfg!(debug_assertions), is_portable_install())
}

fn update_root(app: &AppHandle) -> PathBuf {
    resolve_portable_data_dir(app).join("updates")
}

fn device_id_path(app: &AppHandle) -> PathBuf {
    resolve_portable_data_dir(app)
        .join("update")
        .join("installation-id")
}

fn telemetry_path(app: &AppHandle) -> PathBuf {
    update_root(app).join("telemetry-queue.json")
}

fn pending_path(app: &AppHandle) -> PathBuf {
    update_root(app).join("pending-update.json")
}

pub fn applied_marker_path(app: &AppHandle) -> PathBuf {
    update_root(app).join("last-update-success.txt")
}

fn signature_status_path(app: &AppHandle) -> PathBuf {
    update_root(app).join("signature-status.json")
}

fn valid_device_id(value: &str) -> bool {
    value.len() == DEVICE_ID_PREFIX.len() + 64
        && value.starts_with(DEVICE_ID_PREFIX)
        && value[DEVICE_ID_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut random = vec![0u8; bytes];
    getrandom::fill(&mut random).map_err(|_| "OS random source unavailable".to_string())?;
    let mut encoded = String::with_capacity(bytes * 2);
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").map_err(|_| "random encoding failed".to_string())?;
    }
    Ok(encoded)
}

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn load_or_create_device_id_at(path: &Path) -> Result<String, String> {
    if let Some(existing) = read_trimmed(path) {
        if valid_device_id(&existing) {
            return Ok(existing);
        }
        let _ = std::fs::rename(path, path.with_extension("invalid"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "cannot create update data directory".to_string())?;
    }
    let generated = format!("{DEVICE_ID_PREFIX}{}", random_hex(32)?);
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(generated.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| "cannot persist installation identifier".to_string())?;
            Ok(generated)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let existing = read_trimmed(path)
                .filter(|value| valid_device_id(value))
                .ok_or_else(|| "installation identifier is invalid".to_string())?;
            Ok(existing)
        }
        Err(_) => Err("cannot persist installation identifier".to_string()),
    }
}

fn installation_id(app: &AppHandle) -> Result<String, String> {
    load_or_create_device_id_at(&device_id_path(app))
}

fn configured_update_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("XJC_UPDATE_BASE") {
            let value = value.trim().trim_end_matches('/');
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    option_env!("XJC_UPDATE_BASE")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_UPDATE_BASE)
        .trim_end_matches('/')
        .to_string()
}

fn update_base_url() -> Result<Url, String> {
    let url = Url::parse(&configured_update_base()).map_err(|_| "更新服务地址无效".to_string())?;
    let secure = url.scheme() == "https";
    let local_debug = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if !secure && !local_debug {
        return Err("更新服务必须使用 HTTPS".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("更新服务地址不得包含凭据".to_string());
    }
    Ok(url)
}

fn endpoint_url(path: &str) -> Result<Url, String> {
    update_base_url()?
        .join(path)
        .map_err(|_| "更新服务地址无效".to_string())
}

fn fixed_update_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .redirect(Policy::none())
        .build()
        .map_err(|_| "无法初始化更新网络客户端".to_string())
}

fn configured_portable_key() -> Result<(String, String), ManifestSignatureError> {
    let mut key_id = option_env!("XJC_PORTABLE_UPDATE_PUBLIC_KEY_ID")
        .unwrap_or("")
        .trim()
        .to_string();
    let mut public_key = option_env!("XJC_PORTABLE_UPDATE_PUBLIC_KEY")
        .unwrap_or("")
        .trim()
        .to_string();
    if cfg!(debug_assertions) {
        if key_id.is_empty() {
            key_id = std::env::var("XJC_PORTABLE_UPDATE_PUBLIC_KEY_ID")
                .unwrap_or_default()
                .trim()
                .to_string();
        }
        if public_key.is_empty() {
            public_key = std::env::var("XJC_PORTABLE_UPDATE_PUBLIC_KEY")
                .unwrap_or_default()
                .trim()
                .to_string();
        }
    }
    if key_id.is_empty() || public_key.is_empty() {
        return Err(ManifestSignatureError::MissingKey);
    }
    Ok((key_id, public_key))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn trusted_portable_download_url(
    base: &Url,
    manifest: &PortableManifest,
    file: &PortableManifestFile,
) -> bool {
    let Ok(url) = Url::parse(&file.url) else {
        return false;
    };
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port_or_known_default() != base.port_or_known_default()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let expected = format!(
        "{PORTABLE_DOWNLOAD_PREFIX}{}/{}/{}",
        manifest.release_id, manifest.version, file.name
    );
    url.path() == expected
}

fn verify_portable_manifest_with_key(
    manifest: &PortableManifest,
    expected_key_id: &str,
    public_key_base64: &str,
    base: &Url,
) -> Result<(), ManifestSignatureError> {
    if manifest.signature.algorithm != "ed25519" {
        return Err(ManifestSignatureError::UnsupportedAlgorithm);
    }
    if manifest.signature.key_id != expected_key_id {
        return Err(ManifestSignatureError::UnknownKey);
    }
    let payload = BASE64
        .decode(&manifest.signature.signed_payload)
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    if payload.is_empty() || payload.len() > MAX_MANIFEST_BYTES as usize {
        return Err(ManifestSignatureError::InvalidEncoding);
    }
    if !is_sha256(&manifest.signature.signed_payload_sha256)
        || sha256_bytes(&payload)
            != manifest
                .signature
                .signed_payload_sha256
                .to_ascii_lowercase()
    {
        return Err(ManifestSignatureError::PayloadHashMismatch);
    }
    let public_key = BASE64
        .decode(public_key_base64)
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    let signature = BASE64
        .decode(&manifest.signature.value)
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    let signature = Signature::from_bytes(&signature);
    verifying_key
        .verify_strict(&payload, &signature)
        .map_err(|_| ManifestSignatureError::InvalidSignature)?;

    let signed = serde_json::from_slice::<SignedPortablePayload>(&payload)
        .map_err(|_| ManifestSignatureError::InvalidEncoding)?;
    let manifest_files = manifest
        .files
        .iter()
        .map(|file| SignedPortableFile {
            name: file.name.clone(),
            sha256: file.sha256.to_ascii_lowercase(),
            size: file.size,
        })
        .collect::<Vec<_>>();
    let signed_files = signed
        .files
        .iter()
        .map(|file| SignedPortableFile {
            name: file.name.clone(),
            sha256: file.sha256.to_ascii_lowercase(),
            size: file.size,
        })
        .collect::<Vec<_>>();
    let file_contract_valid = signed_files.len() == 2
        && signed_files.iter().all(|file| {
            matches!(
                file.name.as_str(),
                super::PORTABLE_MAIN_EXE | super::PORTABLE_SERVER_EXE
            ) && is_sha256(&file.sha256)
                && file.size > 0
        })
        && signed_files[0].name != signed_files[1].name;
    if signed.schema != "xjc-portable-manifest-v1"
        || signed.release_id != manifest.release_id
        || signed.version != manifest.version
        || signed.channel != manifest.channel
        || signed.notes != manifest.notes
        || signed.force_update != manifest.force_update
        || !matches!(signed.emergency_policy, true | false)
        || !file_contract_valid
        || signed_files != manifest_files
    {
        return Err(ManifestSignatureError::PayloadMismatch);
    }
    if manifest
        .files
        .iter()
        .any(|file| !trusted_portable_download_url(base, manifest, file))
    {
        return Err(ManifestSignatureError::UntrustedDownloadUrl);
    }
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "cannot create update data directory".to_string())?;
    }
    let temp = path.with_extension(format!("tmp-{}-{}", std::process::id(), random_hex(4)?));
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| "cannot encode update state".to_string())?;
    {
        let mut file = File::create(&temp).map_err(|_| "cannot write update state".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "cannot write update state".to_string())?;
    }
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&temp, path).map_err(|_| "cannot finalize update state".to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() > MAX_MANIFEST_BYTES as usize {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn persist_signature_status(
    app: &AppHandle,
    status: &str,
    key_id: &str,
    version: &str,
    update_type: &str,
) {
    let _ = write_json_atomic(
        &signature_status_path(app),
        &SignatureStatus {
            status: status.to_string(),
            key_id: key_id.chars().take(128).collect(),
            version: version.chars().take(32).collect(),
            update_type: update_type.to_string(),
        },
    );
}

pub fn fetch_portable_manifest(
    app: &AppHandle,
    current: &str,
    requested_channel: Option<&str>,
) -> Result<Option<PortableManifest>, String> {
    if OFFLINE_BUILD {
        return Err("离线版不提供自动更新".to_string());
    }
    let channel = normalize_release_channel(requested_channel);
    let base = update_base_url()?;
    let mut endpoint = endpoint_url(PORTABLE_MANIFEST_PATH)?;
    endpoint
        .query_pairs_mut()
        .append_pair("current", current)
        .append_pair("channel", &channel)
        .append_pair("platform", std::env::consts::OS);
    let device_id = installation_id(app)?;
    let client = fixed_update_client(Duration::from_secs(20))?;
    let mut response = client
        .get(endpoint)
        .header(UPDATE_DEVICE_HEADER, device_id)
        .send()
        .map_err(|_| "检查更新失败：网络不可用".to_string())?;
    if response.status().as_u16() == 204 {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("检查更新失败：HTTP {}", response.status().as_u16()));
    }
    if response.content_length().unwrap_or(0) > MAX_MANIFEST_BYTES {
        return Err("更新清单超过大小上限".to_string());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "更新清单读取失败".to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("更新清单超过大小上限".to_string());
    }
    let manifest = serde_json::from_slice::<PortableManifest>(&bytes)
        .map_err(|_| "更新清单解析失败".to_string())?;
    let configured = configured_portable_key();
    let verification = configured.and_then(|(key_id, key)| {
        verify_portable_manifest_with_key(&manifest, &key_id, &key, &base).map(|_| (key_id, key))
    });
    match verification {
        Ok((key_id, _)) => {
            if manifest.channel != channel {
                persist_signature_status(
                    app,
                    "channel-mismatch",
                    &key_id,
                    &manifest.version,
                    "portable",
                );
                return Err("更新清单通道不匹配".to_string());
            }
            persist_signature_status(app, "verified", &key_id, &manifest.version, "portable");
            Ok(Some(manifest))
        }
        Err(error) => {
            persist_signature_status(
                app,
                error.status(),
                &manifest.signature.key_id,
                &manifest.version,
                "portable",
            );
            Err(format!("便携版更新签名验证失败：{}", error.status()))
        }
    }
}

pub fn offer_context_from_portable(manifest: &PortableManifest) -> UpdateOfferContext {
    UpdateOfferContext {
        release_id: manifest.release_id.clone(),
        release_kind: "portable".to_string(),
        release_version: manifest.version.clone(),
        channel: manifest.channel.clone(),
        cohort: manifest.cohort.name.clone(),
    }
}

pub fn send_portable_download(
    client: &Client,
    app: &AppHandle,
    manifest: &PortableManifest,
    file: &PortableManifestFile,
    current: &str,
) -> Result<reqwest::blocking::Response, String> {
    let base = update_base_url()?;
    if !trusted_portable_download_url(&base, manifest, file) {
        return Err("下载地址不属于受信任更新服务".to_string());
    }
    let mut url = Url::parse(&file.url).map_err(|_| "下载地址无效".to_string())?;
    url.query_pairs_mut()
        .append_pair("current", current)
        .append_pair("platform", std::env::consts::OS);
    let device_id = installation_id(app)?;
    client
        .get(url)
        .header(UPDATE_DEVICE_HEADER, device_id)
        .send()
        .map_err(|_| "下载更新失败：网络不可用".to_string())
}

fn new_event_id() -> String {
    random_hex(12)
        .map(|value| format!("uevt-{value}"))
        .unwrap_or_else(|_| format!("uevt-{}-{}", std::process::id(), unix_millis()))
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn safe_token(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .take(max)
        .collect()
}

fn safe_failure_stage(value: &str) -> String {
    match value {
        "download" | "apply" | "relaunch" | "startup" => value.to_string(),
        _ => "unknown".to_string(),
    }
}

fn safe_error_code(value: &str) -> String {
    match value {
        "INSTALLER_DOWNLOAD_FAILED"
        | "INSTALLER_SIGNATURE_FAILED"
        | "INSTALLER_APPLY_FAILED"
        | "PORTABLE_DOWNLOAD_FAILED"
        | "PORTABLE_HASH_MISMATCH"
        | "PORTABLE_APPLY_FAILED"
        | "PORTABLE_SWAP_FAILED"
        | "PORTABLE_SIGNATURE_FAILED" => value.to_string(),
        _ => "UNKNOWN".to_string(),
    }
}

fn safe_reason(value: &str) -> String {
    match value {
        "network unavailable"
        | "signature verification failed"
        | "download verification failed"
        | "update apply failed"
        | "portable swap failed" => value.to_string(),
        _ => String::new(),
    }
}

fn safe_cohort(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric() || matches!(ch, ':' | '_' | '-' | '.'))
        .take(128)
        .collect()
}

fn make_telemetry_event(
    app_version: &str,
    context: &UpdateOfferContext,
    stage: LifecycleStage,
) -> Option<QueuedTelemetryEvent> {
    if !context.is_usable() {
        return None;
    }
    let (event_type, payload) = match stage {
        LifecycleStage::DownloadStarted => (
            "download",
            TelemetryPayload {
                stage: "download_started".to_string(),
                ok: true,
                duration_ms: None,
                error_code: String::new(),
                reason: String::new(),
            },
        ),
        LifecycleStage::DownloadCompleted => (
            "download",
            TelemetryPayload {
                stage: "download_completed".to_string(),
                ok: true,
                duration_ms: None,
                error_code: String::new(),
                reason: String::new(),
            },
        ),
        LifecycleStage::ApplyStarted => (
            "apply",
            TelemetryPayload {
                stage: "apply_started".to_string(),
                ok: true,
                duration_ms: None,
                error_code: String::new(),
                reason: String::new(),
            },
        ),
        LifecycleStage::ApplySuccess => (
            "apply",
            TelemetryPayload {
                stage: "apply_success".to_string(),
                ok: true,
                duration_ms: None,
                error_code: String::new(),
                reason: String::new(),
            },
        ),
        LifecycleStage::RelaunchSuccess => (
            "relaunch",
            TelemetryPayload {
                stage: "relaunch_success".to_string(),
                ok: true,
                duration_ms: None,
                error_code: String::new(),
                reason: String::new(),
            },
        ),
        LifecycleStage::Failure {
            stage,
            error_code,
            reason,
        } => (
            "failure",
            TelemetryPayload {
                stage: safe_failure_stage(stage),
                ok: false,
                duration_ms: None,
                error_code: safe_error_code(error_code),
                reason: safe_reason(reason),
            },
        ),
    };
    Some(QueuedTelemetryEvent {
        id: new_event_id(),
        app_version: safe_token(app_version, 32),
        platform: safe_token(std::env::consts::OS, 32),
        event_type: event_type.to_string(),
        release_id: safe_token(&context.release_id, 128),
        release_kind: context.release_kind.clone(),
        release_version: safe_token(&context.release_version, 32),
        channel: normalize_release_channel(Some(&context.channel)),
        cohort: safe_cohort(&context.cohort),
        payload,
    })
}

fn telemetry_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_telemetry_queue(path: &Path) -> Vec<QueuedTelemetryEvent> {
    read_json::<Vec<QueuedTelemetryEvent>>(path).unwrap_or_default()
}

fn queue_event_at(path: &Path, event: QueuedTelemetryEvent) -> Result<(), String> {
    let _guard = telemetry_lock()
        .lock()
        .map_err(|_| "telemetry queue lock failed".to_string())?;
    let mut events = read_telemetry_queue(path);
    events.push(event);
    if events.len() > MAX_TELEMETRY_EVENTS {
        events.drain(0..events.len() - MAX_TELEMETRY_EVENTS);
    }
    write_json_atomic(path, &events)
}

pub fn queue_lifecycle_event(app: &AppHandle, context: &UpdateOfferContext, stage: LifecycleStage) {
    if OFFLINE_BUILD {
        return;
    }
    let version = app.config().version.clone().unwrap_or_default();
    if let Some(event) = make_telemetry_event(&version, context, stage) {
        let _ = queue_event_at(&telemetry_path(app), event);
    }
}

fn remove_queued_event(path: &Path, id: &str) {
    let Ok(_guard) = telemetry_lock().lock() else {
        return;
    };
    let mut events = read_telemetry_queue(path);
    let original = events.len();
    events.retain(|event| event.id != id);
    if events.len() != original {
        let _ = write_json_atomic(path, &events);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueueDelivery {
    Remove,
    RetryLater,
}

fn flush_queue_at(path: &Path, mut deliver: impl FnMut(&QueuedTelemetryEvent) -> QueueDelivery) {
    loop {
        let event = {
            let Ok(_guard) = telemetry_lock().lock() else {
                return;
            };
            read_telemetry_queue(path).into_iter().next()
        };
        let Some(event) = event else {
            return;
        };
        match deliver(&event) {
            QueueDelivery::Remove => remove_queued_event(path, &event.id),
            QueueDelivery::RetryLater => return,
        }
    }
}

fn flush_telemetry_blocking(app: &AppHandle) {
    if OFFLINE_BUILD {
        return;
    }
    let Ok(endpoint) = endpoint_url(UPDATE_TELEMETRY_PATH) else {
        return;
    };
    let Ok(device_id) = installation_id(app) else {
        return;
    };
    let Ok(client) = fixed_update_client(Duration::from_secs(8)) else {
        return;
    };
    let path = telemetry_path(app);
    flush_queue_at(&path, |event| {
        let outgoing = OutgoingTelemetry {
            device_id: &device_id,
            app_version: &event.app_version,
            platform: &event.platform,
            event_type: &event.event_type,
            release_id: &event.release_id,
            release_kind: &event.release_kind,
            cohort: &event.cohort,
            payload: &event.payload,
        };
        let response = client.post(endpoint.clone()).json(&outgoing).send();
        match response {
            Ok(response) if response.status().is_success() => QueueDelivery::Remove,
            Ok(response)
                if response.status().is_client_error()
                    && response.status().as_u16() != 408
                    && response.status().as_u16() != 429 =>
            {
                // A permanent contract/release error must not poison the queue.
                QueueDelivery::Remove
            }
            _ => QueueDelivery::RetryLater,
        }
    });
}

fn schedule_telemetry_flush(app: AppHandle) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        flush_telemetry_blocking(&app);
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub fn flush_update_telemetry(app: AppHandle) {
    if !OFFLINE_BUILD {
        schedule_telemetry_flush(app);
    }
}

pub fn write_pending_update(app: &AppHandle, context: &UpdateOfferContext) {
    let _ = std::fs::remove_file(applied_marker_path(app));
    let _ = write_json_atomic(
        &pending_path(app),
        &PendingUpdate {
            context: context.clone(),
            apply_success_reported: false,
        },
    );
}

pub fn clear_pending_update(app: &AppHandle) {
    let _ = std::fs::remove_file(pending_path(app));
}

fn process_startup_files_at(
    updates_root: &Path,
    current_version: &str,
) -> (
    UpdateStartupStatus,
    Vec<(UpdateOfferContext, LifecycleStage)>,
) {
    let marker = updates_root.join("last-update-failed.txt");
    let applied_marker = updates_root.join("last-update-success.txt");
    let pending_file = updates_root.join("pending-update.json");
    let pending = read_json::<PendingUpdate>(&pending_file);
    let mut status = UpdateStartupStatus::default();
    let mut events = Vec::new();
    if marker.is_file() {
        status.previous_failure = true;
        if let Some(pending) = pending {
            status.version = pending.context.release_version.clone();
            status.update_type = pending.context.release_kind.clone();
            events.push((
                pending.context,
                LifecycleStage::Failure {
                    stage: "apply",
                    error_code: "PORTABLE_SWAP_FAILED",
                    reason: "portable swap failed",
                },
            ));
        }
        let _ = std::fs::remove_file(marker);
        let _ = std::fs::remove_file(applied_marker);
        let _ = std::fs::remove_file(pending_file);
        return (status, events);
    }
    if let Some(pending) = pending {
        let applied_version = read_trimmed(&applied_marker).unwrap_or_default();
        let applied = if pending.context.release_kind == "portable" {
            pending.context.release_version == applied_version
        } else {
            pending.context.release_version == current_version
        };
        if applied {
            status.relaunch_success = true;
            status.version = pending.context.release_version.clone();
            status.update_type = pending.context.release_kind.clone();
            if !pending.apply_success_reported {
                events.push((pending.context.clone(), LifecycleStage::ApplySuccess));
            }
            events.push((pending.context, LifecycleStage::RelaunchSuccess));
            let _ = std::fs::remove_file(pending_file);
        }
        let _ = std::fs::remove_file(applied_marker);
    }
    (status, events)
}

pub fn process_update_startup(app: &AppHandle) -> UpdateStartupStatus {
    let current = app.config().version.clone().unwrap_or_default();
    let (status, events) = process_startup_files_at(&update_root(app), &current);
    for (context, stage) in events {
        queue_lifecycle_event(app, &context, stage);
    }
    status
}

#[tauri::command]
pub fn get_update_startup_status(state: State<'_, UpdateStartupState>) -> UpdateStartupStatus {
    state
        .0
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

fn installer_context(update: &Update, channel: &str) -> UpdateOfferContext {
    let raw = &update.raw_json;
    UpdateOfferContext {
        release_id: raw
            .get("release_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        release_kind: "installer".to_string(),
        release_version: update.version.clone(),
        channel: raw
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or(channel)
            .to_string(),
        cohort: raw
            .get("cohort")
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

fn installer_cohort(update: &Update) -> UpdateCohort {
    update
        .raw_json
        .get("cohort")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn installer_update_check(
    app: AppHandle,
    channel: Option<String>,
    state: State<'_, InstallerUpdateState>,
) -> Result<InstallerUpdateCheck, String> {
    if OFFLINE_BUILD {
        return Err("离线版不提供自动更新".to_string());
    }
    if current_update_type() != "installer" {
        return Err("当前版本不使用安装包更新".to_string());
    }
    let channel = normalize_release_channel(channel.as_deref());
    let mut endpoint = endpoint_url(INSTALLER_MANIFEST_PATH)?;
    endpoint
        .query_pairs_mut()
        .append_pair("current", "{{current_version}}")
        .append_pair("platform", "{{target}}-{{arch}}")
        .append_pair("channel", &channel);
    let device_id = installation_id(&app)?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|_| "安装版更新端点配置无效".to_string())?
        .header(UPDATE_DEVICE_HEADER, device_id)
        .map_err(|_| "安装版更新请求头无效".to_string())?
        .timeout(Duration::from_secs(20))
        .configure_client(|builder| builder.redirect(reqwest::redirect::Policy::none()))
        .build()
        .map_err(|error| format!("初始化安装版更新失败：{error}"))?;
    let checked = updater
        .check()
        .await
        .map_err(|error| format!("检查安装版更新失败：{error}"))?;
    let Some(mut update) = checked else {
        if let Ok(mut current) = state.0.lock() {
            *current = None;
        }
        return Ok(InstallerUpdateCheck::default());
    };
    let context = installer_context(&update, &channel);
    if !context.is_usable() {
        return Err("安装版更新响应缺少 release_id".to_string());
    }
    let cohort = installer_cohort(&update);
    let force_update = update
        .raw_json
        .get("force_update")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result = InstallerUpdateCheck {
        available: true,
        version: update.version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        force_update,
        release_id: context.release_id.clone(),
        release_channel: context.channel.clone(),
        cohort,
        signature_verification: "pending-artifact-verification".to_string(),
    };
    // The stable identifier belongs only on the fixed manifest request. Tauri
    // otherwise propagates check headers to the arbitrary artifact URL.
    update.headers.clear();
    persist_signature_status(
        &app,
        "pending-artifact-verification",
        "tauri-updater",
        &context.release_version,
        "installer",
    );
    if let Ok(mut current) = state.0.lock() {
        *current = Some(InstallerOffer { update, context });
    }
    Ok(result)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallerProgress {
    phase: String,
    percent: u32,
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn installer_update_apply(
    app: AppHandle,
    state: State<'_, InstallerUpdateState>,
) -> Result<(), String> {
    if OFFLINE_BUILD {
        return Err("离线版不提供自动更新".to_string());
    }
    let offer = state
        .0
        .lock()
        .map_err(|_| "安装版更新状态不可用".to_string())?
        .take()
        .ok_or_else(|| "请先检查更新".to_string())?;
    let InstallerOffer { update, context } = offer;
    queue_lifecycle_event(&app, &context, LifecycleStage::DownloadStarted);
    schedule_telemetry_flush(app.clone());
    let started = Instant::now();
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded = 0u64;
    let mut total = 0u64;
    let bytes = update
        .download(
            move |chunk, content_length| {
                if total == 0 {
                    total = content_length.unwrap_or(0);
                }
                downloaded = downloaded.saturating_add(chunk as u64);
                let percent = if total > 0 {
                    ((downloaded.saturating_mul(100)) / total).min(100) as u32
                } else {
                    0
                };
                let _ = progress_app.emit(
                    "installer-update-progress",
                    InstallerProgress {
                        phase: "downloading".to_string(),
                        percent,
                        downloaded,
                        total,
                    },
                );
            },
            move || {
                let _ = finish_app.emit(
                    "installer-update-progress",
                    InstallerProgress {
                        phase: "downloaded".to_string(),
                        percent: 100,
                        downloaded: 0,
                        total: 0,
                    },
                );
            },
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(error) => {
            let signature_failure = error.to_string().to_ascii_lowercase().contains("signature");
            queue_lifecycle_event(
                &app,
                &context,
                LifecycleStage::Failure {
                    stage: "download",
                    error_code: if signature_failure {
                        "INSTALLER_SIGNATURE_FAILED"
                    } else {
                        "INSTALLER_DOWNLOAD_FAILED"
                    },
                    reason: if signature_failure {
                        "signature verification failed"
                    } else {
                        "network unavailable"
                    },
                },
            );
            schedule_telemetry_flush(app.clone());
            return Err(format!("安装包下载或签名验证失败：{error}"));
        }
    };
    let _elapsed = started.elapsed();
    queue_lifecycle_event(&app, &context, LifecycleStage::DownloadCompleted);
    persist_signature_status(
        &app,
        "verified",
        "tauri-updater",
        &context.release_version,
        "installer",
    );
    queue_lifecycle_event(&app, &context, LifecycleStage::ApplyStarted);
    write_pending_update(&app, &context);
    schedule_telemetry_flush(app.clone());
    let _ = app.emit(
        "installer-update-progress",
        InstallerProgress {
            phase: "applying".to_string(),
            percent: 100,
            downloaded: 0,
            total: 0,
        },
    );
    match update.install(&bytes) {
        Ok(()) => {
            queue_lifecycle_event(&app, &context, LifecycleStage::ApplySuccess);
            if let Some(mut pending) = read_json::<PendingUpdate>(&pending_path(&app)) {
                pending.apply_success_reported = true;
                let _ = write_json_atomic(&pending_path(&app), &pending);
            }
            schedule_telemetry_flush(app);
            Ok(())
        }
        Err(error) => {
            clear_pending_update(&app);
            queue_lifecycle_event(
                &app,
                &context,
                LifecycleStage::Failure {
                    stage: "apply",
                    error_code: "INSTALLER_APPLY_FAILED",
                    reason: "update apply failed",
                },
            );
            schedule_telemetry_flush(app);
            Err(format!("安装更新失败：{error}"))
        }
    }
}

fn provenance_summary(app: &AppHandle) -> (String, String, Option<bool>, String) {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = current_exe_dir() {
        candidates.push(exe_dir.join("build-provenance.json"));
        if let Some(parent) = exe_dir.parent() {
            candidates.push(parent.join("build-provenance.json"));
        }
    }
    for path in candidates {
        let Some(value) = read_json::<Value>(&path) else {
            continue;
        };
        let version = value.get("version").and_then(Value::as_str).unwrap_or("");
        let product = value.get("product").and_then(Value::as_str).unwrap_or("");
        let commit = value
            .get("source")
            .and_then(|source| source.get("commit"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let variant = value.get("variant").and_then(Value::as_str).unwrap_or("");
        let dirty = value
            .get("source")
            .and_then(|source| source.get("dirty"))
            .and_then(Value::as_bool);
        let expected = app.config().version.clone().unwrap_or_default();
        if product == "XiaoJuClaw"
            && version == expected
            && commit.len() == 40
            && commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return (
                "matched".to_string(),
                variant.to_string(),
                dirty,
                commit.to_string(),
            );
        }
        return (
            "invalid".to_string(),
            variant.to_string(),
            dirty,
            BUILD_COMMIT.to_string(),
        );
    }
    let dirty = BUILD_DIRTY == "true";
    (
        if dirty {
            "embedded-dirty"
        } else {
            "embedded-clean"
        }
        .to_string(),
        "embedded".to_string(),
        Some(dirty),
        BUILD_COMMIT.to_string(),
    )
}

#[tauri::command]
pub fn get_update_diagnostics(app: AppHandle, channel: Option<String>) -> UpdateDiagnostics {
    let update_type = current_update_type().to_string();
    let signature = read_json::<SignatureStatus>(&signature_status_path(&app))
        .filter(|value| value.update_type == update_type)
        .unwrap_or_else(|| {
            let (status, key_id) = match update_type.as_str() {
                "portable" => match configured_portable_key() {
                    Ok((key_id, _)) => ("not-checked".to_string(), key_id),
                    Err(error) => (error.status().to_string(), String::new()),
                },
                "installer" => ("not-checked".to_string(), "tauri-updater".to_string()),
                _ => ("disabled".to_string(), String::new()),
            };
            SignatureStatus {
                status,
                key_id,
                version: String::new(),
                update_type: update_type.clone(),
            }
        });
    let (provenance_status, provenance_variant, provenance_dirty, commit) =
        provenance_summary(&app);
    UpdateDiagnostics {
        version: app.config().version.clone().unwrap_or_default(),
        release_channel: normalize_release_channel(channel.as_deref()),
        update_type,
        commit,
        provenance_status,
        provenance_variant,
        provenance_dirty,
        signature_verification: signature.status,
        signature_key_id: signature.key_id,
        signature_version: signature.version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "xjc-update-canary-{name}-{}-{}",
            std::process::id(),
            unix_millis()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn test_context() -> UpdateOfferContext {
        UpdateOfferContext {
            release_id: "prel_test".to_string(),
            release_kind: "portable".to_string(),
            release_version: "2.0.0".to_string(),
            channel: "stable".to_string(),
            cohort: "percent:10".to_string(),
        }
    }

    fn signed_manifest(signing_key: &SigningKey, base: &Url) -> PortableManifest {
        let payload = br#"{"schema":"xjc-portable-manifest-v1","releaseId":"prel_test","version":"2.0.0","channel":"stable","notes":"safe notes","forceUpdate":false,"emergencyPolicy":false,"files":[{"name":"XiaoJuClaw.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":10},{"name":"XiaoJuClaw-server.exe","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":20}]}"#;
        let signature = signing_key.sign(payload);
        PortableManifest {
            release_id: "prel_test".to_string(),
            version: "2.0.0".to_string(),
            channel: "stable".to_string(),
            notes: "safe notes".to_string(),
            force_update: false,
            cohort: UpdateCohort::default(),
            signature: PortableManifestSignature {
                algorithm: "ed25519".to_string(),
                key_id: "test-key".to_string(),
                value: BASE64.encode(signature.to_bytes()),
                signed_payload_sha256: sha256_bytes(payload),
                signed_payload: BASE64.encode(payload),
            },
            files: vec![
                PortableManifestFile {
                    name: "XiaoJuClaw.exe".to_string(),
                    sha256: "a".repeat(64),
                    size: 10,
                    url: base
                        .join("/api/client/portable/download/prel_test/2.0.0/XiaoJuClaw.exe")
                        .unwrap()
                        .to_string(),
                },
                PortableManifestFile {
                    name: "XiaoJuClaw-server.exe".to_string(),
                    sha256: "b".repeat(64),
                    size: 20,
                    url: base
                        .join("/api/client/portable/download/prel_test/2.0.0/XiaoJuClaw-server.exe")
                        .unwrap()
                        .to_string(),
                },
            ],
        }
    }

    #[test]
    fn installation_id_is_random_and_stable_without_hardware_data() {
        let root = temp_root("device");
        let path = root.join("installation-id");
        let first = load_or_create_device_id_at(&path).unwrap();
        let second = load_or_create_device_id_at(&path).unwrap();
        assert_eq!(first, second);
        assert!(valid_device_id(&first));
        assert!(!first.contains(std::env::consts::ARCH));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn portable_signature_accepts_valid_and_rejects_invalid_or_unknown_key() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let base = Url::parse("https://updates.example.test").unwrap();
        let mut manifest = signed_manifest(&signing_key, &base);
        let public_key = BASE64.encode(signing_key.verifying_key().to_bytes());
        assert_eq!(
            verify_portable_manifest_with_key(&manifest, "test-key", &public_key, &base),
            Ok(())
        );
        assert_eq!(
            verify_portable_manifest_with_key(&manifest, "other-key", &public_key, &base),
            Err(ManifestSignatureError::UnknownKey)
        );
        manifest.signature.value = BASE64.encode([0u8; 64]);
        assert_eq!(
            verify_portable_manifest_with_key(&manifest, "test-key", &public_key, &base),
            Err(ManifestSignatureError::InvalidSignature)
        );
        manifest = signed_manifest(&signing_key, &base);
        manifest.files[0].sha256 = "c".repeat(64);
        assert_eq!(
            verify_portable_manifest_with_key(&manifest, "test-key", &public_key, &base),
            Err(ManifestSignatureError::PayloadMismatch)
        );
    }

    #[test]
    fn device_header_is_scoped_to_fixed_update_download_origin() {
        let signing_key = SigningKey::from_bytes(&[8u8; 32]);
        let base = Url::parse("https://updates.example.test").unwrap();
        let manifest = signed_manifest(&signing_key, &base);
        assert!(trusted_portable_download_url(
            &base,
            &manifest,
            &manifest.files[0]
        ));
        let mut tampered = signed_manifest(&signing_key, &base);
        tampered.files[0].url = "https://attacker.example/XiaoJuClaw.exe".to_string();
        assert!(!trusted_portable_download_url(
            &base,
            &tampered,
            &tampered.files[0]
        ));
    }

    #[test]
    fn telemetry_queue_redacts_free_form_errors_and_keeps_contract_dimensions() {
        let root = temp_root("telemetry");
        let path = root.join("queue.json");
        let context = test_context();
        let event = make_telemetry_event(
            "2.0.0",
            &context,
            LifecycleStage::Failure {
                stage: r#"C:\Users\secret\file"#,
                error_code: "TOKEN=secret/path",
                reason: "sk-secret raw error C:\\Users\\secret",
            },
        )
        .unwrap();
        queue_event_at(&path, event).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("Users"));
        assert!(!raw.contains("sk-secret"));
        assert!(!raw.contains("TOKEN="));
        let queued = read_telemetry_queue(&path);
        assert_eq!(queued[0].release_id, "prel_test");
        assert_eq!(queued[0].channel, "stable");
        assert_eq!(queued[0].cohort, "percent:10");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn telemetry_flush_retries_transient_failures_then_removes_success() {
        let root = temp_root("telemetry-retry");
        let path = root.join("queue.json");
        let event = make_telemetry_event("2.0.0", &test_context(), LifecycleStage::DownloadStarted)
            .unwrap();
        queue_event_at(&path, event).unwrap();

        flush_queue_at(&path, |_| QueueDelivery::RetryLater);
        assert_eq!(read_telemetry_queue(&path).len(), 1);

        flush_queue_at(&path, |_| QueueDelivery::Remove);
        assert!(read_telemetry_queue(&path).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn telemetry_request_matches_public_update_contract() {
        let event =
            make_telemetry_event("2.0.0", &test_context(), LifecycleStage::DownloadCompleted)
                .unwrap();
        let outgoing = OutgoingTelemetry {
            device_id: "xjc-install-test",
            app_version: &event.app_version,
            platform: &event.platform,
            event_type: &event.event_type,
            release_id: &event.release_id,
            release_kind: &event.release_kind,
            cohort: &event.cohort,
            payload: &event.payload,
        };
        let value = serde_json::to_value(outgoing).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "appVersion",
                "cohort",
                "deviceId",
                "eventType",
                "payload",
                "platform",
                "releaseId",
                "releaseKind",
            ]
        );
        assert_eq!(value["eventType"], "download");
        assert_eq!(value["payload"]["stage"], "download_completed");
        assert!(value.get("releaseVersion").is_none());
        assert!(value.get("channel").is_none());
    }

    #[test]
    fn failure_marker_is_surfaced_and_converted_to_failure_event() {
        let root = temp_root("marker");
        let pending = PendingUpdate {
            context: test_context(),
            apply_success_reported: false,
        };
        write_json_atomic(&root.join("pending-update.json"), &pending).unwrap();
        std::fs::write(root.join("last-update-failed.txt"), "update-failed").unwrap();
        let (status, events) = process_startup_files_at(&root, "1.0.0");
        assert!(status.previous_failure);
        assert_eq!(status.version, "2.0.0");
        assert_eq!(events.len(), 1);
        assert!(!root.join("last-update-failed.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relaunch_success_requires_the_portable_success_marker() {
        let root = temp_root("relaunch");
        let pending = PendingUpdate {
            context: test_context(),
            apply_success_reported: false,
        };
        write_json_atomic(&root.join("pending-update.json"), &pending).unwrap();
        let (old_status, old_events) = process_startup_files_at(&root, "1.0.0");
        assert!(!old_status.relaunch_success);
        assert!(old_events.is_empty());
        std::fs::write(root.join("last-update-success.txt"), "2.0.0").unwrap();
        let (status, events) = process_startup_files_at(&root, "2.0.0");
        assert!(status.relaunch_success);
        assert_eq!(events.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installer_relaunch_success_requires_the_installed_version() {
        let root = temp_root("installer-relaunch");
        let mut context = test_context();
        context.release_kind = "installer".to_string();
        let pending = PendingUpdate {
            context,
            apply_success_reported: true,
        };
        write_json_atomic(&root.join("pending-update.json"), &pending).unwrap();

        let (old_status, old_events) = process_startup_files_at(&root, "1.0.0");
        assert!(!old_status.relaunch_success);
        assert!(old_events.is_empty());
        let (status, events) = process_startup_files_at(&root, "2.0.0");
        assert!(status.relaunch_success);
        assert_eq!(events.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn offline_and_release_type_selection_fail_closed() {
        assert_eq!(effective_update_type(true, false, true), "disabled");
        assert_eq!(effective_update_type(false, false, true), "portable");
        assert_eq!(effective_update_type(false, false, false), "installer");
        assert_eq!(normalize_release_channel(Some("unknown")), "stable");
        assert_eq!(normalize_release_channel(Some("BETA")), "beta");
    }
}
