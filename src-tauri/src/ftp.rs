//! FTP, explicit FTPS (AUTH TLS) and implicit FTPS (port 990).
//!
//! suppaftp is blocking, so every call runs on a blocking thread. Browsing
//! uses one connection; each running transfer takes its own from a pool, so a
//! long download does not freeze the file list.

use crate::settings::Site;
use crate::xfer::{cancel_aware, sort_entries, Entry, Progress};
use std::io::{Read, Write};
use std::net::ToSocketAddrs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use suppaftp::list::File as FtpFile;
use suppaftp::types::FileType;
use suppaftp::rustls::{ClientConfig, RootCertStore};
use suppaftp::{Mode, RustlsConnector, RustlsFtpStream};

type Stream = RustlsFtpStream;

/// Trusted roots: the system's certificates plus Mozilla's bundle.
fn roots() -> RootCertStore {
    let mut store = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = store.add(cert);
    }
    store
}

/// A TLS config of its own for every control connection: its data
/// connections resume the control connection's TLS session, as servers with
/// "TLS session resumption required" (FileZilla Server, vsftpd…) demand.
fn tls() -> Result<RustlsConnector, String> {
    let provider = std::sync::Arc::new(suppaftp::rustls::crypto::ring::default_provider());
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots())
        .with_no_client_auth();
    Ok(RustlsConnector::from(std::sync::Arc::new(cfg)))
}

pub struct Ftp {
    site: Site,
    password: String,
    browse: Mutex<Option<Stream>>,
    pool: Mutex<Vec<Stream>>,
}

const TIMEOUT: Duration = Duration::from_secs(30);

fn connect(site: &Site, password: &str) -> Result<Stream, String> {
    let host = site.host.trim();
    let port = site.port_or_default();
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("{host}: {e}"))?
        .next()
        .ok_or_else(|| format!("{host}: no address"))?;
    let mut s = if site.protocol == "ftps-implicit" {
        Stream::connect_secure_implicit(addr, tls()?, host).map_err(|e| e.to_string())?
    } else {
        let s = Stream::connect_timeout(addr, Duration::from_secs(15)).map_err(|e| e.to_string())?;
        if site.protocol == "ftps" {
            s.into_secure(tls()?, host).map_err(|e| format!("TLS: {e}"))?
        } else {
            s
        }
    };
    let _ = s.get_ref().set_read_timeout(Some(TIMEOUT));
    let _ = s.get_ref().set_write_timeout(Some(TIMEOUT));
    let user = if site.user.trim().is_empty() { "anonymous" } else { site.user.trim() };
    s.login(user, password).map_err(|e| e.to_string())?;
    let _ = s.opts("UTF8", Some("ON"));
    s.transfer_type(FileType::Binary).map_err(|e| e.to_string())?;
    if site.active {
        s = s.active_mode(TIMEOUT);
    } else {
        s.set_mode(Mode::Passive);
        // servers behind NAT often announce their private address in PASV
        s.set_passive_nat_workaround(true);
    }
    Ok(s)
}

fn to_entry(f: &FtpFile) -> Entry {
    Entry {
        name: f.name().to_string(),
        dir: f.is_directory(),
        size: f.size() as u64,
        mtime: f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64).filter(|&t| t > 0),
        perms: None,
        link: f.is_symlink(),
    }
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

impl Ftp {
    pub async fn open(site: Site, password: String) -> Result<(Arc<Self>, String), String> {
        let (s2, p2) = (site.clone(), password.clone());
        let (stream, home) = blocking(move || {
            let mut s = connect(&s2, &p2)?;
            let home = s.pwd().unwrap_or_else(|_| "/".into());
            Ok((s, home))
        })
        .await?;
        Ok((Arc::new(Self { site, password, browse: Mutex::new(Some(stream)), pool: Mutex::new(vec![]) }), home))
    }

    /// Runs `f` on the browsing connection; reconnects once if it has dropped.
    async fn with_browse<T: Send + 'static>(self: &Arc<Self>, f: impl Fn(&mut Stream) -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let me = self.clone();
        blocking(move || {
            let mut guard = me.browse.lock().unwrap();
            if guard.is_none() {
                *guard = Some(connect(&me.site, &me.password)?);
            }
            match f(guard.as_mut().unwrap()) {
                Ok(v) => Ok(v),
                Err(e) => {
                    // a NOOP tells a lost connection from an ordinary error
                    if guard.as_mut().unwrap().noop().is_ok() {
                        return Err(e);
                    }
                    *guard = Some(connect(&me.site, &me.password)?);
                    f(guard.as_mut().unwrap())
                }
            }
        })
        .await
    }

    pub async fn list(self: &Arc<Self>, path: &str) -> Result<Vec<Entry>, String> {
        let path = path.to_string();
        self.with_browse(move |s| {
            let mut out: Vec<Entry> = match s.mlsd(Some(&path)) {
                Ok(lines) => lines.iter().filter_map(|l| FtpFile::from_mlsx_line(l).ok()).map(|f| to_entry(&f)).collect(),
                Err(_) => {
                    let lines = s.list(Some(&path)).map_err(|e| e.to_string())?;
                    lines.iter().filter_map(|l| FtpFile::try_from(l.as_str()).ok()).map(|f| to_entry(&f)).collect()
                }
            };
            out.retain(|e| e.name != "." && e.name != "..");
            sort_entries(&mut out);
            Ok(out)
        })
        .await
    }

    pub async fn mkdir(self: &Arc<Self>, path: &str) -> Result<(), String> {
        let path = path.to_string();
        self.with_browse(move |s| s.mkdir(&path).map_err(|e| e.to_string())).await
    }

    pub async fn remove_file(self: &Arc<Self>, path: &str) -> Result<(), String> {
        let path = path.to_string();
        self.with_browse(move |s| s.rm(&path).map_err(|e| e.to_string())).await
    }

    pub async fn remove_dir(self: &Arc<Self>, path: &str) -> Result<(), String> {
        let path = path.to_string();
        self.with_browse(move |s| s.rmdir(&path).map_err(|e| e.to_string())).await
    }

    pub async fn rename(self: &Arc<Self>, from: &str, to: &str) -> Result<(), String> {
        let (from, to) = (from.to_string(), to.to_string());
        self.with_browse(move |s| s.rename(&from, &to).map_err(|e| e.to_string())).await
    }

    fn take(&self) -> Result<Stream, String> {
        if let Some(mut s) = self.pool.lock().unwrap().pop() {
            if s.noop().is_ok() {
                return Ok(s);
            }
        }
        connect(&self.site, &self.password)
    }

    fn give_back(&self, s: Stream) {
        let mut pool = self.pool.lock().unwrap();
        if pool.len() < 8 {
            pool.push(s);
        }
    }

    pub async fn download(self: &Arc<Self>, remote: &str, local: &str, p: Progress) -> Result<(), String> {
        let (me, remote, local) = (self.clone(), remote.to_string(), local.to_string());
        blocking(move || {
            let mut s = me.take()?;
            let mut file = std::fs::File::create(&local).map_err(|e| format!("{local}: {e}"))?;
            let mut data = s.retr_as_stream(&remote).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 128 * 1024];
            let res: Result<(), String> = (|| loop {
                let n = data.read(&mut buf).map_err(|e| cancel_aware(&p, e))?;
                if n == 0 {
                    return Ok(());
                }
                file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                p.add(n as u64)?;
            })();
            match res {
                Ok(()) => {
                    s.finalize_retr_stream(data).map_err(|e| e.to_string())?;
                    me.give_back(s);
                    Ok(())
                }
                Err(e) => {
                    let _ = s.abort(data); // the connection is dropped after an abort
                    drop(file);
                    let _ = std::fs::remove_file(&local);
                    Err(e)
                }
            }
        })
        .await
    }

    pub async fn upload(self: &Arc<Self>, local: &str, remote: &str, p: Progress) -> Result<(), String> {
        let (me, remote, local) = (self.clone(), remote.to_string(), local.to_string());
        blocking(move || {
            let mut s = me.take()?;
            let mut file = std::fs::File::open(&local).map_err(|e| format!("{local}: {e}"))?;
            let mut data = s.put_with_stream(&remote).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 128 * 1024];
            let res: Result<(), String> = (|| loop {
                let n = file.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(());
                }
                data.write_all(&buf[..n]).map_err(|e| cancel_aware(&p, e))?;
                p.add(n as u64)?;
            })();
            match res {
                Ok(()) => {
                    s.finalize_put_stream(data).map_err(|e| e.to_string())?;
                    me.give_back(s);
                    Ok(())
                }
                Err(e) => {
                    drop(data);
                    // remove the partial file on a fresh connection; ignore errors
                    if let Ok(mut c) = connect(&me.site, &me.password) {
                        let _ = c.rm(&remote);
                        me.give_back(c);
                    }
                    Err(e)
                }
            }
        })
        .await
    }

    pub async fn close(self: &Arc<Self>) {
        let me = self.clone();
        let _ = blocking(move || {
            if let Some(mut s) = me.browse.lock().unwrap().take() {
                let _ = s.quit();
            }
            for mut s in me.pool.lock().unwrap().drain(..) {
                let _ = s.quit();
            }
            Ok(())
        })
        .await;
    }
}
