//! Tauri commands for Claude tmux mode. Session commands are scoped by
//! `(environment_id, tab_id)` because separate environments can both have a
//! first tab named `default`.

use crate::claude_tmux::{
    backend::Backend,
    get_manager, hooks,
    session::{short_id, tmux_session_name, TmuxSession, TmuxSessionStatus},
    transcript::{self, PreviousSessionInfo},
};
use crate::local::get_local_terminal_manager;
use crate::models::EnvironmentType;
use crate::pty::get_terminal_manager;
use crate::storage::get_storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::{debug, info, warn};

fn resolve_backend(environment_id: &str) -> Result<Backend, String> {
    let storage = get_storage().map_err(|e| e.to_string())?;
    let env = storage
        .get_environment(environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("environment {} not found", environment_id))?;

    match env.environment_type {
        EnvironmentType::Local => {
            let cwd = env
                .worktree_path
                .clone()
                .ok_or_else(|| "local environment has no worktree path".to_string())?;
            Ok(Backend::Local { cwd })
        }
        EnvironmentType::Containerized => {
            let container_id = env
                .container_id
                .clone()
                .ok_or_else(|| "container environment has no container id".to_string())?;
            Ok(Backend::Container { container_id })
        }
    }
}

/// Resolve the (workspace, claude_home) pair the way `TmuxSession::build`
/// does, so list/resume can find transcripts before any session exists.
fn workspace_and_claude_home(backend: &Backend) -> (String, String) {
    let workspace = match backend {
        Backend::Local { cwd } => cwd.clone(),
        Backend::Container { .. } => "/workspace".to_string(),
    };
    let claude_home = match backend {
        Backend::Local { .. } => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
            format!("{}/.claude", home)
        }
        Backend::Container { .. } => "/home/node/.claude".to_string(),
    };
    (workspace, claude_home)
}

async fn get_or_create(
    app: &AppHandle,
    environment_id: &str,
    tab_id: &str,
    resume_session_id: Option<String>,
) -> Result<Arc<TmuxSession>, String> {
    let mgr = get_manager();
    if let Some(s) = mgr.get_for_env(environment_id, tab_id).await {
        return Ok(s);
    }
    let backend = resolve_backend(environment_id)?;
    let claude_command = resolve_pinned_claude_command(app, &backend);
    let session = Arc::new(TmuxSession::build(
        environment_id.to_string(),
        tab_id.to_string(),
        backend,
        resume_session_id,
        claude_command,
    ));
    mgr.insert(environment_id, tab_id.to_string(), session.clone())
        .await;
    Ok(session)
}

/// Pick a pinned `claude` binary for the session.
///
/// - **Container**: returns `None` and lets the session probe via `which claude`
///   inside the container, which resolves to the npm-global install path that
///   the Dockerfile puts on `$PATH`. This keeps the path as a single source of
///   truth (the Dockerfile).
/// - **Local**: returns the bundled binary path if the app resource directory
///   contains `bin/claude`; otherwise `None` (falls back to host `claude`).
fn resolve_pinned_claude_command(app: &AppHandle, backend: &Backend) -> Option<String> {
    match backend {
        Backend::Container { .. } => None,
        Backend::Local { .. } => resolve_bundled_claude_path(app),
    }
}

fn resolve_bundled_claude_path(app: &AppHandle) -> Option<String> {
    let candidates = bundled_resource_dir_candidates(app);
    find_bundled_binary(&candidates, "claude").map(|p| p.to_string_lossy().into_owned())
}

/// Build the list of "bin/" directories to search for a bundled CLI, in order
/// of preference. Includes the dev fallback (`<repo>/binaries/`) only in debug
/// builds. Exposed at module scope so a sibling can build the same list.
pub(crate) fn bundled_resource_dir_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(bundled) = app
        .path()
        .resolve("bin", tauri::path::BaseDirectory::Resource)
    {
        out.push(bundled);
    }
    if let Ok(res_dir) = app.path().resource_dir() {
        out.push(res_dir.join("bin"));
    }
    #[cfg(debug_assertions)]
    {
        let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(workspace_root) = manifest_path.parent() {
            out.push(workspace_root.join("binaries"));
        }
    }
    out
}

/// Pure helper: given a list of candidate directories, return the full path
/// to `<dir>/<binary_name>` for the first dir where that file exists.
pub(crate) fn find_bundled_binary(candidates: &[PathBuf], binary_name: &str) -> Option<PathBuf> {
    for dir in candidates {
        let full = dir.join(binary_name);
        if full.exists() {
            return Some(full);
        }
    }
    None
}

/// Pure helper: pick the first directory in `candidates` that contains `marker`,
/// returning that directory (not the marker file). Used by callers that need
/// to set `PATH=<dir>:...` rather than a specific binary path.
pub(crate) fn find_bundled_dir_containing(candidates: &[PathBuf], marker: &str) -> Option<PathBuf> {
    find_bundled_binary(candidates, marker).and_then(|p| p.parent().map(Path::to_path_buf))
}

// Tauri commands take flat named IPC arguments, so launch options can't be
// grouped into a struct without changing the frontend invoke payload.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn claude_tmux_start(
    app: AppHandle,
    tab_id: String,
    environment_id: String,
    initial_prompt: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    plan_mode: Option<bool>,
    resume_session_id: Option<String>,
) -> Result<TmuxSessionStatus, String> {
    info!(
        env = %environment_id,
        tab = %tab_id,
        resume = ?resume_session_id,
        "claude_tmux_start"
    );

    let mgr = get_manager();
    let install_lock = mgr.install_lock(&environment_id).await;
    let _guard = install_lock.lock().await;

    // "Start fresh" semantics: when no resume id was supplied, the caller is
    // asking for a brand-new conversation. Drop any in-memory session for
    // this tab and force-kill the per-tab tmux session before launching, so
    // a stale tmux server (e.g. from a prior app run) can't leave claude
    // running with the previous model/plan flags. The tmux name is derived
    // strictly from (env_id, tab_id), so it never matches another tab/project.
    if resume_session_id.is_none() {
        if let Some(existing) = mgr.remove_for_env(&environment_id, &tab_id).await {
            if let Err(e) = existing.stop().await {
                tracing::warn!(tab = %tab_id, error = %e, "stop of prior tmux session failed");
            }
        } else {
            match resolve_backend(&environment_id) {
                Ok(backend) => {
                    let name = tmux_session_name(&environment_id, &tab_id);
                    let _ = backend.exec(&["tmux", "kill-session", "-t", &name]).await;
                }
                Err(e) => {
                    tracing::debug!(
                        environment_id = %environment_id,
                        tab = %tab_id,
                        error = %e,
                        "skipping orphan tmux kill: backend unresolved"
                    );
                }
            }
        }
    }

    let session = get_or_create(&app, &environment_id, &tab_id, resume_session_id).await?;
    hooks::install_workspace_hooks(&session.backend, &session.workspace_hook_paths).await?;
    session
        .clone()
        .start_after_hooks_installed(app, initial_prompt, model, effort, plan_mode.unwrap_or(false))
        .await?;
    let alive = session.tmux_alive().await.unwrap_or(false);
    Ok(session.status(alive))
}

#[tauri::command]
pub async fn claude_tmux_stop(
    tab_id: String,
    environment_id: String,
) -> Result<(), String> {
    info!(tab = %tab_id, "claude_tmux_stop");
    let mgr = get_manager();
    let session = match mgr.remove_for_env(&environment_id, &tab_id).await {
        Some(s) => s,
        None => return Ok(()),
    };
    let env_id = session.environment_id.clone();
    let backend = session.backend.clone();
    let workspace_hook_paths = session.workspace_hook_paths.clone();

    session.stop().await?;

    // If this was the last tab in the workspace, also tear down the
    // workspace-level hook artifacts so we restore the user's original
    // `.claude/settings.local.json`. Hold the per-env install lock so a
    // concurrent `start` in the same workspace can't race against
    // uninstall (would otherwise observe a half-removed state).
    let install_lock = mgr.install_lock(&env_id).await;
    let _guard = install_lock.lock().await;
    if mgr.sessions_in_env(&env_id).await == 0 {
        if let Err(e) = hooks::uninstall_workspace_hooks(&backend, &workspace_hook_paths).await {
            tracing::warn!(env = %env_id, error = %e, "uninstall_workspace_hooks failed");
        }
    }

    Ok(())
}

fn workspace_hook_paths_for_backend(
    environment_id: &str,
    backend: &Backend,
) -> hooks::WorkspaceHookPaths {
    let (workspace, _) = workspace_and_claude_home(backend);
    hooks::WorkspaceHookPaths::new(
        &format!("/tmp/orkestrator-claude-tmux/{}", environment_id),
        &workspace,
    )
}

fn spawn_interactive_output_forwarder<R: Runtime>(
    app: AppHandle<R>,
    terminal_session_id: String,
    mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            if let Err(e) = app.emit(&format!("terminal-output-{}", terminal_session_id), data) {
                warn!(
                    session_id = %terminal_session_id,
                    error = ?e,
                    "failed to emit tmux interactive terminal output"
                );
            }
        }
        debug!(session_id = %terminal_session_id, "tmux interactive output forwarder ended");
    });
}

async fn kill_tmux_sessions_for_env(backend: &Backend, environment_id: &str) {
    let tmux = resolve_tmux_command(backend).await;
    let prefix = format!("orkestrator-{}-", short_id(environment_id));
    let out = match backend
        .exec(&[tmux.as_str(), "list-sessions", "-F", "#{session_name}"])
        .await
    {
        Ok(out) => out,
        Err(e) => {
            tracing::debug!(
                env = %environment_id,
                error = %e,
                "tmux list-sessions failed; nothing to clean"
            );
            return;
        }
    };

    for name in out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.starts_with(&prefix))
    {
        if let Err(e) = backend
            .exec(&[tmux.as_str(), "kill-session", "-t", name])
            .await
        {
            tracing::warn!(
                env = %environment_id,
                tmux_session = %name,
                error = %e,
                "failed to kill orphan Claude tmux session"
            );
        }
    }
}

async fn resolve_tmux_command(backend: &Backend) -> String {
    match backend.exec(&["which", "tmux"]).await {
        Ok(out) if out.success() => out
            .stdout
            .lines()
            .next()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .unwrap_or("tmux")
            .to_string(),
        _ => "tmux".to_string(),
    }
}

pub async fn stop_tmux_sessions_for_environment(environment_id: &str) {
    let mgr = get_manager();
    let install_lock = mgr.install_lock(environment_id).await;
    let _guard = install_lock.lock().await;

    let sessions = mgr.remove_by_env(environment_id).await;
    let mut backend_and_hooks: Option<(Backend, hooks::WorkspaceHookPaths)> = None;

    for session in sessions {
        if backend_and_hooks.is_none() {
            backend_and_hooks = Some((
                session.backend.clone(),
                session.workspace_hook_paths.clone(),
            ));
        }
        if let Err(e) = session.stop().await {
            tracing::warn!(
                env = %environment_id,
                tab = %session.tab_id,
                error = %e,
                "failed to stop tracked Claude tmux session"
            );
        }
    }

    if backend_and_hooks.is_none() {
        if let Ok(backend) = resolve_backend(environment_id) {
            let paths = workspace_hook_paths_for_backend(environment_id, &backend);
            backend_and_hooks = Some((backend, paths));
        }
    }

    if let Some((backend, workspace_hook_paths)) = backend_and_hooks {
        kill_tmux_sessions_for_env(&backend, environment_id).await;
        if mgr.sessions_in_env(environment_id).await == 0 {
            if let Err(e) = hooks::uninstall_workspace_hooks(&backend, &workspace_hook_paths).await
            {
                tracing::warn!(env = %environment_id, error = %e, "uninstall_workspace_hooks failed");
            }
        }
    }
}

pub async fn shutdown_all_tmux_sessions() {
    let mgr = get_manager();
    let sessions = mgr.drain().await;
    let mut envs: HashMap<String, (Backend, hooks::WorkspaceHookPaths)> = HashMap::new();

    for session in sessions {
        envs.entry(session.environment_id.clone())
            .or_insert_with(|| {
                (
                    session.backend.clone(),
                    session.workspace_hook_paths.clone(),
                )
            });
        if let Err(e) = session.stop().await {
            tracing::warn!(
                env = %session.environment_id,
                tab = %session.tab_id,
                error = %e,
                "failed to stop Claude tmux session during shutdown"
            );
        }
    }

    for (environment_id, (backend, workspace_hook_paths)) in envs {
        kill_tmux_sessions_for_env(&backend, &environment_id).await;
        if let Err(e) = hooks::uninstall_workspace_hooks(&backend, &workspace_hook_paths).await {
            tracing::warn!(env = %environment_id, error = %e, "uninstall_workspace_hooks failed during shutdown");
        }
    }
}

#[tauri::command]
pub async fn claude_tmux_interrupt(
    tab_id: String,
    environment_id: String,
) -> Result<(), String> {
    info!(tab = %tab_id, "claude_tmux_interrupt");
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.interrupt().await
}

#[tauri::command]
pub async fn claude_tmux_status(
    tab_id: String,
    environment_id: String,
) -> Result<Option<TmuxSessionStatus>, String> {
    Ok(get_manager().status_for_env(&environment_id, &tab_id).await)
}

#[tauri::command]
pub async fn claude_tmux_transcript(
    tab_id: String,
    environment_id: String,
) -> Result<Vec<Value>, String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.transcript_lines().await
}

#[tauri::command]
pub async fn claude_tmux_pending_hooks(
    tab_id: String,
    environment_id: String,
) -> Result<Vec<hooks::PendingHookEvent>, String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.pending_hooks().await
}

#[tauri::command]
pub async fn claude_tmux_create_interactive_terminal(
    tab_id: String,
    environment_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;

    if !session.tmux_alive().await? {
        return Err("tmux session not running".to_string());
    }

    let command = vec![
        "tmux".to_string(),
        "attach-session".to_string(),
        "-t".to_string(),
        session.tmux_session.clone(),
    ];

    match &session.backend {
        Backend::Local { cwd } => {
            let manager = get_local_terminal_manager()
                .ok_or_else(|| "Local terminal manager not initialized".to_string())?;
            manager
                .create_session_with_command(
                    &session.environment_id,
                    cwd,
                    cols,
                    rows,
                    None,
                    Some(command),
                )
                .await
                .map_err(|e| e.to_string())
        }
        Backend::Container { container_id } => {
            let manager = get_terminal_manager()
                .ok_or_else(|| "Terminal manager not initialized".to_string())?;
            manager
                .create_session_with_command(container_id, cols, rows, Some("node"), command)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub async fn claude_tmux_start_interactive_terminal<R: Runtime>(
    app: AppHandle<R>,
    terminal_session_id: String,
) -> Result<(), String> {
    if let Some(manager) = get_local_terminal_manager() {
        if manager.get_session(&terminal_session_id).is_some() {
            let output_rx = manager
                .start_session(&terminal_session_id)
                .await
                .map_err(|e| e.to_string())?;
            spawn_interactive_output_forwarder(app, terminal_session_id, output_rx);
            return Ok(());
        }
    }

    let manager =
        get_terminal_manager().ok_or_else(|| "Terminal manager not initialized".to_string())?;
    if manager.get_session(&terminal_session_id).is_some() {
        let output_rx = manager
            .start_session(&terminal_session_id)
            .await
            .map_err(|e| e.to_string())?;
        spawn_interactive_output_forwarder(app, terminal_session_id, output_rx);
        return Ok(());
    }

    Err("tmux interactive terminal session not found".to_string())
}

#[tauri::command]
pub async fn claude_tmux_write_interactive_terminal(
    terminal_session_id: String,
    data: String,
) -> Result<(), String> {
    if let Some(manager) = get_local_terminal_manager() {
        if manager.get_session(&terminal_session_id).is_some() {
            return manager
                .write_to_session(&terminal_session_id, data.into_bytes())
                .await
                .map_err(|e| e.to_string());
        }
    }

    let manager =
        get_terminal_manager().ok_or_else(|| "Terminal manager not initialized".to_string())?;
    if manager.get_session(&terminal_session_id).is_some() {
        return manager
            .write_to_session(&terminal_session_id, data.into_bytes())
            .await
            .map_err(|e| e.to_string());
    }

    Err("tmux interactive terminal session not found".to_string())
}

#[tauri::command]
pub async fn claude_tmux_resize_interactive_terminal(
    terminal_session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(manager) = get_local_terminal_manager() {
        if manager.get_session(&terminal_session_id).is_some() {
            return manager
                .resize_session(&terminal_session_id, cols, rows)
                .map_err(|e| e.to_string());
        }
    }

    let manager =
        get_terminal_manager().ok_or_else(|| "Terminal manager not initialized".to_string())?;
    if manager.get_session(&terminal_session_id).is_some() {
        return manager
            .resize_session(&terminal_session_id, cols, rows)
            .await
            .map_err(|e| e.to_string());
    }

    Err("tmux interactive terminal session not found".to_string())
}

#[tauri::command]
pub async fn claude_tmux_detach_interactive_terminal(
    terminal_session_id: String,
) -> Result<(), String> {
    const TMUX_DETACH_CLIENT: &[u8] = b"\x02d";

    if let Some(manager) = get_local_terminal_manager() {
        if manager.get_session(&terminal_session_id).is_some() {
            let _ = manager
                .write_to_session(&terminal_session_id, TMUX_DETACH_CLIENT.to_vec())
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            return manager
                .close_session(&terminal_session_id)
                .map_err(|e| e.to_string());
        }
    }

    let manager =
        get_terminal_manager().ok_or_else(|| "Terminal manager not initialized".to_string())?;
    if manager.get_session(&terminal_session_id).is_some() {
        let _ = manager
            .write_to_session(&terminal_session_id, TMUX_DETACH_CLIENT.to_vec())
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        return manager
            .close_session(&terminal_session_id)
            .map_err(|e| e.to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn claude_tmux_send_text(
    tab_id: String,
    text: String,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.send_text(&text).await
}

#[tauri::command]
pub async fn claude_tmux_send_keys(
    tab_id: String,
    keys: Vec<String>,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
    session.send_keys(&refs).await
}

#[tauri::command]
pub async fn claude_tmux_submit(
    tab_id: String,
    text: String,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.submit(&text).await
}

#[tauri::command]
pub async fn claude_tmux_switch_model(
    tab_id: String,
    model: String,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.switch_model(&model).await
}

#[tauri::command]
pub async fn claude_tmux_switch_effort(
    tab_id: String,
    effort: String,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.switch_effort(&effort).await
}

#[tauri::command]
pub async fn claude_tmux_capture_pane(
    tab_id: String,
    environment_id: String,
) -> Result<String, String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.capture_pane().await
}

#[tauri::command]
pub async fn claude_tmux_resize(
    tab_id: String,
    cols: u16,
    rows: u16,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.resize(cols, rows).await
}

#[tauri::command]
pub async fn claude_tmux_answer_pre_tool_use(
    tab_id: String,
    event_id: String,
    decision: String,
    reason: Option<String>,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session
        .answer_pre_tool_use(&event_id, &decision, reason)
        .await
}

#[tauri::command]
pub async fn claude_tmux_reply_hook(
    tab_id: String,
    event_kind: String,
    event_id: String,
    response: Value,
    environment_id: String,
) -> Result<(), String> {
    let session = get_manager()
        .get_for_env(&environment_id, &tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session
        .reply_to_hook(&event_kind, &event_id, response)
        .await
}

/// Wire-friendly version of `PreviousSessionInfo` — Tauri commands cannot
/// directly return types not annotated with `serde::Serialize`. We mirror the
/// fields exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeTmuxPreviousSession {
    pub session_id: String,
    pub title: Option<String>,
    pub last_activity_unix: u64,
    pub message_count: u32,
    pub transcript_path: String,
}

impl From<PreviousSessionInfo> for ClaudeTmuxPreviousSession {
    fn from(p: PreviousSessionInfo) -> Self {
        Self {
            session_id: p.session_id,
            title: p.title,
            last_activity_unix: p.last_activity_unix,
            message_count: p.message_count,
            transcript_path: p.transcript_path,
        }
    }
}

/// List previous Claude Code sessions recorded for this workspace. Used by
/// the "Resume previous session" UI in a brand new tab.
#[tauri::command]
pub async fn claude_tmux_list_previous_sessions(
    environment_id: String,
) -> Result<Vec<ClaudeTmuxPreviousSession>, String> {
    let backend = resolve_backend(&environment_id)?;
    let (workspace, claude_home) = workspace_and_claude_home(&backend);
    let list = transcript::list_previous_sessions(&backend, &claude_home, &workspace).await?;
    Ok(list.into_iter().map(Into::into).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs as std_fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;
    use tokio::fs;
    use uuid::Uuid;

    struct PathGuard {
        original_path: Option<OsString>,
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            match self.original_path.take() {
                Some(path) => std::env::set_var("PATH", path),
                None => std::env::remove_var("PATH"),
            }
        }
    }

    fn prepend_to_path(dir: &Path) -> PathGuard {
        let original_path = std::env::var_os("PATH");
        let path = match original_path.as_ref() {
            Some(existing) => {
                let mut paths = vec![dir.to_path_buf()];
                paths.extend(std::env::split_paths(existing));
                std::env::join_paths(paths).unwrap()
            }
            None => dir.as_os_str().to_os_string(),
        };
        std::env::set_var("PATH", path);
        PathGuard { original_path }
    }

    fn install_fake_tmux(dir: &Path, log_path: &Path) -> PathBuf {
        let script = dir.join("tmux");
        std_fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = \"load-buffer\" ]; then printf 'stdin:' >> '{}'; cat >> '{}'; printf '\\n' >> '{}'; fi\nexit 0\n",
                log_path.display(),
                log_path.display(),
                log_path.display(),
                log_path.display(),
            ),
        )
        .unwrap();
        let mut perms = std_fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std_fs::set_permissions(&script, perms).unwrap();
        script
    }

    async fn with_fake_tmux<F, Fut>(tmp: &TempDir, f: F)
    where
        F: FnOnce(PathBuf, String) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let _guard = crate::claude_tmux::TEST_PATH_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let bin_dir = tmp.path().join("bin");
        std_fs::create_dir_all(&bin_dir).unwrap();
        let log_path = tmp.path().join("tmux.log");
        let tmux_path = install_fake_tmux(&bin_dir, &log_path);

        let _path_guard = prepend_to_path(&bin_dir);
        f(log_path, tmux_path.to_string_lossy().into_owned()).await;
    }

    #[test]
    fn find_bundled_binary_returns_first_existing_path() {
        let tmp = TempDir::new().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std_fs::create_dir_all(&dir_a).unwrap();
        std_fs::create_dir_all(&dir_b).unwrap();
        // Only the second candidate contains the binary.
        std_fs::write(dir_b.join("claude"), b"#!/bin/sh\n").unwrap();

        let candidates = vec![dir_a.clone(), dir_b.clone()];
        let found = find_bundled_binary(&candidates, "claude").expect("should find binary");
        assert_eq!(found, dir_b.join("claude"));
    }

    #[test]
    fn find_bundled_binary_prefers_earlier_candidates() {
        let tmp = TempDir::new().unwrap();
        let dir_a = tmp.path().join("a");
        let dir_b = tmp.path().join("b");
        std_fs::create_dir_all(&dir_a).unwrap();
        std_fs::create_dir_all(&dir_b).unwrap();
        std_fs::write(dir_a.join("claude"), b"#!/bin/sh\n").unwrap();
        std_fs::write(dir_b.join("claude"), b"#!/bin/sh\n").unwrap();

        let candidates = vec![dir_a.clone(), dir_b.clone()];
        let found = find_bundled_binary(&candidates, "claude").unwrap();
        assert_eq!(found, dir_a.join("claude"));
    }

    #[test]
    fn find_bundled_binary_returns_none_when_missing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        assert!(find_bundled_binary(&[dir], "claude").is_none());
    }

    #[test]
    fn find_bundled_dir_containing_returns_parent_dir() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().join("bin");
        std_fs::create_dir_all(&bin_dir).unwrap();
        std_fs::write(bin_dir.join("claude"), b"#!/bin/sh\n").unwrap();

        let parent = find_bundled_dir_containing(&[bin_dir.clone()], "claude").unwrap();
        assert_eq!(parent, bin_dir);
    }

    #[test]
    fn find_bundled_dir_containing_returns_none_when_missing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        assert!(find_bundled_dir_containing(&[dir], "claude").is_none());
    }

    #[tokio::test]
    async fn stop_command_is_no_op_for_missing_session() {
        let tab_id = format!("missing-{}", Uuid::new_v4());
        // Should return Ok(()) rather than an error when the session is absent.
        claude_tmux_stop(tab_id, "env-missing".to_string())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pending_hooks_command_returns_missing_session_error() {
        let tab_id = format!("missing-{}", Uuid::new_v4());
        let err = claude_tmux_pending_hooks(tab_id, "env-missing".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, "tmux session not running");
    }

    #[tokio::test]
    async fn interrupt_command_returns_missing_session_error() {
        let tab_id = format!("missing-{}", Uuid::new_v4());
        let err = claude_tmux_interrupt(tab_id, "env-missing".to_string())
            .await
            .unwrap_err();
        assert_eq!(err, "tmux session not running");
    }

    #[tokio::test]
    async fn switch_model_command_returns_missing_session_error() {
        let tab_id = format!("missing-{}", Uuid::new_v4());
        let err = claude_tmux_switch_model(
            tab_id,
            "claude-opus-4-7".to_string(),
            "env-missing".to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "tmux session not running");
    }

    #[tokio::test]
    async fn switch_effort_command_returns_missing_session_error() {
        let tab_id = format!("missing-{}", Uuid::new_v4());
        let err = claude_tmux_switch_effort(
            tab_id,
            "high".to_string(),
            "env-missing".to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "tmux session not running");
    }

    #[tokio::test]
    async fn interactive_terminal_commands_handle_missing_sessions() {
        crate::local::init_local_terminal_manager();
        crate::pty::init_terminal_manager();

        let tab_id = format!("missing-{}", Uuid::new_v4());
        let err = claude_tmux_create_interactive_terminal(tab_id, "env-missing".to_string(), 120, 30)
            .await
            .unwrap_err();
        assert_eq!(err, "tmux session not running");

        let terminal_session_id = format!("pty-{}", Uuid::new_v4());
        let err = claude_tmux_write_interactive_terminal(
            terminal_session_id.clone(),
            "input".to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "tmux interactive terminal session not found");

        let err = claude_tmux_resize_interactive_terminal(terminal_session_id.clone(), 100, 25)
            .await
            .unwrap_err();
        assert_eq!(err, "tmux interactive terminal session not found");

        claude_tmux_detach_interactive_terminal(terminal_session_id)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn interrupt_command_sends_escape_to_existing_session() {
        let tmp = TempDir::new().unwrap();
        let tab_id = format!("tab-{}", Uuid::new_v4());
        let environment_id = format!("env-command-test-{}", Uuid::new_v4());
        let cwd = tmp.path().to_string_lossy().into_owned();
        let command_tab_id = tab_id.clone();

        with_fake_tmux(&tmp, |log_path, tmux_path| async move {
            let mut session = TmuxSession::build(
                environment_id.clone(),
                tab_id.clone(),
                Backend::Local { cwd },
                None,
                None,
            );
            session.tmux_command = tmux_path;
            let session = Arc::new(session);
            let tmux_session = session.tmux_session.clone();
            get_manager()
                .insert(&environment_id, tab_id.clone(), session)
                .await;

            claude_tmux_interrupt(command_tab_id, environment_id.clone())
                .await
                .unwrap();
            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains(&format!("send-keys -t {} -- Escape", tmux_session)));

            get_manager().remove_for_env(&environment_id, &tab_id).await;
        })
        .await;
    }

    #[tokio::test]
    async fn switch_model_command_dispatches_to_existing_session() {
        let tmp = TempDir::new().unwrap();
        let tab_id = format!("tab-{}", Uuid::new_v4());
        let environment_id = format!("env-command-test-{}", Uuid::new_v4());
        let cwd = tmp.path().to_string_lossy().into_owned();
        let command_tab_id = tab_id.clone();

        with_fake_tmux(&tmp, |log_path, tmux_path| async move {
            let mut session = TmuxSession::build(
                environment_id.clone(),
                tab_id.clone(),
                Backend::Local { cwd },
                None,
                None,
            );
            session.tmux_command = tmux_path;
            let session = Arc::new(session);
            let tmux_session = session.tmux_session.clone();
            get_manager()
                .insert(&environment_id, tab_id.clone(), session)
                .await;

            claude_tmux_switch_model(
                command_tab_id,
                "claude-opus-4-7".to_string(),
                environment_id.clone(),
            )
            .await
            .unwrap();
            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains("stdin:/model claude-opus-4-7"));
            assert!(log.contains(&format!("send-keys -t {} -- Enter", tmux_session)));

            get_manager().remove_for_env(&environment_id, &tab_id).await;
        })
        .await;
    }

    #[tokio::test]
    async fn switch_effort_command_dispatches_to_existing_session() {
        let tmp = TempDir::new().unwrap();
        let tab_id = format!("tab-{}", Uuid::new_v4());
        let environment_id = format!("env-command-test-{}", Uuid::new_v4());
        let cwd = tmp.path().to_string_lossy().into_owned();
        let command_tab_id = tab_id.clone();

        with_fake_tmux(&tmp, |log_path, tmux_path| async move {
            let mut session = TmuxSession::build(
                environment_id.clone(),
                tab_id.clone(),
                Backend::Local { cwd },
                None,
                None,
            );
            session.tmux_command = tmux_path;
            let session = Arc::new(session);
            let tmux_session = session.tmux_session.clone();
            get_manager()
                .insert(&environment_id, tab_id.clone(), session)
                .await;

            claude_tmux_switch_effort(
                command_tab_id,
                "xhigh".to_string(),
                environment_id.clone(),
            )
            .await
            .unwrap();
            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains("stdin:/effort xhigh"));
            assert!(log.contains(&format!("send-keys -t {} -- Enter", tmux_session)));

            get_manager().remove_for_env(&environment_id, &tab_id).await;
        })
        .await;
    }

    #[tokio::test]
    async fn pending_hooks_command_returns_session_snapshot() {
        let tmp = TempDir::new().unwrap();
        let tab_id = format!("tab-{}", Uuid::new_v4());
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };
        let environment_id = format!("env-command-test-{}", Uuid::new_v4());
        let session = Arc::new(TmuxSession::build(
            environment_id.clone(),
            tab_id.clone(),
            backend.clone(),
            None,
            None,
        ));
        hooks::ensure_session_dirs(&backend, &session.session_hook_paths)
            .await
            .unwrap();
        let pending = format!(
            "{}/PreToolUse-id-1.json",
            session.session_hook_paths.pending_dir
        );
        fs::write(&pending, "{\"tool_name\":\"ExitPlanMode\"}")
            .await
            .unwrap();

        get_manager()
            .insert(&environment_id, tab_id.clone(), session)
            .await;
        let hooks = claude_tmux_pending_hooks(tab_id.clone(), environment_id.clone())
            .await
            .unwrap();
        get_manager().remove_for_env(&environment_id, &tab_id).await;

        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].id, "id-1");
        assert_eq!(hooks[0].kind, "PreToolUse");
    }

    // NOTE: `shutdown_all_tmux_sessions` is exercised by the components it
    // composes — `TmuxSessionManager::drain` (covered in
    // `claude_tmux::manager::tests`), `kill_tmux_sessions_for_env` (test
    // below), and `hooks::uninstall_workspace_hooks` (covered in
    // `claude_tmux::hooks::tests`). A direct test would call `drain` on the
    // shared global manager and race with other tmux tests inserting into
    // it, so we avoid it here.

    #[tokio::test]
    async fn kill_tmux_sessions_for_env_targets_only_matching_prefix() {
        let tmp = TempDir::new().unwrap();
        let backend = Backend::Local {
            cwd: tmp.path().to_string_lossy().into_owned(),
        };

        let env_a = format!("env-prefix-a-{}", Uuid::new_v4());
        let env_b = format!("env-prefix-b-{}", Uuid::new_v4());
        let session_a = tmux_session_name(&env_a, "tab-a");
        let session_b = tmux_session_name(&env_b, "tab-b");

        // Install a fake tmux that returns both session names from list-sessions
        // and logs subsequent calls.
        let _guard = crate::claude_tmux::TEST_PATH_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        let bin_dir = tmp.path().join("bin");
        std_fs::create_dir_all(&bin_dir).unwrap();
        let log_path = tmp.path().join("tmux.log");
        let script = bin_dir.join("tmux");
        std_fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\nif [ \"$1\" = \"list-sessions\" ]; then\n  printf '%s\\n' '{a}' '{b}'\nfi\nexit 0\n",
                log = log_path.display(),
                a = session_a,
                b = session_b,
            ),
        )
        .unwrap();
        let mut perms = std_fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std_fs::set_permissions(&script, perms).unwrap();

        let _path_guard = prepend_to_path(&bin_dir);

        kill_tmux_sessions_for_env(&backend, &env_a).await;

        let log = fs::read_to_string(&log_path).await.unwrap();
        assert!(
            log.contains(&format!("kill-session -t {}", session_a)),
            "expected kill of env_a session, got log:\n{}",
            log,
        );
        assert!(
            !log.contains(&format!("kill-session -t {}", session_b)),
            "env_b session was killed by env_a cleanup, log:\n{}",
            log,
        );
    }

    #[tokio::test]
    async fn stop_tmux_sessions_for_environment_stops_tracked_sessions() {
        let tmp = TempDir::new().unwrap();
        let environment_id = format!("env-command-test-{}", Uuid::new_v4());
        let tab_id = format!("tab-{}", Uuid::new_v4());
        let cwd = tmp.path().to_string_lossy().into_owned();

        with_fake_tmux(&tmp, |log_path, tmux_path| async move {
            let mut session = TmuxSession::build(
                environment_id.clone(),
                tab_id.clone(),
                Backend::Local { cwd },
                None,
                None,
            );
            session.tmux_command = tmux_path;
            let session = Arc::new(session);
            let tmux_session = session.tmux_session.clone();
            get_manager()
                .insert(&environment_id, tab_id.clone(), session)
                .await;

            stop_tmux_sessions_for_environment(&environment_id).await;

            let log = fs::read_to_string(log_path).await.unwrap();
            assert!(log.contains(&format!("kill-session -t {}", tmux_session)));
            assert!(get_manager()
                .get_for_env(&environment_id, &tab_id)
                .await
                .is_none());
            assert_eq!(get_manager().sessions_in_env(&environment_id).await, 0);
        })
        .await;
    }
}
