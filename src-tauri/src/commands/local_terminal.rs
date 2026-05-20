//! Tauri commands for local terminal sessions
//!
//! These commands handle terminal sessions for local (worktree-based) environments,
//! spawning native shell processes instead of Docker exec.

use crate::commands::claude_tmux::{bundled_resource_dir_candidates, find_bundled_dir_containing};
use crate::local::get_local_terminal_manager;
use crate::storage::get_storage;
use tauri::{AppHandle, Emitter, Runtime};
use tracing::{debug, info, instrument, warn};

fn spawn_local_output_forwarder<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
) {
    let session_id_clone = session_id.clone();

    debug!(session_id = %session_id, "Starting local output forwarder task");

    // Spawn task to forward output to frontend via events
    tokio::spawn(async move {
        while let Some(data) = output_rx.recv().await {
            // Emit terminal output event (same format as container terminals)
            if let Err(e) = app.emit(&format!("terminal-output-{}", session_id_clone), data) {
                warn!(session_id = %session_id_clone, error = ?e, "Failed to emit terminal output event");
            }
        }
        debug!(session_id = %session_id_clone, "Local output forwarder task ended");
    });
}

/// Create a local terminal session for a local environment
#[tauri::command]
#[instrument(skip(app), fields(environment_id = %environment_id, cols, rows))]
pub async fn create_local_terminal_session(
    app: AppHandle,
    environment_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    debug!("Creating local terminal session");

    let manager = get_local_terminal_manager()
        .ok_or_else(|| "Local terminal manager not initialized".to_string())?;

    // Get the environment to find the worktree path
    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let worktree_path = environment
        .worktree_path
        .ok_or_else(|| "Environment has no worktree path".to_string())?;

    let session_id = manager
        .create_session(
            &environment_id,
            &worktree_path,
            cols,
            rows,
            resolve_bundled_bin_dir(&app),
        )
        .await
        .map_err(|e| e.to_string())?;

    info!(session_id = %session_id, environment_id = %environment_id, "Local terminal session created");
    Ok(session_id)
}

fn resolve_bundled_bin_dir(app_handle: &tauri::AppHandle) -> Option<String> {
    let candidates = bundled_resource_dir_candidates(app_handle);
    find_bundled_dir_containing(&candidates, "claude").map(|p| p.to_string_lossy().into_owned())
}

/// Start a local terminal session and begin forwarding output
#[tauri::command]
#[instrument(skip(app), fields(session_id = %session_id))]
pub async fn start_local_terminal_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<(), String> {
    debug!("Starting local terminal session");

    let manager = get_local_terminal_manager()
        .ok_or_else(|| "Local terminal manager not initialized".to_string())?;

    let output_rx = manager
        .start_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;

    spawn_local_output_forwarder(app, session_id, output_rx);

    Ok(())
}

/// Write data to a local terminal session
#[tauri::command]
#[instrument(fields(session_id = %session_id, data_len = data.len()))]
pub async fn local_terminal_write(session_id: String, data: String) -> Result<(), String> {
    let manager = get_local_terminal_manager()
        .ok_or_else(|| "Local terminal manager not initialized".to_string())?;

    manager
        .write_to_session(&session_id, data.into_bytes())
        .await
        .map_err(|e| e.to_string())
}

/// Resize a local terminal session
#[tauri::command]
#[instrument(fields(session_id = %session_id, cols, rows))]
pub fn local_terminal_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let manager = get_local_terminal_manager()
        .ok_or_else(|| "Local terminal manager not initialized".to_string())?;

    manager
        .resize_session(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

/// Close a local terminal session
#[tauri::command]
#[instrument(fields(session_id = %session_id))]
pub fn close_local_terminal_session(session_id: String) -> Result<(), String> {
    debug!("Closing local terminal session");

    let manager = get_local_terminal_manager()
        .ok_or_else(|| "Local terminal manager not initialized".to_string())?;

    manager
        .close_session(&session_id)
        .map_err(|e| e.to_string())
}
