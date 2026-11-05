//! 统一更新服务：检查 / 下载 / 安装重启的单一状态机。
//!
//! 托盘与前端弹窗共用同一份快照：状态变更统一经 [`set_phase`] 写快照 → emit
//! `update-state` → 刷新托盘菜单；前端只订阅事件，不再自己调用 JS 版 updater。
//! 主窗口关闭（轻量模式、隐藏到托盘）时托盘仍可独立走完 检查 → 下载 → 重启。
//!
//! 检查复用 `wb_switch_core::modules::update::update_check`（release 资产端点 + 302 兜底，
//! 不占 GitHub API 配额）；下载走 tauri-plugin-updater 的 Rust API（签名校验在
//! `Update::download` 内部完成），代理取自 `update::load_github_config()` 的 `proxy`。
//!
//! **安装时机**：下载完成的包暂存在内存（`PACKAGE`），由用户点「重启以完成升级」时才
//! 安装。Windows NSIS 安装器要求应用退出后才能完成安装，下载即安装等于强制自动重启；
//! macOS 安装可能触发 `/Applications` 写授权，放在用户主动动作时语义才自然。

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use wb_switch_core::modules::config::now_secs;
use wb_switch_core::modules::update;

const BUSY_MESSAGE: &str = "更新任务正在进行中，请稍候";
const NO_PACKAGE_MESSAGE: &str = "没有可安装的更新包，请先下载更新包";
const DEMO_DOWNLOAD_MESSAGE: &str = "演示模式已跳过更新下载";
const DEMO_RESTART_MESSAGE: &str = "演示模式已跳过更新安装";

/// 更新阶段。前端与托盘菜单都只读这一份状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// 尚未检查 / 未开始。
    Idle,
    /// 正在检查更新源。
    Checking,
    /// 已是最新版本。
    UpToDate,
    /// 有新版且可下载。
    Available,
    /// 正在后台下载更新包。
    Downloading,
    /// 包已下载完成，等待用户重启（安装发生在重启时）。
    ReadyToRestart,
    /// 检查 / 下载 / 安装失败，可按文案重试。
    Error,
}

/// 更新状态快照：命令返回值、`update-state` 事件负载、托盘菜单文案的唯一来源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub phase: UpdatePhase,
    /// 目标版本号（无 `v` 前缀）；检查失败或已是最新时为 None。
    pub latest: Option<String>,
    /// 下载进度（0-100）；总量未知（无 `Content-Length`）时为 None。
    pub percent: Option<u8>,
    /// 错误 / 提示文案。
    pub message: Option<String>,
    /// 最近一次检查完成时刻（秒）。
    pub checked_at: Option<i64>,
    pub manual_url: Option<String>,
    pub manual_sha256: Option<String>,
}

impl UpdateSnapshot {
    fn idle() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            latest: None,
            percent: None,
            message: None,
            checked_at: None,
            manual_url: None,
            manual_sha256: None,
        }
    }
}

/// 已下载的更新包：bytes 交给 `Update::install`，`update` 提供安装上下文
/// （安装目标路径、安装器参数等，无法在外部重建）。
struct DownloadedPackage {
    version: String,
    bytes: Vec<u8>,
    update: tauri_plugin_updater::Update,
}

static SNAPSHOT: OnceLock<Mutex<UpdateSnapshot>> = OnceLock::new();
static MANIFEST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static BACKEND_OVERRIDE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static BACKEND_GENERATION: AtomicU64 = AtomicU64::new(0);
static PACKAGE: OnceLock<Mutex<Option<DownloadedPackage>>> = OnceLock::new();
/// 「检查 / 下载 / 安装」共用互斥：任一任务在跑时重复点击直接拒绝。
static BUSY: AtomicBool = AtomicBool::new(false);
/// 托盘菜单重建档位（每 10% 一档）；`u8::MAX` 表示当前无下载进度。
static MENU_PROGRESS_BUCKET: AtomicU8 = AtomicU8::new(u8::MAX);
/// 本轮下载是否已打过「进度开始上报」日志（排障用，一次下载只打一行）。
static PROGRESS_REPORTED: AtomicBool = AtomicBool::new(false);

const DEFAULT_BACKEND: &str = "https://woai.info/admin/api";

fn normalize_backend(value: &str) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(value.trim()).map_err(|_| "后台地址无效")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if !(url.scheme() == "https" || (local && url.scheme() == "http"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("后台地址须使用 HTTPS".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    let path = if path.ends_with("/api") {
        path
    } else {
        format!("{path}/api")
    };
    url.set_path(&path);
    Ok(url)
}

fn backend_file() -> std::path::PathBuf {
    wb_switch_core::modules::config::store_dir().join("update_backend_url.txt")
}

pub fn configure_backend(value: &str) -> Result<bool, String> {
    let parsed = normalize_backend(value);
    let url = parsed
        .as_ref()
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "INVALID".into());
    let path = backend_file();
    let changed = std::fs::read_to_string(&path).ok().as_deref() != Some(url.as_str());
    if changed {
        BACKEND_GENERATION.fetch_add(1, Ordering::AcqRel);
        *BACKEND_OVERRIDE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some("INVALID".into());
        *MANIFEST
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *package_cell().lock().unwrap_or_else(|e| e.into_inner()) = None;
        with_snapshot(|s| {
            *s = UpdateSnapshot::idle();
            s.phase = UpdatePhase::Error;
            s.message = Some("后台更新地址保存失败".into());
        });
        std::fs::create_dir_all(path.parent().ok_or("后台配置路径无效")?)
            .map_err(|e| format!("后台更新地址保存失败：{e}"))?;
        std::fs::write(path, &url).map_err(|e| format!("后台更新地址保存失败：{e}"))?;
        with_snapshot(|s| *s = UpdateSnapshot::idle());
    }
    *BACKEND_OVERRIDE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(url);
    if let Err(error) = &parsed {
        with_snapshot(|s| {
            s.phase = UpdatePhase::Error;
            s.message = Some(error.clone());
            s.latest = None;
            s.manual_url = None;
            s.manual_sha256 = None;
        });
    }
    parsed.map(|_| changed)
}

fn configured_backend() -> Result<tauri::Url, String> {
    let saved = BACKEND_OVERRIDE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .or_else(|| std::fs::read_to_string(backend_file()).ok());
    normalize_backend(saved.as_deref().unwrap_or(DEFAULT_BACKEND))
}

fn version_parts(value: &str) -> Option<Vec<u64>> {
    let parts: Vec<_> = value.trim().trim_start_matches('v').split('.').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    parts.iter().map(|part| part.parse().ok()).collect()
}

fn asset_matches(platform: &str, arch: &str, filename: &str) -> bool {
    let name = filename.to_ascii_lowercase();
    match (platform, arch) {
        ("windows", "x86_64") => !name.contains("arm64") && !name.contains("aarch64"),
        ("macos", "aarch64") => {
            name.contains("arm64") || name.contains("aarch64") || name.contains("universal")
        }
        ("macos", "x86_64") => {
            name.contains("x64")
                || name.contains("x86_64")
                || name.contains("intel")
                || name.contains("universal")
        }
        _ => false,
    }
}

fn installed_distribution() -> bool {
    #[cfg(target_os = "windows")]
    {
        return std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("uninstall.exe").is_file()))
            .unwrap_or(false);
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::current_exe()
            .ok()
            .map(|p| p.starts_with("/Applications"))
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

fn choose_release(
    data: &Value,
    base: &tauri::Url,
    platform: &str,
    arch: &str,
    installed: bool,
) -> Result<Value, String> {
    let releases = data
        .get("data")
        .and_then(Value::as_array)
        .ok_or("后台版本数据无效")?;
    if releases.is_empty() {
        return Err("后台尚未发布版本".into());
    }
    let current = version_parts(update::APP_VERSION).ok_or("当前版本号无效")?;
    let mut best: Option<(Vec<u64>, Value)> = None;
    let mut newer_without_package = false;
    let mut saw_stable = false;
    for release in releases {
        if release.get("enabled").and_then(Value::as_bool) != Some(true)
            || release
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("stable")
                != "stable"
        {
            continue;
        }
        let version = release.get("version").and_then(Value::as_str).unwrap_or("");
        let Some(parts) = version_parts(version) else {
            continue;
        };
        saw_stable = true;
        if parts > current {
            newer_without_package = true;
        }
        if parts <= current || best.as_ref().is_some_and(|(p, _)| parts <= *p) {
            continue;
        }
        let Some(file) = release.get("files").and_then(|f| f.get(platform)) else {
            continue;
        };
        if file.get("downloadEnabled").and_then(Value::as_bool) != Some(true)
            || !asset_matches(
                platform,
                arch,
                file.get("name").and_then(Value::as_str).unwrap_or(""),
            )
        {
            continue;
        }
        let Some(storage) = file.get("storageName").and_then(Value::as_str).filter(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
                && *s != "."
                && *s != ".."
        }) else {
            continue;
        };
        let Some(checksum) = file.get("sha256").and_then(Value::as_str).filter(|value| {
            value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) else {
            continue;
        };
        let mut download = base.clone();
        download.set_path(&format!(
            "{}/client/releases/files/{storage}",
            base.path().trim_end_matches('/')
        ));
        let manifest = release
            .get("manifestUrl")
            .and_then(Value::as_str)
            .and_then(|s| tauri::Url::parse(s).ok())
            .filter(|u| {
                u.scheme() == "https"
                    && u.origin() == base.origin()
                    && u.username().is_empty()
                    && u.password().is_none()
            });
        let signed = installed && manifest.is_some();
        best = Some((
            parts,
            json!({"ok": true, "current": update::APP_VERSION, "latest": version.trim_start_matches('v'), "hasUpdate": true, "releaseUrl": download.as_str(), "manualUrl": if signed { None } else { Some(download.as_str()) }, "manualSha256": if signed { None } else { Some(checksum.to_ascii_lowercase()) }, "manifestUrl": if signed { manifest.map(|u| u.to_string()) } else { None }, "checkedAt": now_secs()}),
        ));
    }
    if let Some((_, value)) = best {
        return Ok(value);
    }
    if newer_without_package {
        return Err("后台有新版本，暂无适配此设备的更新包".into());
    }
    if !saw_stable {
        return Err("后台暂无可用的正式版本".into());
    }
    Ok(
        json!({"ok":true, "current":update::APP_VERSION, "latest":update::APP_VERSION, "hasUpdate":false, "checkedAt":now_secs()}),
    )
}

// ---------------------------------------------------------------------------
// 互斥
// ---------------------------------------------------------------------------

/// 更新任务互斥 guard：覆盖「检查 / 下载 / 安装」全过程，drop 即释放。
struct BusyGuard;

impl BusyGuard {
    /// 抢占更新任务；已有任务在跑时返回 None（调用方按各自契约拒绝）。
    fn acquire() -> Option<Self> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// 快照读写（无宿主依赖：单测直接驱动这一层）
// ---------------------------------------------------------------------------

fn snapshot_cell() -> &'static Mutex<UpdateSnapshot> {
    SNAPSHOT.get_or_init(|| Mutex::new(UpdateSnapshot::idle()))
}

fn package_cell() -> &'static Mutex<Option<DownloadedPackage>> {
    PACKAGE.get_or_init(|| Mutex::new(None))
}

fn with_snapshot<T>(edit: impl FnOnce(&mut UpdateSnapshot) -> T) -> T {
    let mut guard = snapshot_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    edit(&mut guard)
}

/// 读当前快照（`update_state` 命令与托盘菜单共用）。
pub fn snapshot() -> UpdateSnapshot {
    with_snapshot(|snapshot| snapshot.clone())
}

/// 进入检查阶段。
///
/// 下载中 / 已就绪不被后台检查改写：否则托盘菜单会从「正在下载 / 重启以完成升级」
/// 闪回「正在检查…」，用户正准备点的入口会消失。
fn begin_check() -> UpdateSnapshot {
    with_snapshot(|snapshot| {
        if matches!(
            snapshot.phase,
            UpdatePhase::Downloading | UpdatePhase::ReadyToRestart
        ) {
            return snapshot.clone();
        }
        snapshot.phase = UpdatePhase::Checking;
        snapshot.percent = None;
        snapshot.message = None;
        snapshot.clone()
    })
}

/// 写入检查结果（`ok=false` 或 `hasUpdate=false` 分别落到 Error / UpToDate）。
fn apply_check_result(result: &Value) -> UpdateSnapshot {
    with_snapshot(|snapshot| {
        if matches!(
            snapshot.phase,
            UpdatePhase::Downloading | UpdatePhase::ReadyToRestart
        ) {
            return snapshot.clone();
        }
        snapshot.percent = None;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            snapshot.phase = UpdatePhase::Error;
            snapshot.latest = None;
            snapshot.manual_url = None;
            snapshot.manual_sha256 = None;
            snapshot.message = result
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| result.get("error").and_then(Value::as_str))
                .map(str::to_string);
            return snapshot.clone();
        }
        let latest = result
            .get("latest")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let has_update =
            result.get("hasUpdate").and_then(Value::as_bool) == Some(true) && !latest.is_empty();
        snapshot.phase = if has_update {
            UpdatePhase::Available
        } else {
            UpdatePhase::UpToDate
        };
        snapshot.latest = has_update.then_some(latest);
        snapshot.manual_url = if has_update {
            result
                .get("manualUrl")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        };
        snapshot.manual_sha256 = if has_update {
            result
                .get("manualSha256")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        };
        snapshot.message = None;
        snapshot.checked_at = result
            .get("checkedAt")
            .and_then(Value::as_i64)
            .or_else(|| Some(now_secs()));
        snapshot.clone()
    })
}

/// 进入下载阶段（进度百分比由首个 chunk 回调填入，总量未知时保持 None）。
fn begin_download(latest: &str) -> UpdateSnapshot {
    MENU_PROGRESS_BUCKET.store(0, Ordering::Release);
    PROGRESS_REPORTED.store(false, Ordering::Release);
    with_snapshot(|snapshot| {
        snapshot.phase = UpdatePhase::Downloading;
        snapshot.latest = Some(latest.to_string());
        snapshot.percent = None;
        snapshot.message = None;
        snapshot.clone()
    })
}

/// 下载完成：包已存入 `PACKAGE`，菜单转为「重启以完成升级」。
fn mark_ready_to_restart(latest: &str) -> UpdateSnapshot {
    MENU_PROGRESS_BUCKET.store(u8::MAX, Ordering::Release);
    with_snapshot(|snapshot| {
        snapshot.phase = UpdatePhase::ReadyToRestart;
        snapshot.latest = Some(latest.to_string());
        snapshot.percent = Some(100);
        snapshot.message = None;
        snapshot.clone()
    })
}

/// 失败：置 Error（保留 `latest`，托盘据此区分「检查失败」与「下载失败」两种重试文案）。
fn fail(message: String) -> UpdateSnapshot {
    MENU_PROGRESS_BUCKET.store(u8::MAX, Ordering::Release);
    with_snapshot(|snapshot| {
        snapshot.phase = UpdatePhase::Error;
        snapshot.percent = None;
        snapshot.message = Some(message);
        snapshot.clone()
    })
}

/// 下载进度换算：总量未知或为 0 → None；超出总量按 100 截断。
fn percent_of(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    let percent = downloaded.saturating_mul(100) / total;
    Some(percent.min(100) as u8)
}

/// 记录一次进度回调：整数百分比变化才写快照并返回新值（未变化返回 None）。
fn advance_progress(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let percent = percent_of(downloaded, total)?;
    with_snapshot(|snapshot| {
        if snapshot.percent == Some(percent) {
            return None;
        }
        snapshot.percent = Some(percent);
        Some(percent)
    })
}

/// 菜单重建判定：跨 10% 档时才重建（每 1% 重建会让打开的菜单闪掉）。
fn should_rebuild_menu(percent: u8) -> bool {
    let bucket = percent / 10;
    MENU_PROGRESS_BUCKET.swap(bucket, Ordering::AcqRel) != bucket
}

// ---------------------------------------------------------------------------
// 对外能力
// ---------------------------------------------------------------------------

/// 检查更新：走状态机（Checking → Available / UpToDate / Error），返回与旧
/// `check_update` 完全同形的结果（前端展示与 webui 侧契约不变）。
///
/// 已有更新任务在跑时直接返回忙碌错误，不并发触发第二次检查。
pub async fn check<R: Runtime>(app: &AppHandle<R>, _proxy: Option<&str>, force: bool) -> Value {
    let Some(_busy) = BusyGuard::acquire() else {
        // 互斥拒绝不写日志到 stderr 之外：托盘文案已表达同一件事。
        eprintln!("[更新] 已有任务在跑，跳过本次检查");
        let mut value = json!({
            "ok": false,
            "error": BUSY_MESSAGE,
            "message": BUSY_MESSAGE,
        });
        value["releaseUrl"] = json!(release_url());
        return value;
    };
    eprintln!("[更新] 检查更新（force={force}）");
    set_phase(app, begin_check());
    let generation = BACKEND_GENERATION.load(Ordering::Acquire);
    let result = match async {
        let base = configured_backend()?;
        let mut url = base.clone();
        url.set_path(&format!(
            "{}/client/releases",
            base.path().trim_end_matches('/')
        ));
        let mut client_builder = reqwest::Client::builder().timeout(Duration::from_secs(15));
        if let Some(proxy) = configured_proxy() {
            client_builder = client_builder
                .proxy(reqwest::Proxy::all(&proxy).map_err(|error| format!("更新代理地址无效：{error}"))?);
        }
        let response = client_builder
            .build()
            .map_err(|e| e.to_string())?
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let data: Value = response.json().await.map_err(|e| e.to_string())?;
        if data.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err("后台版本查询失败".to_string());
        }
        choose_release(
            &data,
            &base,
            std::env::consts::OS,
            std::env::consts::ARCH,
            installed_distribution(),
        )
    }
    .await
    {
        Ok(value) => value,
        Err(error) => json!({"ok": false, "error": error, "message": error}),
    };
    if BACKEND_GENERATION.load(Ordering::Acquire) != generation {
        return json!({"ok":false,"error":"后台地址已更改，请重新检查"});
    }
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        *MANIFEST
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = result
            .get("manifestUrl")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    publish_check_result(app, result)
}

/// 处理前端 WebView 已经拿到的版本响应。
///
/// Windows 上 WebView 使用系统代理链路，而 Rust 的 reqwest 链路可能被本机网络设备
/// 在 TLS 握手阶段重置。前端请求成功后仍交回这里做平台、版本、文件名和校验值校验，
/// 不信任前端自行拼出的下载地址。
pub fn apply_external_check<R: Runtime>(app: &AppHandle<R>, data: Value) -> Value {
    let result = match configured_backend() {
        Ok(base) => {
            if data.get("ok").and_then(Value::as_bool) != Some(true) {
                Err("后台版本查询失败".to_string())
            } else {
                choose_release(
                    &data,
                    &base,
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    installed_distribution(),
                )
            }
        }
        Err(error) => Err(error),
    };
    let result = match result {
        Ok(value) => value,
        Err(error) => json!({"ok": false, "error": error, "message": error}),
    };
    publish_check_result(app, result)
}

fn publish_check_result<R: Runtime>(app: &AppHandle<R>, result: Value) -> Value {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        *MANIFEST
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = result
            .get("manifestUrl")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    let snapshot = set_phase(app, apply_check_result(&result));
    eprintln!(
        "[更新] 检查结果：{:?} latest={:?}",
        snapshot.phase, snapshot.latest
    );
    result
}

/// 启动下载：立即返回，进度走 `update-state` 事件与托盘 tooltip。
///
/// 下载在后台任务里进行（含重新 check 一次以拿到 `Update` 句柄），因此托盘与前端
/// 都不需要等网络；重复调用由 `BUSY` 拒绝。
pub fn start_download<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if crate::is_screenshot_demo() {
        return Err(DEMO_DOWNLOAD_MESSAGE.to_string());
    }
    if let Some(url) = snapshot().manual_url {
        return app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string());
    }
    let Some(busy) = BusyGuard::acquire() else {
        eprintln!("[更新] 已有任务在跑，跳过本次下载");
        return Err(BUSY_MESSAGE.to_string());
    };
    eprintln!("[更新] 启动下载任务");
    let app = app.clone();
    let generation = BACKEND_GENERATION.load(Ordering::Acquire);
    tauri::async_runtime::spawn(async move {
        let _busy = busy;
        let result = download_package(&app).await;
        if BACKEND_GENERATION.load(Ordering::Acquire) != generation {
            return;
        }
        match result {
            // 下载完成：包先暂存，等用户点「重启以完成升级」时才安装。
            Ok(Some(package)) => {
                let version = package.version.clone();
                eprintln!("[更新] 下载完成 v{version}（{} 字节）", package.bytes.len());
                store_package(package);
                set_phase(&app, mark_ready_to_restart(&version));
                reset_tooltip(&app);
                notify(
                    &app,
                    "更新已就绪",
                    &format!("v{version} 已下载完成，点「重启以完成升级」后生效"),
                );
            }
            // 更新源已无可用包（版本已追平）。
            Ok(None) => {
                eprintln!("[更新] 更新源无可用更新包，转为已是最新");
                set_phase(
                    &app,
                    apply_check_result(&json!({"ok": true, "hasUpdate": false})),
                );
                reset_tooltip(&app);
            }
            Err(message) => {
                eprintln!("[更新] 下载失败：{message}");
                set_phase(&app, fail(message.clone()));
                reset_tooltip(&app);
                notify(&app, "更新下载失败", &message);
            }
        }
    });
    Ok(())
}

/// 接收 WebView 下载的安装包，校验哈希后启动安装器并退出当前进程。
pub fn install_manual_package<R: Runtime>(
    app: &AppHandle<R>,
    version: &str,
    sha256: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let expected = sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("更新包校验值无效".into());
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err("更新包校验失败".into());
    }
    let safe_version = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        .collect::<String>();
    let path = std::env::temp_dir().join(format!("workbuddy-update-{safe_version}.exe"));
    std::fs::write(&path, bytes).map_err(|e| format!("保存更新包失败：{e}"))?;
    #[cfg(target_os = "windows")]
    {
        let installed_exe = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .ok_or("无法定位安装目录")?
            .join("小玉米")
            .join("小玉米.exe");
        let helper = std::env::temp_dir().join(format!(
            "workbuddy-update-launcher-{}.exe",
            std::process::id()
        ));
        let current_exe = std::env::current_exe().map_err(|e| format!("无法定位当前程序：{e}"))?;
        std::fs::copy(&current_exe, &helper)
            .map_err(|e| format!("创建更新启动助手失败：{e}"))?;
        std::process::Command::new(&helper)
            .arg("--wb-update-wait")
            .arg(&path)
            .arg(&installed_exe)
            .spawn()
            .map_err(|e| format!("启动更新助手失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(&path)
            .spawn()
            .map_err(|e| format!("启动安装程序失败：{e}"))?;
    }
    app.exit(0);
    Ok(())
}

/// 安装已下载的更新包并重启应用（用户点「重启以完成升级」时调用）。
///
/// 无包时返回可读错误（不 panic）；安装失败置 Error + 通知，并释放已暂存的包。
pub async fn restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if crate::is_screenshot_demo() {
        return Err(DEMO_RESTART_MESSAGE.to_string());
    }
    // 无包时返回可读错误（不 panic）。
    let package = take_package_for_install()?;
    let Some(_busy) = BusyGuard::acquire() else {
        store_package(package);
        return Err(BUSY_MESSAGE.to_string());
    };

    let DownloadedPackage {
        version,
        bytes,
        update,
    } = package;
    eprintln!("[更新] 开始安装 v{version}");
    // 安装会解压整包并替换应用（macOS 未授权时经 AppleScript 在主线程弹授权框），
    // 放 blocking 线程，避免占住 async worker。
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    match installed {
        Ok(Ok(())) => match crate::commands::relaunch_app_inner(app) {
            // macOS / Linux：安装已完成，由本进程拉起新版本。Windows 侧安装器会先让
            // 本进程退出（`install` 内部 `std::process::exit`），到不了这里。
            Ok(()) => Ok(()),
            Err(error) => {
                // 包已装好，重启失败只剩「手动重启」一条路：明确告知，避免用户以为要重下。
                let message = format!("v{version} 已安装，请手动重启应用完成升级：{error}");
                eprintln!("[更新] 重启失败：{message}");
                set_phase(app, fail(message.clone()));
                notify(app, "更新已安装", &message);
                Err(message)
            }
        },
        Ok(Err(error)) => {
            let message = format!("安装 v{version} 失败：{error}");
            eprintln!("[更新] {message}");
            set_phase(app, fail(message.clone()));
            notify(app, "更新安装失败", &message);
            Err(message)
        }
        Err(error) => {
            let message = format!("安装 v{version} 失败：{error}");
            eprintln!("[更新] {message}");
            set_phase(app, fail(message.clone()));
            notify(app, "更新安装失败", &message);
            Err(message)
        }
    }
}

// ---------------------------------------------------------------------------
// 下载 / 安装内部实现
// ---------------------------------------------------------------------------

/// 下载更新包：`Ok(None)` 表示更新源当前没有可用包（版本已追平）。
async fn download_package<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<DownloadedPackage>, String> {
    let manifest = MANIFEST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("后台未提供签名更新清单")?;
    let expected = snapshot().latest.ok_or("尚未选择更新版本")?;
    let builder = app
        .updater_builder()
        .endpoints(vec![
            tauri::Url::parse(&manifest).map_err(|e| e.to_string())?
        ])
        .map_err(|e| e.to_string())?;
    let builder = match configured_proxy() {
        Some(proxy) => builder.proxy(
            tauri::Url::parse(&proxy).map_err(|error| format!("更新代理地址无效：{error}"))?,
        ),
        None => builder,
    };
    let updater = builder
        .build()
        .map_err(|error| format!("初始化更新器失败：{error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查更新包失败：{error}"))?;
    let Some(update) = update else {
        return Ok(None);
    };

    let version = update.version.clone();
    if version_parts(&version) != version_parts(&expected) {
        return Err("签名更新版本与后台版本不一致".into());
    }
    set_phase(app, begin_download(&version));
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk_length, total| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                on_download_chunk(&progress_app, downloaded, total);
            },
            || {},
        )
        .await
        .map_err(|error| format!("下载更新包失败：{error}"))?;
    Ok(Some(DownloadedPackage {
        version,
        bytes,
        update,
    }))
}

/// 单个下载分包的回调：tooltip 实时更新；快照与事件按整数百分比；菜单跨 10% 才重建。
fn on_download_chunk<R: Runtime>(app: &AppHandle<R>, downloaded: u64, total: Option<u64>) {
    set_tooltip(app, &download_tooltip(percent_of(downloaded, total)));
    let Some(percent) = advance_progress(downloaded, total) else {
        return;
    };
    if !PROGRESS_REPORTED.swap(true, Ordering::AcqRel) {
        eprintln!("[更新] 进度开始上报：{percent}%（total={total:?}）");
    }
    let _ = app.emit("update-state", snapshot());
    if should_rebuild_menu(percent) {
        eprintln!("[更新] 下载进度 {percent}%（重建托盘菜单）");
        refresh_tray(app);
    }
}

fn download_tooltip(percent: Option<u8>) -> String {
    match percent {
        Some(percent) => format!("正在下载更新 {percent}%"),
        None => "正在下载更新…".to_string(),
    }
}

/// 更新代理：`update::load_github_config()` 的 `proxy` 注入 updater builder；留空表示不设置。
fn configured_proxy() -> Option<String> {
    update::load_github_config()
        .get("proxy")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|proxy| !proxy.is_empty())
        .map(str::to_string)
}

fn store_package(package: DownloadedPackage) {
    *package_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(package);
}

/// 取出待安装的包；无包时返回可读错误（不 panic）。
fn take_package_for_install() -> Result<DownloadedPackage, String> {
    take_package().ok_or_else(|| NO_PACKAGE_MESSAGE.to_string())
}

fn take_package() -> Option<DownloadedPackage> {
    package_cell()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

/// 公开更新页地址（按当前更新源配置拼装，与 core 的 `update_check` 同源）。
fn release_url() -> String {
    let config = update::load_github_config();
    let owner = config
        .get("owner")
        .and_then(Value::as_str)
        .filter(|owner| !owner.is_empty())
        .unwrap_or(update::GITHUB_OWNER);
    let repo = config
        .get("repo")
        .and_then(Value::as_str)
        .filter(|repo| !repo.is_empty())
        .unwrap_or(update::GITHUB_REPO);
    format!("https://github.com/{owner}/{repo}/releases/latest")
}

// ---------------------------------------------------------------------------
// 宿主出口：广播 / 托盘刷新 / tooltip / 通知
// ---------------------------------------------------------------------------

/// 统一状态出口：写好的快照经 emit + 托盘刷新对外可见。
fn set_phase<R: Runtime>(app: &AppHandle<R>, snapshot: UpdateSnapshot) -> UpdateSnapshot {
    let _ = app.emit("update-state", &snapshot);
    refresh_tray(app);
    snapshot
}

fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(desktop)]
    crate::tray::refresh_tray_menu(app);
    #[cfg(not(desktop))]
    let _ = app;
}

fn set_tooltip<R: Runtime>(app: &AppHandle<R>, text: &str) {
    #[cfg(desktop)]
    crate::tray::set_update_tooltip(app, text);
    #[cfg(not(desktop))]
    let _ = (app, text);
}

/// 更新流程结束（完成 / 失败）后把 tooltip 复位，避免长期停留在进度文案上。
fn reset_tooltip<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(desktop)]
    crate::tray::reset_tray_tooltip(app);
    #[cfg(not(desktop))]
    let _ = app;
}

fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    /// 快照 / BUSY / PACKAGE 都是进程级单例，用例之间必须串行。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> MutexGuard<'static, ()> {
        TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reset() {
        *snapshot_cell()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = UpdateSnapshot::idle();
        BUSY.store(false, Ordering::Release);
    }

    fn test_release(version: &str, platform: &str, name: &str, enabled: bool) -> Value {
        let checksum = "a".repeat(64);
        json!({"version":version, "channel":"stable", "enabled":true, "files":{platform:{"name":name, "storageName":"safe-123.exe", "sha256":checksum, "downloadEnabled":enabled}}})
    }

    #[test]
    fn backend_release_selection_uses_version_and_prefix() {
        let base = normalize_backend("https://woai.info/admin/api").unwrap();
        let releases = json!({"data":[test_release("9.0.0","windows","setup_x64.exe",true), test_release("10.0.0","windows","setup_x64.exe",true)]});
        let value = choose_release(&releases, &base, "windows", "x86_64", false).unwrap();
        assert_eq!(value["latest"], "10.0.0");
        assert_eq!(
            value["manualUrl"],
            "https://woai.info/admin/api/client/releases/files/safe-123.exe"
        );
    }

    #[test]
    fn missing_or_disabled_package_is_not_latest() {
        let base = normalize_backend(DEFAULT_BACKEND).unwrap();
        assert!(choose_release(&json!({"data":[]}), &base, "windows", "x86_64", false).is_err());
        let data = json!({"data":[test_release("9.0.0","windows","setup.exe",false)]});
        assert!(choose_release(&data, &base, "windows", "x86_64", false)
            .unwrap_err()
            .contains("暂无适配"));
        let old = json!({"data":[test_release("0.0.1","windows","setup.exe",true)]});
        assert_eq!(
            choose_release(&old, &base, "windows", "x86_64", false).unwrap()["hasUpdate"],
            false
        );
    }

    #[test]
    fn mac_packages_require_matching_architecture() {
        let base = normalize_backend(DEFAULT_BACKEND).unwrap();
        let data = json!({"data":[test_release("9.0.0","macos","app_aarch64.dmg",true)]});
        assert!(choose_release(&data, &base, "macos", "x86_64", false).is_err());
        assert!(choose_release(&data, &base, "macos", "aarch64", false).is_ok());
    }

    #[test]
    fn portable_and_untrusted_manifests_use_manual_download() {
        let base = normalize_backend(DEFAULT_BACKEND).unwrap();
        let mut release = test_release("9.0.0", "windows", "setup.exe", true);
        release["manifestUrl"] = json!("https://woai.info/admin/api/manifest.json");
        let data = json!({"data":[release]});
        let portable = choose_release(&data, &base, "windows", "x86_64", false).unwrap();
        assert!(portable["manualUrl"].is_string());
        let installed = choose_release(&data, &base, "windows", "x86_64", true).unwrap();
        assert!(installed["manualUrl"].is_null());
        assert!(installed["manifestUrl"].is_string());
        let mut untrusted = data.clone();
        untrusted["data"][0]["manifestUrl"] = json!("https://example.com/manifest.json");
        assert!(
            choose_release(&untrusted, &base, "windows", "x86_64", true).unwrap()["manualUrl"]
                .is_string()
        );
    }

    #[test]
    fn backend_and_download_path_validation() {
        assert!(normalize_backend("http://example.com").is_err());
        assert!(normalize_backend("https://user:password@example.com/api").is_err());
        assert_eq!(
            normalize_backend("http://127.0.0.1:57900")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:57900/api"
        );
        let mut bad = test_release("9.0.0", "windows", "setup.exe", true);
        bad["files"]["windows"]["storageName"] = json!("../../escape");
        assert!(choose_release(
            &json!({"data":[bad]}),
            &normalize_backend(DEFAULT_BACKEND).unwrap(),
            "windows",
            "x86_64",
            false
        )
        .is_err());
    }

    #[test]
    fn phases_flow_idle_available_downloading_ready_to_restart() {
        let _guard = lock();
        reset();
        assert_eq!(snapshot().phase, UpdatePhase::Idle);

        assert_eq!(begin_check().phase, UpdatePhase::Checking);

        let available = apply_check_result(&json!({
            "ok": true,
            "latest": "9.9.9",
            "hasUpdate": true,
            "checkedAt": 1_700_000_000,
        }));
        assert_eq!(available.phase, UpdatePhase::Available);
        assert_eq!(available.latest.as_deref(), Some("9.9.9"));
        assert_eq!(available.checked_at, Some(1_700_000_000));

        let downloading = begin_download("9.9.9");
        assert_eq!(downloading.phase, UpdatePhase::Downloading);
        assert_eq!(downloading.latest.as_deref(), Some("9.9.9"));
        assert_eq!(downloading.percent, None);

        assert_eq!(advance_progress(30, Some(100)), Some(30));
        assert_eq!(snapshot().percent, Some(30));

        let ready = mark_ready_to_restart("9.9.9");
        assert_eq!(ready.phase, UpdatePhase::ReadyToRestart);
        assert_eq!(ready.percent, Some(100));
        assert_eq!(ready.latest.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn check_without_update_lands_on_up_to_date() {
        let _guard = lock();
        reset();
        let snapshot =
            apply_check_result(&json!({"ok": true, "latest": "0.1.0", "hasUpdate": false}));
        assert_eq!(snapshot.phase, UpdatePhase::UpToDate);
        assert_eq!(snapshot.latest, None);
        assert!(snapshot.checked_at.is_some());
    }

    #[test]
    fn failed_check_lands_on_error_with_message() {
        let _guard = lock();
        reset();
        let snapshot = apply_check_result(&json!({
            "ok": false,
            "error": "网络请求失败",
            "message": "网络请求失败（code=-1）",
        }));
        assert_eq!(snapshot.phase, UpdatePhase::Error);
        assert_eq!(snapshot.message.as_deref(), Some("网络请求失败（code=-1）"));
        assert_eq!(snapshot.latest, None);
    }

    #[test]
    fn failed_recheck_clears_stale_available_target() {
        let _guard = lock();
        reset();
        apply_check_result(&json!({
            "ok": true,
            "latest": "9.9.9",
            "hasUpdate": true,
        }));
        assert_eq!(begin_check().phase, UpdatePhase::Checking);
        assert_eq!(snapshot().latest.as_deref(), Some("9.9.9"));
        let snapshot = apply_check_result(&json!({
            "ok": false,
            "error": "网络请求失败",
            "message": "网络请求失败（code=-1）",
        }));
        assert_eq!(snapshot.phase, UpdatePhase::Error);
        assert_eq!(snapshot.latest, None);
        assert_eq!(snapshot.message.as_deref(), Some("网络请求失败（code=-1）"));
    }

    #[test]
    fn failed_check_from_idle_still_errors() {
        let _guard = lock();
        reset();
        begin_check();
        let snapshot = apply_check_result(&json!({
            "ok": false,
            "error": "网络请求失败",
            "message": "网络请求失败（code=-1）",
        }));
        assert_eq!(snapshot.phase, UpdatePhase::Error);
        assert_eq!(snapshot.latest, None);
        assert_eq!(snapshot.message.as_deref(), Some("网络请求失败（code=-1）"));
    }

    /// 下载中 / 待重启不被后台检查改写：托盘升级入口不能闪掉。
    #[test]
    fn check_does_not_downgrade_downloading_or_ready_to_restart() {
        let _guard = lock();
        reset();
        begin_download("9.9.9");
        assert_eq!(begin_check().phase, UpdatePhase::Downloading);
        assert_eq!(
            apply_check_result(&json!({"ok": true, "latest": "9.9.10", "hasUpdate": true})).phase,
            UpdatePhase::Downloading
        );

        mark_ready_to_restart("9.9.9");
        assert_eq!(begin_check().phase, UpdatePhase::ReadyToRestart);
        assert_eq!(
            apply_check_result(&json!({"ok": true, "latest": "9.9.10", "hasUpdate": true})).phase,
            UpdatePhase::ReadyToRestart
        );
        assert_eq!(snapshot().phase, UpdatePhase::ReadyToRestart);
    }

    #[test]
    fn failed_download_keeps_target_version_for_retry() {
        let _guard = lock();
        reset();
        apply_check_result(&json!({"ok": true, "latest": "9.9.9", "hasUpdate": true}));
        begin_download("9.9.9");
        let snapshot = fail("下载更新包失败：连接超时".to_string());
        assert_eq!(snapshot.phase, UpdatePhase::Error);
        assert_eq!(snapshot.latest.as_deref(), Some("9.9.9"));
        assert_eq!(snapshot.percent, None);
    }

    #[test]
    fn busy_guard_rejects_second_entry_until_released() {
        let _guard = lock();
        reset();
        let first = BusyGuard::acquire();
        assert!(first.is_some(), "首次进入应拿到互斥");
        assert!(BusyGuard::acquire().is_none(), "并发进入必须被拒");
        drop(first);
        let second = BusyGuard::acquire();
        assert!(second.is_some(), "释放后应重新可进入");
        drop(second);
    }

    #[test]
    fn restart_without_package_returns_error_instead_of_panicking() {
        let _guard = lock();
        *package_cell()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let error = match take_package_for_install() {
            Ok(_) => panic!("无包时不应返回可安装的更新包"),
            Err(error) => error,
        };
        assert!(error.contains("没有可安装的更新包"), "{error}");
    }

    #[test]
    fn percent_conversion_clamps_and_handles_unknown_total() {
        assert_eq!(percent_of(0, Some(100)), Some(0));
        assert_eq!(percent_of(1, Some(3)), Some(33));
        assert_eq!(percent_of(99, Some(100)), Some(99));
        assert_eq!(percent_of(100, Some(100)), Some(100));
        assert_eq!(percent_of(150, Some(100)), Some(100), "超出总量按 100 截断");
        assert_eq!(percent_of(10, None), None, "无 Content-Length 时不报百分比");
        assert_eq!(percent_of(10, Some(0)), None, "总量为 0 不除零");
    }

    #[test]
    fn progress_snapshot_written_only_on_integer_change() {
        let _guard = lock();
        reset();
        begin_download("9.9.9");
        assert_eq!(advance_progress(1, Some(1000)), Some(0));
        assert_eq!(
            advance_progress(2, Some(1000)),
            None,
            "同一整数百分比不重复写"
        );
        assert_eq!(advance_progress(10, Some(1000)), Some(1));
        assert_eq!(snapshot().percent, Some(1));
        assert_eq!(advance_progress(10, None), None, "总量未知不写百分比");
    }

    #[test]
    fn menu_rebuilds_once_per_ten_percent_bucket() {
        let _guard = lock();
        MENU_PROGRESS_BUCKET.store(0, Ordering::Release);
        assert!(!should_rebuild_menu(0));
        assert!(!should_rebuild_menu(3));
        assert!(!should_rebuild_menu(9));
        assert!(should_rebuild_menu(10));
        assert!(!should_rebuild_menu(11));
        assert!(should_rebuild_menu(100), "跨档必须重建");
        assert!(!should_rebuild_menu(100), "同档不重复重建");
    }

    /// 事件 / 命令负载的字段契约（前端 `UpdateSnapshot` 按此解析）。
    #[test]
    fn snapshot_serializes_camel_case_contract() {
        let _guard = lock();
        reset();
        let value = serde_json::to_value(UpdateSnapshot::idle()).unwrap();
        assert_eq!(value["phase"], json!("idle"));
        assert_eq!(value["latest"], json!(null));
        assert_eq!(value["percent"], json!(null));
        assert_eq!(value["message"], json!(null));
        assert_eq!(value["checkedAt"], json!(null));

        let value = serde_json::to_value(mark_ready_to_restart("1.2.3")).unwrap();
        assert_eq!(value["phase"], json!("readyToRestart"));
        assert_eq!(value["latest"], json!("1.2.3"));
        assert_eq!(value["percent"], json!(100));
    }

    #[test]
    fn download_tooltip_reports_percent_or_unknown() {
        assert_eq!(download_tooltip(Some(42)), "正在下载更新 42%");
        assert_eq!(download_tooltip(None), "正在下载更新…");
    }
}
