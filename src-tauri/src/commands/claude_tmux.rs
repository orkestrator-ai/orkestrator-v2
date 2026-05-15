//! Tauri commands for Claude tmux mode. All commands are keyed by `tab_id`
//! (each tab is its own claude session); `environment_id` is only needed to
//! resolve the backend the first time a tab is started.

use crate::claude_tmux::{
    backend::Backend,
    get_manager,
    hooks,
    session::{tmux_session_name, TmuxSession, TmuxSessionStatus},
    transcript::{self, PreviousSessionInfo},
};
use crate::models::EnvironmentType;
use crate::storage::get_storage;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::AppHandle;
use tracing::info;

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
    environment_id: &str,
    tab_id: &str,
    resume_session_id: Option<String>,
) -> Result<Arc<TmuxSession>, String> {
    let mgr = get_manager();
    if let Some(s) = mgr.get(tab_id).await {
        return Ok(s);
    }
    let backend = resolve_backend(environment_id)?;
    let session = Arc::new(TmuxSession::build(
        environment_id.to_string(),
        tab_id.to_string(),
        backend,
        resume_session_id,
    ));
    mgr.insert(tab_id.to_string(), session.clone()).await;
    Ok(session)
}

#[tauri::command]
pub async fn claude_tmux_start(
    app: AppHandle,
    tab_id: String,
    environment_id: String,
    initial_prompt: Option<String>,
    model: Option<String>,
    plan_mode: Option<bool>,
    resume_session_id: Option<String>,
) -> Result<TmuxSessionStatus, String> {
    info!(
        env = %environment_id,
        tab = %tab_id,
        resume = ?resume_session_id,
        "claude_tmux_start"
    );

    // "Start fresh" semantics: when no resume id was supplied, the caller is
    // asking for a brand-new conversation. Drop any in-memory session for
    // this tab and force-kill the per-tab tmux session before launching, so
    // a stale tmux server (e.g. from a prior app run) can't leave claude
    // running with the previous model/plan flags. The tmux name is derived
    // strictly from (env_id, tab_id) — never matches another tab or project.
    if resume_session_id.is_none() {
        let mgr = get_manager();
        if let Some(existing) = mgr.remove(&tab_id).await {
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

    let session = get_or_create(&environment_id, &tab_id, resume_session_id).await?;
    session
        .clone()
        .start(app, initial_prompt, model, plan_mode.unwrap_or(false))
        .await?;
    let alive = session.tmux_alive().await.unwrap_or(false);
    Ok(session.status(alive))
}

#[tauri::command]
pub async fn claude_tmux_stop(tab_id: String) -> Result<(), String> {
    info!(tab = %tab_id, "claude_tmux_stop");
    let mgr = get_manager();
    let session = match mgr.remove(&tab_id).await {
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

#[tauri::command]
pub async fn claude_tmux_status(
    tab_id: String,
) -> Result<Option<TmuxSessionStatus>, String> {
    Ok(get_manager().status(&tab_id).await)
}

#[tauri::command]
pub async fn claude_tmux_send_text(tab_id: String, text: String) -> Result<(), String> {
    let session = get_manager()
        .get(&tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.send_text(&text).await
}

#[tauri::command]
pub async fn claude_tmux_send_keys(
    tab_id: String,
    keys: Vec<String>,
) -> Result<(), String> {
    let session = get_manager()
        .get(&tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
    session.send_keys(&refs).await
}

#[tauri::command]
pub async fn claude_tmux_submit(tab_id: String, text: String) -> Result<(), String> {
    let session = get_manager()
        .get(&tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    if !text.is_empty() {
        session.send_text(&text).await?;
    }
    session.send_enter().await
}

#[tauri::command]
pub async fn claude_tmux_capture_pane(tab_id: String) -> Result<String, String> {
    let session = get_manager()
        .get(&tab_id)
        .await
        .ok_or_else(|| "tmux session not running".to_string())?;
    session.capture_pane().await
}

#[tauri::command]
pub async fn claude_tmux_resize(
    tab_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_manager()
        .get(&tab_id)
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
) -> Result<(), String> {
    let session = get_manager()
        .get(&tab_id)
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
) -> Result<(), String> {
    let session = get_manager()
        .get(&tab_id)
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
