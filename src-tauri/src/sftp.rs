//! SFTP over russh (pure Rust, no OpenSSL / libssh2).
//!
//! Host keys: the first connection to a server fails with
//! `HOSTKEY_UNKNOWN:<fingerprint>`; the UI asks, and connects again with that
//! fingerprint trusted. A changed key fails with `HOSTKEY_CHANGED:<new>` and is
//! never accepted silently.

use crate::settings::Site;
use crate::xfer::{cancel_aware, mode_string, sort_entries, Entry, Progress, ProgressReader, ProgressWriter};
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct HostCheck {
    /// The trusted fingerprint for this host, if any.
    known: Option<String>,
    /// A fingerprint the user has just accepted in the UI.
    accept: Option<String>,
    /// What the server presented (filled during the handshake).
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKey) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        *self.seen.lock().unwrap() = Some(fp.clone());
        Ok(match &self.known {
            Some(k) => *k == fp,
            None => self.accept.as_deref() == Some(fp.as_str()),
        })
    }
}

pub struct Sftp {
    _handle: Handle<HostCheck>,
    sftp: SftpSession,
}

/// The result of a successful connection: the session, the home folder and
/// the fingerprint to save when it was newly accepted.
pub struct Opened {
    pub conn: Arc<Sftp>,
    pub home: String,
    pub new_fingerprint: Option<String>,
}

fn default_keys() -> Vec<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let Some(home) = home else { return vec![] };
    let ssh = std::path::PathBuf::from(home).join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|n| ssh.join(n)).filter(|p| p.exists()).collect()
}

impl Sftp {
    pub async fn open(site: &Site, password: &str, known: Option<String>, accept: Option<String>) -> Result<Opened, String> {
        let config = client::Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let seen = Arc::new(Mutex::new(None));
        let was_known = known.is_some();
        let handler = HostCheck { known: known.clone(), accept, seen: seen.clone() };
        let addr = (site.host.trim().to_string(), site.port_or_default());
        let connected = tokio::time::timeout(Duration::from_secs(20), client::connect(Arc::new(config), addr, handler)).await;
        let mut handle = match connected {
            Err(_) => return Err(format!("{}: connection timed out", site.host)),
            Ok(Ok(h)) => h,
            Ok(Err(e)) => {
                if let Some(fp) = seen.lock().unwrap().clone() {
                    if was_known && known.as_deref() != Some(fp.as_str()) {
                        return Err(format!("HOSTKEY_CHANGED:{fp}"));
                    }
                    if !was_known {
                        return Err(format!("HOSTKEY_UNKNOWN:{fp}"));
                    }
                }
                return Err(e.to_string());
            }
        };
        let fingerprint = seen.lock().unwrap().clone();
        let user = if site.user.trim().is_empty() { "root" } else { site.user.trim() };

        // keys first (the given one, or the default ones), then the password
        let mut authed = false;
        let keys: Vec<std::path::PathBuf> =
            if site.key_path.trim().is_empty() { default_keys() } else { vec![site.key_path.trim().into()] };
        let mut key_error = None;
        for path in keys {
            let pass = (!site.passphrase.is_empty()).then_some(site.passphrase.as_str());
            match load_secret_key(&path, pass) {
                Ok(key) => {
                    let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
                    let r = handle
                        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                        .await
                        .map_err(|e| e.to_string())?;
                    if r.success() {
                        authed = true;
                        break;
                    }
                }
                Err(e) => {
                    if !site.key_path.trim().is_empty() {
                        key_error = Some(format!("{}: {e}", path.display()));
                    }
                }
            }
        }
        if !authed && !password.is_empty() {
            authed = handle.authenticate_password(user, password).await.map_err(|e| e.to_string())?.success();
        }
        if !authed {
            return Err(key_error.unwrap_or_else(|| "AUTH_FAILED".into()));
        }
        let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| e.to_string())?;
        sftp.set_timeout(60);
        let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
        Ok(Opened {
            conn: Arc::new(Self { _handle: handle, sftp }),
            home,
            new_fingerprint: if was_known { None } else { fingerprint },
        })
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        let rd = self.sftp.read_dir(path).await.map_err(|e| e.to_string())?;
        let mut out = vec![];
        for e in rd {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let md = e.metadata();
            let link = e.file_type().is_symlink();
            let mut dir = md.is_dir();
            if link {
                // follow the link to see whether it points to a folder
                if let Ok(t) = self.sftp.metadata(crate::xfer::join(path, &name)).await {
                    dir = t.is_dir();
                }
            }
            out.push(Entry {
                name,
                dir,
                size: md.size.unwrap_or(0),
                mtime: md.mtime.map(|t| t as i64),
                perms: md.permissions.map(mode_string),
                link,
            });
        }
        sort_entries(&mut out);
        Ok(out)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        self.sftp.create_dir(path).await.map_err(|e| e.to_string())
    }
    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        self.sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        self.sftp.remove_dir(path).await.map_err(|e| e.to_string())
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.sftp.rename(from, to).await.map_err(|e| e.to_string())
    }

    pub async fn download(&self, remote: &str, local: &str, p: Progress) -> Result<(), String> {
        let mut src = self.sftp.open(remote).await.map_err(|e| e.to_string())?;
        let file = tokio::fs::File::create(local).await.map_err(|e| format!("{local}: {e}"))?;
        let mut dst = ProgressWriter { inner: tokio::io::BufWriter::with_capacity(256 * 1024, file), progress: p.clone() };
        let r = async {
            let mut buf = vec![0u8; 255 * 1024];
            loop {
                let n = src.read(&mut buf).await.map_err(|e| cancel_aware(&p, e))?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await.map_err(|e| cancel_aware(&p, e))?;
            }
            dst.flush().await.map_err(|e| e.to_string())
        }
        .await;
        let _ = src.shutdown().await;
        if r.is_err() {
            drop(dst);
            let _ = tokio::fs::remove_file(local).await;
        }
        r
    }

    pub async fn upload(&self, local: &str, remote: &str, p: Progress) -> Result<(), String> {
        let file = tokio::fs::File::open(local).await.map_err(|e| format!("{local}: {e}"))?;
        let mut src = ProgressReader { inner: file, progress: p.clone() };
        let mut dst = self.sftp.create(remote).await.map_err(|e| e.to_string())?;
        let r = async {
            let mut buf = vec![0u8; 255 * 1024];
            loop {
                let n = src.read(&mut buf).await.map_err(|e| cancel_aware(&p, e))?;
                if n == 0 {
                    break;
                }
                dst.write_all(&buf[..n]).await.map_err(|e| cancel_aware(&p, e))?;
            }
            dst.flush().await.map_err(|e| e.to_string())
        }
        .await;
        let _ = dst.shutdown().await;
        if r.is_err() {
            let _ = self.sftp.remove_file(remote).await;
        }
        r
    }

    pub async fn close(&self) {
        let _ = self.sftp.close().await;
    }
}
