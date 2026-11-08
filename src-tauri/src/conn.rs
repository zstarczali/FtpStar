//! One open connection of any protocol, behind a common set of operations.

use crate::ftp::Ftp;
use crate::onedrive::OneDrive;
use crate::s3::S3;
use crate::sftp::Sftp;
use crate::xfer::{join, Entry, Progress};
use serde::Serialize;
use std::sync::Arc;

pub enum Conn {
    Ftp(Arc<Ftp>),
    Sftp(Arc<Sftp>),
    S3(S3),
    OneDrive(OneDrive),
}

/// A file or folder found by `walk`, relative to the walked folder ("a/b.txt").
#[derive(Serialize, Clone)]
pub struct WalkItem {
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    pub mtime: Option<i64>,
}

impl Conn {
    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        match self {
            Conn::Ftp(c) => c.list(path).await,
            Conn::Sftp(c) => c.list(path).await,
            Conn::S3(c) => c.list(path).await,
            Conn::OneDrive(c) => c.list(path).await,
        }
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        match self {
            Conn::Ftp(c) => c.mkdir(path).await,
            Conn::Sftp(c) => c.mkdir(path).await,
            Conn::S3(c) => c.mkdir(path).await,
            Conn::OneDrive(c) => c.mkdir(path).await,
        }
    }

    /// Deletes a file, or a folder with everything in it.
    pub async fn remove(&self, path: &str, dir: bool) -> Result<(), String> {
        match self {
            Conn::S3(c) => return if dir { c.remove_dir(path).await } else { c.remove_file(path).await },
            Conn::OneDrive(c) => return c.remove(path).await,
            _ => {}
        }
        if !dir {
            return match self {
                Conn::Ftp(c) => c.remove_file(path).await,
                Conn::Sftp(c) => c.remove_file(path).await,
                _ => unreachable!(),
            };
        }
        // FTP / SFTP: empty the folder first, deepest items first
        let mut dirs = vec![path.to_string()];
        let mut stack = vec![path.to_string()];
        while let Some(d) = stack.pop() {
            for e in self.list(&d).await? {
                let p = join(&d, &e.name);
                if e.dir && !e.link {
                    dirs.push(p.clone());
                    stack.push(p);
                } else {
                    match self {
                        Conn::Ftp(c) => c.remove_file(&p).await?,
                        Conn::Sftp(c) => c.remove_file(&p).await?,
                        _ => unreachable!(),
                    }
                }
            }
        }
        for d in dirs.iter().rev() {
            match self {
                Conn::Ftp(c) => c.remove_dir(d).await?,
                Conn::Sftp(c) => c.remove_dir(d).await?,
                _ => unreachable!(),
            }
        }
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str, dir: bool) -> Result<(), String> {
        match self {
            Conn::Ftp(c) => c.rename(from, to).await,
            Conn::Sftp(c) => c.rename(from, to).await,
            Conn::S3(c) => c.rename(from, to, dir).await,
            Conn::OneDrive(c) => c.rename(from, to).await,
        }
    }

    pub async fn download(&self, remote: &str, local: &str, p: Progress) -> Result<(), String> {
        match self {
            Conn::Ftp(c) => c.download(remote, local, p).await,
            Conn::Sftp(c) => c.download(remote, local, p).await,
            Conn::S3(c) => c.download(remote, local, p).await,
            Conn::OneDrive(c) => c.download(remote, local, p).await,
        }
    }

    pub async fn upload(&self, local: &str, remote: &str, p: Progress) -> Result<(), String> {
        match self {
            Conn::Ftp(c) => c.upload(local, remote, p).await,
            Conn::Sftp(c) => c.upload(local, remote, p).await,
            Conn::S3(c) => c.upload(local, remote, p).await,
            Conn::OneDrive(c) => c.upload(local, remote, p).await,
        }
    }

    /// Everything under a remote folder, folders before their contents.
    pub async fn walk(&self, root: &str) -> Result<Vec<WalkItem>, String> {
        let mut out = vec![];
        let mut stack = vec![String::new()];
        while let Some(rel) = stack.pop() {
            let abs = if rel.is_empty() { root.to_string() } else { join(root, &rel) };
            for e in self.list(&abs).await? {
                let r = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
                if e.dir {
                    stack.push(r.clone());
                }
                out.push(WalkItem { rel: r, dir: e.dir, size: e.size, mtime: e.mtime });
            }
        }
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(out)
    }

    pub async fn close(&self) {
        match self {
            Conn::Ftp(c) => c.close().await,
            Conn::Sftp(c) => c.close().await,
            _ => {}
        }
    }
}
