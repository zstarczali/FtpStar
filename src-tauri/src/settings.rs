//! Settings, saved sites and trusted SSH host keys, each a JSON file in the
//! app's configuration folder.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Language of backend messages (errors shown in the UI). Set by the UI.
static ENGLISH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_english(on: bool) {
    ENGLISH.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Picks the Hungarian or the English text.
pub fn tr(hu: &str, en: &str) -> String {
    if ENGLISH.load(std::sync::atomic::Ordering::Relaxed) { en.to_string() } else { hu.to_string() }
}

/// Network timeout in seconds (Settings → General), read by every protocol.
static NET_TIMEOUT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(30);

/// How long a connection attempt or a stalled read / write may take.
pub fn net_timeout() -> std::time::Duration {
    std::time::Duration::from_secs(NET_TIMEOUT.load(std::sync::atomic::Ordering::Relaxed))
}

fn apply_timeout(secs: u32) {
    NET_TIMEOUT.store(secs.clamp(5, 600) as u64, std::sync::atomic::Ordering::Relaxed);
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub ui_language: String,
    pub theme: String,
    pub font_size: u32,
    pub zoom: f64,
    pub show_hidden: bool,
    pub confirm_delete: bool,
    /// What to do when the target file exists: ask | overwrite | skip | newer
    pub overwrite: String,
    /// Parallel transfers per connection (each gets its own connection).
    pub parallel: u32,
    /// Azure app (public client) id for the OneDrive sign-in.
    pub onedrive_client_id: String,
    /// Open tabs (site ids) restored at start.
    pub open_sites: Vec<String>,
    pub last_local_dir: String,
    /// Small UI preferences of the frontend (column widths, panel sizes…).
    pub ui: BTreeMap<String, serde_json::Value>,
    /// Network timeout in seconds: connecting, and a read / write that stalls.
    pub timeout: u32,
    /// Folder with the installers (empty = update::UPDATE_SERVER_DEFAULT)
    pub update_server: String,
    /// Look for a new version at start
    pub update_check: bool,
    /// Version the user chose to skip
    pub update_skip: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ui_language: "auto".into(),
            theme: "dark".into(),
            font_size: 13,
            zoom: 1.0,
            show_hidden: false,
            confirm_delete: true,
            overwrite: "ask".into(),
            parallel: 2,
            onedrive_client_id: String::new(),
            open_sites: vec![],
            last_local_dir: String::new(),
            ui: BTreeMap::new(),
            timeout: 30,
            update_server: String::new(),
            update_check: true,
            update_skip: String::new(),
        }
    }
}

/// A saved connection. Every protocol uses the fields it needs.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Site {
    pub id: String,
    pub name: String,
    /// ftp | ftps | ftps-implicit | sftp | s3 | onedrive
    pub protocol: String,
    pub host: String,
    /// 0 = the protocol's default
    pub port: u16,
    pub user: String,
    /// Empty = asked at connect time.
    pub password: String,
    /// SFTP private key file; empty = the default keys in ~/.ssh.
    pub key_path: String,
    pub passphrase: String,
    /// FTP: active mode instead of passive.
    pub active: bool,
    pub remote_dir: String,
    pub local_dir: String,
    /// Tab colour, e.g. "#e05577"; empty = none.
    pub color: String,
    pub folder: String,
    pub notes: String,
    pub s3_region: String,
    /// Custom endpoint for S3-compatible services (R2, MinIO, Wasabi…).
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_path_style: bool,
    pub onedrive_refresh_token: String,
    pub onedrive_account: String,
}

impl Site {
    pub fn port_or_default(&self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        match self.protocol.as_str() {
            "sftp" => 22,
            "ftps-implicit" => 990,
            _ => 21,
        }
    }
}

fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Writes through a temporary file, so a crash never leaves half a file.
fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub struct Store {
    dir: PathBuf,
    settings: Mutex<Settings>,
    sites: Mutex<Vec<Site>>,
    known_hosts: Mutex<BTreeMap<String, String>>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        let settings: Settings = load_json(&dir.join("settings.json"));
        apply_timeout(settings.timeout);
        Self {
            settings: Mutex::new(settings),
            sites: Mutex::new(load_json(&dir.join("sites.json"))),
            known_hosts: Mutex::new(load_json(&dir.join("known_hosts.json"))),
            dir,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save_settings(&self, s: Settings) -> Result<(), String> {
        save_json(&self.dir.join("settings.json"), &s)?;
        apply_timeout(s.timeout);
        *self.settings.lock().unwrap() = s;
        Ok(())
    }

    pub fn sites(&self) -> Vec<Site> {
        self.sites.lock().unwrap().clone()
    }

    pub fn save_sites(&self, sites: Vec<Site>) -> Result<(), String> {
        save_json(&self.dir.join("sites.json"), &sites)?;
        *self.sites.lock().unwrap() = sites;
        Ok(())
    }

    /// Changes one saved site in place (e.g. a renewed OneDrive token).
    pub fn update_site(&self, id: &str, f: impl FnOnce(&mut Site)) -> Result<(), String> {
        let mut sites = self.sites.lock().unwrap();
        if let Some(s) = sites.iter_mut().find(|s| s.id == id) {
            f(s);
            save_json(&self.dir.join("sites.json"), &*sites)?;
        }
        Ok(())
    }

    pub fn known_host(&self, key: &str) -> Option<String> {
        self.known_hosts.lock().unwrap().get(key).cloned()
    }

    pub fn trust_host(&self, key: &str, fingerprint: &str) -> Result<(), String> {
        let mut m = self.known_hosts.lock().unwrap();
        m.insert(key.to_string(), fingerprint.to_string());
        save_json(&self.dir.join("known_hosts.json"), &*m)
    }
}
