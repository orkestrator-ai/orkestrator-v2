//! One tmux-driven Claude session per *tab*.
//!
//! Each session owns:
//!   - a tmux session name unique to this tab (`orkestrator-<env-short>-<tab-short>`)
//!   - a per-session runtime subdir under the workspace hook root
//!   - a background poll loop that drains hook events from that subdir and
//!     tails the JSONL transcript, emitting Tauri events to the frontend
//!
//! Workspace-level hook artifacts (`hook.sh` and `.claude/settings.local.json`)
//! are shared across all tabs in the same workspace; the script routes events
//! to the right per-session subdir based on the `session_id` field in the
//! payload Claude Code provides. See [`crate::claude_tmux::hooks`].

use super::backend::Backend;
use super::hooks::{self, PendingHookEvent, SessionHookPaths, WorkspaceHookPaths};
use super::transcript::{self, TranscriptTail, POLL_INTERVAL_MS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, Notify};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// All Tauri events emitted on behalf of a tmux session go through this
/// single channel name. The payload's `kind` field disambiguates.
pub const TAURI_EVENT: &str = "claude-tmux:event";
#[cfg(not(test))]
const COMMAND_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
#[cfg(test)]
const COMMAND_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);
#[cfg(not(test))]
const COMMAND_NO_HOOK_SETTLE: std::time::Duration = std::time::Duration::from_millis(2_000);
#[cfg(test)]
const COMMAND_NO_HOOK_SETTLE: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(not(test))]
const COMMAND_AFTER_IDLE_SETTLE: std::time::Duration = std::time::Duration::from_millis(400);
#[cfg(test)]
const COMMAND_AFTER_IDLE_SETTLE: std::time::Duration = std::time::Duration::from_millis(20);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TmuxEvent {
    /// Session has fully started — tmux up, claude launched, hooks installed.
    Started {
        tab_id: String,
        environment_id: String,
        session_id: String,
        /// True if we resumed an existing claude session (and so historical
        /// transcript content will replay through TranscriptLine events).
        resumed: bool,
    },
    /// The backend-delayed initial prompt was safely delivered to Claude.
    InitialPromptSent {
        tab_id: String,
        environment_id: String,
        session_id: String,
    },
    /// A new JSONL line was appended to the transcript.
    TranscriptLine {
        tab_id: String,
        environment_id: String,
        session_id: String,
        line: Value,
    },
    /// A hook event landed (PreToolUse blocks until `reply_to_hook` is called;
    /// others are informational).
    Hook {
        tab_id: String,
        environment_id: String,
        session_id: String,
        event_id: String,
        event_kind: String,
        payload: Value,
    },
    /// The tmux session was killed or claude exited.
    Stopped {
        tab_id: String,
        environment_id: String,
    },
    /// A previously emitted blocking hook timed out before the user
    /// responded. The frontend should dismiss the pending approval.
    HookTimedOut {
        tab_id: String,
        environment_id: String,
        session_id: String,
        event_kind: String,
        event_id: String,
    },
    /// Recoverable error during polling — surfaced for diagnostics but the
    /// loop keeps running.
    Warning {
        tab_id: String,
        environment_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxSessionStatus {
    pub tab_id: String,
    pub environment_id: String,
    pub session_id: Option<String>,
    pub tmux_session: String,
    pub running: bool,
    pub transcript_path: Option<String>,
    pub resumed: bool,
    pub busy: bool,
}

pub struct TmuxSession {
    pub tab_id: String,
    pub environment_id: String,
    pub backend: Backend,
    pub session_id: String,
    pub tmux_session: String,
    pub(crate) tmux_command: String,
    pub claude_command: String,
    pub workspace_hook_paths: WorkspaceHookPaths,
    pub session_hook_paths: SessionHookPaths,
    pub claude_home: String,
    pub transcript_path: Arc<Mutex<Option<String>>>,
    pub stop_notify: Arc<Notify>,
    poll_loop_running: AtomicBool,
    /// True while Claude is mid-turn, as observed by hook events in the Rust
    /// poll loop. Frontend listeners can be absent while an environment is
    /// hidden, so status must carry the latest lifecycle state.
    busy: AtomicBool,
    /// Unix-seconds when this `TmuxSession` was built. Kept for diagnostics
    /// around fresh session startup.
    pub started_at_unix: u64,
    /// True if `session_id` was supplied by the caller to resume an existing
    /// Claude Code session.
    pub is_resume: bool,
}

impl TmuxSession {
    /// Build paths and IDs but do not yet start anything.
    ///
    /// `resume_session_id`, when `Some`, makes this `TmuxSession` attach to an
    /// existing Claude Code session id; the JSONL transcript for that id will
    /// be tailed from the beginning, replaying the prior conversation.
    pub fn build(
        environment_id: String,
        tab_id: String,
        backend: Backend,
        resume_session_id: Option<String>,
        claude_command: Option<String>,
    ) -> Self {
        let is_resume = resume_session_id.is_some();
        let session_id = resume_session_id.unwrap_or_else(|| Uuid::new_v4().to_string());

        let tmux_session = tmux_session_name(&environment_id, &tab_id);

        // Workspace runtime dir is per-env; multiple tabs share it. The
        // hook script (one per workspace) routes events into the right
        // per-session subdir.
        let workspace_root = format!("/tmp/orkestrator-claude-tmux/{}", environment_id);

        let workspace = match &backend {
            Backend::Local { cwd } => cwd.clone(),
            Backend::Container { .. } => "/workspace".to_string(),
        };
        // NOTE: Container paths assume Orkestrator's base image — see the
        // module docs in `mod.rs` for the layout this code depends on.
        let claude_home = match &backend {
            Backend::Local { .. } => {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
                format!("{}/.claude", home)
            }
            Backend::Container { .. } => "/home/node/.claude".to_string(),
        };

        let workspace_hook_paths = WorkspaceHookPaths::new(&workspace_root, &workspace);
        let session_hook_paths = SessionHookPaths::new(&workspace_hook_paths, &session_id);

        let started_at_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .saturating_sub(5);

        TmuxSession {
            tab_id,
            environment_id,
            backend,
            session_id,
            tmux_session,
            tmux_command: "tmux".to_string(),
            claude_command: claude_command.unwrap_or_else(|| "claude".to_string()),
            workspace_hook_paths,
            session_hook_paths,
            claude_home,
            transcript_path: Arc::new(Mutex::new(None)),
            stop_notify: Arc::new(Notify::new()),
            poll_loop_running: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            started_at_unix,
            is_resume,
        }
    }

    pub fn status(&self, running: bool) -> TmuxSessionStatus {
        TmuxSessionStatus {
            tab_id: self.tab_id.clone(),
            environment_id: self.environment_id.clone(),
            session_id: Some(self.session_id.clone()),
            tmux_session: self.tmux_session.clone(),
            running,
            transcript_path: None,
            resumed: self.is_resume,
            busy: self.busy.load(Ordering::SeqCst),
        }
    }

    async fn discover_transcript_path(&self) -> Result<Option<String>, String> {
        if let Some(path) = self.transcript_path.lock().await.clone() {
            return Ok(Some(path));
        }

        let cwd = match &self.backend {
            Backend::Local { cwd } => cwd.clone(),
            Backend::Container { .. } => "/workspace".to_string(),
        };
        // Fresh tmux tabs are launched with a stable `--session-id`, so the
        // transcript must match that exact id. Falling back to the newest JSONL
        // in the project can attach the native transcript view to a different
        // still-running tab before this tab's own transcript has been written.
        let found = transcript::find_transcript_path(
            &self.backend,
            &self.claude_home,
            &cwd,
            &self.session_id,
            None,
        )
        .await?;
        if let Some(path) = found.as_ref() {
            let _ = self.transcript_path.lock().await.replace(path.clone());
        }
        Ok(found)
    }

    /// Read the complete JSONL transcript known for this session. This is
    /// used by the frontend to catch up after the tab was unmounted while the
    /// backend kept tailing tmux output.
    pub async fn transcript_lines(&self) -> Result<Vec<Value>, String> {
        let Some(path) = self.discover_transcript_path().await? else {
            return Ok(Vec::new());
        };
        let content = self.backend.read_file(&path).await?.unwrap_or_default();
        let mut lines = Vec::new();
        for raw in content.lines() {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                lines.push(value);
            }
        }
        Ok(lines)
    }

    /// Return currently pending blocking hook events for UI rehydration. Unlike
    /// the poll loop, this intentionally ignores the already-emitted set so a
    /// remounted tab can recover prompts whose live Tauri events were missed.
    pub async fn pending_hooks(&self) -> Result<Vec<PendingHookEvent>, String> {
        hooks::list_pending_blocking(&self.backend, &self.session_hook_paths).await
    }

    /// Start tmux + claude after the caller has already installed workspace
    /// hooks while holding the per-environment install lock. Keeping the lock
    /// at the command level serializes the whole create/insert/start sequence
    /// against environment stop/delete cleanup.
    pub(crate) async fn start_after_hooks_installed(
        self: Arc<Self>,
        app: AppHandle,
        initial_prompt: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        plan_mode: bool,
    ) -> Result<(), String> {
        // Ensure this session's pending/response/timeout subdirs exist BEFORE
        // claude launches and starts firing hooks.
        hooks::ensure_session_dirs(&self.backend, &self.session_hook_paths).await?;

        // 2. Ensure tmux is available.
        let tmux = self.tmux_command.as_str();
        let probe = self.backend.exec(&["which", tmux]).await?;
        if !probe.success() || probe.stdout.trim().is_empty() {
            return Err(
                "tmux is not installed in this environment. For containers, rebuild the base image; for local, install tmux on the host."
                    .to_string(),
            );
        }

        // 2b. Ensure claude CLI is available *and* supports --session-id —
        // we rely on that flag to discover the transcript filename and to
        // resume previous sessions deterministically.
        let claude_command = self.resolve_claude_command().await?;
        let claude_probe = self.backend.exec(&[&claude_command, "--version"]).await?;
        if !claude_probe.success() {
            return Err("claude CLI not found in this environment.".to_string());
        }
        let help = self.backend.exec(&[&claude_command, "--help"]).await?;
        let help_text = format!("{}\n{}", help.stdout, help.stderr);
        if !help_text.contains("--session-id") {
            return Err(
                "Installed claude CLI does not support --session-id. Upgrade to a newer Claude Code version, or switch to terminal/native mode."
                    .to_string(),
            );
        }
        // If we're resuming, also require --resume.
        if self.is_resume && !help_text.contains("--resume") {
            return Err(
                "Installed claude CLI does not support --resume. Upgrade to a newer Claude Code version to use the resume-session feature."
                    .to_string(),
            );
        }

        // 3. Start tmux session (if not already alive) and launch claude.
        let alive = self.tmux_alive().await?;
        let launched_new = !alive;
        if launched_new {
            let claude_cmd =
                self.claude_launch_command(&claude_command, &help_text, model, effort, plan_mode);

            let wrapped = format!("{}; echo '[claude exited]'; exec bash", claude_cmd);

            let out = self
                .backend
                .exec(&[
                    tmux,
                    "new-session",
                    "-d",
                    "-s",
                    &self.tmux_session,
                    "-x",
                    "200",
                    "-y",
                    "50",
                    "sh",
                    "-c",
                    &wrapped,
                ])
                .await?;
            if !out.success() {
                return Err(format!("tmux new-session failed: {}", out.stderr));
            }
            info!(
                env = %self.environment_id,
                tab = %self.tab_id,
                session = %self.tmux_session,
                resume = self.is_resume,
                "Started tmux claude session"
            );
        }

        // 4. Kick off the poll loop.
        self.clone().spawn_poll_loop(app.clone());

        // 5. Emit started event before any delayed prompt work. The frontend
        // needs `running=true` so it can surface Claude Code's own first-run
        // confirmation prompts, including the bypass-permissions warning.
        let _ = app.emit(
            TAURI_EVENT,
            TmuxEvent::Started {
                tab_id: self.tab_id.clone(),
                environment_id: self.environment_id.clone(),
                session_id: self.session_id.clone(),
                resumed: self.is_resume,
            },
        );

        // 6. Send the initial prompt (if any) in the background, after the
        // TUI is past any selection/confirmation prompt. Claude Code now asks
        // for explicit bypass-permissions confirmation on fresh installs; the
        // old fixed-delay send could press Enter while "No, exit" was selected.
        if should_send_initial_prompt(initial_prompt.as_deref()) {
            self.clone().spawn_initial_prompt_sender(
                app.clone(),
                initial_prompt.unwrap_or_default(),
                launched_new,
            );
        }

        Ok(())
    }

    /// Build the claude invocation for a fresh tmux launch. Split out of
    /// [`Self::start_after_hooks_installed`] so the flag handling (notably
    /// the `--effort` help-text gating) is unit-testable without a Tauri
    /// `AppHandle`.
    fn claude_launch_command(
        &self,
        claude_command: &str,
        help_text: &str,
        model: Option<String>,
        effort: Option<String>,
        plan_mode: bool,
    ) -> String {
        let mut claude_cmd = shell_arg(claude_command);
        if let Some(m) = model {
            if !m.is_empty() {
                claude_cmd.push_str(&format!(" --model {}", shell_arg(&m)));
            }
        }
        if let Some(e) = effort {
            if !e.is_empty() {
                // Older CLIs don't know --effort; skip the flag rather than
                // fail the launch, since effort is a tuning knob, not a
                // prerequisite.
                if help_text.contains("--effort") {
                    claude_cmd.push_str(&format!(" --effort {}", shell_arg(&e)));
                } else {
                    warn!(
                        tab = %self.tab_id,
                        effort = %e,
                        "claude CLI does not support --effort; launching without it"
                    );
                }
            }
        }
        if plan_mode {
            claude_cmd.push_str(" --permission-mode plan");
        }
        claude_cmd.push_str(" --dangerously-skip-permissions");
        if self.is_resume {
            // `--resume <id>` replays the prior conversation; the
            // transcript path is still the same `<id>.jsonl` file.
            //
            // If `initial_prompt` is also supplied, it gets sent by
            // `start_after_hooks_installed` *after* claude reattaches — i.e.
            // it is appended to the resumed conversation. This is intentional
            // (it's how the resume-then-continue flow works in the UI), not
            // an accident. Don't introduce a branch that drops the prompt on
            // resume without confirming the UI flow first.
            claude_cmd.push_str(&format!(" --resume {}", self.session_id));
        } else {
            claude_cmd.push_str(&format!(" --session-id {}", self.session_id));
        }
        claude_cmd
    }

    fn spawn_initial_prompt_sender(
        self: Arc<Self>,
        app: AppHandle,
        prompt: String,
        launched_new: bool,
    ) {
        tokio::spawn(async move {
            if let Err(e) = self
                .send_initial_prompt_when_ready(&prompt, launched_new)
                .await
            {
                warn!(
                    tab = %self.tab_id,
                    error = %e,
                    "failed to send delayed tmux initial prompt"
                );
                let _ = app.emit(
                    TAURI_EVENT,
                    TmuxEvent::Warning {
                        tab_id: self.tab_id.clone(),
                        environment_id: self.environment_id.clone(),
                        message: format!("Failed to send initial prompt: {e}"),
                    },
                );
                return;
            }

            let _ = app.emit(
                TAURI_EVENT,
                TmuxEvent::InitialPromptSent {
                    tab_id: self.tab_id.clone(),
                    environment_id: self.environment_id.clone(),
                    session_id: self.session_id.clone(),
                },
            );
        });
    }

    async fn send_initial_prompt_when_ready(
        &self,
        prompt: &str,
        launched_new: bool,
    ) -> Result<(), String> {
        if launched_new {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        }

        self.wait_for_tui_input_ready().await?;
        self.submit(prompt).await
    }

    async fn wait_for_tui_input_ready(&self) -> Result<(), String> {
        const INITIAL_PROMPT_READY_TIMEOUT_SECS: u64 = 10 * 60;
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(INITIAL_PROMPT_READY_TIMEOUT_SECS);

        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err("timed out waiting for Claude to leave its startup prompt".to_string());
            }
            if !self.tmux_alive().await.unwrap_or(false) {
                return Err("tmux session stopped before Claude was ready".to_string());
            }

            let snapshot = self.capture_pane().await.unwrap_or_default();
            if pane_has_claude_exited(&snapshot) {
                return Err("Claude exited before the initial prompt was sent".to_string());
            }
            if !pane_has_selection_prompt(&snapshot) {
                return Ok(());
            }

            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    async fn resolve_claude_command(&self) -> Result<String, String> {
        if self.claude_command.contains('/') {
            let probe = self
                .backend
                .exec(&["test", "-x", &self.claude_command])
                .await?;
            if probe.success() {
                return Ok(self.claude_command.clone());
            }
        }

        let claude_probe = self.backend.exec(&["which", "claude"]).await?;
        if claude_probe.success() {
            let resolved = claude_probe.stdout.trim();
            if !resolved.is_empty() {
                return Ok(resolved.to_string());
            }
        }

        Ok(self.claude_command.clone())
    }

    fn spawn_poll_loop(self: Arc<Self>, app: AppHandle) {
        if !self.try_mark_poll_loop_started() {
            debug!(tab = %self.tab_id, "tmux poll loop already running");
            return;
        }
        let session = self.clone();
        tokio::spawn(async move {
            let mut tail: Option<TranscriptTail> = None;
            let mut emitted_blocking_ids: HashSet<String> = HashSet::new();
            loop {
                tokio::select! {
                    _ = session.stop_notify.notified() => {
                        debug!(tab = %session.tab_id, "tmux poll loop stop signal");
                        break;
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)) => {}
                }

                // a) drain pending hook events (dedup blocking by id)
                match hooks::drain_pending(
                    &session.backend,
                    &session.session_hook_paths,
                    &mut emitted_blocking_ids,
                )
                .await
                {
                    Ok(events) => {
                        for evt in events {
                            session.emit_hook(&app, evt);
                        }
                    }
                    Err(e) => {
                        warn!(tab = %session.tab_id, error = %e, "drain_pending failed");
                    }
                }

                // a2) drain blocking-hook timeouts
                match hooks::drain_timeouts(&session.backend, &session.session_hook_paths).await {
                    Ok(timeouts) => {
                        for (kind, id) in timeouts {
                            emitted_blocking_ids.remove(&id);
                            let _ = app.emit(
                                TAURI_EVENT,
                                TmuxEvent::HookTimedOut {
                                    tab_id: session.tab_id.clone(),
                                    environment_id: session.environment_id.clone(),
                                    session_id: session.session_id.clone(),
                                    event_kind: kind,
                                    event_id: id,
                                },
                            );
                        }
                    }
                    Err(e) => {
                        warn!(tab = %session.tab_id, error = %e, "drain_timeouts failed");
                    }
                }

                // b) discover the exact transcript file if we don't know it yet.
                //    We do not fall back to the newest project JSONL here:
                //    concurrent tmux tabs can be writing nearby transcripts.
                if tail.is_none() {
                    match session.discover_transcript_path().await {
                        Ok(Some(p)) => {
                            info!(tab = %session.tab_id, path = %p, "Found transcript JSONL");
                            tail = Some(TranscriptTail::new(p));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            warn!(tab = %session.tab_id, error = %e, "find_transcript_path failed");
                        }
                    }
                }

                // c) tail the transcript
                if let Some(t) = tail.as_mut() {
                    match t.read_new(&session.backend).await {
                        Ok(lines) => {
                            for line in lines {
                                let _ = app.emit(
                                    TAURI_EVENT,
                                    TmuxEvent::TranscriptLine {
                                        tab_id: session.tab_id.clone(),
                                        environment_id: session.environment_id.clone(),
                                        session_id: session.session_id.clone(),
                                        line,
                                    },
                                );
                            }
                        }
                        Err(e) => {
                            warn!(tab = %session.tab_id, error = %e, "transcript read failed");
                        }
                    }
                }

                // d) detect tmux dying
                if !session.tmux_alive().await.unwrap_or(false) {
                    let _ = app.emit(
                        TAURI_EVENT,
                        TmuxEvent::Stopped {
                            tab_id: session.tab_id.clone(),
                            environment_id: session.environment_id.clone(),
                        },
                    );
                    break;
                }
            }
            session.mark_poll_loop_stopped();
        });
    }

    fn try_mark_poll_loop_started(&self) -> bool {
        self.poll_loop_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn mark_poll_loop_stopped(&self) {
        self.poll_loop_running.store(false, Ordering::SeqCst);
    }

    fn emit_hook(&self, app: &AppHandle, evt: PendingHookEvent) {
        self.update_busy_from_hook_kind(&evt.kind);
        let _ = app.emit(
            TAURI_EVENT,
            TmuxEvent::Hook {
                tab_id: self.tab_id.clone(),
                environment_id: self.environment_id.clone(),
                session_id: self.session_id.clone(),
                event_id: evt.id,
                event_kind: evt.kind,
                payload: evt.payload,
            },
        );
    }

    fn update_busy_from_hook_kind(&self, kind: &str) {
        match kind {
            "UserPromptSubmit" => self.busy.store(true, Ordering::SeqCst),
            "Stop" => self.busy.store(false, Ordering::SeqCst),
            _ => {}
        }
    }

    pub async fn tmux_alive(&self) -> Result<bool, String> {
        let tmux = self.tmux_command.as_str();
        let out = self
            .backend
            .exec(&[tmux, "has-session", "-t", &self.tmux_session])
            .await?;
        Ok(out.success())
    }

    /// Send text into the tmux pane (no trailing Enter) using a tmux paste
    /// buffer with bracketed-paste mode. The Claude TUI recognizes bracketed
    /// paste and ingests the whole payload as a single unit — newlines stay
    /// as newlines instead of being interpreted as submits, and we avoid
    /// firing one tmux command per line for long inputs.
    pub async fn send_text(&self, text: &str) -> Result<(), String> {
        if text.is_empty() {
            return Ok(());
        }
        let tmux = self.tmux_command.as_str();
        let buffer_name = format!("claude-tmux-input-{}", self.tmux_session);
        let load = self
            .backend
            .exec_with_stdin(
                &[tmux, "load-buffer", "-b", &buffer_name, "-"],
                Some(text),
            )
            .await?;
        if !load.success() {
            return Err(load.stderr);
        }
        let paste = self
            .backend
            .exec(&[
                tmux,
                "paste-buffer",
                "-p",
                "-d",
                "-b",
                &buffer_name,
                "-t",
                &self.tmux_session,
            ])
            .await?;
        if !paste.success() {
            return Err(paste.stderr);
        }
        Ok(())
    }

    pub async fn send_enter(&self) -> Result<(), String> {
        self.send_keys(&["Enter"]).await
    }

    /// Send text then submit it. The settle delay between paste and Enter
    /// gives the Claude TUI time to finish ingesting the bracketed paste;
    /// without it a fast Enter can be absorbed into the paste and the prompt
    /// is left sitting in the compose area instead of being submitted.
    pub async fn submit(&self, text: &str) -> Result<(), String> {
        if !text.is_empty() {
            self.send_text(text).await?;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        self.send_enter().await
    }

    /// Send Claude Code's `/model` slash command and keep the caller blocked
    /// until the command has settled. A plain `submit("/model ...")` returns
    /// immediately after pressing Enter, but Claude Code may still be applying
    /// the model change; sending the next user prompt during that window can
    /// interrupt the internal command turn instead of submitting the prompt.
    pub async fn switch_model(&self, model_arg: &str) -> Result<(), String> {
        let trimmed = model_arg.trim();
        if trimmed.is_empty() {
            return Err("model id cannot be empty".to_string());
        }

        self.submit(&format!("/model {trimmed}")).await?;
        self.wait_for_command_idle().await;
        Ok(())
    }

    /// Send Claude Code's `/effort` slash command and block until it settles,
    /// for the same reason as [`Self::switch_model`].
    pub async fn switch_effort(&self, effort_arg: &str) -> Result<(), String> {
        let trimmed = effort_arg.trim();
        if trimmed.is_empty() {
            return Err("effort level cannot be empty".to_string());
        }

        self.submit(&format!("/effort {trimmed}")).await?;
        self.wait_for_command_idle().await;
        Ok(())
    }

    async fn wait_for_command_idle(&self) {
        let started = tokio::time::Instant::now();
        let deadline = started + COMMAND_IDLE_TIMEOUT;
        let no_hook_deadline = started + COMMAND_NO_HOOK_SETTLE;
        let mut saw_busy = self.busy.load(Ordering::SeqCst);

        loop {
            let now = tokio::time::Instant::now();
            let busy = self.busy.load(Ordering::SeqCst);
            if busy {
                saw_busy = true;
            } else if saw_busy {
                tokio::time::sleep(COMMAND_AFTER_IDLE_SETTLE).await;
                return;
            } else if now >= no_hook_deadline {
                return;
            }

            if now >= deadline {
                warn!(
                    tab = %self.tab_id,
                    session = %self.tmux_session,
                    "timed out waiting for Claude slash command to settle"
                );
                return;
            }

            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    pub async fn send_keys(&self, keys: &[&str]) -> Result<(), String> {
        let mut args: Vec<&str> = vec![
            self.tmux_command.as_str(),
            "send-keys",
            "-t",
            &self.tmux_session,
        ];
        args.push("--");
        args.extend_from_slice(keys);
        let out = self.backend.exec(&args).await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(())
    }

    /// Interrupt the current Claude turn without tearing down the tmux
    /// session. Escape is Claude Code's in-TUI interrupt key; unlike Ctrl-C,
    /// it avoids sending SIGINT to the foreground process.
    pub async fn interrupt(&self) -> Result<(), String> {
        self.send_keys(&["Escape"]).await?;
        self.busy.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Capture the visible pane (the TUI) as text. We deliberately omit `-e`
    /// (which preserves ANSI escape sequences) because the frontend renders
    /// the result in a plain `<pre>` — the raw escape bytes appear as
    /// garbage. `-J` joins lines wrapped by tmux so long output reads
    /// naturally.
    pub async fn capture_pane(&self) -> Result<String, String> {
        let tmux = self.tmux_command.as_str();
        let out = self
            .backend
            .exec(&[tmux, "capture-pane", "-t", &self.tmux_session, "-p", "-J"])
            .await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(out.stdout)
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let tmux = self.tmux_command.as_str();
        let out = self
            .backend
            .exec(&[
                tmux,
                "resize-window",
                "-t",
                &self.tmux_session,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .await?;
        if !out.success() {
            return Err(out.stderr);
        }
        Ok(())
    }

    pub async fn reply_to_hook(
        &self,
        event_kind: &str,
        event_id: &str,
        response: Value,
    ) -> Result<(), String> {
        hooks::reply_to_hook(
            &self.backend,
            &self.session_hook_paths,
            event_kind,
            event_id,
            &response,
        )
        .await
    }

    pub async fn answer_pre_tool_use(
        &self,
        event_id: &str,
        decision: &str,
        reason: Option<String>,
    ) -> Result<(), String> {
        let resp = hooks::pre_tool_use_response(decision, reason.as_deref());
        self.reply_to_hook("PreToolUse", event_id, resp).await
    }

    /// Stop tmux for this tab and clean up this session's runtime dir.
    /// Workspace-level hooks (`.claude/settings.local.json` etc.) are left in
    /// place — the caller (manager) decides when to uninstall them based on
    /// whether other sessions in the same env are still active.
    pub async fn stop(&self) -> Result<(), String> {
        self.stop_notify.notify_waiters();

        let _ = self
            .backend
            .exec(&[
                self.tmux_command.as_str(),
                "kill-session",
                "-t",
                &self.tmux_session,
            ])
            .await;

        if let Err(e) = hooks::remove_session_dirs(&self.backend, &self.session_hook_paths).await {
            warn!(tab = %self.tab_id, error = %e, "remove_session_dirs failed");
        }

        Ok(())
    }
}

pub fn short_id(id: &str) -> String {
    id.chars().take(12).collect::<String>().replace('-', "")
}

/// Compute the deterministic tmux session name for a given (env, tab) pair.
/// Exposed so callers that need to act on the session (e.g. force-kill on
/// "Start fresh") can do so without first instantiating a `TmuxSession`.
pub fn tmux_session_name(environment_id: &str, tab_id: &str) -> String {
    format!(
        "orkestrator-{}-{}",
        short_id(environment_id),
        short_id(tab_id),
    )
}

fn shell_arg(s: &str) -> String {
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

fn should_send_initial_prompt(prompt: Option<&str>) -> bool {
    prompt.is_some_and(|p| !p.trim().is_empty())
}

fn pane_has_selection_prompt(snapshot: &str) -> bool {
    let plain = strip_ansi(snapshot);
    let lower = plain.to_ascii_lowercase();
    if !lower.contains("esc to cancel") || !lower.contains("enter to") {
        return false;
    }

    plain.lines().any(is_selection_option_line)
}

fn is_selection_option_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    let without_selector = trimmed
        .strip_prefix('>')
        .or_else(|| trimmed.strip_prefix('›'))
        .or_else(|| trimmed.strip_prefix('❯'))
        .or_else(|| trimmed.strip_prefix('▸'))
        .or_else(|| trimmed.strip_prefix('➜'))
        .or_else(|| trimmed.strip_prefix('→'))
        .unwrap_or(trimmed)
        .trim_start();

    let digit_count = without_selector
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .count();
    digit_count > 0 && without_selector[digit_count..].starts_with(". ")
}

fn pane_has_claude_exited(snapshot: &str) -> bool {
    strip_ansi(snapshot).contains("[claude exited]")
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            Some(&'[') => {
                // CSI: ESC [ <params> <letter>
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(&']') => {
                // OSC: ESC ] ... BEL or ESC \ (ST)
                chars.next();
                loop {
                    match chars.next() {
                        Some('\x07') | None => break,
                        Some('\x1b') => {
                            chars.next(); // consume the \ of ST
                            break;
                        }
                        _ => {}
                    }
                }
            }
            Some(_) => {
                // Two-char sequences: ESC M (reverse index), ESC O (SS3), etc.
                chars.next();
            }
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_tmux::hooks::{self, HOOK_TIMEOUT_SECS};
    use std::collections::HashSet;
    use std::fs as std_fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;
    use tokio::fs;

    fn build(tmp: &TempDir, env: &str, tab: &str, resume: Option<&str>) -> Arc<TmuxSession> {
        build_with_tmux(tmp, env, tab, resume, None)
    }

    fn build_with_tmux(
        tmp: &TempDir,
        env: &str,
        tab: &str,
        resume: Option<&str>,
        tmux_command: Option<String>,
    ) -> Arc<TmuxSession> {
        build_with_tmux_cwd(
            tmp.path().to_string_lossy().into_owned(),
            env,
            tab,
            resume,
            tmux_command,
        )
    }

    fn build_with_tmux_cwd(
        cwd: String,
        env: &str,
        tab: &str,
        resume: Option<&str>,
        tmux_command: Option<String>,
    ) -> Arc<TmuxSession> {
        let mut session = TmuxSession::build(
            env.to_string(),
            tab.to_string(),
            Backend::Local { cwd },
            resume.map(str::to_string),
            None,
        );
        if let Some(tmux_command) = tmux_command {
            session.tmux_command = tmux_command;
        }
        Arc::new(session)
    }

    fn install_fake_tmux(dir: &std::path::Path, log_path: &std::path::Path, status: i32) {
        let script = dir.join("tmux");
        std_fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = \"load-buffer\" ]; then printf 'stdin:' >> '{}'; cat >> '{}'; printf '\\n' >> '{}'; fi\nif [ {} -ne 0 ]; then echo 'tmux failed' >&2; fi\nexit {}\n",
                log_path.display(),
                log_path.display(),
                log_path.display(),
                log_path.display(),
                status,
                status,
            ),
        )
        .unwrap();
        let mut perms = std_fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std_fs::set_permissions(&script, perms).unwrap();
    }

    async fn with_fake_tmux<F, Fut>(tmp: &TempDir, status: i32, f: F)
    where
        F: FnOnce(std::path::PathBuf, String) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let bin_dir = tmp.path().join("bin");
        std_fs::create_dir_all(&bin_dir).unwrap();
        let log_path = tmp.path().join("tmux.log");
        install_fake_tmux(&bin_dir, &log_path, status);
        let tmux_path = bin_dir.join("tmux").to_string_lossy().into_owned();

        f(log_path, tmux_path).await;
    }

    #[test]
    fn short_id_truncates_and_strips_dashes() {
        let id = short_id("a33f9026-8cfe-4077-aefd-4db2c2637dcc");
        assert_eq!(id.len(), 11);
        assert!(!id.contains('-'));
        assert!("a33f9026-8cfe".starts_with(&id[..4]));
    }

    #[test]
    fn tmux_session_name_matches_build_output() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-xyz", "tab-abc", None);
        assert_eq!(s.tmux_session, tmux_session_name("env-xyz", "tab-abc"));
        // Distinct (env, tab) pairs yield distinct names.
        assert_ne!(
            tmux_session_name("env-xyz", "tab-abc"),
            tmux_session_name("env-xyz", "tab-other"),
        );
        assert_ne!(
            tmux_session_name("env-xyz", "tab-abc"),
            tmux_session_name("env-other", "tab-abc"),
        );
    }

    #[test]
    fn shell_arg_quotes_simple_value() {
        assert_eq!(shell_arg("sonnet"), "'sonnet'");
    }

    #[test]
    fn shell_arg_escapes_single_quotes() {
        assert_eq!(shell_arg("it's"), "'it'\\''s'");
    }

    #[test]
    fn tmux_session_status_returns_running_flag_and_resume_flag() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);
        let alive = s.status(true);
        assert_eq!(alive.environment_id, "env-1");
        assert_eq!(alive.tab_id, "tab-1");
        assert!(alive.running);
        assert!(!alive.resumed);
        assert!(alive.session_id.is_some());
        assert!(alive.tmux_session.starts_with("orkestrator-"));
        assert!(alive.tmux_session.contains('-'));

        let dead = s.status(false);
        assert!(!dead.running);

        let resumed = build(
            &tmp,
            "env-1",
            "tab-2",
            Some("00000000-0000-0000-0000-000000000000"),
        );
        assert!(resumed.is_resume);
        assert_eq!(resumed.session_id, "00000000-0000-0000-0000-000000000000");
        assert!(resumed.status(true).resumed);
    }

    #[test]
    fn busy_status_tracks_top_level_turn_lifecycle_only() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);

        assert!(!s.status(true).busy);
        s.update_busy_from_hook_kind("UserPromptSubmit");
        assert!(s.status(true).busy);
        s.update_busy_from_hook_kind("SubagentStop");
        assert!(s.status(true).busy);
        s.update_busy_from_hook_kind("Stop");
        assert!(!s.status(true).busy);
    }

    #[tokio::test]
    async fn interrupt_sends_escape_and_clears_busy_on_success() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 0, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));
            s.update_busy_from_hook_kind("UserPromptSubmit");

            s.interrupt().await.unwrap();

            assert!(!s.status(true).busy);
            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains(&format!("send-keys -t {} -- Escape", s.tmux_session)));
        })
        .await;
    }

    #[tokio::test]
    async fn send_text_uses_bracketed_paste_buffer() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 0, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));

            s.send_text("- review this\nnext line").await.unwrap();

            let log = fs::read_to_string(log_path).await.unwrap();
            let buffer_name = format!("claude-tmux-input-{}", s.tmux_session);
            assert!(log.contains(&format!("load-buffer -b {buffer_name} -")));
            assert!(log.contains(&format!(
                "paste-buffer -p -d -b {buffer_name} -t {}",
                s.tmux_session
            )));
            // Per-line send-keys is no longer used for paste delivery.
            assert!(!log.contains("send-keys"));
        })
        .await;
    }

    #[tokio::test]
    async fn submit_pastes_text_then_presses_enter() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 0, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));

            s.submit("hello").await.unwrap();

            let log = fs::read_to_string(log_path).await.unwrap();
            let buffer_name = format!("claude-tmux-input-{}", s.tmux_session);
            let load_pos = log
                .find(&format!("load-buffer -b {buffer_name} -"))
                .expect("load-buffer logged");
            let paste_pos = log
                .find(&format!(
                    "paste-buffer -p -d -b {buffer_name} -t {}",
                    s.tmux_session
                ))
                .expect("paste-buffer logged");
            let enter_pos = log
                .find(&format!("send-keys -t {} -- Enter", s.tmux_session))
                .expect("Enter logged");
            assert!(load_pos < paste_pos);
            assert!(paste_pos < enter_pos);
        })
        .await;
    }

    #[tokio::test]
    async fn switch_model_rejects_empty_model_id() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);

        let err = s.switch_model("   ").await.unwrap_err();

        assert_eq!(err, "model id cannot be empty");
    }

    #[tokio::test]
    async fn switch_model_submits_model_command_and_settles_without_hooks() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 0, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));

            s.switch_model("  claude-opus-4-7  ").await.unwrap();

            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains("stdin:/model claude-opus-4-7"));
            assert!(log.contains(&format!("send-keys -t {} -- Enter", s.tmux_session)));
        })
        .await;
    }

    #[tokio::test]
    async fn switch_model_waits_for_busy_to_clear_before_returning() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 0, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));
            s.update_busy_from_hook_kind("UserPromptSubmit");
            let s_for_task = Arc::clone(&s);
            let task = tokio::spawn(async move {
                s_for_task.switch_model("claude-haiku-4-5").await.unwrap();
            });

            tokio::time::sleep(std::time::Duration::from_millis(350)).await;
            s.update_busy_from_hook_kind("Stop");

            task.await.unwrap();
            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains("stdin:/model claude-haiku-4-5"));
            assert!(!s.status(true).busy);
        })
        .await;
    }

    const HELP_WITH_EFFORT: &str = "--session-id\n--resume\n--effort <level>";
    const HELP_WITHOUT_EFFORT: &str = "--session-id\n--resume";

    #[test]
    fn claude_launch_command_includes_model_effort_and_plan_flags() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);

        let cmd = s.claude_launch_command(
            "claude",
            HELP_WITH_EFFORT,
            Some("sonnet".to_string()),
            Some("xhigh".to_string()),
            true,
        );

        assert_eq!(
            cmd,
            format!(
                "'claude' --model 'sonnet' --effort 'xhigh' --permission-mode plan --dangerously-skip-permissions --session-id {}",
                s.session_id
            )
        );
    }

    #[test]
    fn claude_launch_command_skips_effort_when_cli_does_not_advertise_it() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);

        let cmd = s.claude_launch_command(
            "claude",
            HELP_WITHOUT_EFFORT,
            None,
            Some("xhigh".to_string()),
            false,
        );

        assert!(!cmd.contains("--effort"));
        assert_eq!(
            cmd,
            format!(
                "'claude' --dangerously-skip-permissions --session-id {}",
                s.session_id
            )
        );
    }

    #[test]
    fn claude_launch_command_omits_empty_model_and_effort() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);

        let cmd = s.claude_launch_command(
            "claude",
            HELP_WITH_EFFORT,
            Some(String::new()),
            Some(String::new()),
            false,
        );

        assert!(!cmd.contains("--model"));
        assert!(!cmd.contains("--effort"));
    }

    #[test]
    fn claude_launch_command_uses_resume_flag_for_resumed_sessions() {
        let tmp = TempDir::new().unwrap();
        let s = build(
            &tmp,
            "env-1",
            "tab-1",
            Some("00000000-0000-0000-0000-000000000000"),
        );

        let cmd = s.claude_launch_command("claude", HELP_WITH_EFFORT, None, None, false);

        assert!(cmd.contains("--resume 00000000-0000-0000-0000-000000000000"));
        assert!(!cmd.contains("--session-id"));
    }

    #[tokio::test]
    async fn switch_effort_rejects_empty_effort_level() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);

        let err = s.switch_effort("   ").await.unwrap_err();

        assert_eq!(err, "effort level cannot be empty");
    }

    #[tokio::test]
    async fn switch_effort_submits_effort_command_and_settles_without_hooks() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 0, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));

            s.switch_effort("  xhigh  ").await.unwrap();

            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains("stdin:/effort xhigh"));
            assert!(log.contains(&format!("send-keys -t {} -- Enter", s.tmux_session)));
        })
        .await;
    }

    #[tokio::test]
    async fn interrupt_preserves_busy_when_tmux_send_fails() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, 1, |log_path, tmux_path| async move {
            let s = build_with_tmux_cwd(cwd, "env-1", "tab-1", None, Some(tmux_path));
            s.update_busy_from_hook_kind("UserPromptSubmit");

            let err = s.interrupt().await.unwrap_err();

            assert!(err.contains("tmux failed"));
            assert!(s.status(true).busy);
            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains(&format!("send-keys -t {} -- Escape", s.tmux_session)));
        })
        .await;
    }

    #[tokio::test]
    async fn transcript_lines_reads_cached_path_and_skips_invalid_json() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-1", "tab-1", None);
        let path = tmp.path().join("session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\nnot-json\n{\"type\":\"assistant\"}\n",
        )
        .await
        .unwrap();
        let path = path.to_string_lossy().into_owned();
        s.transcript_path.lock().await.replace(path);

        let lines = s.transcript_lines().await.unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["type"], "user");
        assert_eq!(lines[1]["type"], "assistant");
    }

    #[tokio::test]
    async fn transcript_lines_does_not_read_newest_unrelated_project_jsonl() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        let mut s = TmuxSession::build(
            "env-1".to_string(),
            "tab-1".to_string(),
            Backend::Local { cwd: cwd.clone() },
            None,
            None,
        );
        s.claude_home = tmp.path().join(".claude").to_string_lossy().into_owned();
        let project_dir = tmp
            .path()
            .join(".claude")
            .join("projects")
            .join(transcript::encode_cwd(&cwd));
        fs::create_dir_all(&project_dir).await.unwrap();
        fs::write(
            project_dir.join("previous-review-session.jsonl"),
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"review text\"}}\n",
        )
        .await
        .unwrap();

        let lines = s.transcript_lines().await.unwrap();
        assert!(lines.is_empty());
    }

    #[tokio::test]
    async fn pending_hooks_returns_current_blocking_hooks_without_consuming_them() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let s = TmuxSession::build(
            "env-pending".to_string(),
            "tab-p".to_string(),
            backend.clone(),
            None,
            None,
        );
        hooks::ensure_session_dirs(&backend, &s.session_hook_paths)
            .await
            .unwrap();

        let blocking = format!("{}/PreToolUse-id-1.json", s.session_hook_paths.pending_dir);
        let info = format!(
            "{}/Notification-id-2.json",
            s.session_hook_paths.pending_dir
        );
        fs::write(&blocking, "{\"tool_name\":\"AskUserQuestion\"}")
            .await
            .unwrap();
        fs::write(&info, "{\"message\":\"hello\"}").await.unwrap();

        let pending = s.pending_hooks().await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "id-1");
        assert_eq!(pending[0].kind, "PreToolUse");
        assert!(std::path::Path::new(&blocking).exists());
        assert!(std::path::Path::new(&info).exists());
    }

    #[test]
    fn tabs_in_same_env_get_distinct_tmux_session_names() {
        let tmp = TempDir::new().unwrap();
        let a = build(&tmp, "env-shared", "tab-aaaa-0001", None);
        let b = build(&tmp, "env-shared", "tab-bbbb-0002", None);
        assert_ne!(a.tmux_session, b.tmux_session);
        assert_ne!(a.session_id, b.session_id);
        // …but they share the workspace hook artifacts.
        assert_eq!(a.workspace_hook_paths.script, b.workspace_hook_paths.script);
        assert_eq!(
            a.workspace_hook_paths.claude_settings,
            b.workspace_hook_paths.claude_settings
        );
        // …and have distinct per-session pending dirs.
        assert_ne!(
            a.session_hook_paths.session_dir,
            b.session_hook_paths.session_dir
        );
    }

    #[test]
    fn poll_loop_running_guard_allows_only_one_loop() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-poll", "tab-1", None);
        assert!(s.try_mark_poll_loop_started());
        assert!(!s.try_mark_poll_loop_started());
        s.mark_poll_loop_stopped();
        assert!(s.try_mark_poll_loop_started());
    }

    #[test]
    fn initial_prompt_is_sent_whenever_non_empty() {
        assert!(should_send_initial_prompt(Some("hello")));
        assert!(should_send_initial_prompt(Some("review this branch")));
        assert!(!should_send_initial_prompt(Some("   ")));
        assert!(!should_send_initial_prompt(Some("")));
        assert!(!should_send_initial_prompt(None));
    }

    #[test]
    fn detects_claude_tui_selection_prompts() {
        let pane = r#"
WARNING: Claude Code running in Bypass Permissions mode

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
"#;

        assert!(pane_has_selection_prompt(pane));
    }

    #[test]
    fn does_not_treat_plain_output_as_selection_prompt() {
        let pane = r#"
1. Inspect the failing test
2. Patch the race

node@host:/workspace$
"#;

        assert!(!pane_has_selection_prompt(pane));
    }

    #[test]
    fn detects_claude_exited_sentinel() {
        assert!(pane_has_claude_exited(
            "\u{1b}[31m[claude exited]\u{1b}[0m\nnode@host:/workspace$"
        ));
    }

    #[test]
    fn strip_ansi_handles_osc_sequences() {
        // OSC terminated by BEL
        assert_eq!(strip_ansi("\x1b]0;window title\x07hello"), "hello");
        // OSC terminated by ST (ESC \)
        assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
    }

    #[test]
    fn strip_ansi_handles_two_char_escape_sequences() {
        // ESC M (reverse index) — only two chars consumed
        assert_eq!(strip_ansi("\x1bMtext"), "text");
    }

    #[test]
    fn pane_has_selection_prompt_survives_osc_wrapped_text() {
        let pane = "\x1b]0;claude\x07\
WARNING: Claude Code running in Bypass Permissions mode\n\
\n\
› 1. No, exit\n\
  2. Yes, I accept\n\
\n\
Enter to confirm · Esc to cancel\n";
        assert!(pane_has_selection_prompt(pane));
    }

    #[test]
    fn hook_timeout_constant_is_reasonable() {
        assert!(HOOK_TIMEOUT_SECS >= 60);
        assert!(HOOK_TIMEOUT_SECS <= 3600);
    }

    #[test]
    fn build_defaults_claude_command_to_bare_name() {
        let tmp = TempDir::new().unwrap();
        let s = build(&tmp, "env-d", "tab-d", None);
        assert_eq!(s.claude_command, "claude");
    }

    #[test]
    fn build_uses_explicit_claude_command_when_provided() {
        let tmp = TempDir::new().unwrap();
        let s = Arc::new(TmuxSession::build(
            "env-x".to_string(),
            "tab-x".to_string(),
            Backend::Local {
                cwd: tmp.path().to_string_lossy().into_owned(),
            },
            None,
            Some("/opt/bin/claude".to_string()),
        ));
        assert_eq!(s.claude_command, "/opt/bin/claude");
    }

    #[tokio::test]
    async fn resolve_claude_command_returns_absolute_path_when_executable() {
        let tmp = TempDir::new().unwrap();
        let bin = tmp.path().join("fake-claude");
        std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&bin).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&bin, perms).unwrap();
        }

        let s = Arc::new(TmuxSession::build(
            "env-r".to_string(),
            "tab-r".to_string(),
            Backend::Local {
                cwd: tmp.path().to_string_lossy().into_owned(),
            },
            None,
            Some(bin.to_string_lossy().into_owned()),
        ));

        let resolved = s.resolve_claude_command().await.unwrap();
        assert_eq!(resolved, bin.to_string_lossy());
    }

    #[tokio::test]
    async fn install_then_uninstall_restores_original_settings() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let s = TmuxSession::build(
            "env-restore".to_string(),
            "tab-r".to_string(),
            backend.clone(),
            None,
            None,
        );

        let original = "{\"theme\":\"dark\"}";
        let settings_path = s.workspace_hook_paths.claude_settings.clone();
        let parent = std::path::Path::new(&settings_path).parent().unwrap();
        fs::create_dir_all(parent).await.unwrap();
        fs::write(&settings_path, original).await.unwrap();

        hooks::install_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();

        let after_install = fs::read_to_string(&settings_path).await.unwrap();
        assert!(after_install.contains("\"hooks\""));
        assert!(after_install.contains("\"theme\""));

        hooks::uninstall_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();
        let restored = fs::read_to_string(&settings_path).await.unwrap();
        assert_eq!(restored, original);
        assert!(!std::path::Path::new(&s.workspace_hook_paths.root).exists());
    }

    #[tokio::test]
    async fn uninstall_removes_settings_when_none_existed() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let s = TmuxSession::build(
            "env-fresh".to_string(),
            "tab-f".to_string(),
            backend.clone(),
            None,
            None,
        );

        hooks::install_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();
        assert!(std::path::Path::new(&s.workspace_hook_paths.claude_settings).exists());

        hooks::uninstall_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();
        assert!(!std::path::Path::new(&s.workspace_hook_paths.claude_settings).exists());
    }

    #[tokio::test]
    async fn second_install_preserves_first_backup() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let a = TmuxSession::build(
            "env-x".to_string(),
            "tab-1".to_string(),
            backend.clone(),
            None,
            None,
        );
        let b = TmuxSession::build(
            "env-x".to_string(),
            "tab-2".to_string(),
            backend.clone(),
            None,
            None,
        );

        // First install with no original.
        hooks::install_workspace_hooks(&backend, &a.workspace_hook_paths)
            .await
            .unwrap();

        // Second install (different tab, same workspace) MUST NOT clobber the
        // backup with the now-installed (hooked) settings. Otherwise, uninstall
        // would "restore" the hooked file as if it were original.
        hooks::install_workspace_hooks(&backend, &b.workspace_hook_paths)
            .await
            .unwrap();

        hooks::uninstall_workspace_hooks(&backend, &a.workspace_hook_paths)
            .await
            .unwrap();
        assert!(!std::path::Path::new(&a.workspace_hook_paths.claude_settings).exists());
    }

    /// Two `install_workspace_hooks` calls run concurrently while sharing
    /// the per-env install lock (the same protocol `TmuxSession::start`
    /// uses). The pre-existing user settings must round-trip on uninstall.
    ///
    /// Without the lock, the second install could (in worst-case
    /// interleaving) read the *merged* settings as if they were the user's
    /// original and overwrite the backup, making uninstall restore the
    /// hook-laced file as if it were untouched.
    #[tokio::test]
    async fn concurrent_install_under_lock_preserves_original_backup() {
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let a = TmuxSession::build(
            "env-conc".to_string(),
            "tab-1".to_string(),
            backend.clone(),
            None,
            None,
        );
        let b = TmuxSession::build(
            "env-conc".to_string(),
            "tab-2".to_string(),
            backend.clone(),
            None,
            None,
        );

        // Plant a pre-existing user settings file we expect to recover.
        let original = "{\"theme\":\"original-theme\"}";
        let settings_path = a.workspace_hook_paths.claude_settings.clone();
        let parent = std::path::Path::new(&settings_path).parent().unwrap();
        fs::create_dir_all(parent).await.unwrap();
        fs::write(&settings_path, original).await.unwrap();

        // Shared per-env lock, exactly as the manager hands out in production.
        let lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));

        let lock_a = lock.clone();
        let backend_a = backend.clone();
        let paths_a = a.workspace_hook_paths.clone();
        let task_a = tokio::spawn(async move {
            let _guard = lock_a.lock().await;
            hooks::install_workspace_hooks(&backend_a, &paths_a)
                .await
                .unwrap();
        });
        let lock_b = lock.clone();
        let backend_b = backend.clone();
        let paths_b = b.workspace_hook_paths.clone();
        let task_b = tokio::spawn(async move {
            let _guard = lock_b.lock().await;
            hooks::install_workspace_hooks(&backend_b, &paths_b)
                .await
                .unwrap();
        });

        let _ = tokio::join!(task_a, task_b);

        // After both installs, uninstall must restore the original user
        // settings byte-for-byte (the test would fail if either install
        // had cached the hook-merged file as "original").
        hooks::uninstall_workspace_hooks(&backend, &a.workspace_hook_paths)
            .await
            .unwrap();
        let restored = fs::read_to_string(&settings_path).await.unwrap();
        assert_eq!(restored, original);
    }

    #[tokio::test]
    async fn drain_pending_dedupes_blocking_events_across_calls() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let s = TmuxSession::build(
            "env-dedup".to_string(),
            "tab-d".to_string(),
            backend.clone(),
            None,
            None,
        );
        hooks::install_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();
        hooks::ensure_session_dirs(&backend, &s.session_hook_paths)
            .await
            .unwrap();

        // Simulate hook.sh writing a PreToolUse pending file for this session.
        let pending = format!(
            "{}/PreToolUse-1234-5678.json",
            s.session_hook_paths.pending_dir
        );
        fs::write(&pending, "{\"tool_name\":\"Bash\"}")
            .await
            .unwrap();

        let mut emitted: HashSet<String> = HashSet::new();
        let first = hooks::drain_pending(&backend, &s.session_hook_paths, &mut emitted)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, "PreToolUse");
        assert_eq!(emitted.len(), 1);

        let second = hooks::drain_pending(&backend, &s.session_hook_paths, &mut emitted)
            .await
            .unwrap();
        assert!(second.is_empty());

        fs::remove_file(&pending).await.unwrap();
        let third = hooks::drain_pending(&backend, &s.session_hook_paths, &mut emitted)
            .await
            .unwrap();
        assert!(third.is_empty());
        assert!(emitted.is_empty());
    }

    #[tokio::test]
    async fn drain_pending_consumes_informational_events_each_time() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let s = TmuxSession::build(
            "env-info".to_string(),
            "tab-i".to_string(),
            backend.clone(),
            None,
            None,
        );
        hooks::install_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();
        hooks::ensure_session_dirs(&backend, &s.session_hook_paths)
            .await
            .unwrap();

        let pending = format!(
            "{}/Notification-aa-bb.json",
            s.session_hook_paths.pending_dir
        );
        fs::write(&pending, "{\"message\":\"hi\"}").await.unwrap();

        let mut emitted: HashSet<String> = HashSet::new();
        let first = hooks::drain_pending(&backend, &s.session_hook_paths, &mut emitted)
            .await
            .unwrap();
        assert_eq!(first.len(), 1);
        assert!(!std::path::Path::new(&pending).exists());
    }

    #[tokio::test]
    async fn drain_timeouts_returns_and_removes_timeout_sentinels() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let s = TmuxSession::build(
            "env-timeout".to_string(),
            "tab-t".to_string(),
            backend.clone(),
            None,
            None,
        );
        hooks::install_workspace_hooks(&backend, &s.workspace_hook_paths)
            .await
            .unwrap();
        hooks::ensure_session_dirs(&backend, &s.session_hook_paths)
            .await
            .unwrap();

        let timeout_file = format!("{}/PreToolUse-id-1.json", s.session_hook_paths.timeout_dir);
        fs::write(&timeout_file, "{\"timed_out\":true}")
            .await
            .unwrap();

        let outs = hooks::drain_timeouts(&backend, &s.session_hook_paths)
            .await
            .unwrap();
        assert_eq!(outs.len(), 1);
        assert_eq!(outs[0].0, "PreToolUse");
        assert_eq!(outs[0].1, "id-1");
        assert!(!std::path::Path::new(&timeout_file).exists());
    }
}
