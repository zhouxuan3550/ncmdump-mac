use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::Color;
use tauri::{AppHandle, Emitter, Manager, TitleBarStyle};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Semaphore;

const APP_DATA_FILE: &str = "app-data.json";
const HISTORY_LIMIT: usize = 100;
const TRAY_SHOW: &str = "tray-show-window";
const TRAY_PICK_FILES: &str = "tray-pick-files";
const TRAY_PICK_FOLDER: &str = "tray-pick-folder";
const TRAY_CONVERT: &str = "tray-convert";
const TRAY_QUIT: &str = "tray-quit";

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConvertRequest {
    mode: ConvertMode,
    files: Vec<String>,
    folder: String,
    output_dir: Option<String>,
    recursive: bool,
    remove_original: bool,
    #[serde(default = "default_duplicate_policy")]
    duplicate_policy: DuplicatePolicy,
    #[serde(default)]
    organize_policy: OrganizePolicy,
    #[serde(default)]
    jobs: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    output_dir: Option<String>,
    #[serde(default = "default_true")]
    recursive: bool,
    #[serde(default)]
    remove_original: bool,
    #[serde(default = "default_jobs")]
    jobs: u32,
    #[serde(default = "default_true")]
    auto_scan_default: bool,
    #[serde(default = "default_true")]
    watch_default_cache: bool,
    #[serde(default)]
    auto_reveal_output: bool,
    #[serde(default = "default_duplicate_policy")]
    duplicate_policy: DuplicatePolicy,
    #[serde(default)]
    organize_policy: OrganizePolicy,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            output_dir: None,
            recursive: true,
            remove_original: false,
            jobs: default_jobs(),
            auto_scan_default: true,
            watch_default_cache: true,
            auto_reveal_output: false,
            duplicate_policy: default_duplicate_policy(),
            organize_policy: OrganizePolicy::None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum DuplicatePolicy {
    Rename,
    Skip,
    Overwrite,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "lowercase")]
enum OrganizePolicy {
    #[default]
    None,
    Artist,
    Album,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    source: String,
    output: Option<String>,
    success: bool,
    message: String,
    converted_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct AppStore {
    #[serde(default)]
    settings: AppSettings,
    #[serde(default)]
    history: Vec<HistoryRecord>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DefaultCacheScan {
    path: Option<String>,
    files: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppData {
    settings: AppSettings,
    history: Vec<HistoryRecord>,
    default_cache: DefaultCacheScan,
}

fn default_true() -> bool {
    true
}

fn default_jobs() -> u32 {
    2
}

fn default_duplicate_policy() -> DuplicatePolicy {
    DuplicatePolicy::Rename
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum ConvertMode {
    Files,
    Folder,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConversionResult {
    source: String,
    output: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    success: bool,
    message: String,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum ProgressStatus {
    Converting,
    Done,
    Failed,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConversionProgress {
    source: String,
    output: Option<String>,
    status: ProgressStatus,
    message: String,
    /// Bytes already dumped for the current file, or 0 if unknown.
    #[serde(default)]
    processed: u64,
    /// Total bytes of the source .ncm, or 0 if unknown.
    #[serde(default)]
    total: u64,
}

// Sidecar JSON protocol emitted by the C++ tool with `--json`. One JSON object
// per line, discriminated by `type`. This replaces every brittle string scan.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SidecarEvent {
    Done { payload: SidecarDone },
    Warn { payload: String },
    Error { payload: String },
    Info { payload: String },
    Progress { payload: SidecarProgress },
}

#[derive(Debug, Deserialize)]
struct SidecarDone {
    // `source` is part of the JSON protocol but Rust already knows which file
    // it asked about; kept here so future integrity checks can verify it.
    #[allow(dead_code)]
    source: String,
    output: String,
    #[allow(dead_code)]
    removed: bool,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    artist: Option<String>,
    #[serde(default)]
    album: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SidecarProgress {
    #[allow(dead_code)]
    source: String,
    processed: u64,
    total: u64,
}

// Cooperative cancellation shared across concurrent workers.
static CANCEL_FLAG: Lazy<Arc<AtomicBool>> = Lazy::new(|| Arc::new(AtomicBool::new(false)));

#[tauri::command]
async fn convert_ncm(
    app: AppHandle,
    request: ConvertRequest,
) -> Result<Vec<ConversionResult>, String> {
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let sources = collect_sources(&request)?;
    if sources.is_empty() {
        return Err("没有找到可转换的 .ncm 文件。".into());
    }

    let parallelism = request.jobs.filter(|n| *n >= 1).unwrap_or(2).min(8) as usize;
    let semaphore = Arc::new(Semaphore::new(parallelism));

    let mut tasks = Vec::with_capacity(sources.len());
    for source in sources {
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let app = app.clone();
        let request = request.clone();
        let source_string = source.to_string_lossy().to_string();
        let cancel = CANCEL_FLAG.clone();

        let _ = app.emit(
            "conversion-progress",
            ConversionProgress {
                source: source_string.clone(),
                output: None,
                status: ProgressStatus::Converting,
                message: "正在转换...".into(),
                processed: 0,
                total: 0,
            },
        );

        tasks.push(tokio::spawn(async move {
            let _permit = permit; // released on drop
            if cancel.load(Ordering::SeqCst) {
                return ConversionResult {
                    source: source_string,
                    output: None,
                    title: None,
                    artist: None,
                    album: None,
                    success: false,
                    message: "已取消".into(),
                };
            }
            convert_one(&app, &request, &source, &source_string).await
        }));
    }

    let mut results = Vec::with_capacity(tasks.len());
    for task in tasks {
        let result = match task.await {
            Ok(r) => r,
            Err(join_err) => ConversionResult {
                source: String::new(),
                output: None,
                title: None,
                artist: None,
                album: None,
                success: false,
                message: format!("内部任务失败：{join_err}"),
            },
        };
        let _ = app.emit(
            "conversion-progress",
            ConversionProgress {
                source: result.source.clone(),
                output: result.output.clone(),
                status: if result.success {
                    ProgressStatus::Done
                } else {
                    ProgressStatus::Failed
                },
                message: result.message.clone(),
                processed: 0,
                total: 0,
            },
        );
        results.push(result);
    }

    // macOS Notification Center: one banner per batch, not per file.
    // `show()` is fire-and-forget and auto-requests permission on first use.
    let ok = results.iter().filter(|r| r.success).count();
    let failed = results.len() - ok;
    if !results.is_empty() {
        let _ = append_history_records(&app, &results);

        use tauri_plugin_notification::NotificationExt;
        let title = if failed == 0 {
            "转换完成".to_string()
        } else {
            "转换完成（含失败）".to_string()
        };
        let body = if failed == 0 {
            format!("已成功转换 {ok} 个文件")
        } else {
            format!("成功 {ok} 个，失败 {failed} 个")
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }

    Ok(results)
}

#[tauri::command]
fn load_app_data(app: AppHandle) -> Result<AppData, String> {
    let store = read_store(&app)?;
    let default_cache = if store.settings.auto_scan_default {
        scan_default_cache()
    } else {
        DefaultCacheScan {
            path: None,
            files: Vec::new(),
        }
    };
    Ok(AppData {
        settings: store.settings,
        history: store.history,
        default_cache,
    })
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.settings = normalize_settings(settings);
    write_store(&app, &store)
}

#[tauri::command]
fn clear_history(app: AppHandle) -> Result<Vec<HistoryRecord>, String> {
    let mut store = read_store(&app)?;
    store.history.clear();
    write_store(&app, &store)?;
    Ok(store.history)
}

#[tauri::command]
fn delete_history_record(
    app: AppHandle,
    source: String,
    converted_at: u64,
) -> Result<Vec<HistoryRecord>, String> {
    let mut store = read_store(&app)?;
    store
        .history
        .retain(|item| !(item.source == source && item.converted_at == converted_at));
    write_store(&app, &store)?;
    Ok(store.history)
}

#[tauri::command]
fn scan_default_cache_now() -> Result<DefaultCacheScan, String> {
    Ok(scan_default_cache())
}

#[tauri::command]
fn update_tray_status(
    app: AppHandle,
    queue_count: usize,
    busy: bool,
    last_status: Option<String>,
) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let title = if busy {
            Some("转换中".to_string())
        } else if queue_count > 0 {
            Some(format!("{queue_count} 个"))
        } else {
            None
        };
        let tooltip = match (busy, queue_count, last_status) {
            (true, count, _) => format!("NCM 转换器 · 正在转换 {count} 个文件"),
            (false, count, _) if count > 0 => format!("NCM 转换器 · 队列 {count} 个文件"),
            (false, _, Some(status)) if !status.is_empty() => format!("NCM 转换器 · {status}"),
            _ => "NCM 转换器".to_string(),
        };
        let _ = tray.set_title(title);
        let _ = tray.set_tooltip(Some(tooltip));
    }
    Ok(())
}

#[tauri::command]
fn cancel_ncm() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn scan_ncm_paths(paths: Vec<String>, recursive: bool) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for path in paths {
        let path = PathBuf::from(path);
        if path.is_dir() {
            collect_ncm_files(&path, recursive, &mut files).map_err(|error| error.to_string())?;
        } else if path.is_file() && is_ncm_file(&path) {
            files.push(path);
        }
    }
    files.sort();
    files.dedup();
    Ok(files
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err(format!("文件不存在：{path:?}"));
    }

    reveal_path(&path)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let allowed = [
        "https://github.com/zhouxuan3550/ncmdump-mac",
        "https://api.github.com/repos/zhouxuan3550/ncmdump-mac",
    ];
    if !allowed.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("只能打开本应用的 GitHub 页面。".into());
    }

    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("无法打开链接：{error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开 Finder：{error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map_err(|error| format!("无法打开资源管理器：{error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_path(path: &Path) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::process::Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map_err(|error| format!("无法打开文件管理器：{error}"))?;
    Ok(())
}

fn collect_sources(request: &ConvertRequest) -> Result<Vec<PathBuf>, String> {
    match request.mode {
        ConvertMode::Files => Ok(request
            .files
            .iter()
            .map(PathBuf::from)
            .filter(|path| is_ncm_file(path))
            .collect()),
        ConvertMode::Folder => {
            let folder = PathBuf::from(&request.folder);
            if !folder.is_dir() {
                return Err("请选择一个有效的来源文件夹。".into());
            }
            let mut files = Vec::new();
            collect_ncm_files(&folder, request.recursive, &mut files)
                .map_err(|error| error.to_string())?;
            Ok(files)
        }
    }
}

fn app_data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(APP_DATA_FILE))
}

fn read_store(app: &AppHandle) -> Result<AppStore, String> {
    let path = app_data_path(app)?;
    if !path.exists() {
        return Ok(AppStore::default());
    }

    let raw = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    if raw.trim().is_empty() {
        return Ok(AppStore::default());
    }

    let mut store: AppStore = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    store.settings = normalize_settings(store.settings);
    if store.history.len() > HISTORY_LIMIT {
        store.history.truncate(HISTORY_LIMIT);
    }
    Ok(store)
}

fn write_store(app: &AppHandle, store: &AppStore) -> Result<(), String> {
    let path = app_data_path(app)?;
    let data = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    std::fs::write(path, data).map_err(|error| error.to_string())
}

fn normalize_settings(mut settings: AppSettings) -> AppSettings {
    settings.jobs = settings.jobs.clamp(1, 8);
    settings.output_dir = settings.output_dir.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    });
    settings
}

fn append_history_records(app: &AppHandle, results: &[ConversionResult]) -> Result<(), String> {
    let mut store = read_store(app)?;
    let converted_at = now_seconds();
    let mut next: Vec<HistoryRecord> = results
        .iter()
        .map(|result| HistoryRecord {
            source: result.source.clone(),
            output: result.output.clone(),
            success: result.success,
            message: result.message.clone(),
            converted_at,
        })
        .collect();
    next.extend(store.history);
    next.truncate(HISTORY_LIMIT);
    store.history = next;
    write_store(app, &store)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn scan_default_cache() -> DefaultCacheScan {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return DefaultCacheScan {
            path: None,
            files: Vec::new(),
        };
    };

    let candidates = [
        home.join("Music").join("网易云音乐"),
        home.join("Music").join("NetEase Cloud Music"),
        home.join("Library")
            .join("Containers")
            .join("com.netease.163music")
            .join("Data")
            .join("Music"),
        home.join("Library")
            .join("Containers")
            .join("com.netease.163music")
            .join("Data")
            .join("Documents"),
    ];

    for candidate in candidates {
        if !candidate.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        if collect_ncm_files(&candidate, true, &mut files).is_ok() && !files.is_empty() {
            files.sort();
            files.dedup();
            return DefaultCacheScan {
                path: Some(candidate.to_string_lossy().to_string()),
                files: files
                    .into_iter()
                    .map(|path| path.to_string_lossy().to_string())
                    .collect(),
            };
        }
    }

    DefaultCacheScan {
        path: None,
        files: Vec::new(),
    }
}

fn collect_ncm_files(
    folder: &Path,
    recursive: bool,
    files: &mut Vec<PathBuf>,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(folder)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() && recursive {
            collect_ncm_files(&path, recursive, files)?;
        } else if path.is_file() && is_ncm_file(&path) {
            files.push(path);
        }
    }
    Ok(())
}

// Pure extension check. Filesystem existence is the caller's responsibility,
// so this stays trivially testable and side-effect-free.
fn is_ncm_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("ncm"))
}

fn strip_ansi(s: &str) -> String {
    String::from_utf8_lossy(&strip_ansi_escapes::strip(s.as_bytes())).into_owned()
}

fn safe_path_segment(value: Option<&str>, fallback: &str) -> String {
    let cleaned = value
        .unwrap_or(fallback)
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            _ if ch.is_control() => ' ',
            _ => ch,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn unique_destination(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "converted".into());
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_string());

    for index in 2..1000 {
        let file_name = match &extension {
            Some(ext) if !ext.is_empty() => format!("{stem} {index}.{ext}"),
            _ => format!("{stem} {index}"),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    path
}

fn organize_output(
    output: Option<String>,
    policy: OrganizePolicy,
    artist: Option<&str>,
    album: Option<&str>,
) -> Result<Option<String>, String> {
    if matches!(policy, OrganizePolicy::None) {
        return Ok(output);
    }

    let Some(output) = output else {
        return Ok(None);
    };

    let source_path = PathBuf::from(&output);
    if !source_path.is_file() {
        return Ok(Some(output));
    }

    let Some(base_dir) = source_path.parent() else {
        return Ok(Some(output));
    };
    let Some(file_name) = source_path.file_name() else {
        return Ok(Some(output));
    };

    let artist_dir = safe_path_segment(artist, "未知歌手");
    let target_dir = match policy {
        OrganizePolicy::None => base_dir.to_path_buf(),
        OrganizePolicy::Artist => base_dir.join(artist_dir),
        OrganizePolicy::Album => base_dir
            .join(artist_dir)
            .join(safe_path_segment(album, "未知专辑")),
    };

    fs::create_dir_all(&target_dir).map_err(|error| format!("无法创建整理目录：{error}"))?;
    let target_path = unique_destination(target_dir.join(file_name));
    if target_path == source_path {
        return Ok(Some(output));
    }

    fs::rename(&source_path, &target_path)
        .or_else(|_| {
            fs::copy(&source_path, &target_path)?;
            fs::remove_file(&source_path)
        })
        .map_err(|error| format!("无法整理输出文件：{error}"))?;

    Ok(Some(target_path.to_string_lossy().to_string()))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn emit_tray_action(app: &AppHandle, action: &str) {
    show_main_window(app);
    let _ = app.emit("tray-action", action);
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "显示窗口", true, None::<&str>)?;
    let pick_files =
        MenuItem::with_id(app, TRAY_PICK_FILES, "选择 NCM 文件...", true, None::<&str>)?;
    let pick_folder = MenuItem::with_id(
        app,
        TRAY_PICK_FOLDER,
        "选择来源文件夹...",
        true,
        None::<&str>,
    )?;
    let convert = MenuItem::with_id(app, TRAY_CONVERT, "开始转换", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "退出 NCM 转换器", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &pick_files,
            &pick_folder,
            &convert,
            &separator,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("NCM 转换器")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW => show_main_window(app),
            TRAY_PICK_FILES => emit_tray_action(app, "pick-files"),
            TRAY_PICK_FOLDER => emit_tray_action(app, "pick-folder"),
            TRAY_CONVERT => emit_tray_action(app, "convert"),
            TRAY_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

async fn convert_one(
    app: &AppHandle,
    request: &ConvertRequest,
    source: &Path,
    source_string: &str,
) -> ConversionResult {
    let mut args: Vec<String> = vec![source.to_string_lossy().to_string()];
    if let Some(output_dir) = request
        .output_dir
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        args.push("-o".into());
        args.push(output_dir.clone());
    }
    if request.remove_original {
        args.push("-m".into());
    }
    args.push("--duplicate".into());
    args.push(match request.duplicate_policy {
        DuplicatePolicy::Rename => "rename".into(),
        DuplicatePolicy::Skip => "skip".into(),
        DuplicatePolicy::Overwrite => "overwrite".into(),
    });
    args.push("--json".into());
    args.push("-q".into()); // keep stdout reserved for JSON events

    let command = match app.shell().sidecar("ncmdump") {
        Ok(command) => command,
        Err(error) => {
            return ConversionResult {
                source: source_string.to_string(),
                output: None,
                title: None,
                artist: None,
                album: None,
                success: false,
                message: format!("无法启动转换器：{error}"),
            };
        }
    };

    match command.args(args).output().await {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let success = output.status.success();

            let mut collected_output: Option<String> = None;
            let mut collected_title: Option<String> = None;
            let mut collected_artist: Option<String> = None;
            let mut collected_album: Option<String> = None;
            let mut warnings: Vec<String> = Vec::new();
            let mut errors: Vec<String> = Vec::new();

            for line in stdout.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<SidecarEvent>(trimmed) {
                    Ok(SidecarEvent::Done { payload }) => {
                        collected_output = Some(payload.output);
                        collected_title = payload.title;
                        collected_artist = payload.artist;
                        collected_album = payload.album;
                    }
                    Ok(SidecarEvent::Warn { payload }) => warnings.push(payload),
                    Ok(SidecarEvent::Error { payload }) => errors.push(payload),
                    Ok(SidecarEvent::Info { payload }) => {
                        warnings.push(payload);
                    }
                    Ok(SidecarEvent::Progress { payload }) => {
                        // Forward every progress tick to the webview so the
                        // per-file bar can update at ~20 Hz.
                        let _ = app.emit(
                            "conversion-progress",
                            ConversionProgress {
                                source: source_string.to_string(),
                                output: None,
                                status: ProgressStatus::Converting,
                                message: "正在转换...".into(),
                                processed: payload.processed,
                                total: payload.total,
                            },
                        );
                    }
                    Err(_) => {
                        // Non-JSON line (banner, debug noise). Surface as a warning
                        // rather than failing the whole conversion.
                        warnings.push(strip_ansi(trimmed));
                    }
                }
            }

            if !success {
                let stderr_clean = strip_ansi(stderr.trim());
                if !stderr_clean.is_empty() {
                    errors.push(stderr_clean);
                }
                return ConversionResult {
                    source: source_string.to_string(),
                    output: collected_output,
                    title: collected_title,
                    artist: collected_artist,
                    album: collected_album,
                    success: false,
                    message: if errors.is_empty() {
                        "转换失败".into()
                    } else {
                        errors.join("; ")
                    },
                };
            }

            let message = if !errors.is_empty() {
                errors.join("; ")
            } else if !warnings.is_empty() {
                warnings.join("; ")
            } else {
                "转换完成".into()
            };

            let output = match organize_output(
                collected_output,
                request.organize_policy,
                collected_artist.as_deref(),
                collected_album.as_deref(),
            ) {
                Ok(output) => output,
                Err(error) => {
                    return ConversionResult {
                        source: source_string.to_string(),
                        output: None,
                        title: collected_title,
                        artist: collected_artist,
                        album: collected_album,
                        success: false,
                        message: error,
                    };
                }
            };

            ConversionResult {
                source: source_string.to_string(),
                output,
                title: collected_title,
                artist: collected_artist,
                album: collected_album,
                success: true,
                message,
            }
        }
        Err(error) => ConversionResult {
            source: source_string.to_string(),
            output: None,
            title: None,
            artist: None,
            album: None,
            success: false,
            message: format!("转换器运行失败：{error}"),
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            convert_ncm,
            load_app_data,
            save_settings,
            clear_history,
            delete_history_record,
            cancel_ncm,
            reveal_in_finder,
            open_url,
            scan_ncm_paths,
            scan_default_cache_now,
            update_tray_status
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                let _ = window.set_title("");
                let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));

                // Apply macOS NSVisualEffectView so the page's translucent panels
                // sit on top of real system vibrancy instead of a flat fill.
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{
                        apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                    };
                    let _ = clear_vibrancy(&window);
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        Some(18.0),
                    );
                }
            }
            let _ = app.path().app_config_dir().and_then(|path| {
                std::fs::create_dir_all(path)?;
                Ok(())
            });
            build_tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_done_event() {
        let raw =
            r#"{"type":"done","payload":{"source":"a.ncm","output":"a.mp3","removed":false}}"#;
        match serde_json::from_str::<SidecarEvent>(raw).unwrap() {
            SidecarEvent::Done { payload } => {
                assert_eq!(payload.source, "a.ncm");
                assert_eq!(payload.output, "a.mp3");
                assert!(!payload.removed);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn parses_warn_event() {
        let raw = r#"{"type":"warn","payload":"missing cover"}"#;
        match serde_json::from_str::<SidecarEvent>(raw).unwrap() {
            SidecarEvent::Warn { payload } => assert_eq!(payload, "missing cover"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn parses_error_event() {
        let raw = r#"{"type":"error","payload":"broken ncm"}"#;
        match serde_json::from_str::<SidecarEvent>(raw).unwrap() {
            SidecarEvent::Error { payload } => assert_eq!(payload, "broken ncm"),
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn is_ncm_file_is_case_insensitive() {
        assert!(is_ncm_file(Path::new("song.NCM")));
        assert!(is_ncm_file(Path::new("song.ncm")));
        assert!(!is_ncm_file(Path::new("song.mp3")));
        assert!(!is_ncm_file(Path::new("")));
    }
}
