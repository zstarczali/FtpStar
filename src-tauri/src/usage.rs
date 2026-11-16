//! AI token counter: every answer's `usage` (Claude API, DeepSeek, Claude Code CLI)
//! is added up per provider / model, kept across restarts in `ai-usage.json`
//! next to the settings, and sent to the UI as the `ai-usage` event.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(default)]
pub struct Counts {
    pub requests: u64,
    /// uncached input tokens
    pub input: u64,
    pub output: u64,
    /// prompt-cache writes (Claude)
    pub cache_write: u64,
    /// prompt-cache hits (Claude, DeepSeek)
    pub cache_read: u64,
    /// the cost the Claude Code CLI reports (USD); the APIs do not send one
    pub cost_usd: f64,
}

impl Counts {
    fn add(&mut self, o: &Counts) {
        self.requests += o.requests;
        self.input += o.input;
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.cache_read += o.cache_read;
        self.cost_usd += o.cost_usd;
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Stored {
    /// when the counting started / was last reset (ms since 1970)
    pub since: i64,
    pub total: Counts,
    /// "provider · model" → counts
    pub models: BTreeMap<String, Counts>,
}

#[derive(Serialize, Clone)]
pub struct Report {
    pub all: Stored,
    /// since the app was started
    pub session: Counts,
    /// the last answer
    pub last: Option<Counts>,
}

struct State {
    path: PathBuf,
    all: Stored,
    session: Counts,
    last: Option<Counts>,
    app: Option<tauri::AppHandle>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Loads the stored counts; call once from `setup`.
pub fn init(app: tauri::AppHandle, config_dir: PathBuf) {
    let path = config_dir.join("ai-usage.json");
    let mut all: Stored = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if all.since == 0 {
        all.since = now_ms();
    }
    let _ = STATE.set(Mutex::new(State { path, all, session: Counts::default(), last: None, app: Some(app) }));
}

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| Mutex::new(State {
        path: std::env::temp_dir().join("ai-usage.json"),
        all: Stored { since: now_ms(), ..Default::default() },
        session: Counts::default(),
        last: None,
        app: None,
    }))
}

fn report_of(s: &State) -> Report {
    Report { all: s.all.clone(), session: s.session.clone(), last: s.last.clone() }
}

pub fn report() -> Report {
    report_of(&state().lock().unwrap_or_else(|e| e.into_inner()))
}

fn save_and_emit(s: &State) {
    if let Some(dir) = s.path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&s.all) {
        let _ = std::fs::write(&s.path, json);
    }
    if let Some(app) = &s.app {
        let _ = app.emit("ai-usage", report_of(s));
    }
}

pub fn record(provider: &str, model: &str, c: Counts) {
    if c == Counts::default() {
        return;
    }
    let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
    s.all.total.add(&c);
    let key = if model.is_empty() { provider.to_string() } else { format!("{provider} · {model}") };
    s.all.models.entry(key).or_default().add(&c);
    s.session.add(&c);
    s.last = Some(c);
    save_and_emit(&s);
}

pub fn reset() -> Report {
    let mut s = state().lock().unwrap_or_else(|e| e.into_inner());
    s.all = Stored { since: now_ms(), ..Default::default() };
    s.session = Counts::default();
    s.last = None;
    save_and_emit(&s);
    report_of(&s)
}

fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// Claude Messages API answer (also the `usage` of the Claude Code CLI result).
pub fn anthropic_counts(usage: &Value) -> Counts {
    Counts {
        requests: 1,
        input: n(&usage["input_tokens"]),
        output: n(&usage["output_tokens"]),
        cache_write: n(&usage["cache_creation_input_tokens"]),
        cache_read: n(&usage["cache_read_input_tokens"]),
        cost_usd: 0.0,
    }
}

/// Records a Claude API answer (`v` = the whole response body).
pub fn record_anthropic(model: &str, v: &Value) {
    // with server-side fallback the answering model is in the response
    let model = v["model"].as_str().unwrap_or(model);
    record("Claude API", model, anthropic_counts(&v["usage"]));
}

/// Records a DeepSeek (OpenAI-style) answer: cache hits are part of prompt_tokens.
pub fn record_deepseek(model: &str, v: &Value) {
    let u = &v["usage"];
    let hit = n(&u["prompt_cache_hit_tokens"]);
    let model = v["model"].as_str().unwrap_or(model);
    record("DeepSeek", model, Counts {
        requests: 1,
        input: n(&u["prompt_tokens"]).saturating_sub(hit),
        output: n(&u["completion_tokens"]),
        cache_write: 0,
        cache_read: hit,
        cost_usd: 0.0,
    });
}

/// Records a Claude Code CLI result (`--output-format json`).
pub fn record_cli(model: &str, v: &Value) {
    let mut c = anthropic_counts(&v["usage"]);
    c.cost_usd = v["total_cost_usd"].as_f64().unwrap_or(0.0);
    record("Claude Code CLI", if model.is_empty() { "default" } else { model }, c);
}

#[tauri::command]
pub fn ai_usage() -> Report {
    report()
}

#[tauri::command]
pub fn ai_usage_reset() -> Report {
    reset()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_usage_shapes() {
        let a = anthropic_counts(&json!({ "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 3 }));
        assert_eq!((a.input, a.output, a.cache_read, a.cache_write, a.requests), (10, 5, 3, 0, 1));
        let mut t = Counts::default();
        t.add(&a);
        t.add(&a);
        assert_eq!((t.requests, t.input), (2, 20));
    }
}
