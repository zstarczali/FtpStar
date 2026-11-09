//! Microsoft OneDrive through Microsoft Graph.
//!
//! Sign-in is the OAuth device-code flow: FtpStar shows a short code, the user
//! enters it at microsoft.com/devicelogin, and FtpStar receives a refresh token,
//! saved with the site. It needs an Azure app registration (public client,
//! "Allow public client flows" on); its client id is set in Settings.

use crate::xfer::{cancel_aware, sort_entries, Entry, Progress};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

const LOGIN: &str = "https://login.microsoftonline.com";
const GRAPH: &str = "https://graph.microsoft.com/v1.0/me/drive";
const SCOPE: &str = "Files.ReadWrite.All offline_access User.Read";
/// Upload-session chunk: a multiple of 320 KiB, as Graph requires (5 MiB).
const CHUNK: usize = 320 * 1024 * 16;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(crate::settings::net_timeout())
        .read_timeout(crate::settings::net_timeout().max(Duration::from_secs(30)))
        .user_agent(concat!("FtpStar/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

fn graph_error(v: &Value, status: reqwest::StatusCode) -> String {
    v["error"]["message"].as_str().or(v["error_description"].as_str()).map(String::from).unwrap_or_else(|| format!("OneDrive: HTTP {status}"))
}

async fn json_of(r: reqwest::Response) -> Result<Value, String> {
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(v)
    } else {
        Err(graph_error(&v, status))
    }
}

/// Sign-in authority per client id. Apps registered for "personal Microsoft
/// accounts only" are refused on `/common` (AADSTS9002346) and must use
/// `/consumers`; the first such refusal switches the client id over.
static TENANTS: std::sync::Mutex<Vec<(String, &'static str)>> = std::sync::Mutex::new(Vec::new());

fn tenant(client_id: &str) -> &'static str {
    TENANTS.lock().unwrap().iter().find(|(c, _)| c == client_id).map(|(_, t)| *t).unwrap_or("common")
}

/// POST a form to the token service (`devicecode` or `token`), retrying on
/// `/consumers` when the app is personal-account-only.
async fn auth_post(http: &reqwest::Client, client_id: &str, endpoint: &str, form: &[(&str, &str)]) -> Result<(reqwest::StatusCode, Value), String> {
    let client_id = client_id.trim();
    loop {
        let t = tenant(client_id);
        let r = http.post(format!("{LOGIN}/{t}/oauth2/v2.0/{endpoint}")).form(form).send().await.map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if t == "common" && v["error_description"].as_str().is_some_and(|d| d.contains("AADSTS9002346")) {
            TENANTS.lock().unwrap().push((client_id.to_string(), "consumers"));
            continue;
        }
        return Ok((status, v));
    }
}

#[derive(Serialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
    pub message: String,
}

pub async fn device_start(client_id: &str) -> Result<DeviceCode, String> {
    if client_id.trim().is_empty() {
        return Err("ONEDRIVE_NO_CLIENT_ID".into());
    }
    let (status, v) = auth_post(&client(), client_id, "devicecode", &[("client_id", client_id.trim()), ("scope", SCOPE)]).await?;
    if !status.is_success() {
        return Err(graph_error(&v, status));
    }
    Ok(DeviceCode {
        device_code: v["device_code"].as_str().unwrap_or_default().into(),
        user_code: v["user_code"].as_str().unwrap_or_default().into(),
        verification_uri: v["verification_uri"].as_str().unwrap_or("https://microsoft.com/devicelogin").into(),
        interval: v["interval"].as_u64().unwrap_or(5),
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
        message: v["message"].as_str().unwrap_or_default().into(),
    })
}

#[derive(Serialize)]
pub struct PollResult {
    /// pending | ok
    pub status: String,
    pub refresh_token: String,
    pub account: String,
}

/// One poll of the device-code flow: "pending" until the user has signed in.
pub async fn device_poll(client_id: &str, device_code: &str) -> Result<PollResult, String> {
    let form = [("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), ("client_id", client_id.trim()), ("device_code", device_code)];
    let (_, v) = auth_post(&client(), client_id, "token", &form).await?;
    match v["error"].as_str() {
        Some("authorization_pending") | Some("slow_down") => {
            return Ok(PollResult { status: "pending".into(), refresh_token: String::new(), account: String::new() })
        }
        Some(_) => return Err(graph_error(&v, reqwest::StatusCode::BAD_REQUEST)),
        None => {}
    }
    let access = v["access_token"].as_str().unwrap_or_default();
    let me = client().get("https://graph.microsoft.com/v1.0/me").bearer_auth(access).send().await.map_err(|e| e.to_string())?;
    let me = json_of(me).await.unwrap_or(Value::Null);
    let account = me["userPrincipalName"].as_str().or(me["mail"].as_str()).or(me["displayName"].as_str()).unwrap_or("OneDrive");
    Ok(PollResult { status: "ok".into(), refresh_token: v["refresh_token"].as_str().unwrap_or_default().into(), account: account.into() })
}

struct Token {
    access: String,
    refresh: String,
    expires: Instant,
}

pub struct OneDrive {
    http: reqwest::Client,
    client_id: String,
    token: Mutex<Token>,
    /// Called with the new refresh token (Microsoft rotates it) to save it.
    on_refresh: Box<dyn Fn(&str) + Send + Sync>,
}

/// Graph address of an item by path: the root, or `root:/a/b:`.
fn item(path: &str) -> String {
    let p = path.trim_matches('/');
    if p.is_empty() {
        format!("{GRAPH}/root")
    } else {
        let enc: Vec<String> = p.split('/').map(|s| urlencoding::encode(s).into_owned()).collect();
        format!("{GRAPH}/root:/{}:", enc.join("/"))
    }
}

impl OneDrive {
    pub async fn open(client_id: &str, refresh: &str, on_refresh: Box<dyn Fn(&str) + Send + Sync>) -> Result<Self, String> {
        if refresh.is_empty() {
            return Err("ONEDRIVE_SIGN_IN".into());
        }
        let me = Self {
            http: client(),
            client_id: client_id.trim().to_string(),
            token: Mutex::new(Token { access: String::new(), refresh: refresh.to_string(), expires: Instant::now() }),
            on_refresh,
        };
        me.access().await?;
        Ok(me)
    }

    async fn access(&self) -> Result<String, String> {
        let mut t = self.token.lock().await;
        if !t.access.is_empty() && t.expires > Instant::now() + Duration::from_secs(60) {
            return Ok(t.access.clone());
        }
        let form = [("grant_type", "refresh_token"), ("client_id", self.client_id.as_str()), ("refresh_token", t.refresh.as_str()), ("scope", SCOPE)];
        let (status, v) = auth_post(&self.http, &self.client_id, "token", &form).await?;
        if !status.is_success() {
            return Err(format!("ONEDRIVE_SIGN_IN:{}", graph_error(&v, status)));
        }
        t.access = v["access_token"].as_str().unwrap_or_default().into();
        t.expires = Instant::now() + Duration::from_secs(v["expires_in"].as_u64().unwrap_or(3600));
        if let Some(rt) = v["refresh_token"].as_str() {
            if rt != t.refresh {
                t.refresh = rt.into();
                (self.on_refresh)(rt);
            }
        }
        Ok(t.access.clone())
    }

    async fn send(&self, rb: reqwest::RequestBuilder) -> Result<Value, String> {
        json_of(rb.bearer_auth(self.access().await?).send().await.map_err(|e| e.to_string())?).await
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Entry>, String> {
        let mut url = format!("{}/children?$top=999&$select=name,size,folder,file,lastModifiedDateTime", item(path));
        let mut out = vec![];
        loop {
            let v = self.send(self.http.get(&url)).await?;
            for it in v["value"].as_array().cloned().unwrap_or_default() {
                let mtime = it["lastModifiedDateTime"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp());
                out.push(Entry {
                    name: it["name"].as_str().unwrap_or_default().into(),
                    dir: it.get("folder").is_some(),
                    size: if it.get("folder").is_some() { 0 } else { it["size"].as_u64().unwrap_or(0) },
                    mtime,
                    perms: None,
                    link: false,
                });
            }
            match v["@odata.nextLink"].as_str() {
                Some(next) => url = next.to_string(),
                None => break,
            }
        }
        sort_entries(&mut out);
        Ok(out)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        let (parent, name) = crate::xfer::split(path);
        let body = json!({ "name": name, "folder": {}, "@microsoft.graph.conflictBehavior": "fail" });
        self.send(self.http.post(format!("{}/children", item(&parent))).json(&body)).await.map(|_| ())
    }

    /// Deletes a file or a whole folder (Graph deletes folders recursively).
    pub async fn remove(&self, path: &str) -> Result<(), String> {
        let r = self.http.delete(item(path)).bearer_auth(self.access().await?).send().await.map_err(|e| e.to_string())?;
        if r.status().is_success() {
            Ok(())
        } else {
            json_of(r).await.map(|_| ())
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let (parent, name) = crate::xfer::split(to);
        let parent_path = if parent == "/" { "/drive/root:".to_string() } else { format!("/drive/root:{parent}") };
        let body = json!({ "name": name, "parentReference": { "path": parent_path } });
        self.send(self.http.patch(item(from)).json(&body)).await.map(|_| ())
    }

    pub async fn download(&self, remote: &str, local: &str, p: Progress) -> Result<(), String> {
        let r = self.http.get(format!("{}/content", item(remote))).bearer_auth(self.access().await?).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return json_of(r).await.map(|_| ());
        }
        if let Some(len) = r.content_length() {
            p.set_total(len);
        }
        let mut file = tokio::io::BufWriter::with_capacity(256 * 1024, tokio::fs::File::create(local).await.map_err(|e| format!("{local}: {e}"))?);
        let mut stream = r.bytes_stream();
        let res: Result<(), String> = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| cancel_aware(&p, e))?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                p.add(chunk.len() as u64)?;
            }
            file.flush().await.map_err(|e| e.to_string())
        }
        .await;
        if res.is_err() {
            drop(file);
            let _ = tokio::fs::remove_file(local).await;
        }
        res
    }

    pub async fn upload(&self, local: &str, remote: &str, p: Progress) -> Result<(), String> {
        let mut file = tokio::fs::File::open(local).await.map_err(|e| format!("{local}: {e}"))?;
        let total = file.metadata().await.map_err(|e| e.to_string())?.len();
        if total <= 4 * 1024 * 1024 {
            let mut buf = Vec::with_capacity(total as usize);
            file.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
            self.send(self.http.put(format!("{}/content", item(remote))).body(buf)).await?;
            return p.add(total);
        }
        // large file: an upload session, sent in 5 MiB pieces
        let body = json!({ "item": { "@microsoft.graph.conflictBehavior": "replace" } });
        let v = self.send(self.http.post(format!("{}/createUploadSession", item(remote))).json(&body)).await?;
        let url = v["uploadUrl"].as_str().ok_or("OneDrive: no upload URL")?.to_string();
        let mut buf = vec![0u8; CHUNK];
        let mut start: u64 = 0;
        let res: Result<(), String> = async {
            while start < total {
                p.check()?;
                let mut n = 0;
                while n < CHUNK {
                    let k = file.read(&mut buf[n..]).await.map_err(|e| e.to_string())?;
                    if k == 0 {
                        break;
                    }
                    n += k;
                }
                let end = start + n as u64 - 1;
                let r = self
                    .http
                    .put(&url)
                    .header("Content-Range", format!("bytes {start}-{end}/{total}"))
                    .body(buf[..n].to_vec())
                    .send()
                    .await
                    .map_err(|e| cancel_aware(&p, e))?;
                if !r.status().is_success() {
                    return json_of(r).await.map(|_| ());
                }
                start = end + 1;
                p.add(n as u64)?;
            }
            Ok(())
        }
        .await;
        if res.is_err() {
            let _ = self.http.delete(&url).send().await; // cancel the session
        }
        res
    }
}
