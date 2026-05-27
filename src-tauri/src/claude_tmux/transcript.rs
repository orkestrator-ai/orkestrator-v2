//! Watches the Claude Code JSONL transcript for a session and emits each new
//! line as it appears.
//!
//! Claude Code writes one JSON object per line to
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (host or container).
//! The encoded-cwd is the absolute path with `/` replaced by `-`. We find the
//! file by globbing for `<session-id>.jsonl` so we don't need to compute the
//! encoding ourselves (and we tolerate Claude Code changing it).
//!
//! Strategy:
//!   - poll `find ~/.claude/projects -name '<session>.jsonl'` until the file
//!     appears (Claude may take a beat after launch).
//!   - then poll the file size and, whenever it grows, read the new tail and
//!     parse out complete lines.
//!
//! Polling at ~250ms is plenty for chat UX and uses negligible CPU.

use super::backend::Backend;
use serde_json::Value;

const POLL_MS: u64 = 250;

/// Encode an absolute cwd path the way Claude Code names its project
/// directory under `~/.claude/projects/`. The scheme observed in practice:
/// drop the trailing slash, then replace every `/` with `-`. An absolute
/// path like `/Users/foo/proj` therefore becomes `-Users-foo-proj`.
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed.replace('/', "-")
}

/// Resolve the absolute JSONL path for the given session ID for a *specific*
/// worktree/workspace. The search is intentionally scoped to the encoded-cwd
/// directory so concurrent Claude sessions in unrelated projects on the same
/// machine cannot bleed into our chat.
///
/// `min_mtime_unix` constrains the mtime fallback (only files modified at or
/// after this time are considered). This is the safety net for installed
/// `claude` builds that ignore `--session-id` and assign their own UUID.
pub async fn find_transcript_path(
    backend: &Backend,
    claude_home: &str,
    cwd: &str,
    session_id: &str,
    min_mtime_unix: Option<u64>,
) -> Result<Option<String>, String> {
    let encoded = encode_cwd(cwd);
    let project_dir = format!("{}/projects/{}", claude_home, encoded);

    // Pass 1: exact session-id match in our project directory.
    let exact = format!("{}/{}.jsonl", project_dir, session_id);
    if backend.file_size(&exact).await.unwrap_or(0) > 0
        || backend.read_file(&exact).await.ok().flatten().is_some()
    {
        return Ok(Some(exact));
    }

    // Pass 2: newest JSONL inside *only* our project's encoded dir, gated by
    // mtime so we don't pick up an older session from a previous run.
    if let Some(t) = min_mtime_unix {
        if let Some(p) = newest_jsonl_in_dir(backend, &project_dir, t).await? {
            return Ok(Some(p));
        }
    }

    Ok(None)
}

/// Return the absolute path of the most recently modified `*.jsonl` file
/// inside `dir` whose mtime ≥ `min_mtime_unix` seconds.
async fn newest_jsonl_in_dir(
    backend: &Backend,
    dir: &str,
    min_mtime_unix: u64,
) -> Result<Option<String>, String> {
    match backend {
        Backend::Container { .. } => {
            // GNU `find` is reliable on our Debian container image.
            let script = format!(
                "find {}/ -mindepth 1 -maxdepth 1 -type f -name '*.jsonl' -newermt @{} -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-",
                shell_q(dir),
                min_mtime_unix,
            );
            let out = backend.exec(&["sh", "-c", &script]).await?;
            let path = out.stdout.trim().to_string();
            if path.is_empty() {
                Ok(None)
            } else {
                Ok(Some(path))
            }
        }
        Backend::Local { .. } => {
            // BSD `find` on macOS does not support `-newermt @<epoch>`; scan
            // via Rust fs APIs instead.
            let mut newest: Option<(u64, String)> = None;
            let names = backend.list_dir(dir).await.unwrap_or_default();
            for name in names {
                if !name.ends_with(".jsonl") {
                    continue;
                }
                let full = format!("{}/{}", dir, name);
                if let Ok(meta) = tokio::fs::metadata(&full).await {
                    if let Ok(mtime) = meta.modified() {
                        if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                            let secs = dur.as_secs();
                            if secs >= min_mtime_unix
                                && newest.as_ref().is_none_or(|(t, _)| secs > *t)
                            {
                                newest = Some((secs, full));
                            }
                        }
                    }
                }
            }
            Ok(newest.map(|(_, p)| p))
        }
    }
}

fn shell_q(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// State for incrementally reading a JSONL file as it grows.
pub struct TranscriptTail {
    pub path: String,
    /// Byte offset we've already read up to. Lines starting at `offset` and
    /// later are unread.
    pub offset: u64,
    /// Buffer for a partial trailing line that hasn't been newline-terminated.
    pub partial: String,
}

impl TranscriptTail {
    pub fn new(path: String) -> Self {
        TranscriptTail {
            path,
            offset: 0,
            partial: String::new(),
        }
    }

    /// Read everything new from `offset` to EOF, advance `offset`, and return
    /// every complete JSONL line parsed as a value.
    pub async fn read_new(&mut self, backend: &Backend) -> Result<Vec<Value>, String> {
        let size = backend.file_size(&self.path).await?;
        if size <= self.offset {
            return Ok(Vec::new());
        }
        // Simple approach: re-read the full file. For real-world chat-size
        // transcripts (≤ a few MB) this is fine and avoids range-read complexity
        // across both local and container backends.
        let full = backend.read_file(&self.path).await?.unwrap_or_default();
        let new_chunk = full.get(self.offset as usize..).unwrap_or("").to_string();
        self.offset = full.len() as u64;

        let combined = std::mem::take(&mut self.partial) + &new_chunk;
        let mut lines: Vec<Value> = Vec::new();
        let mut last_newline = 0usize;
        for (idx, b) in combined.bytes().enumerate() {
            if b == b'\n' {
                let line = &combined[last_newline..idx];
                last_newline = idx + 1;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(trimmed) {
                    Ok(v) => lines.push(v),
                    Err(_) => {
                        // Keep parsing; drop unparseable lines.
                    }
                }
            }
        }
        // Anything after the last newline is a partial line.
        if last_newline < combined.len() {
            self.partial = combined[last_newline..].to_string();
        }

        Ok(lines)
    }
}

pub const POLL_INTERVAL_MS: u64 = POLL_MS;

/// Metadata about one previously-recorded Claude session that the user could
/// resume in a new tab. Returned from [`list_previous_sessions`].
#[derive(Debug, Clone)]
pub struct PreviousSessionInfo {
    pub session_id: String,
    pub title: Option<String>,
    pub last_activity_unix: u64,
    pub message_count: u32,
    pub transcript_path: String,
}

/// Maximum number of previous sessions returned by [`list_previous_sessions`].
/// Resume dialogs only need the most recent handful; capping bounds the
/// memory cost of reading transcript bodies for users with hundreds of old
/// sessions in `~/.claude/projects/<encoded-cwd>`.
pub const PREVIOUS_SESSIONS_LIMIT: usize = 50;

/// List recorded Claude Code sessions for `cwd`, newest first.
///
/// Reads `<claude_home>/projects/<encoded-cwd>/*.jsonl`, parses each file's
/// first user prompt (for the title) and counts lines to estimate message
/// volume. Capped at [`PREVIOUS_SESSIONS_LIMIT`] entries by mtime so a
/// workspace with hundreds of old sessions doesn't materialize all of them
/// when the resume dialog opens.
pub async fn list_previous_sessions(
    backend: &Backend,
    claude_home: &str,
    cwd: &str,
) -> Result<Vec<PreviousSessionInfo>, String> {
    let project_dir = format!("{}/projects/{}", claude_home, encode_cwd(cwd));
    let names = backend.list_dir(&project_dir).await.unwrap_or_default();

    // Phase 1: collect (mtime, full_path, session_id) without reading any
    // transcript bodies. mtime probes are O(stat) per file, much cheaper
    // than reading the contents.
    let mut candidates: Vec<(u64, String, String)> = Vec::new();
    for name in names {
        let Some(session_id) = name.strip_suffix(".jsonl") else {
            continue;
        };
        let full = format!("{}/{}", project_dir, name);
        let mtime = file_mtime_unix(backend, &full).await.unwrap_or(0);
        candidates.push((mtime, full, session_id.to_string()));
    }
    // Newest first.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.truncate(PREVIOUS_SESSIONS_LIMIT);

    // Phase 2: read bodies only for the surviving (capped) candidates.
    let mut out: Vec<PreviousSessionInfo> = Vec::with_capacity(candidates.len());
    for (mtime, full, session_id) in candidates {
        let content = backend.read_file(&full).await?.unwrap_or_default();
        let (title, message_count) = summarize_transcript(&content);
        out.push(PreviousSessionInfo {
            session_id,
            title,
            last_activity_unix: mtime,
            message_count,
            transcript_path: full,
        });
    }
    Ok(out)
}

/// Read the first user-text content from the JSONL and the total line count.
fn summarize_transcript(content: &str) -> (Option<String>, u32) {
    let mut count: u32 = 0;
    let mut title: Option<String> = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        count = count.saturating_add(1);
        if title.is_some() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        // Look for a user-role message whose first text-content part starts
        // the conversation. Claude Code records text either inline or as an
        // array of content blocks.
        let role = v
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|r| r.as_str())
            .or_else(|| v.get("type").and_then(|t| t.as_str()));
        if role != Some("user") {
            continue;
        }
        let content_field = v
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| v.get("content"));
        let Some(content_field) = content_field else {
            continue;
        };
        let extracted = match content_field {
            Value::String(s) => Some(s.clone()),
            Value::Array(arr) => arr.iter().find_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            }),
            _ => None,
        };
        if let Some(text) = extracted {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                title = Some(truncate_title(trimmed, 80));
            }
        }
    }
    (title, count)
}

fn truncate_title(s: &str, max_chars: usize) -> String {
    let single_line = s.replace('\n', " ");
    if single_line.chars().count() <= max_chars {
        return single_line;
    }
    let mut out: String = single_line.chars().take(max_chars).collect();
    out.push('…');
    out
}

async fn file_mtime_unix(backend: &Backend, path: &str) -> Result<u64, String> {
    match backend {
        Backend::Local { .. } => match tokio::fs::metadata(path).await {
            Ok(m) => Ok(m
                .modified()
                .ok()
                .and_then(|mt| mt.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0)),
            Err(_) => Ok(0),
        },
        Backend::Container { .. } => {
            let out = backend
                .exec(&[
                    "sh",
                    "-c",
                    &format!("stat -c %Y {} 2>/dev/null || echo 0", shell_q(path)),
                ])
                .await?;
            Ok(out.stdout.trim().parse().unwrap_or(0))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_tmux::backend::Backend;
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use tokio::fs;

    fn local_backend(dir: &TempDir) -> Backend {
        Backend::Local {
            cwd: dir.path().to_string_lossy().into_owned(),
        }
    }

    fn path_in(dir: &TempDir, rel: &str) -> PathBuf {
        dir.path().join(rel)
    }

    #[test]
    fn encode_cwd_matches_claude_codes_scheme() {
        assert_eq!(encode_cwd("/Users/foo/proj"), "-Users-foo-proj");
        assert_eq!(encode_cwd("/Users/foo/proj/"), "-Users-foo-proj");
        assert_eq!(encode_cwd("/workspace"), "-workspace");
    }

    #[tokio::test]
    async fn find_transcript_path_returns_none_when_missing() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            "/Users/me/proj",
            "session-xyz",
            None,
        )
        .await
        .unwrap();
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn find_transcript_path_locates_file_in_encoded_cwd() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/proj";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();
        let jsonl = proj_dir.join("session-xyz.jsonl");
        fs::write(&jsonl, b"{\"type\":\"system\"}\n").await.unwrap();

        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            cwd,
            "session-xyz",
            None,
        )
        .await
        .unwrap();
        assert_eq!(out, Some(jsonl.to_string_lossy().into_owned()));
    }

    #[tokio::test]
    async fn find_transcript_path_falls_back_to_newest_jsonl_when_id_misses() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/proj";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();
        // Wrong session id but freshly written → fallback should pick it.
        let jsonl = proj_dir.join("other-session.jsonl");
        fs::write(&jsonl, b"{\"type\":\"system\"}\n").await.unwrap();

        let claude_home = dir.path().join(".claude");
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(60);

        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            cwd,
            "session-xyz",
            Some(start),
        )
        .await
        .unwrap();
        assert_eq!(out, Some(jsonl.to_string_lossy().into_owned()));
    }

    #[tokio::test]
    async fn find_transcript_path_does_not_fallback_without_mtime_gate() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/proj";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();
        fs::write(proj_dir.join("other-session.jsonl"), b"{\"type\":\"system\"}\n")
            .await
            .unwrap();

        let claude_home = dir.path().join(".claude");
        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            cwd,
            "session-xyz",
            None,
        )
        .await
        .unwrap();

        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn find_transcript_path_ignores_concurrent_sessions_in_other_projects() {
        // Regression: when another Claude session is actively writing under a
        // *different* project dir, our cwd-scoped search must NOT pick it up.
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let our_cwd = "/Users/me/proj-a";
        let our_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(our_cwd)));
        let other_dir = path_in(&dir, ".claude/projects/-Users-me-proj-b");
        fs::create_dir_all(&our_dir).await.unwrap();
        fs::create_dir_all(&other_dir).await.unwrap();
        // Only the OTHER project has any JSONL file, and it's fresh.
        fs::write(
            other_dir.join("other-session.jsonl"),
            b"{\"type\":\"user\"}\n",
        )
        .await
        .unwrap();

        let claude_home = dir.path().join(".claude");
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(60);

        let out = find_transcript_path(
            &backend,
            claude_home.to_str().unwrap(),
            our_cwd,
            "session-xyz",
            Some(start),
        )
        .await
        .unwrap();
        assert_eq!(
            out, None,
            "must NOT bleed across project directories — got {out:?}"
        );
    }

    #[tokio::test]
    async fn transcript_tail_returns_empty_for_unchanged_file() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        fs::write(&path, b"{\"type\":\"user\"}\n").await.unwrap();

        let mut tail = TranscriptTail::new(path.to_string_lossy().into_owned());
        let first = tail.read_new(&backend).await.unwrap();
        assert_eq!(first.len(), 1);

        let second = tail.read_new(&backend).await.unwrap();
        assert!(second.is_empty());
    }

    #[tokio::test]
    async fn transcript_tail_reads_appended_lines() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        let path_str = path.to_string_lossy().into_owned();
        fs::write(&path, b"").await.unwrap();
        let mut tail = TranscriptTail::new(path_str.clone());

        fs::write(
            &path,
            b"{\"type\":\"user\",\"i\":1}\n{\"type\":\"assistant\",\"i\":2}\n",
        )
        .await
        .unwrap();
        let first = tail.read_new(&backend).await.unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["i"], 1);
        assert_eq!(first[1]["i"], 2);

        // Append a third line.
        let cur = fs::read_to_string(&path).await.unwrap();
        fs::write(&path, format!("{cur}{{\"type\":\"user\",\"i\":3}}\n"))
            .await
            .unwrap();
        let second = tail.read_new(&backend).await.unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["i"], 3);
    }

    #[tokio::test]
    async fn transcript_tail_buffers_partial_lines_until_newline() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        let path_str = path.to_string_lossy().into_owned();
        let mut tail = TranscriptTail::new(path_str.clone());

        // Write a partial line (no newline).
        fs::write(&path, b"{\"type\":\"user\"").await.unwrap();
        let first = tail.read_new(&backend).await.unwrap();
        assert!(first.is_empty(), "partial line should not emit");

        // Complete the line.
        fs::write(&path, b"{\"type\":\"user\",\"i\":1}\n")
            .await
            .unwrap();
        let second = tail.read_new(&backend).await.unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0]["i"], 1);
    }

    #[test]
    fn summarize_transcript_extracts_first_user_text_and_message_count() {
        let jsonl = r#"
{"type":"system","message":{"role":"system","content":"boot"}}
{"type":"user","message":{"role":"user","content":"Hello there"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Second prompt — ignored for title"}]}}
"#;
        let (title, count) = summarize_transcript(jsonl);
        assert_eq!(title.as_deref(), Some("Hello there"));
        assert_eq!(count, 4);
    }

    #[test]
    fn summarize_transcript_truncates_long_titles_and_collapses_newlines() {
        // Embed escaped \n inside the JSON content string. summarize_transcript
        // collapses those newlines to spaces and ellipsizes past 80 chars.
        let content_value = json!(format!("line1\nline2 {}", "x".repeat(200)));
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": content_value },
        });
        let (title, _) = summarize_transcript(&line.to_string());
        let t = title.unwrap();
        assert!(t.starts_with("line1 line2"), "title was: {t}");
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 81); // 80 + ellipsis
    }

    #[tokio::test]
    async fn list_previous_sessions_returns_newest_first_with_titles() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/proj";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();

        // Older session.
        let old = proj_dir.join("sess-old.jsonl");
        fs::write(
            &old,
            r#"{"type":"user","message":{"role":"user","content":"older"}}
"#,
        )
        .await
        .unwrap();

        // Newer session — write a few seconds later by sleeping.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let new = proj_dir.join("sess-new.jsonl");
        fs::write(
            &new,
            r#"{"type":"user","message":{"role":"user","content":"newer"}}
{"type":"assistant","message":{"role":"assistant","content":"reply"}}
"#,
        )
        .await
        .unwrap();

        let claude_home = path_in(&dir, ".claude");
        let sessions = list_previous_sessions(&backend, claude_home.to_str().unwrap(), cwd)
            .await
            .unwrap();

        assert_eq!(sessions.len(), 2);
        // Newest first.
        assert_eq!(sessions[0].session_id, "sess-new");
        assert_eq!(sessions[1].session_id, "sess-old");
        assert_eq!(sessions[0].title.as_deref(), Some("newer"));
        assert_eq!(sessions[0].message_count, 2);
        assert!(sessions[0].last_activity_unix >= sessions[1].last_activity_unix);
    }

    #[tokio::test]
    async fn list_previous_sessions_caps_results_to_limit() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let cwd = "/Users/me/lots-of-sessions";
        let proj_dir = path_in(&dir, &format!(".claude/projects/{}", encode_cwd(cwd)));
        fs::create_dir_all(&proj_dir).await.unwrap();

        // Create slightly more files than the cap. We pin each file's mtime
        // via `filetime` because `tokio::fs::write` resolution is per-second
        // on most filesystems — short sleeps between writes wouldn't give us
        // monotonically distinct mtimes.
        let total = PREVIOUS_SESSIONS_LIMIT + 5;
        let base = 1_700_000_000_i64; // arbitrary fixed epoch seconds
        for i in 0..total {
            let path = proj_dir.join(format!("sess-{:03}.jsonl", i));
            fs::write(
                &path,
                format!(
                    r#"{{"type":"user","message":{{"role":"user","content":"prompt {}"}}}}
"#,
                    i
                ),
            )
            .await
            .unwrap();
            // sess-000 → oldest, sess-{total-1} → newest.
            let t = filetime::FileTime::from_unix_time(base + i as i64, 0);
            filetime::set_file_mtime(&path, t).unwrap();
        }

        let claude_home = path_in(&dir, ".claude");
        let sessions = list_previous_sessions(&backend, claude_home.to_str().unwrap(), cwd)
            .await
            .unwrap();

        assert_eq!(sessions.len(), PREVIOUS_SESSIONS_LIMIT);
        // The cap drops the OLDEST entries. The very newest (sess-{total-1})
        // must be present; the very oldest (sess-000) must not.
        assert!(sessions
            .iter()
            .any(|s| s.session_id == format!("sess-{:03}", total - 1)));
        assert!(!sessions.iter().any(|s| s.session_id == "sess-000"));
    }

    #[tokio::test]
    async fn list_previous_sessions_returns_empty_for_unknown_project() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let claude_home = path_in(&dir, ".claude");
        let sessions =
            list_previous_sessions(&backend, claude_home.to_str().unwrap(), "/path/nobody/uses")
                .await
                .unwrap();
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn transcript_tail_drops_unparseable_lines_but_keeps_going() {
        let dir = TempDir::new().unwrap();
        let backend = local_backend(&dir);
        let path = path_in(&dir, "t.jsonl");
        let path_str = path.to_string_lossy().into_owned();
        fs::write(&path, b"not json\n{\"type\":\"user\"}\n")
            .await
            .unwrap();

        let mut tail = TranscriptTail::new(path_str);
        let lines = tail.read_new(&backend).await.unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["type"], json!("user"));
    }
}
