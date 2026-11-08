//! Amazon S3 and S3-compatible storage (Cloudflare R2, MinIO, Wasabi,
//! Backblaze B2…). Folders are key prefixes ending in "/"; a new folder is an
//! empty "name/" object, as the AWS console makes it.

use crate::settings::Site;
use crate::xfer::{sort_entries, Entry, Progress, ProgressReader, ProgressWriter, CANCELLED};
use s3::creds::Credentials;
use s3::{Bucket, Region};

pub struct S3 {
    bucket: Box<Bucket>,
}

/// "/a/b" → "a/b"; with `dir`, "a/b/" ("" for the root).
fn key(path: &str, dir: bool) -> String {
    let k = path.trim_matches('/').to_string();
    if dir && !k.is_empty() {
        format!("{k}/")
    } else {
        k
    }
}

fn err(e: impl ToString) -> String {
    let s = e.to_string();
    if s.contains(CANCELLED) {
        CANCELLED.into()
    } else {
        s
    }
}

fn check_status(code: u16) -> Result<(), String> {
    if (200..300).contains(&code) {
        Ok(())
    } else {
        Err(format!("S3: HTTP {code}"))
    }
}

impl S3 {
    pub async fn open(site: &Site, secret: &str) -> Result<(Self, String), String> {
        if site.s3_bucket.trim().is_empty() {
            return Err("S3: bucket name missing".into());
        }
        let region_name = if site.s3_region.trim().is_empty() { "us-east-1".to_string() } else { site.s3_region.trim().to_string() };
        let custom = !site.s3_endpoint.trim().is_empty();
        let region = if custom {
            Region::Custom { region: region_name, endpoint: site.s3_endpoint.trim().trim_end_matches('/').to_string() }
        } else {
            region_name.parse::<Region>().map_err(|e| e.to_string())?
        };
        let creds = Credentials::new(Some(site.user.trim()), Some(secret), None, None, None).map_err(|e| e.to_string())?;
        let mut bucket = Bucket::new(site.s3_bucket.trim(), region, creds).map_err(err)?;
        if custom || site.s3_path_style {
            bucket = bucket.with_path_style();
        }
        let me = Self { bucket };
        // a cheap call that fails on wrong keys, region or bucket
        me.bucket.list_page(String::new(), Some("/".into()), None, None, Some(1)).await.map_err(err)?;
        let home = if site.remote_dir.trim().is_empty() { "/".into() } else { site.remote_dir.clone() };
        Ok((me, home))
    }

    async fn all_keys(&self, prefix: &str) -> Result<Vec<String>, String> {
        let res = self.bucket.list(prefix.to_string(), None).await.map_err(err)?;
        Ok(res.into_iter().flat_map(|r| r.contents.into_iter().map(|o| o.key)).collect())
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        let prefix = key(path, true);
        let res = self.bucket.list(prefix.clone(), Some("/".into())).await.map_err(err)?;
        let mut out = vec![];
        for r in res {
            for cp in r.common_prefixes.unwrap_or_default() {
                let name = cp.prefix[prefix.len()..].trim_end_matches('/').to_string();
                if !name.is_empty() {
                    out.push(Entry { name, dir: true, size: 0, mtime: None, perms: None, link: false });
                }
            }
            for o in r.contents {
                if o.key == prefix || o.key.len() <= prefix.len() {
                    continue; // the folder's own marker object
                }
                let mtime = chrono::DateTime::parse_from_rfc3339(&o.last_modified).ok().map(|d| d.timestamp());
                out.push(Entry { name: o.key[prefix.len()..].to_string(), dir: false, size: o.size, mtime, perms: None, link: false });
            }
        }
        sort_entries(&mut out);
        Ok(out)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        let r = self.bucket.put_object(key(path, true), &[]).await.map_err(err)?;
        check_status(r.status_code())
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        self.bucket.delete_object(key(path, false)).await.map_err(err)?;
        Ok(())
    }

    /// Deletes everything under the prefix, the marker object included.
    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        let prefix = key(path, true);
        for k in self.all_keys(&prefix).await? {
            self.bucket.delete_object(&k).await.map_err(err)?;
        }
        let _ = self.bucket.delete_object(&prefix).await;
        Ok(())
    }

    /// S3 has no rename: copy, then delete. For a folder, every object in it.
    pub async fn rename(&self, from: &str, to: &str, dir: bool) -> Result<(), String> {
        if !dir {
            check_status(self.bucket.copy_object_internal(key(from, false), key(to, false)).await.map_err(err)?)?;
            return self.remove_file(from).await;
        }
        let (fp, tp) = (key(from, true), key(to, true));
        for k in self.all_keys(&fp).await? {
            let target = format!("{tp}{}", &k[fp.len()..]);
            check_status(self.bucket.copy_object_internal(&k, &target).await.map_err(err)?)?;
        }
        self.remove_dir(from).await
    }

    pub async fn download(&self, remote: &str, local: &str, p: Progress) -> Result<(), String> {
        let file = tokio::fs::File::create(local).await.map_err(|e| format!("{local}: {e}"))?;
        let mut w = ProgressWriter { inner: tokio::io::BufWriter::with_capacity(256 * 1024, file), progress: p };
        let r = self.bucket.get_object_to_writer(key(remote, false), &mut w).await.map_err(err).and_then(check_status);
        let r = match r {
            Ok(()) => tokio::io::AsyncWriteExt::flush(&mut w).await.map_err(|e| e.to_string()),
            Err(e) => Err(e),
        };
        if r.is_err() {
            drop(w);
            let _ = tokio::fs::remove_file(local).await;
        }
        r
    }

    pub async fn upload(&self, local: &str, remote: &str, p: Progress) -> Result<(), String> {
        let file = tokio::fs::File::open(local).await.map_err(|e| format!("{local}: {e}"))?;
        let mut r = ProgressReader { inner: file, progress: p };
        let res = self.bucket.put_object_stream(&mut r, key(remote, false)).await.map_err(err)?;
        check_status(res.status_code())
    }
}
