//! Tauri commands: settings, sites, the local file system, connections and
//! transfers.

use crate::conn::{Conn, WalkItem};
use crate::settings::{Settings, Site, Store};
use crate::xfer::{sort_entries, Entry, Progress};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub store: Arc<Store>,
    sessions: Mutex<HashMap<String, Arc<Conn>>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next: AtomicU64,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self { store: Arc::new(store), sessions: Mutex::new(HashMap::new()), cancels: Mutex::new(HashMap::new()), next: AtomicU64::new(1) }
    }
    fn conn(&self, id: &str) -> Result<Arc<Conn>, String> {
        self.sessions.lock().unwrap().get(id).cloned().ok_or_else(|| "NOT_CONNECTED".to_string())
    }
}

// ───────────────────────────── settings & sites ─────────────────────────────

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.store.settings()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    state.store.save_settings(settings)
}

/// The UI tells the backend which language to use for its messages.
#[tauri::command]
pub fn set_ui_language(lang: String) {
    crate::settings::set_english(lang == "en");
}

#[tauri::command]
pub fn get_sites(state: State<'_, AppState>) -> Vec<Site> {
    state.store.sites()
}

#[tauri::command]
pub fn save_sites(state: State<'_, AppState>, sites: Vec<Site>) -> Result<(), String> {
    state.store.save_sites(sites)
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    config_dir: String,
    os: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        config_dir: state.store.dir().display().to_string(),
        os: std::env::consts::OS.into(),
    }
}

#[tauri::command]
pub fn set_zoom(window: tauri::WebviewWindow, scale: f64) -> Result<(), String> {
    window.set_zoom(scale.clamp(0.5, 3.0)).map_err(|e| e.to_string())
}

// ───────────────────────────── local file system ─────────────────────────────

#[derive(Serialize)]
pub struct LocalHome {
    home: String,
    roots: Vec<String>,
    sep: String,
}

#[tauri::command]
pub fn local_home(app: AppHandle) -> LocalHome {
    let home = app.path().home_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "/".into());
    #[cfg(windows)]
    let roots = (b'A'..=b'Z').map(|c| format!("{}:\\", c as char)).filter(|r| std::path::Path::new(r).exists()).collect();
    #[cfg(not(windows))]
    let roots = vec!["/".to_string()];
    LocalHome { home, roots, sep: std::path::MAIN_SEPARATOR.to_string() }
}

fn hidden(name: &str, md: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if md.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    let _ = md;
    name.starts_with('.')
}

fn mtime(md: &std::fs::Metadata) -> Option<i64> {
    md.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

#[tauri::command]
pub async fn local_list(path: String, show_hidden: bool) -> Result<Vec<Entry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut out = vec![];
        for e in std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
            let Ok(e) = e else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(lmd) = e.metadata() else { continue };
            let link = e.file_type().map(|t| t.is_symlink()).unwrap_or(false);
            let md = if link { std::fs::metadata(e.path()).unwrap_or(lmd) } else { lmd };
            if !show_hidden && hidden(&name, &md) {
                continue;
            }
            #[cfg(unix)]
            let perms = {
                use std::os::unix::fs::PermissionsExt;
                Some(crate::xfer::mode_string(md.permissions().mode()))
            };
            #[cfg(not(unix))]
            let perms = None;
            out.push(Entry { name, dir: md.is_dir(), size: if md.is_dir() { 0 } else { md.len() }, mtime: mtime(&md), perms, link });
        }
        sort_entries(&mut out);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub async fn local_remove(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let md = std::fs::symlink_metadata(&path).map_err(|e| format!("{path}: {e}"))?;
        if md.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) }.map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Stat {
    exists: bool,
    dir: bool,
    size: u64,
    mtime: Option<i64>,
}

#[tauri::command]
pub fn local_stat(path: String) -> Stat {
    match std::fs::metadata(&path) {
        Ok(md) => Stat { exists: true, dir: md.is_dir(), size: md.len(), mtime: mtime(&md) },
        Err(_) => Stat { exists: false, dir: false, size: 0, mtime: None },
    }
}

/// Everything under a local folder ("a/b.txt" style paths), folders first.
#[tauri::command]
pub async fn local_walk(path: String) -> Result<Vec<WalkItem>, String> {
    tokio::task::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&path);
        let mut out = vec![];
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).map_err(|e| format!("{}: {e}", d.display()))? {
                let Ok(e) = e else { continue };
                let p = e.path();
                let Ok(md) = std::fs::metadata(&p) else { continue };
                let rel = p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                if md.is_dir() {
                    stack.push(p);
                }
                out.push(WalkItem { rel, dir: md.is_dir(), size: if md.is_dir() { 0 } else { md.len() }, mtime: mtime(&md) });
            }
        }
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A fresh temporary folder for editing a remote file.
#[tauri::command]
pub fn temp_dir() -> Result<String, String> {
    let n = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let p = std::env::temp_dir().join("FtpStar").join(format!("{n:x}"));
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

use std::process::Command as Proc;

fn spawn(cmd: &mut Proc) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a file with its default application.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    return spawn(Proc::new("cmd").args(["/C", "start", ""]).arg(&path));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg(&path));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(&path));
}

/// Shows a file (selected) or folder in the system file manager.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    return spawn(Proc::new("explorer").arg(format!("/select,{}", path.replace('/', "\\"))));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg("-R").arg(&path));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(std::path::Path::new(&path).parent().unwrap_or(std::path::Path::new("/"))));
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links".into());
    }
    #[cfg(windows)]
    return spawn(Proc::new("rundll32").args(["url.dll,FileProtocolHandler", &url]));
    #[cfg(target_os = "macos")]
    return spawn(Proc::new("open").arg(&url));
    #[cfg(not(any(windows, target_os = "macos")))]
    return spawn(Proc::new("xdg-open").arg(&url));
}

// ───────────────────────────── connections ─────────────────────────────

#[derive(Serialize)]
pub struct Connected {
    session: String,
    home: String,
}

/// Opens a connection. `password` is used when the site has none saved;
/// `accept_fingerprint` trusts a new SSH host key the user has confirmed.
#[tauri::command]
pub async fn connect(state: State<'_, AppState>, site: Site, password: Option<String>, accept_fingerprint: Option<String>) -> Result<Connected, String> {
    let pass = if site.password.is_empty() { password.unwrap_or_default() } else { site.password.clone() };
    let store = state.store.clone();
    let (conn, mut home) = match site.protocol.as_str() {
        "ftp" | "ftps" | "ftps-implicit" => {
            let (c, home) = crate::ftp::Ftp::open(site.clone(), pass).await?;
            (Conn::Ftp(c), home)
        }
        "sftp" => {
            let host_key = format!("{}:{}", site.host.trim().to_lowercase(), site.port_or_default());
            let known = store.known_host(&host_key);
            let o = crate::sftp::Sftp::open(&site, &pass, known, accept_fingerprint).await?;
            if let Some(fp) = o.new_fingerprint {
                store.trust_host(&host_key, &fp)?;
            }
            (Conn::Sftp(o.conn), o.home)
        }
        "s3" => {
            let (c, home) = crate::s3::S3::open(&site, &pass).await?;
            (Conn::S3(c), home)
        }
        "onedrive" => {
            let client_id = store.settings().onedrive_client_id;
            let (st, id) = (store.clone(), site.id.clone());
            let save = Box::new(move |rt: &str| {
                let rt = rt.to_string();
                let _ = st.update_site(&id, |s| s.onedrive_refresh_token = rt);
            });
            (Conn::OneDrive(crate::onedrive::OneDrive::open(&client_id, &site.onedrive_refresh_token, save).await?), "/".into())
        }
        p => return Err(format!("unknown protocol: {p}")),
    };
    if !site.remote_dir.trim().is_empty() {
        home = site.remote_dir.trim().to_string();
    }
    let id = format!("s{}", state.next.fetch_add(1, Ordering::Relaxed));
    state.sessions.lock().unwrap().insert(id.clone(), Arc::new(conn));
    Ok(Connected { session: id, home })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session: String) -> Result<(), String> {
    let c = state.sessions.lock().unwrap().remove(&session);
    if let Some(c) = c {
        c.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_list(state: State<'_, AppState>, session: String, path: String) -> Result<Vec<Entry>, String> {
    state.conn(&session)?.list(&path).await
}

#[tauri::command]
pub async fn remote_walk(state: State<'_, AppState>, session: String, path: String) -> Result<Vec<WalkItem>, String> {
    state.conn(&session)?.walk(&path).await
}

#[tauri::command]
pub async fn remote_mkdir(state: State<'_, AppState>, session: String, path: String) -> Result<(), String> {
    state.conn(&session)?.mkdir(&path).await
}

#[tauri::command]
pub async fn remote_remove(state: State<'_, AppState>, session: String, path: String, dir: bool) -> Result<(), String> {
    state.conn(&session)?.remove(&path, dir).await
}

#[tauri::command]
pub async fn remote_rename(state: State<'_, AppState>, session: String, from: String, to: String, dir: bool) -> Result<(), String> {
    state.conn(&session)?.rename(&from, &to, dir).await
}

/// One file transfer; progress arrives as `xfer` events with this `id`.
/// `direction`: "down" (remote → local) or "up".
#[tauri::command]
pub async fn transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    session: String,
    id: String,
    direction: String,
    local: String,
    remote: String,
    size: u64,
) -> Result<u64, String> {
    let conn = state.conn(&session)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(id.clone(), cancel.clone());
    let p = Progress::new(Some(app), id.clone(), size, cancel);
    if direction == "down" {
        if let Some(dir) = std::path::Path::new(&local).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    let r = if direction == "down" { conn.download(&remote, &local, p.clone()).await } else { conn.upload(&local, &remote, p.clone()).await };
    p.emit(true);
    state.cancels.lock().unwrap().remove(&id);
    r.map(|_| p.done())
}

/// Thumbnail of a local image (data URL).
#[tauri::command]
pub async fn local_thumb(path: String, size: u32) -> Result<String, String> {
    tokio::task::spawn_blocking(move || crate::thumb::make(std::path::Path::new(&path), size)).await.map_err(|e| e.to_string())?
}

/// Thumbnail of a remote image: downloaded once to a cache folder (named after
/// the site, path, size and date), then made like a local one.
#[tauri::command]
pub async fn remote_thumb(state: State<'_, AppState>, session: String, server: String, path: String, file_size: u64, mtime: i64, size: u32) -> Result<String, String> {
    if file_size > crate::thumb::MAX_REMOTE {
        return Err("too large".into());
    }
    let cached = crate::thumb::cache_file(&server, &path, file_size, mtime);
    if !cached.exists() {
        let conn = state.conn(&session)?;
        if let Some(dir) = cached.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let part = cached.with_extension("part");
        let p = Progress::new(None, String::new(), file_size, Arc::new(AtomicBool::new(false)));
        conn.download(&path, &part.display().to_string(), p).await?;
        std::fs::rename(&part, &cached).map_err(|e| e.to_string())?;
    }
    tokio::task::spawn_blocking(move || crate::thumb::make(&cached, size)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, id: String) {
    if let Some(c) = state.cancels.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn onedrive_device_start(client_id: String) -> Result<crate::onedrive::DeviceCode, String> {
    crate::onedrive::device_start(&client_id).await
}

#[tauri::command]
pub async fn onedrive_device_poll(client_id: String, device_code: String) -> Result<crate::onedrive::PollResult, String> {
    crate::onedrive::device_poll(&client_id, &device_code).await
}

// ───────────────────────────── windows ─────────────────────────────

pub fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE
}

/// Text on the system clipboard (empty when there is none).
#[tauri::command]
pub async fn clipboard_text() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        Ok(cb.get_text().unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Files copied in Explorer / Finder (CF_HDROP / file URLs).
#[tauri::command]
pub async fn clipboard_files() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        Ok(cb.get().file_list().map(|v| v.into_iter().map(|p| p.display().to_string()).collect()).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Puts local files on the system clipboard, so they can be pasted in Explorer / Finder too.
#[tauri::command]
pub async fn clipboard_set_files(paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set().file_list(&paths).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies a local file or folder (with everything in it) to `to`.
pub fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    let md = std::fs::metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
    if !md.is_dir() {
        std::fs::copy(from, to).map_err(|e| format!("{}: {e}", from.display()))?;
        return Ok(());
    }
    // a folder cannot be copied into itself
    if let (Ok(a), Ok(b)) = (from.canonicalize(), to.parent().map(|p| p.canonicalize()).unwrap_or_else(|| Err(std::io::ErrorKind::NotFound.into()))) {
        if b.starts_with(&a) {
            return Err(crate::settings::tr("Egy mappa nem másolható önmagába", "A folder cannot be copied into itself"));
        }
    }
    std::fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
    for e in std::fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))? {
        let e = e.map_err(|e| e.to_string())?;
        copy_tree(&e.path(), &to.join(e.file_name()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn local_copy(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || copy_tree(std::path::Path::new(&from), std::path::Path::new(&to)))
        .await
        .map_err(|e| e.to_string())?
}

/// Moves a local file or folder; across drives it is copied, then removed.
#[tauri::command]
pub async fn local_move(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if std::fs::rename(&from, &to).is_ok() {
            return Ok(());
        }
        let src = std::path::Path::new(&from);
        copy_tree(src, std::path::Path::new(&to))?;
        if src.is_dir() { std::fs::remove_dir_all(src) } else { std::fs::remove_file(src) }.map_err(|e| format!("{from}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Creates a window declared in tauri.conf.json (with `create: false`).
pub fn create_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let cfg = app.config().app.windows.iter().find(|w| w.label == label).cloned().ok_or_else(|| format!("no '{label}' window"))?;
    tauri::WebviewWindowBuilder::from_config(app, &cfg).and_then(|b| b.build()).map(|_| ()).map_err(|e| e.to_string())
}

static SPLASH_DONE: AtomicBool = AtomicBool::new(false);

/// Shows the main window and closes the splash (called by the UI when ready,
/// and as a fallback when the splash is closed by hand).
pub fn finish_splash(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    if SPLASH_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = main.show();
    {
        use tauri_plugin_window_state::WindowExt;
        let _ = main.restore_state(window_state_flags());
    }
    let _ = main.set_focus();
    if let Some(s) = app.get_webview_window("splashscreen") {
        let _ = s.close();
    }
}

/// How long the splash screen stays on screen at least (as in GitStar).
pub const SPLASH_TIME: std::time::Duration = std::time::Duration::from_secs(3);
static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Called at start-up: the splash time is counted from here.
pub fn mark_start() {
    let _ = STARTED.set(std::time::Instant::now());
}

#[tauri::command]
pub async fn ui_ready(app: AppHandle) {
    // the UI is usually ready long before: the splash stays for SPLASH_TIME
    let shown = STARTED.get().map(|s| s.elapsed()).unwrap_or_default();
    tokio::time::sleep(SPLASH_TIME.saturating_sub(shown)).await;
    finish_splash(&app);
}
