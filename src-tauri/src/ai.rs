//! AI features through the Claude Messages API (raw HTTP, API key auth),
//! DeepSeek, or the local Claude Code CLI.

use crate::settings::tr;
use serde_json::{json, Value};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Largest text sent to the model; above this it is cut and the user is
/// told so in the result.
pub const MAX_DIFF_CHARS: usize = 600_000;

const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";

/// Smaller diff limit for DeepSeek (smaller context window than Claude).
pub const DEEPSEEK_MAX_DIFF_CHARS: usize = 300_000;

pub struct AiRequest<'a> {
    /// "anthropic" | "deepseek" | "claude-cli"
    pub provider: &'a str,
    /// API key; for "claude-cli" the CLI path from Settings (empty = find it)
    pub api_key: &'a str,
    pub model: &'a str,
    pub system: String,
    pub user: String,
    pub effort: &'a str,
    pub max_tokens: u32,
}

/// Models that accept the `output_config.effort` parameter.
fn supports_effort(model: &str) -> bool {
    !(model.starts_with("claude-haiku-4") || model.contains("sonnet-4-5") || model.contains("3-"))
}

/// Models that accept server-side `fallbacks: "default"`.
fn supports_fallback(model: &str) -> bool {
    matches!(model, "claude-opus-5-5" | "claude-opus-5" | "claude-fable-5-1" | "claude-sonnet-5-5")
}

pub async fn complete(req: AiRequest<'_>) -> Result<String, String> {
    if req.provider == "deepseek" {
        return complete_deepseek(req).await;
    }
    if req.provider == "claude-cli" {
        let (path, model, system, user) = (req.api_key.to_string(), req.model.to_string(), req.system, req.user);
        let effort = supports_effort(&model).then(|| req.effort.to_string());
        return tauri::async_runtime::spawn_blocking(move || crate::claude_cli::complete(&path, &model, effort.as_deref(), &system, &user))
            .await
            .map_err(|e| e.to_string())?;
    }
    if req.api_key.trim().is_empty() {
        return Err(tr("Nincs megadva Anthropic API kulcs (Beállítások → AI).", "No Anthropic API key is set (Settings → AI)."));
    }
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "messages": [{ "role": "user", "content": req.user }],
    });
    if supports_effort(req.model) {
        body["output_config"] = json!({ "effort": req.effort });
    }
    let fallback = supports_fallback(req.model);
    if fallback {
        body["fallbacks"] = json!("default");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut http = client
        .post(API_URL)
        .header("x-api-key", req.api_key.trim())
        .header("anthropic-version", API_VERSION)
        .header("content-type", "application/json");
    if fallback {
        http = http.header("anthropic-beta", FALLBACK_BETA);
    }
    let resp = http.json(&body).send().await.map_err(|e| format!("{}: {e}", tr("Hálózati hiba", "Network error")))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| format!("{}: {e}", tr("Hibás válasz", "Invalid response")))?;
    if !status.is_success() {
        let unknown = tr("ismeretlen hiba", "unknown error");
        let msg = v["error"]["message"].as_str().unwrap_or(&unknown);
        let kind = v["error"]["type"].as_str().unwrap_or("");
        return Err(match status.as_u16() {
            401 => format!("{} ({msg})", tr("Érvénytelen API kulcs", "Invalid API key")),
            429 => format!("{} ({msg})", tr("Túl sok kérés / kvóta elfogyott, próbáld később", "Too many requests / quota exceeded, try again later")),
            529 => format!("{} ({msg})", tr("Az API túlterhelt, próbáld később", "The API is overloaded, try again later")),
            c => format!("{} {c} {kind}: {msg}", tr("API hiba", "API error")),
        });
    }
    crate::usage::record_anthropic(req.model, &v);
    if v["stop_reason"].as_str() == Some("refusal") {
        let expl = v["stop_details"]["explanation"].as_str().unwrap_or("");
        return Err(format!("{} {expl}", tr("A modell elutasította a kérést.", "The model declined the request.")));
    }
    let text: String = v["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err(tr("Üres válasz érkezett a modelltől.", "The model returned an empty response."));
    }
    let mut text = text.trim().to_string();
    if v["stop_reason"].as_str() == Some("max_tokens") {
        text.push_str(&tr("\n\n_(A válasz a maximális hossznál megszakadt.)_", "\n\n_(The answer was cut at the maximum length.)_"));
    }
    Ok(text)
}

/// DeepSeek: OpenAI-compatible chat completions API, Bearer key.
async fn complete_deepseek(req: AiRequest<'_>) -> Result<String, String> {
    if req.api_key.trim().is_empty() {
        return Err(tr("Nincs megadva DeepSeek API kulcs (Beállítások → AI).", "No DeepSeek API key is set (Settings → AI)."));
    }
    // max_tokens is left to the server default: the per-model limits are not published.
    let body = json!({
        "model": req.model,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user },
        ],
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(DEEPSEEK_URL)
        .bearer_auth(req.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", tr("Hálózati hiba", "Network error")))?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("{}: {e}", tr("Hibás válasz", "Invalid response")))?;
    let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| raw.chars().take(300).collect());
        return Err(match status.as_u16() {
            401 => format!("{} ({msg})", tr("Érvénytelen DeepSeek API kulcs", "Invalid DeepSeek API key")),
            402 => format!("{} ({msg})", tr("Elfogyott a DeepSeek egyenleg", "DeepSeek balance is insufficient")),
            429 => format!("{} ({msg})", tr("Túl sok kérés, próbáld később", "Too many requests, try again later")),
            500 | 503 => format!("{} ({msg})", tr("A DeepSeek szerver túlterhelt vagy hibás, próbáld később", "The DeepSeek server is busy or failing, try again later")),
            c => format!("DeepSeek {} {c}: {msg}", tr("hiba", "error")),
        });
    }
    crate::usage::record_deepseek(req.model, &v);
    let choice = &v["choices"][0];
    let text = choice["message"]["content"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(tr("Üres válasz érkezett a modelltől.", "The model returned an empty response."));
    }
    let mut text = text;
    if choice["finish_reason"].as_str() == Some("length") {
        text.push_str(&tr("\n\n_(A válasz a maximális hossznál megszakadt.)_", "\n\n_(The answer was cut at the maximum length.)_"));
    }
    Ok(text)
}

pub fn cut_diff(diff: &str, provider: &str) -> (String, bool) {
    let max = if provider == "deepseek" { DEEPSEEK_MAX_DIFF_CHARS } else { MAX_DIFF_CHARS };
    if diff.len() <= max {
        return (diff.to_string(), false);
    }
    let mut end = max;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    (diff[..end].to_string(), true)
}

fn lang_name(lang: &str) -> &'static str {
    if lang == "en" { "English" } else { "Hungarian" }
}

/// What the AI does when the user only presses the AI button.
pub const FOLDER_DEFAULT_ASK: &str = "Analyse the comparison using the default structure.";

pub fn folder_system(lang: &str) -> String {
    format!(
        "You are inside FtpStar, a two-pane file transfer client (FTP, FTPS, SFTP, Amazon S3, OneDrive). The user compares \
         a local folder with a folder on a server. You get a report (inside <compare>) made from both folder trees with \
         subfolders: file names relative to the compared folders, sizes, modification times (UTC), and the result of the \
         comparison per file: only on the local side, only on the server, newer on one side, different size, same. You do \
         NOT see the file contents.\n\
         Answer in {lang}, formatted as Markdown.\n\
         When no specific request is made: ## Összefoglaló / Summary (2–4 sentences: how far the two sides are apart, which \
         side looks more recent overall, what kind of project it is), ## Változások / Changes (group the changed files by \
         folder or purpose, mention the most important ones by name, note what is new only locally and only on the server), \
         ## Kockázatok / Risks (e.g. a file newer on the server that an upload would overwrite, the same file changed on \
         both sides, secrets or local-only files on the server such as .env, .git, backups, dumps, logs, node_modules, large \
         or temporary files), ## Javaslat / Suggested steps (a short checklist: what to upload, what to download, what to \
         check by hand; FtpStar can do this with \"Csak újak / New only\" or by selecting the files). \
         Never claim to know what changed inside a file; reason only from names, sizes and dates, and say so when it matters. \
         When the report says lists were cut, mention it. When the request is a question, answer it directly and concisely. \
         Use the heading language that matches {lang}.",
        lang = lang_name(lang)
    )
}
