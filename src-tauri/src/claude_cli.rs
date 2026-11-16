//! AI through the locally installed Claude Code CLI (`claude -p`).
//! Uses the user's own Claude login (subscription or API key set up in the CLI),
//! so NoteStar needs no API key of its own. Tools, MCP servers, slash commands and
//! session files are switched off: the CLI only answers the prompt.

use crate::settings::tr;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Executable names of the CLI on this platform, preferred first.
fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] }
}

/// Finds the `claude` executable: the path from Settings, then PATH, then the usual
/// install locations (GUI apps on macOS start with a short PATH, so these matter).
pub fn find(custom: &str) -> Result<PathBuf, String> {
    let custom = custom.trim().trim_matches('"');
    if !custom.is_empty() {
        let p = PathBuf::from(custom);
        return if p.is_file() {
            Ok(p)
        } else {
            Err(format!("{}: {custom}", tr("A megadott Claude CLI nem található", "The Claude CLI given in Settings was not found")))
        };
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(h) = home() {
        dirs.push(h.join(".local").join("bin"));
        dirs.push(h.join(".claude").join("local"));
        dirs.push(h.join(".npm-global").join("bin"));
        dirs.push(h.join(".bun").join("bin"));
        dirs.push(h.join(".volta").join("bin"));
    }
    if cfg!(windows) {
        if let Some(a) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(a).join("npm"));
        }
    } else {
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
        dirs.push("/usr/bin".into());
    }
    for name in exe_names() {
        for d in &dirs {
            let p = d.join(name);
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err(tr(
        "Nem található a Claude CLI (claude). Telepítsd (https://claude.com/claude-code), jelentkezz be a „claude” paranccsal, vagy add meg az útvonalát a Beállításokban.",
        "The Claude CLI (claude) was not found. Install it (https://claude.com/claude-code), sign in by running „claude”, or set its path in Settings.",
    ))
}

fn command(exe: &Path) -> Command {
    // npm installs a .cmd shim on Windows, which only runs through cmd.exe
    let is_cmd = exe.extension().map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")).unwrap_or(false);
    let cmd = if is_cmd {
        let mut c = Command::new("cmd");
        c.arg("/D").arg("/C").arg(exe);
        c
    } else {
        Command::new(exe)
    };
    #[cfg(windows)]
    let cmd = {
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    cmd
}

/// Runs one prompt through `claude -p` and returns the answer text. Blocking.
pub fn complete(custom_path: &str, model: &str, effort: Option<&str>, system: &str, user: &str) -> Result<String, String> {
    let exe = find(custom_path)?;
    // the system prompt goes in a file: no quoting or command-line length issues
    let dir = std::env::temp_dir();
    let sys_file = dir.join(format!("ftpstar-ai-{}-{}.txt", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
    std::fs::write(&sys_file, system).map_err(|e| e.to_string())?;

    let mut cmd = command(&exe);
    cmd.args(["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]);
    cmd.arg("--system-prompt-file").arg(&sys_file);
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model.trim());
    }
    if let Some(e) = effort {
        cmd.arg("--effort").arg(e);
    }
    // a neutral folder, so no project CLAUDE.md or settings of the open repository are picked up
    cmd.current_dir(&dir)
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let result = (|| {
        let mut child = cmd.spawn().map_err(|e| format!("{} ({}): {e}", tr("A Claude CLI nem indítható", "Could not start the Claude CLI"), exe.display()))?;
        let mut stdin = child.stdin.take().ok_or("stdin")?;
        let input = user.to_string();
        // write on another thread: a big diff could fill the pipe while the CLI is writing too
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let _ = writer.join();
        Ok::<_, String>(out)
    })();
    let _ = std::fs::remove_file(&sys_file);
    let out = result?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // the JSON result is the last line that parses as an object
    let v: Option<Value> = stdout.lines().rev().find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(|v| v.is_object()));
    let Some(v) = v else {
        let msg: String = format!("{} {}", stderr.trim(), stdout.trim()).trim().chars().take(600).collect();
        let msg = if msg.is_empty() { format!("exit {}", out.status) } else { msg };
        return Err(format!("{}: {msg}", tr("Claude CLI hiba", "Claude CLI error")));
    };
    crate::usage::record_cli(model, &v);
    let text = v["result"].as_str().unwrap_or("").trim().to_string();
    if v["is_error"].as_bool() == Some(true) || v["subtype"].as_str().is_some_and(|s| s != "success") {
        let mut msg = if text.is_empty() { stderr.trim().chars().take(600).collect() } else { text };
        if msg.is_empty() {
            msg = v["subtype"].as_str().unwrap_or("error").to_string();
        }
        let low = msg.to_lowercase();
        if low.contains("log in") || low.contains("login") || low.contains("authenticat") {
            msg.push_str(&tr(" — jelentkezz be a „claude” paranccsal egy terminálban.", " — sign in by running „claude” in a terminal."));
        }
        return Err(format!("{}: {msg}", tr("Claude CLI hiba", "Claude CLI error")));
    }
    if text.is_empty() {
        return Err(tr("Üres válasz érkezett a modelltől.", "The model returned an empty response."));
    }
    let mut text = text;
    if v["stop_reason"].as_str() == Some("max_tokens") {
        text.push_str(&tr("\n\n_(A válasz a maximális hossznál megszakadt.)_", "\n\n_(The answer was cut at the maximum length.)_"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    // Runs the real CLI (needs it installed and signed in): cargo test claude_cli -- --ignored
    #[test]
    #[ignore]
    fn real_cli_round_trip() {
        let ok = super::complete("", "claude-haiku-5-5", Some("low"), "Answer with exactly: OK", "Connection test.");
        assert_eq!(ok.as_deref().map(str::trim), Ok("OK"), "{ok:?}");
        let bad = super::complete("", "nonexistent-model-x", None, "x", "x");
        eprintln!("bad model -> {bad:?}");
        assert!(bad.is_err());
        let nopath = super::complete("C:/nope/claude.exe", "claude-haiku-5-5", None, "x", "x");
        eprintln!("bad path -> {nopath:?}");
        assert!(nopath.is_err());
    }
}
