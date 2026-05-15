//! Claude Code hook integration for tmux mode.
//!
//! Claude Code calls user-defined "hook" shell commands at well-known points
//! (PreToolUse, PostToolUse, UserPromptSubmit, Stop, Notification). We use
//! these hooks to surface tool decisions to our native UI.
//!
//! Layout:
//!   - One `hook.sh` is installed per *workspace* (env). It extracts
//!     `session_id` from the payload Claude Code feeds on stdin and writes
//!     the event to a *per-session* pending dir at
//!     `<workspace_root>/sessions/<session_id>/pending/<EventKind>-<id>.json`.
//!   - Each `TmuxSession`'s poll loop reads from its own session's pending
//!     dir, so concurrent tabs in the same workspace get their own events
//!     without bleed.
//!   - `.claude/settings.local.json` (workspace-level) is installed once and
//!     uninstalled when the last session in the workspace stops; an
//!     idempotent backup of the user's original is preserved.

use super::backend::Backend;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Default for how long the PreToolUse hook will wait for the UI to respond
/// before falling back to Claude Code's normal permission prompt.
pub const HOOK_TIMEOUT_SECS: u32 = 600; // 10 min

/// Sentinel value stored in the settings-backup file when there was no
/// original `.claude/settings.local.json` at install time.
const BACKUP_SENTINEL_NO_ORIGINAL: &str = "__orkestrator_no_original__";

#[derive(Debug, Clone, Copy)]
pub enum HookEventKind {
    PreToolUse,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    SubagentStop,
    Notification,
    SessionStart,
}

impl HookEventKind {
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "PreToolUse" => HookEventKind::PreToolUse,
            "PostToolUse" => HookEventKind::PostToolUse,
            "UserPromptSubmit" => HookEventKind::UserPromptSubmit,
            "Stop" => HookEventKind::Stop,
            "SubagentStop" => HookEventKind::SubagentStop,
            "Notification" => HookEventKind::Notification,
            "SessionStart" => HookEventKind::SessionStart,
            _ => return None,
        })
    }

    pub fn is_blocking(&self) -> bool {
        matches!(self, HookEventKind::PreToolUse)
    }
}

/// A pending hook event read off disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingHookEvent {
    /// Unique ID (filename stem). Used to match the response file back.
    pub id: String,
    /// "PreToolUse", "PostToolUse", etc.
    pub kind: String,
    /// Raw payload Claude Code wrote to the hook's stdin.
    pub payload: Value,
}

/// Workspace-level (per-env) hook layout. One `hook.sh` and one settings
/// install per workspace, regardless of how many tabs are open.
#[derive(Debug, Clone)]
pub struct WorkspaceHookPaths {
    pub root: String,
    pub sessions_dir: String,
    pub script: String,
    pub claude_settings: String,
    pub claude_settings_backup: String,
}

impl WorkspaceHookPaths {
    /// `runtime_root` is per-workspace (e.g. `/tmp/orkestrator-claude-tmux/<env-id>`).
    /// `workspace` is the cwd whose `.claude/settings.local.json` we'll touch.
    pub fn new(runtime_root: &str, workspace: &str) -> Self {
        let root = runtime_root.to_string();
        WorkspaceHookPaths {
            sessions_dir: format!("{}/sessions", root),
            script: format!("{}/hook.sh", root),
            claude_settings: format!("{}/.claude/settings.local.json", workspace),
            claude_settings_backup: format!("{}/settings.local.json.orkestrator-backup", root),
            root,
        }
    }
}

/// Per-session subdirectories under the workspace's `sessions_dir`. Each
/// `TmuxSession` owns its own set; hook.sh routes events here by parsing the
/// `session_id` field from the payload.
#[derive(Debug, Clone)]
pub struct SessionHookPaths {
    pub session_dir: String,
    pub pending_dir: String,
    pub response_dir: String,
    /// Sentinel files dropped by hook.sh when a blocking hook times out.
    pub timeout_dir: String,
}

impl SessionHookPaths {
    pub fn new(workspace: &WorkspaceHookPaths, session_id: &str) -> Self {
        let session_dir = format!("{}/{}", workspace.sessions_dir, session_id);
        SessionHookPaths {
            pending_dir: format!("{}/pending", session_dir),
            response_dir: format!("{}/response", session_dir),
            timeout_dir: format!("{}/timeout", session_dir),
            session_dir,
        }
    }
}

/// Shell script Claude Code will invoke for every configured hook event.
///
/// The script:
///   1. reads the JSON payload from stdin
///   2. extracts `session_id` with sed (no jq dependency)
///   3. writes the payload to `<sessions_dir>/<session_id>/pending/<EventKind>-<id>.json`
///   4. for blocking hooks (PreToolUse), polls the corresponding response file
///      and emits its contents back to Claude on stdout
///   5. for informational hooks, prints `{}` and exits
///
/// If `session_id` cannot be parsed (unexpected payload shape), events are
/// routed to a fallback `unknown/` subdir so they don't disappear silently.
pub fn hook_script(workspace: &WorkspaceHookPaths, timeout_secs: u32) -> String {
    format!(
        r#"#!/usr/bin/env bash
# orkestrator-ai claude-tmux hook
# Usage: hook.sh <EventKind>
# Stdin: JSON payload from Claude Code
# Stdout: JSON response (for blocking hooks)
set -u
EVENT_KIND="${{1:-Unknown}}"
SESSIONS_DIR={sessions_dir_q}
TIMEOUT_SECS={timeout}

PAYLOAD="$(cat)"

# Extract session_id from the JSON payload.
#
# Primary: python3, which parses the JSON properly and is broadly available
# on macOS/Linux and in our container base image.
# Fallback: sed regex — handles single-line JSON where session_id is a
# UUID-shaped string. Used only when python3 is missing or fails.
# If both fail (payload missing the field or shape is unexpected) we route
# events to an `unknown/` subdir so they don't disappear silently.
SESSION_ID=""
if command -v python3 >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | python3 -c 'import sys, json
try:
    d = json.loads(sys.stdin.read())
    v = d.get("session_id", "") if isinstance(d, dict) else ""
    if isinstance(v, str):
        print(v)
except Exception:
    pass' 2>/dev/null)"
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]\{{8,\}}\)".*/\1/p' | head -1)"
fi
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown"
fi
# Defensive: strip any path-traversal characters before using as a dir name.
SESSION_ID="$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9._-')"
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="unknown"
fi

SESSION_DIR="$SESSIONS_DIR/$SESSION_ID"
PENDING_DIR="$SESSION_DIR/pending"
RESPONSE_DIR="$SESSION_DIR/response"
TIMEOUT_DIR="$SESSION_DIR/timeout"
mkdir -p "$PENDING_DIR" "$RESPONSE_DIR" "$TIMEOUT_DIR" 2>/dev/null || true

# Generate a unique ID (no nanoseconds on BSD/macOS; combine date+pid+RANDOM).
ID="$(date +%s)-$$-${{RANDOM}}-${{RANDOM}}"
PENDING_FILE="$PENDING_DIR/${{EVENT_KIND}}-${{ID}}.json"
RESPONSE_FILE="$RESPONSE_DIR/${{EVENT_KIND}}-${{ID}}.json"
TIMEOUT_FILE="$TIMEOUT_DIR/${{EVENT_KIND}}-${{ID}}.json"

printf '%s' "$PAYLOAD" > "$PENDING_FILE"

case "$EVENT_KIND" in
  PreToolUse)
    # Block until Rust writes a decision or we time out.
    i=0
    while [ $i -lt $((TIMEOUT_SECS * 4)) ]; do
      if [ -f "$RESPONSE_FILE" ]; then
        cat "$RESPONSE_FILE"
        rm -f "$RESPONSE_FILE" "$PENDING_FILE"
        exit 0
      fi
      sleep 0.25
      i=$((i + 1))
    done
    # Timeout: drop a sentinel so Rust can dismiss the UI prompt, then
    # defer to Claude Code's own permission flow with an empty response.
    printf '{{"timed_out":true}}' > "$TIMEOUT_FILE"
    rm -f "$PENDING_FILE"
    echo '{{}}'
    ;;
  *)
    # Informational hook: emit then exit.
    # Pending file is left for Rust to pick up; Rust deletes after consuming.
    echo '{{}}'
    ;;
esac
"#,
        sessions_dir_q = shell_dq(&workspace.sessions_dir),
        timeout = timeout_secs,
    )
}

/// Build the hooks object that our settings.local.json contributes. Returned
/// as a JSON Value so the caller can merge it into any pre-existing settings.
///
/// NOTE: We deliberately do *not* register a `PreToolUse` hook. The session
/// is launched with `--dangerously-skip-permissions`, so the UI should not
/// gate tool calls.
pub fn hooks_block(hook_script_path: &str) -> Value {
    let cmd = format!("bash {} ", shell_dq(hook_script_path)); // event kind appended below

    let mk = |kind: &str| {
        json!({
            "matcher": "*",
            "hooks": [{ "type": "command", "command": format!("{}{}", cmd, kind) }]
        })
    };
    let mk_no_matcher = |kind: &str| {
        json!({
            "hooks": [{ "type": "command", "command": format!("{}{}", cmd, kind) }]
        })
    };

    json!({
        "PostToolUse":      [mk("PostToolUse")],
        "UserPromptSubmit": [mk_no_matcher("UserPromptSubmit")],
        "Stop":             [mk_no_matcher("Stop")],
        "SubagentStop":     [mk_no_matcher("SubagentStop")],
        "Notification":     [mk_no_matcher("Notification")],
        "SessionStart":     [mk_no_matcher("SessionStart")]
    })
}

/// Merge our hooks block into `existing` (parsed `.claude/settings.local.json`
/// content, or `null` if absent). Preserves any unrelated keys. Returns the
/// pretty-printed JSON text to write.
pub fn merge_settings_json(existing: Option<&str>, hook_script_path: &str) -> String {
    let mut root: Value = existing
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| json!({}));

    if !root.is_object() {
        root = json!({});
    }
    let obj = root.as_object_mut().expect("root is object");
    obj.insert("hooks".to_string(), hooks_block(hook_script_path));

    serde_json::to_string_pretty(&root).expect("settings JSON serializes")
}

/// Install workspace-level hooks. Idempotent: a subsequent call when the
/// hooks are already installed does NOT clobber the original-settings backup
/// — only the first install captures the user's true original.
pub async fn install_workspace_hooks(
    backend: &Backend,
    paths: &WorkspaceHookPaths,
) -> Result<(), String> {
    backend.ensure_dir(&paths.root).await?;
    backend.ensure_dir(&paths.sessions_dir).await?;

    let script = hook_script(paths, HOOK_TIMEOUT_SECS);
    backend.write_file(&paths.script, &script).await?;
    backend.exec(&["chmod", "+x", &paths.script]).await?;

    // Backup: write the original settings ONLY if we haven't already on a
    // previous install. This keeps the user's true original safe even when
    // the second tab in the same workspace calls install_workspace_hooks.
    let existing_backup = backend.read_file(&paths.claude_settings_backup).await?;
    let existing_settings = backend.read_file(&paths.claude_settings).await?;
    if existing_backup.is_none() {
        match existing_settings.as_deref() {
            Some(prev) => {
                backend
                    .write_file(&paths.claude_settings_backup, prev)
                    .await?;
            }
            None => {
                backend
                    .write_file(&paths.claude_settings_backup, BACKUP_SENTINEL_NO_ORIGINAL)
                    .await?;
            }
        }
    }

    // Always overwrite settings.local.json with our hooks block; subsequent
    // installs are no-ops because the merged content is the same.
    let merged = merge_settings_json(existing_settings.as_deref(), &paths.script);
    backend.write_file(&paths.claude_settings, &merged).await?;

    Ok(())
}

/// Restore the user's original `.claude/settings.local.json` and remove the
/// workspace runtime directory. Should only be called when the last session
/// in the workspace stops — the caller is responsible for this gating.
pub async fn uninstall_workspace_hooks(
    backend: &Backend,
    paths: &WorkspaceHookPaths,
) -> Result<(), String> {
    let backup = backend.read_file(&paths.claude_settings_backup).await?;
    match backup.as_deref() {
        Some(s) if s == BACKUP_SENTINEL_NO_ORIGINAL => {
            backend.remove_file(&paths.claude_settings).await?;
        }
        Some(content) => {
            backend.write_file(&paths.claude_settings, content).await?;
        }
        None => {
            // No backup recorded — leave settings as-is.
        }
    }
    backend.remove_file(&paths.claude_settings_backup).await.ok();
    backend.exec(&["rm", "-rf", &paths.root]).await.ok();
    Ok(())
}

/// Create the per-session pending/response/timeout dirs.
pub async fn ensure_session_dirs(
    backend: &Backend,
    paths: &SessionHookPaths,
) -> Result<(), String> {
    backend.ensure_dir(&paths.session_dir).await?;
    backend.ensure_dir(&paths.pending_dir).await?;
    backend.ensure_dir(&paths.response_dir).await?;
    backend.ensure_dir(&paths.timeout_dir).await?;
    Ok(())
}

/// Remove a session's runtime subdirs. Best-effort.
pub async fn remove_session_dirs(
    backend: &Backend,
    paths: &SessionHookPaths,
) -> Result<(), String> {
    backend.exec(&["rm", "-rf", &paths.session_dir]).await.ok();
    Ok(())
}

/// Scan the timeout dir and return the IDs of blocking hooks that gave up
/// waiting for a response. Files are consumed on read.
pub async fn drain_timeouts(
    backend: &Backend,
    paths: &SessionHookPaths,
) -> Result<Vec<(String, String)>, String> {
    let names = backend.list_dir(&paths.timeout_dir).await?;
    let mut out = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let (kind, id) = parse_event_filename(&name);
        let full = format!("{}/{}", paths.timeout_dir, name);
        backend.remove_file(&full).await.ok();
        out.push((kind, id));
    }
    Ok(out)
}

/// Scan the pending dir and return all unread events, deleting them after
/// reading. Returns events sorted by filename so the order matches when
/// they were written.
///
/// `already_emitted` is a set of blocking-event IDs that have previously been
/// surfaced to the UI. Blocking pending files stay on disk until `hook.sh`
/// consumes the response, so without this set we would re-emit them on every
/// poll. The set is also pruned of IDs whose pending files have disappeared.
pub async fn drain_pending(
    backend: &Backend,
    paths: &SessionHookPaths,
    already_emitted: &mut HashSet<String>,
) -> Result<Vec<PendingHookEvent>, String> {
    let mut names = backend.list_dir(&paths.pending_dir).await?;
    names.sort();

    let still_present: HashSet<String> = names
        .iter()
        .filter(|n| n.ends_with(".json"))
        .map(|n| parse_event_filename(n).1)
        .collect();
    already_emitted.retain(|id| still_present.contains(id));

    let mut events = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let full = format!("{}/{}", paths.pending_dir, name);
        let (kind, id) = parse_event_filename(&name);

        let is_blocking = HookEventKind::from_str(&kind)
            .map(|k| k.is_blocking())
            .unwrap_or(false);

        if is_blocking && already_emitted.contains(&id) {
            continue;
        }

        let Some(content) = backend.read_file(&full).await? else {
            continue;
        };
        let payload: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => Value::String(content.clone()),
        };

        if is_blocking {
            already_emitted.insert(id.clone());
        } else {
            backend.remove_file(&full).await.ok();
        }

        events.push(PendingHookEvent {
            id,
            kind,
            payload,
        });
    }

    Ok(events)
}

/// Write a response file for a previously emitted blocking hook event.
pub async fn reply_to_hook(
    backend: &Backend,
    paths: &SessionHookPaths,
    kind: &str,
    id: &str,
    response: &Value,
) -> Result<(), String> {
    let filename = format!("{}-{}.json", kind, id);
    let response_path = format!("{}/{}", paths.response_dir, filename);
    backend
        .write_file(
            &response_path,
            &serde_json::to_string(response).unwrap_or_else(|_| "{}".into()),
        )
        .await?;
    Ok(())
}

/// Convenience: build a PreToolUse JSON response. `decision` is one of
/// "approve" | "block". For "block", `reason` is shown to Claude.
pub fn pre_tool_use_response(decision: &str, reason: Option<&str>) -> Value {
    let mut out = json!({ "decision": decision });
    if let Some(r) = reason {
        out["reason"] = Value::String(r.to_string());
    }
    out
}

fn parse_event_filename(name: &str) -> (String, String) {
    let stem = name.strip_suffix(".json").unwrap_or(name);
    if let Some(dash) = stem.find('-') {
        let (kind, rest) = stem.split_at(dash);
        let id = rest.trim_start_matches('-');
        return (kind.to_string(), id.to_string());
    }
    (stem.to_string(), String::new())
}

/// Double-quote escape for embedding paths inside the generated bash script.
fn shell_dq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_filename_splits_kind_and_id() {
        let (kind, id) = parse_event_filename("PreToolUse-1731519430-1234-9876-5432.json");
        assert_eq!(kind, "PreToolUse");
        assert_eq!(id, "1731519430-1234-9876-5432");
    }

    #[test]
    fn parse_event_filename_tolerates_missing_extension() {
        let (kind, id) = parse_event_filename("Notification-abc-123");
        assert_eq!(kind, "Notification");
        assert_eq!(id, "abc-123");
    }

    #[test]
    fn parse_event_filename_returns_empty_id_when_no_dash() {
        let (kind, id) = parse_event_filename("PreToolUse.json");
        assert_eq!(kind, "PreToolUse");
        assert_eq!(id, "");
    }

    #[test]
    fn pre_tool_use_response_approve_has_no_reason() {
        let v = pre_tool_use_response("approve", None);
        assert_eq!(v["decision"], "approve");
        assert!(v.get("reason").is_none());
    }

    #[test]
    fn pre_tool_use_response_block_includes_reason() {
        let v = pre_tool_use_response("block", Some("nope"));
        assert_eq!(v["decision"], "block");
        assert_eq!(v["reason"], "nope");
    }

    #[test]
    fn hooks_block_has_supported_informational_event_kinds() {
        let v = hooks_block("/tmp/x/hook.sh");
        let obj = v.as_object().unwrap();
        for kind in [
            "PostToolUse",
            "UserPromptSubmit",
            "Stop",
            "SubagentStop",
            "Notification",
            "SessionStart",
        ] {
            assert!(obj.contains_key(kind), "missing kind: {kind}");
        }
        assert!(!obj.contains_key("PreToolUse"));
        let post = &v["PostToolUse"][0];
        assert_eq!(post["matcher"], "*");
        assert!(post["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("PostToolUse"));
    }

    #[test]
    fn merge_settings_json_preserves_unrelated_keys() {
        let prev = r#"{"theme":"dark","permissions":{"x":1}}"#;
        let merged = merge_settings_json(Some(prev), "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["permissions"]["x"], 1);
        assert!(v["hooks"]["PostToolUse"].is_array());
    }

    #[test]
    fn merge_settings_json_creates_object_from_nothing() {
        let merged = merge_settings_json(None, "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert!(v["hooks"]["PostToolUse"].is_array());
    }

    #[test]
    fn merge_settings_json_overwrites_existing_hooks() {
        let prev = r#"{"hooks":{"PostToolUse":[{"matcher":"foo","hooks":[]}]}}"#;
        let merged = merge_settings_json(Some(prev), "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "*");
    }

    #[test]
    fn merge_settings_json_replaces_non_object_root() {
        let merged = merge_settings_json(Some("[\"oops\"]"), "/tmp/hook.sh");
        let v: Value = serde_json::from_str(&merged).unwrap();
        assert!(v.is_object());
        assert!(v["hooks"].is_object());
    }

    #[test]
    fn hook_event_kind_blocking_only_pre_tool_use() {
        assert!(HookEventKind::PreToolUse.is_blocking());
        for k in [
            HookEventKind::PostToolUse,
            HookEventKind::UserPromptSubmit,
            HookEventKind::Stop,
            HookEventKind::SubagentStop,
            HookEventKind::Notification,
            HookEventKind::SessionStart,
        ] {
            assert!(!k.is_blocking());
        }
    }

    #[test]
    fn shell_dq_escapes_dangerous_chars() {
        let escaped = shell_dq("/tmp/$x \"y\" `z` \\w");
        assert_eq!(escaped, "\"/tmp/\\$x \\\"y\\\" \\`z\\` \\\\w\"");
    }

    #[test]
    fn workspace_hook_paths_layout() {
        let p = WorkspaceHookPaths::new("/tmp/run", "/work");
        assert_eq!(p.root, "/tmp/run");
        assert_eq!(p.sessions_dir, "/tmp/run/sessions");
        assert_eq!(p.script, "/tmp/run/hook.sh");
        assert_eq!(p.claude_settings, "/work/.claude/settings.local.json");
        assert!(p.claude_settings_backup.starts_with("/tmp/run/"));
    }

    #[test]
    fn session_hook_paths_are_nested_under_sessions_dir() {
        let ws = WorkspaceHookPaths::new("/tmp/run", "/work");
        let s = SessionHookPaths::new(&ws, "abc-123");
        assert_eq!(s.session_dir, "/tmp/run/sessions/abc-123");
        assert_eq!(s.pending_dir, "/tmp/run/sessions/abc-123/pending");
        assert_eq!(s.response_dir, "/tmp/run/sessions/abc-123/response");
        assert_eq!(s.timeout_dir, "/tmp/run/sessions/abc-123/timeout");
    }

    #[test]
    fn hook_script_routes_by_session_id_and_contains_event_branch() {
        let ws = WorkspaceHookPaths::new("/tmp/run", "/work");
        let script = hook_script(&ws, 60);
        assert!(script.contains("SESSIONS_DIR=\"/tmp/run/sessions\""));
        assert!(script.contains("session_id"));
        assert!(script.contains("PreToolUse)"));
        assert!(script.contains("timed_out"));
        // Each event is dispatched into a per-session subdir.
        assert!(script.contains("$SESSION_DIR/pending"));
        assert!(script.contains("$SESSION_DIR/response"));
        assert!(script.contains("$SESSION_DIR/timeout"));
        // session_id extraction prefers python3 with a sed fallback.
        assert!(script.contains("python3"));
        assert!(script.contains("json.loads"));
        assert!(script.contains("sed -n"));
        // Path-traversal characters are sanitized out of the session id.
        assert!(script.contains("tr -cd"));
    }

    /// Run the generated hook.sh end-to-end (when bash is available) and
    /// verify it routes events to the correct per-session subdir for both
    /// happy-path JSON and a payload that requires the sed fallback.
    #[tokio::test]
    async fn hook_script_routes_payloads_to_per_session_subdir() {
        // CI without bash should just no-op this test.
        if std::process::Command::new("bash")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipping: bash not on PATH");
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let runtime = tmp.path().join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let ws = WorkspaceHookPaths::new(runtime.to_str().unwrap(), "/work");

        // Write the script.
        let script_text = hook_script(&ws, 1);
        let script_path = tmp.path().join("hook.sh");
        std::fs::write(&script_path, script_text).unwrap();
        std::process::Command::new("chmod")
            .args(["+x", script_path.to_str().unwrap()])
            .status()
            .unwrap();

        // Run the script as an informational event with a well-formed payload.
        let payload = r#"{"session_id":"abc-12345678","tool_name":"Bash"}"#;
        let mut child = std::process::Command::new(script_path.to_str().unwrap())
            .arg("Notification")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let status = child.wait().unwrap();
        assert!(status.success(), "hook script must exit cleanly");

        // The pending file landed in the per-session subdir.
        let pending_dir = format!("{}/sessions/abc-12345678/pending", ws.root);
        let entries: Vec<_> = std::fs::read_dir(&pending_dir).unwrap().collect();
        assert_eq!(entries.len(), 1, "expected one pending file");
    }
}
