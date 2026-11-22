//! ZX Spectrum Next SD card images (the .img / .sd file of CSpect or
//! ZEsarUX) through the hdfmonkey command line tool. hdfmonkey knows ls, get,
//! put, mkdir and rm; rename is done as copy + delete. Every call is run one
//! at a time, because two hdfmonkey processes writing the same FAT image
//! would damage it.

use crate::settings::Site;
use crate::xfer::{join, sort_entries, Entry, Progress, CANCELLED};
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct NextSd {
    tool: PathBuf,
    image: String,
    lock: tokio::sync::Mutex<()>,
}

/// "/a/b/" → "a/b" (hdfmonkey wants paths without a leading slash).
fn rel(path: &str) -> String {
    path.trim_matches('/').to_string()
}

/// hdfmonkey writes names in the Windows ANSI code page, not UTF-8.
#[cfg(windows)]
fn decode(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(cp: u32, flags: u32, src: *const u8, srclen: i32, dst: *mut u16, dstlen: i32) -> i32;
    }
    const CP_ACP: u32 = 0;
    unsafe {
        let n = MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if n <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut buf = vec![0u16; n as usize];
        MultiByteToWideChar(CP_ACP, 0, bytes.as_ptr(), bytes.len() as i32, buf.as_mut_ptr(), n);
        String::from_utf16_lossy(&buf)
    }
}

#[cfg(not(windows))]
fn decode(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The hdfmonkey to use: the one set for the site, else the one next to the
/// image, else the one on the PATH.
fn find_tool(site: &Site, image: &Path) -> PathBuf {
    let set = site.hdfmonkey.trim();
    if !set.is_empty() {
        return PathBuf::from(set);
    }
    let exe = if cfg!(windows) { "hdfmonkey.exe" } else { "hdfmonkey" };
    if let Some(dir) = image.parent() {
        let p = dir.join(exe);
        if p.is_file() {
            return p;
        }
    }
    PathBuf::from(exe)
}

impl NextSd {
    pub async fn open(site: &Site) -> Result<(Self, String), String> {
        let image = site.sd_image.trim().trim_matches('"').to_string();
        if image.is_empty() {
            return Err("SD image file missing".into());
        }
        if !Path::new(&image).is_file() {
            return Err(format!("SD image not found: {image}"));
        }
        let tool = find_tool(site, Path::new(&image));
        let me = Self { tool, image, lock: tokio::sync::Mutex::new(()) };
        me.list("/").await?; // fails on a missing hdfmonkey or a bad image
        Ok((me, "/".into()))
    }

    /// Runs one hdfmonkey command on the image; stdout on success.
    async fn run(&self, cmd: &str, args: &[&str]) -> Result<Vec<u8>, String> {
        let _guard = self.lock.lock().await;
        let mut c = Command::new(&self.tool);
        c.arg(cmd).arg(&self.image).args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let tool = self.tool.display().to_string();
        let out = tokio::task::spawn_blocking(move || c.output()).await.map_err(|e| e.to_string())?.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("hdfmonkey not found ({tool}). Set its path in the Site Manager.")
            } else {
                format!("{tool}: {e}")
            }
        })?;
        // hdfmonkey reports errors on stdout as well, with exit code 127
        if !out.status.success() {
            let msg = decode(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_string();
            return Err(format!("hdfmonkey {cmd}: {}", if msg.is_empty() { format!("exit code {:?}", out.status.code()) } else { msg }));
        }
        Ok(out.stdout)
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        let out = decode(&self.run("ls", &[&rel(path)]).await?);
        let mut v = vec![];
        for line in out.lines() {
            let Some((a, name)) = line.split_once('\t') else { continue };
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let dir = a == "[DIR]";
            v.push(Entry { name: name.to_string(), dir, size: if dir { 0 } else { a.trim().parse().unwrap_or(0) }, mtime: None, perms: None, link: false });
        }
        sort_entries(&mut v);
        Ok(v)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        self.run("mkdir", &[&rel(path)]).await.map(|_| ())
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        self.run("rm", &[&rel(path)]).await.map(|_| ())
    }

    /// hdfmonkey deletes only empty folders.
    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        let mut dirs = vec![path.to_string()];
        let mut stack = vec![path.to_string()];
        while let Some(d) = stack.pop() {
            for e in self.list(&d).await? {
                let p = join(&d, &e.name);
                if e.dir {
                    dirs.push(p.clone());
                    stack.push(p);
                } else {
                    self.remove_file(&p).await?;
                }
            }
        }
        for d in dirs.iter().rev() {
            self.remove_file(d).await?;
        }
        Ok(())
    }

    async fn exists(&self, path: &str) -> Result<bool, String> {
        let p = rel(path);
        let (parent, name) = p.rsplit_once('/').unwrap_or(("", &p));
        Ok(self.list(parent).await?.iter().any(|e| e.name.eq_ignore_ascii_case(name)))
    }

    /// No rename in hdfmonkey: the files are copied through a temporary
    /// folder to the new name, then the old ones are deleted.
    pub async fn rename(&self, from: &str, to: &str, dir: bool) -> Result<(), String> {
        let same = rel(from).eq_ignore_ascii_case(&rel(to));
        if !same && self.exists(to).await? {
            return Err(format!("already exists: {to}"));
        }
        let tmp = std::env::temp_dir().join(format!("ftpstar-nextsd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let r = self.rename_via(from, to, dir, same, &tmp).await;
        let _ = std::fs::remove_dir_all(&tmp);
        r
    }

    async fn rename_via(&self, from: &str, to: &str, dir: bool, same: bool, tmp: &Path) -> Result<(), String> {
        // only the case changes: through a temporary name, as FAT sees the two as one
        if same {
            let mid = format!("{}.~ftpstar", rel(from));
            Box::pin(self.rename_via(from, &mid, dir, false, tmp)).await?;
            return Box::pin(self.rename_via(&mid, to, dir, false, tmp)).await;
        }
        if !dir {
            let local = tmp.join("f");
            let local = local.to_string_lossy();
            self.run("get", &[&rel(from), &local]).await?;
            self.run("put", &[&local, &rel(to)]).await?;
            let _ = std::fs::remove_file(&*local);
            return self.remove_file(from).await;
        }
        let mut stack = vec![String::new()];
        self.mkdir(to).await?;
        let mut n = 0u32;
        while let Some(sub) = stack.pop() {
            let src = if sub.is_empty() { from.to_string() } else { join(from, &sub) };
            let dst = if sub.is_empty() { to.to_string() } else { join(to, &sub) };
            for e in self.list(&src).await? {
                let s = if sub.is_empty() { e.name.clone() } else { format!("{sub}/{}", e.name) };
                if e.dir {
                    self.mkdir(&join(&dst, &e.name)).await?;
                    stack.push(s);
                } else {
                    n += 1;
                    let local = tmp.join(n.to_string());
                    let local = local.to_string_lossy();
                    self.run("get", &[&rel(&join(&src, &e.name)), &local]).await?;
                    self.run("put", &[&local, &rel(&join(&dst, &e.name))]).await?;
                    let _ = std::fs::remove_file(&*local);
                }
            }
        }
        self.remove_dir(from).await
    }

    /// hdfmonkey shows no progress: the bar jumps to the end when it is done.
    pub async fn download(&self, remote: &str, local: &str, p: Progress) -> Result<(), String> {
        p.check()?;
        if let Err(e) = self.run("get", &[&rel(remote), local]).await {
            let _ = tokio::fs::remove_file(local).await;
            return Err(e);
        }
        let n = tokio::fs::metadata(local).await.map(|m| m.len()).unwrap_or(0);
        p.add(n).or_else(|e| if e == CANCELLED { Ok(()) } else { Err(e) })
    }

    pub async fn upload(&self, local: &str, remote: &str, p: Progress) -> Result<(), String> {
        p.check()?;
        let n = tokio::fs::metadata(local).await.map_err(|e| format!("{local}: {e}"))?.len();
        self.run("put", &[local, &rel(remote)]).await?;
        p.add(n).or_else(|e| if e == CANCELLED { Ok(()) } else { Err(e) })
    }
}
