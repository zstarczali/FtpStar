//! Shared types of the backends: directory entries, transfer progress and
//! cancellation, and remote path helpers.

use serde::Serialize;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    /// Unix seconds
    pub mtime: Option<i64>,
    /// "rwxr-xr-x" where the protocol knows it
    pub perms: Option<String>,
    pub link: bool,
}

pub const CANCELLED: &str = "CANCELLED";

/// Counts the bytes of one transfer, sends `xfer` events to the UI at most
/// ten times a second, and stops the transfer when it is cancelled.
#[derive(Clone)]
pub struct Progress {
    inner: Arc<ProgressInner>,
}

struct ProgressInner {
    app: Option<AppHandle>,
    id: String,
    cancel: Arc<AtomicBool>,
    state: Mutex<(u64, u64, Instant)>, // done, total, last emit
}

#[derive(Serialize, Clone)]
struct XferEvent<'a> {
    id: &'a str,
    done: u64,
    total: u64,
}

impl Progress {
    pub fn new(app: Option<AppHandle>, id: String, total: u64, cancel: Arc<AtomicBool>) -> Self {
        let p = Self {
            inner: Arc::new(ProgressInner { app, id, cancel, state: Mutex::new((0, total, Instant::now() - Duration::from_secs(1))) }),
        };
        p.emit(true);
        p
    }

    pub fn cancelled(&self) -> bool {
        self.inner.cancel.load(Ordering::Relaxed)
    }

    pub fn check(&self) -> Result<(), String> {
        if self.cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    pub fn set_total(&self, total: u64) {
        self.inner.state.lock().unwrap().1 = total;
    }

    pub fn add(&self, n: u64) -> Result<(), String> {
        {
            let mut st = self.inner.state.lock().unwrap();
            st.0 += n;
        }
        self.emit(false);
        self.check()
    }

    pub fn done(&self) -> u64 {
        self.inner.state.lock().unwrap().0
    }

    pub fn emit(&self, force: bool) {
        let (done, total) = {
            let mut st = self.inner.state.lock().unwrap();
            if !force && st.2.elapsed() < Duration::from_millis(100) {
                return;
            }
            st.2 = Instant::now();
            (st.0, st.1)
        };
        if let Some(app) = &self.inner.app {
            let _ = app.emit("xfer", XferEvent { id: &self.inner.id, done, total });
        }
    }
}

/// AsyncRead wrapper that reports the bytes read (uploads).
pub struct ProgressReader<R> {
    pub inner: R,
    pub progress: Progress,
}

impl<R: AsyncRead + Unpin> AsyncRead for ProgressReader<R> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = r {
            let n = (buf.filled().len() - before) as u64;
            if self.progress.add(n).is_err() {
                return Poll::Ready(Err(std::io::Error::other(CANCELLED)));
            }
        }
        r
    }
}

/// AsyncWrite wrapper that reports the bytes written (downloads).
pub struct ProgressWriter<W> {
    pub inner: W,
    pub progress: Progress,
}

impl<W: AsyncWrite + Unpin> AsyncWrite for ProgressWriter<W> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = r {
            if self.progress.add(n as u64).is_err() {
                return Poll::Ready(Err(std::io::Error::other(CANCELLED)));
            }
        }
        r
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Turns any error into the "CANCELLED" marker when the transfer was cancelled.
pub fn cancel_aware(p: &Progress, e: impl ToString) -> String {
    if p.cancelled() {
        CANCELLED.into()
    } else {
        e.to_string()
    }
}

/// "/a/b/" + "c" → "/a/b/c"
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// "/a/b/c" → ("/a/b", "c")
pub fn split(path: &str) -> (String, String) {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) => ("/".into(), p[1..].into()),
        Some(i) => (p[..i].into(), p[i + 1..].into()),
        None => ("/".into(), p.into()),
    }
}

/// Unix mode bits → "drwxr-xr-x" style text (without the type letter).
pub fn mode_string(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let b = (mode >> shift) & 7;
        s.push(if b & 4 != 0 { 'r' } else { '-' });
        s.push(if b & 2 != 0 { 'w' } else { '-' });
        s.push(if b & 1 != 0 { 'x' } else { '-' });
    }
    s
}

pub fn sort_entries(v: &mut [Entry]) {
    v.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a", "b"), "/a/b");
        assert_eq!(split("/a/b"), ("/a".into(), "b".into()));
        assert_eq!(split("/a"), ("/".into(), "a".into()));
        assert_eq!(split("/a/b/"), ("/a".into(), "b".into()));
        assert_eq!(mode_string(0o755), "rwxr-xr-x");
    }
}
