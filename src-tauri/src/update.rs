//! Self-update, the same way the Visual Assembler and GitStar do it: the newest version is read
//! from the download folder's page (links like `FtpStar_0.3.0_x64-setup.exe`, no
//! separate manifest), the platform's installer is downloaded with progress events,
//! then started; the app exits and the installer / a helper script restarts it.

use crate::commands::AppState;
use crate::settings::tr;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Folder holding the installers; changeable in Settings (`update_server`).
pub const UPDATE_SERVER_DEFAULT: &str = "https://www.c64va.pro/downloads/FtpStar/";

/// Installer folder on the server, added when only the server address is given.
const UPDATE_DIR: &str = "downloads/FtpStar/";

/// The update folder's address checked, ending in `/`: https, or http only for
/// localhost (local test); no user name, query or fragment. A bare server
/// address (`https://www.c64va.pro/`) gets the standard folder appended; a
/// longer path is taken as the folder itself.
pub fn normalize_update_server(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(UPDATE_SERVER_DEFAULT.to_string());
    }
    let bad = || tr(&format!("Érvénytelen frissítési cím (https:// kell): {raw}"), &format!("Invalid update address (https:// required): {raw}"));
    let url = reqwest::Url::parse(raw).map_err(|_| bad())?;
    let host = url.host_str().unwrap_or("");
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && local);
    if !scheme_ok || host.is_empty() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(bad());
    }
    let mut s = url.to_string();
    if !s.ends_with('/') {
        s.push('/');
    }
    if url.path() == "/" {
        s.push_str(UPDATE_DIR);
    }
    Ok(s)
}

fn update_server(state: &AppState) -> String {
    normalize_update_server(&state.store.settings().update_server).unwrap_or_else(|_| UPDATE_SERVER_DEFAULT.to_string())
}

fn parse_version_triplet(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().trim_start_matches('v').split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Installer file name of the running platform: prefix + version + suffix
/// (the names `tauri build` gives the bundles of the GitHub Actions workflow).
fn update_asset_pattern() -> Option<(&'static str, &'static str)> {
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return Some(("FtpStar_", "_arm64-setup.exe"));
    #[cfg(all(target_os = "windows", not(target_arch = "aarch64")))]
    return Some(("FtpStar_", "_x64-setup.exe"));
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some(("FtpStar_", "_aarch64.dmg"));
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return Some(("FtpStar_", "_x64.dmg"));
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        if std::env::var_os("APPIMAGE").is_some() {
            return Some(("FtpStar_", "_amd64.AppImage"));
        }
        let rpm_based = Path::new("/etc/redhat-release").exists()
            || Path::new("/etc/fedora-release").exists()
            || (!Path::new("/usr/bin/dpkg").exists() && Path::new("/usr/bin/rpm").exists());
        return if rpm_based { Some(("FtpStar-", "-1.x86_64.rpm")) } else { Some(("FtpStar_", "_amd64.deb")) };
    }
    #[allow(unreachable_code)]
    None
}

fn update_asset_name(version: &str) -> Option<String> {
    let (prefix, suffix) = update_asset_pattern()?;
    Some(format!("{prefix}{version}{suffix}"))
}

/// The highest `prefix<version>suffix` version on the page (links or directory listing).
fn find_latest_asset_version(html: &str, prefix: &str, suffix: &str) -> Option<(u32, u32, u32)> {
    let text = html.replace("%20", " ");
    let mut best: Option<(u32, u32, u32)> = None;
    let mut rest = text.as_str();
    while let Some(pos) = rest.find(prefix) {
        rest = &rest[pos + prefix.len()..];
        let ver_len = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
        let (ver, tail) = rest.split_at(ver_len);
        if !tail.starts_with(suffix) {
            continue;
        }
        if let Some(v) = parse_version_triplet(ver) {
            if best.map_or(true, |b| v > b) {
                best = Some(v);
            }
        }
    }
    best
}

fn http_client(app: &AppHandle, timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .user_agent(format!("FtpStar/{}", app.package_info().version))
        .build()
        .map_err(|e| e.to_string())
}

/// The default update folder, and a typed address checked (normalized) for Settings.
#[tauri::command]
pub fn update_server_check(url: String) -> Result<Value, String> {
    Ok(json!({ "default": UPDATE_SERVER_DEFAULT, "normalized": normalize_update_server(&url)? }))
}

/// Checks the download folder for a newer installer of this platform.
#[tauri::command]
pub async fn check_for_update(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let current = app.package_info().version.to_string();
    let Some((prefix, suffix)) = update_asset_pattern() else {
        return Ok(json!({ "supported": false, "currentVersion": current }));
    };
    let server = update_server(&state);
    let html = http_client(&app, 15)?
        .get(&server)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let Some((ma, mi, pa)) = find_latest_asset_version(&html, prefix, suffix) else {
        return Err(tr("Ehhez a platformhoz nem található letöltés.", "No download found for this platform."));
    };
    let latest = format!("{ma}.{mi}.{pa}");
    let current_v = parse_version_triplet(&current).unwrap_or((0, 0, 0));
    let file_name = update_asset_name(&latest).unwrap_or_default();
    Ok(json!({
        "supported": true,
        "currentVersion": current,
        "latestVersion": latest,
        "updateAvailable": (ma, mi, pa) > current_v,
        "fileName": file_name,
        "url": format!("{server}{file_name}"),
        "server": server,
    }))
}

#[cfg(not(target_os = "windows"))]
fn spawn_update_script(script: &str, args: &[&str]) -> Result<(), String> {
    let dir = std::env::temp_dir().join("ftpstar").join("update");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script_path = dir.join("apply-update.sh");
    fs::write(&script_path, script).map_err(|e| e.to_string())?;
    // Under an AppImage these may point into a mount that disappears on exit:
    // the helper, pkexec/apt-get and the restarted app must not inherit them.
    Command::new("/bin/sh")
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .arg(&script_path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".ftpstar-write-test");
    let ok = fs::write(&probe, b"").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// Starts the downloaded installer. `Ok(true)` = the app exits and the installer /
/// helper restarts it, `Ok(false)` = the installer was only opened, the user finishes it.
fn launch_update_installer(file: &Path) -> Result<bool, String> {
    let file_str = file.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Start-Process -> ShellExecuteEx: handles UAC elevation (a per-machine install
        // would fail with ERROR_ELEVATION_REQUIRED from CreateProcess).
        // Tauri NSIS: /P = passive (progress only), /R = restart the app after install.
        let ps_cmd = format!("Start-Process -FilePath '{}' -ArgumentList '/P','/R'", file_str.replace('\'', "''"));
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &ps_cmd])
            .stdin(std::process::Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        return Ok(true);
    }

    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id().to_string();
        let bundle = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.ancestors().find(|p| p.extension().map_or(false, |e| e == "app")).map(Path::to_path_buf));
        let Some(bundle) = bundle.filter(|b| b.parent().map_or(false, dir_writable)) else {
            Command::new("open").arg(&file_str).spawn().map_err(|e| e.to_string())?;
            return Ok(false);
        };
        let script = r#"PID="$1"; DMG="$2"; TARGET="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
MNT=$(mktemp -d /tmp/ftpstar-update.XXXXXX)
if ! hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$DMG"; then open "$DMG"; exit 1; fi
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -n 1)
if [ -n "$SRC" ] && rm -rf "$TARGET.new" && ditto "$SRC" "$TARGET.new"; then
  rm -rf "$TARGET.old"; mv "$TARGET" "$TARGET.old" && mv "$TARGET.new" "$TARGET" && rm -rf "$TARGET.old"
  hdiutil detach -quiet "$MNT"
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  open "$TARGET"
else
  hdiutil detach -quiet "$MNT"; open "$DMG"
fi
"#;
        spawn_update_script(script, &[&pid, &file_str, &bundle.to_string_lossy()])?;
        return Ok(true);
    }

    #[cfg(target_os = "linux")]
    {
        let pid = std::process::id().to_string();
        if let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
            if !appimage.parent().map_or(false, dir_writable) {
                return Err(format!("Not writable: {}", appimage.display()));
            }
            let script = r#"PID="$1"; NEW="$2"; TARGET="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
chmod +x "$NEW" && cp -f "$NEW" "$TARGET.new" && mv -f "$TARGET.new" "$TARGET" && rm -f "$NEW"
exec "$TARGET"
"#;
            spawn_update_script(script, &[&pid, &file_str, &appimage.to_string_lossy()])?;
            return Ok(true);
        }
        if !Path::new("/usr/bin/pkexec").exists() {
            Command::new("xdg-open").arg(&file_str).spawn().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let script = r#"PID="$1"; PKG="$2"; EXE="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
case "$PKG" in
  *.deb) if command -v apt-get >/dev/null; then pkexec apt-get install -y "$PKG"; else pkexec dpkg -i "$PKG"; fi ;;
  *.rpm) if command -v dnf >/dev/null; then pkexec dnf install -y "$PKG"; else pkexec rpm -U "$PKG"; fi ;;
esac
if [ $? -ne 0 ]; then xdg-open "$PKG"; fi
exec "$EXE"
"#;
        spawn_update_script(script, &[&pid, &file_str, &exe.to_string_lossy()])?;
        return Ok(true);
    }

    #[allow(unreachable_code)]
    Err(tr("Ezen a platformon nincs automatikus frissítés.", "Self-update is not supported on this platform."))
}

/// Downloads the installer of `version` (emitting `update-download-progress`) and starts it.
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle, state: State<'_, AppState>, version: String) -> Result<Value, String> {
    // Only a version comes from JS, the URL is built here, so no arbitrary file
    // can be downloaded and run.
    if parse_version_triplet(&version).is_none() {
        return Err(format!("Invalid version: {version}"));
    }
    let file_name = update_asset_name(&version)
        .ok_or_else(|| tr("Ezen a platformon nincs automatikus frissítés.", "Self-update is not supported on this platform."))?;
    let url = format!("{}{}", update_server(&state), file_name);

    let dir = std::env::temp_dir().join("ftpstar").join("update");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(&file_name);
    let partial = dir.join(format!("{file_name}.part"));

    let mut resp = http_client(&app, 600)?
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut out = fs::File::create(&partial).map_err(|e| e.to_string())?;
    let mut received: u64 = 0;
    let mut last_pct: i64 = -1;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        let pct = if total > 0 { (received * 100 / total) as i64 } else { -1 };
        if pct != last_pct {
            last_pct = pct;
            let _ = app.emit("update-download-progress", json!({ "received": received, "total": total }));
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);

    if (total > 0 && received != total) || received < 1024 * 1024 {
        let _ = fs::remove_file(&partial);
        return Err(tr(&format!("Hiányos letöltés ({received} / {total} bájt)."), &format!("Incomplete download ({received} / {total} bytes).")));
    }
    let _ = fs::remove_file(&target);
    fs::rename(&partial, &target).map_err(|e| e.to_string())?;

    let restarting = launch_update_installer(&target)?;
    if restarting {
        // the window-state plugin saves on exit, so the size/position survive the update
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            handle.exit(0);
        });
    }
    Ok(json!({ "restarting": restarting, "path": target.to_string_lossy() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_highest_matching_version() {
        let html = r#"<a href="FtpStar_0.2.0_x64-setup.exe">
            <a href="FtpStar_0.10.1_arm64-setup.exe">
            <a href="FtpStar_0.3.1_x64-setup.exe">
            <a href="FtpStar-0.9.0-1.x86_64.rpm">"#;
        assert_eq!(find_latest_asset_version(html, "FtpStar_", "_x64-setup.exe"), Some((0, 3, 1)));
        assert_eq!(find_latest_asset_version(html, "FtpStar_", "_arm64-setup.exe"), Some((0, 10, 1)));
        assert_eq!(find_latest_asset_version(html, "FtpStar-", "-1.x86_64.rpm"), Some((0, 9, 0)));
        assert_eq!(find_latest_asset_version(html, "FtpStar_", "_x64.dmg"), None);
    }

    #[test]
    fn update_server_must_be_https() {
        assert_eq!(normalize_update_server("").unwrap(), UPDATE_SERVER_DEFAULT);
        assert_eq!(normalize_update_server("https://example.com/dl").unwrap(), "https://example.com/dl/");
        assert_eq!(normalize_update_server("https://www.c64va.pro/").unwrap(), UPDATE_SERVER_DEFAULT);
        assert_eq!(normalize_update_server("https://www.c64va.pro").unwrap(), UPDATE_SERVER_DEFAULT);
        assert_eq!(normalize_update_server(UPDATE_SERVER_DEFAULT).unwrap(), UPDATE_SERVER_DEFAULT);
        assert!(normalize_update_server("http://example.com/").is_err());
        assert!(normalize_update_server("http://localhost:8080/").is_ok());
        assert!(normalize_update_server("https://u:p@example.com/").is_err());
    }
}
