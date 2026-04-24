//! Tauri commands for local server management
//!
//! These commands manage OpenCode, Claude-bridge, and Codex-bridge servers
//! for local (non-Docker) environments.

use crate::local::ports::{allocate_ports, is_port_available};
use crate::local::process::{get_process_manager, is_process_alive, ProcessType};
use crate::local::{
    get_local_claude_status, get_local_codex_status, get_local_opencode_status,
    start_local_claude_bridge, start_local_codex_bridge, start_local_opencode_server,
    stop_local_claude_bridge, stop_local_codex_bridge, stop_local_opencode_server,
    LocalServerStartResult, LocalServerStatus,
};
use crate::storage::get_storage;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tauri::Manager;
use tracing::{debug, info, warn};

static OPENCODE_START_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn get_opencode_start_lock(environment_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = OPENCODE_START_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap();
    map.entry(environment_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

static CLAUDE_START_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn get_claude_start_lock(environment_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = CLAUDE_START_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap();
    map.entry(environment_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

static CODEX_START_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn get_codex_start_lock(environment_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = CODEX_START_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap();
    map.entry(environment_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

use super::load_codex_bridge_raw_event_logging;

/// Result type for local server start commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerResult {
    pub port: u16,
    pub pid: u32,
    pub was_running: bool,
}

impl From<LocalServerStartResult> for LocalServerResult {
    fn from(result: LocalServerStartResult) -> Self {
        Self {
            port: result.port,
            pid: result.pid,
            was_running: result.was_running,
        }
    }
}

/// Status type for local server commands
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatusResult {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

impl From<LocalServerStatus> for LocalServerStatusResult {
    fn from(status: LocalServerStatus) -> Self {
        Self {
            running: status.running,
            port: status.port,
            pid: status.pid,
        }
    }
}

/// Start the OpenCode server for a local environment
#[tauri::command]
pub async fn start_local_opencode_server_cmd(
    app_handle: tauri::AppHandle,
    environment_id: String,
) -> Result<LocalServerResult, String> {
    debug!(environment_id = %environment_id, "Starting local OpenCode server");

    // Serialize starts per environment to avoid races when React mounts/remounts
    // quickly and triggers overlapping start requests.
    let start_lock = get_opencode_start_lock(&environment_id);
    let _guard = start_lock.lock().await;

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Verify this is a local environment
    if environment.is_containerized() {
        return Err("Cannot start local server for containerized environment".to_string());
    }

    // Get the worktree path
    let worktree_path = environment
        .worktree_path
        .as_ref()
        .ok_or("Local environment missing worktree path")?;

    let manager = get_process_manager();

    // Get the allocated port
    let mut port = environment
        .local_opencode_port
        .ok_or("Local environment missing OpenCode port")?;

    // Check for stale PID from a previous app session and try to recover
    if let Some(pid) = environment.opencode_pid {
        if is_process_alive(pid) {
            let stored_status =
                get_local_opencode_status(&environment_id, Some(port), Some(pid)).await;
            if stored_status.running {
                manager
                    .recover_from_pid(&environment_id, ProcessType::OpenCode, pid)
                    .await;
                debug!(
                    environment_id = %environment_id,
                    port = port,
                    pid = pid,
                    "Reusing existing healthy OpenCode server"
                );
                return Ok(LocalServerResult {
                    port,
                    pid,
                    was_running: true,
                });
            }

            warn!(
                environment_id = %environment_id,
                pid = pid,
                port = port,
                "Stored OpenCode PID is alive but invalid for this environment; clearing stale PID"
            );
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "opencodePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        } else {
            debug!(
                environment_id = %environment_id,
                pid = pid,
                "Stored OpenCode PID is no longer alive; clearing"
            );
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "opencodePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    // Check if port is already in use (e.g., stale process from previous app session)
    if !is_port_available(port) {
        warn!(
            environment_id = %environment_id,
            port = port,
            "OpenCode port already in use; attempting to recover"
        );

        // If we are currently tracking an OpenCode process, stop it
        if manager
            .is_running(&environment_id, ProcessType::OpenCode)
            .await
        {
            if let Err(err) = manager.kill(&environment_id, ProcessType::OpenCode).await {
                warn!(
                    environment_id = %environment_id,
                    port = port,
                    error = %err,
                    "Failed to kill existing OpenCode process"
                );
            }
        }

        if !is_port_available(port) {
            let all_envs = storage.get_all_environments().map_err(|e| e.to_string())?;
            let allocation = allocate_ports(&all_envs)?;
            let new_port = allocation.opencode_port;
            warn!(
                environment_id = %environment_id,
                old_port = port,
                new_port = new_port,
                "Reassigning OpenCode port"
            );
            port = new_port;
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "localOpencodePort": new_port,
                        "opencodePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    // Get the path to the bundled opencode binary (for packaged apps)
    let bundled_opencode_path = resolve_bundled_opencode_path(&app_handle);
    if let Some(ref opencode_path) = bundled_opencode_path {
        debug!(environment_id = %environment_id, opencode_path = %opencode_path, "Resolved bundled opencode path");
    }

    // Start the server
    let result = start_local_opencode_server(
        &environment_id,
        worktree_path,
        port,
        bundled_opencode_path.as_deref(),
    )
    .await?;

    // Persist any changed runtime metadata (PID and possibly reassigned port)
    if environment.opencode_pid != Some(result.pid)
        || environment.local_opencode_port != Some(result.port)
    {
        storage
            .update_environment(
                &environment_id,
                json!({
                    "opencodePid": result.pid,
                    "localOpencodePort": result.port
                }),
            )
            .map_err(|e| format!("Failed to update environment: {}", e))?;
    }

    info!(
        environment_id = %environment_id,
        port = result.port,
        pid = result.pid,
        "Local OpenCode server started"
    );

    Ok(result.into())
}

/// Stop the OpenCode server for a local environment
#[tauri::command]
pub async fn stop_local_opencode_server_cmd(environment_id: String) -> Result<(), String> {
    debug!(environment_id = %environment_id, "Stopping local OpenCode server");

    stop_local_opencode_server(&environment_id).await?;

    // Clear the PID in storage
    let storage = get_storage().map_err(|e| e.to_string())?;
    storage
        .update_environment(
            &environment_id,
            json!({
                "opencodePid": null
            }),
        )
        .map_err(|e| format!("Failed to update environment: {}", e))?;

    info!(environment_id = %environment_id, "Local OpenCode server stopped");

    Ok(())
}

/// Get the status of the OpenCode server for a local environment
#[tauri::command]
pub async fn get_local_opencode_server_status(
    environment_id: String,
) -> Result<LocalServerStatusResult, String> {
    debug!(environment_id = %environment_id, "Getting local OpenCode server status");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let status = get_local_opencode_status(
        &environment_id,
        environment.local_opencode_port,
        environment.opencode_pid,
    )
    .await;

    Ok(status.into())
}

/// Start the Claude-bridge server for a local environment
#[tauri::command]
pub async fn start_local_claude_server_cmd(
    app_handle: tauri::AppHandle,
    environment_id: String,
) -> Result<LocalServerResult, String> {
    debug!(environment_id = %environment_id, "Starting local Claude-bridge server");

    // Serialize starts per environment to avoid races when React mounts/remounts tabs
    // quickly and triggers overlapping start requests.
    let start_lock = get_claude_start_lock(&environment_id);
    let _guard = start_lock.lock().await;

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;
    debug!(
        environment_id = %environment_id,
        environment_type = ?environment.environment_type,
        worktree_path = ?environment.worktree_path,
        port = ?environment.local_claude_port,
        pid = ?environment.claude_bridge_pid,
        "Local Claude-bridge environment snapshot"
    );

    // Verify this is a local environment
    if environment.is_containerized() {
        return Err("Cannot start local server for containerized environment".to_string());
    }

    // Get the worktree path
    let worktree_path = environment
        .worktree_path
        .as_ref()
        .ok_or("Local environment missing worktree path")?;

    let manager = get_process_manager();

    // Get the allocated port
    let mut port = environment
        .local_claude_port
        .ok_or("Local environment missing Claude-bridge port")?;

    if let Some(pid) = environment.claude_bridge_pid {
        if is_process_alive(pid) {
            // Only recover a stored PID if it is actually responding as Claude-bridge
            // on the expected port. This avoids false positives when PID was reused by
            // an unrelated process.
            let stored_status =
                get_local_claude_status(&environment_id, Some(port), Some(pid)).await;
            if stored_status.running {
                manager
                    .recover_from_pid(&environment_id, ProcessType::ClaudeBridge, pid)
                    .await;
                debug!(
                    environment_id = %environment_id,
                    port = port,
                    pid = pid,
                    "Reusing existing healthy Claude-bridge server"
                );
                return Ok(LocalServerResult {
                    port,
                    pid,
                    was_running: true,
                });
            }

            warn!(
                environment_id = %environment_id,
                pid = pid,
                port = port,
                "Stored Claude-bridge PID is alive but unhealthy; clearing stale PID"
            );
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "claudeBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        } else {
            debug!(
                environment_id = %environment_id,
                pid = pid,
                "Stored Claude-bridge PID is no longer alive; clearing"
            );
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "claudeBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    if !is_port_available(port) {
        warn!(
            environment_id = %environment_id,
            port = port,
            "Claude-bridge port already in use; attempting to recover"
        );

        // If we are currently tracking a Claude-bridge process for this environment,
        // stop it before trying to recover/reassign the port.
        if manager
            .is_running(&environment_id, ProcessType::ClaudeBridge)
            .await
        {
            if let Err(err) = manager
                .kill(&environment_id, ProcessType::ClaudeBridge)
                .await
            {
                warn!(
                    environment_id = %environment_id,
                    port = port,
                    error = %err,
                    "Failed to kill existing Claude-bridge process"
                );
            }
        }

        if !is_port_available(port) {
            let all_envs = storage.get_all_environments().map_err(|e| e.to_string())?;
            let allocation = allocate_ports(&all_envs)?;
            let new_port = allocation.claude_port;
            warn!(
                environment_id = %environment_id,
                old_port = port,
                new_port = new_port,
                "Reassigning Claude-bridge port"
            );
            port = new_port;
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "localClaudePort": new_port,
                        "claudeBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    // Get the path to the claude-bridge
    // In development, it's in the bridges/claude-bridge directory
    // In production, it's bundled as a resource
    let bridge_path = resolve_claude_bridge_path(&app_handle);
    debug!(environment_id = %environment_id, bridge_path = %bridge_path, "Resolved claude-bridge path");

    // Get the path to the bundled bun binary (for packaged apps)
    let bundled_bun_path = resolve_bundled_bun_path(&app_handle);
    if let Some(ref bun_path) = bundled_bun_path {
        debug!(environment_id = %environment_id, bun_path = %bun_path, "Resolved bundled bun path");
    }

    // Start the server
    let result = start_local_claude_bridge(
        &environment_id,
        worktree_path,
        port,
        &bridge_path,
        bundled_bun_path.as_deref(),
    )
    .await?;

    // Persist any changed runtime metadata (PID and possibly reassigned port)
    if environment.claude_bridge_pid != Some(result.pid)
        || environment.local_claude_port != Some(result.port)
    {
        storage
            .update_environment(
                &environment_id,
                json!({
                    "claudeBridgePid": result.pid,
                    "localClaudePort": result.port
                }),
            )
            .map_err(|e| format!("Failed to update environment: {}", e))?;
    }

    info!(
        environment_id = %environment_id,
        port = result.port,
        pid = result.pid,
        "Local Claude-bridge server started"
    );

    Ok(result.into())
}

fn dev_claude_bridge_path() -> Option<String> {
    // In dev, CARGO_MANIFEST_DIR points to src-tauri; claude-bridge lives at ../bridges/claude-bridge.
    //
    // IMPORTANT: env!() captures the path at COMPILE TIME, not runtime. This means:
    // - In debug builds: Points to the developer's local src-tauri directory
    // - In release builds: Points to wherever the build was performed (CI server, etc.)
    //
    // This is INTENTIONAL for dev builds only. In production (release builds), the bundled
    // resource path takes precedence via resolve_claude_bridge_path(), which checks bundled
    // paths first. The #[cfg(debug_assertions)] guard in resolve_claude_bridge_path() ensures
    // this dev path is only preferred in debug mode.
    //
    // If this path doesn't exist at runtime (e.g., in a packaged release app), the fallback
    // logic in resolve_claude_bridge_path() will handle it gracefully.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let manifest_path = PathBuf::from(manifest_dir);
    let workspace_root = manifest_path.parent()?;
    let bridge_path = workspace_root.join("bridges").join("claude-bridge");
    Some(bridge_path.to_string_lossy().to_string())
}

/// Resolve the claude-bridge path for both development and production
fn resolve_claude_bridge_path(app_handle: &tauri::AppHandle) -> String {
    // In debug mode, prefer the development path first because it has node_modules
    // The bundled resource path in target/debug only has dist and package.json
    #[cfg(debug_assertions)]
    {
        if let Some(dev_path) = dev_claude_bridge_path() {
            let dev_pathbuf = PathBuf::from(&dev_path);
            // Check that both the directory and node_modules exist
            if dev_pathbuf.exists() && dev_pathbuf.join("node_modules").exists() {
                debug!(path = %dev_path, "Using dev claude-bridge path (debug mode)");
                return dev_path;
            }
        }
    }

    // Try bundled resource path (production)
    // Use resolve_resource which is the Tauri v2 way to access bundled resources
    if let Ok(bundled) = app_handle
        .path()
        .resolve("claude-bridge", tauri::path::BaseDirectory::Resource)
    {
        debug!(path = %bundled.display(), "Checking bundled claude-bridge path");
        if bundled.exists() {
            debug!(path = %bundled.display(), "Found bundled claude-bridge");
            return bundled.to_string_lossy().to_string();
        }
    }

    // Also try resource_dir() directly as a fallback
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bundled = res_dir.join("claude-bridge");
        debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir claude-bridge path");
        if bundled.exists() {
            debug!(path = %bundled.display(), "Found claude-bridge via resource_dir");
            return bundled.to_string_lossy().to_string();
        }
    }

    // Fallback to development path (also handles release builds where bundled path doesn't exist)
    if let Some(dev_path) = dev_claude_bridge_path() {
        let dev_pathbuf = PathBuf::from(&dev_path);
        if dev_pathbuf.exists() {
            debug!(path = %dev_path, "Found dev claude-bridge path");
            return dev_path;
        }
    }

    // Last resort - relative path (will likely fail but provides a clear error)
    warn!("Could not resolve claude-bridge path, using fallback");
    "bridges/claude-bridge".to_string()
}

fn dev_codex_bridge_path() -> Option<String> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let manifest_path = PathBuf::from(manifest_dir);
    let workspace_root = manifest_path.parent()?;
    let bridge_path = workspace_root.join("bridges").join("codex-bridge");
    Some(bridge_path.to_string_lossy().to_string())
}

fn resolve_codex_bridge_path(app_handle: &tauri::AppHandle) -> String {
    #[cfg(debug_assertions)]
    {
        if let Some(dev_path) = dev_codex_bridge_path() {
            let dev_pathbuf = PathBuf::from(&dev_path);
            if dev_pathbuf.exists() && dev_pathbuf.join("node_modules").exists() {
                debug!(path = %dev_path, "Using dev codex-bridge path (debug mode)");
                return dev_path;
            }
        }
    }

    if let Ok(bundled) = app_handle
        .path()
        .resolve("codex-bridge", tauri::path::BaseDirectory::Resource)
    {
        debug!(path = %bundled.display(), "Checking bundled codex-bridge path");
        if bundled.exists() {
            debug!(path = %bundled.display(), "Found bundled codex-bridge");
            return bundled.to_string_lossy().to_string();
        }
    }

    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let bundled = res_dir.join("codex-bridge");
        debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir codex-bridge path");
        if bundled.exists() {
            debug!(path = %bundled.display(), "Found codex-bridge via resource_dir");
            return bundled.to_string_lossy().to_string();
        }
    }

    if let Some(dev_path) = dev_codex_bridge_path() {
        let dev_pathbuf = PathBuf::from(&dev_path);
        if dev_pathbuf.exists() {
            debug!(path = %dev_path, "Found dev codex-bridge path");
            return dev_path;
        }
    }

    warn!("Could not resolve codex-bridge path, using fallback");
    "bridges/codex-bridge".to_string()
}

/// Resolve the bundled opencode binary path for packaged apps
fn resolve_bundled_opencode_path(#[allow(unused)] app_handle: &tauri::AppHandle) -> Option<String> {
    // In debug mode, skip bundled opencode - it may have code signing issues on macOS
    #[cfg(debug_assertions)]
    {
        debug!("Debug mode: skipping bundled opencode, will use system binary");
        return None;
    }

    // Try bundled resource path (production)
    #[cfg(not(debug_assertions))]
    {
        if let Ok(bundled) = app_handle
            .path()
            .resolve("bin/opencode", tauri::path::BaseDirectory::Resource)
        {
            debug!(path = %bundled.display(), "Checking bundled opencode path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found bundled opencode");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let bundled = res_dir.join("bin").join("opencode");
            debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir opencode path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found opencode via resource_dir");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        debug!("No bundled opencode found, will use system binary");
        None
    }
}

/// Resolve the bundled codex binary path for packaged apps
fn resolve_bundled_codex_path(#[allow(unused)] app_handle: &tauri::AppHandle) -> Option<String> {
    // In debug mode, skip bundled codex - it may have code signing issues on macOS
    #[cfg(debug_assertions)]
    {
        debug!("Debug mode: skipping bundled codex, will use system binary");
        return None;
    }

    #[cfg(not(debug_assertions))]
    {
        if let Ok(bundled) = app_handle
            .path()
            .resolve("bin/codex", tauri::path::BaseDirectory::Resource)
        {
            debug!(path = %bundled.display(), "Checking bundled codex path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found bundled codex");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let bundled = res_dir.join("bin").join("codex");
            debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir codex path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found codex via resource_dir");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        debug!("No bundled codex found, will use system binary");
        None
    }
}

/// Resolve the bundled bun binary path for packaged apps
fn resolve_bundled_bun_path(#[allow(unused)] app_handle: &tauri::AppHandle) -> Option<String> {
    // In debug mode, skip bundled bun - it may have code signing issues on macOS
    // that cause it to hang. Use system bun/node instead.
    #[cfg(debug_assertions)]
    {
        debug!("Debug mode: skipping bundled bun, will use system runtime");
        return None;
    }

    // Try bundled resource path (production)
    #[cfg(not(debug_assertions))]
    {
        if let Ok(bundled) = app_handle
            .path()
            .resolve("bin/bun", tauri::path::BaseDirectory::Resource)
        {
            debug!(path = %bundled.display(), "Checking bundled bun path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found bundled bun");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        // Also try resource_dir() directly as a fallback
        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let bundled = res_dir.join("bin").join("bun");
            debug!(resource_dir = %res_dir.display(), path = %bundled.display(), "Checking resource_dir bun path");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Found bun via resource_dir");
                return Some(bundled.to_string_lossy().to_string());
            }
        }

        // No bundled bun found - that's okay, we'll fall back to system bun/node
        debug!("No bundled bun found, will use system runtime");
        None
    }
}

/// Stop the Claude-bridge server for a local environment
#[tauri::command]
pub async fn stop_local_claude_server_cmd(environment_id: String) -> Result<(), String> {
    debug!(environment_id = %environment_id, "Stopping local Claude-bridge server");

    stop_local_claude_bridge(&environment_id).await?;

    // Clear the PID in storage
    let storage = get_storage().map_err(|e| e.to_string())?;
    storage
        .update_environment(
            &environment_id,
            json!({
                "claudeBridgePid": null
            }),
        )
        .map_err(|e| format!("Failed to update environment: {}", e))?;

    info!(environment_id = %environment_id, "Local Claude-bridge server stopped");

    Ok(())
}

/// Get the status of the Claude-bridge server for a local environment
#[tauri::command]
pub async fn get_local_claude_server_status(
    environment_id: String,
) -> Result<LocalServerStatusResult, String> {
    debug!(environment_id = %environment_id, "Getting local Claude-bridge server status");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let status = get_local_claude_status(
        &environment_id,
        environment.local_claude_port,
        environment.claude_bridge_pid,
    )
    .await;

    Ok(status.into())
}

/// Start the Codex bridge server for a local environment
#[tauri::command]
pub async fn start_local_codex_server_cmd(
    app_handle: tauri::AppHandle,
    environment_id: String,
) -> Result<LocalServerResult, String> {
    debug!(environment_id = %environment_id, "Starting local Codex bridge server");

    let start_lock = get_codex_start_lock(&environment_id);
    let _guard = start_lock.lock().await;

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    if environment.is_containerized() {
        return Err("Cannot start local server for containerized environment".to_string());
    }

    let worktree_path = environment
        .worktree_path
        .as_ref()
        .ok_or("Local environment missing worktree path")?;

    let manager = get_process_manager();
    let mut port = environment
        .local_codex_port
        .ok_or("Local environment missing Codex bridge port")?;

    if let Some(pid) = environment.codex_bridge_pid {
        if is_process_alive(pid) {
            let stored_status =
                get_local_codex_status(&environment_id, Some(port), Some(pid)).await;
            if stored_status.running {
                manager
                    .recover_from_pid(&environment_id, ProcessType::CodexBridge, pid)
                    .await;
                debug!(
                    environment_id = %environment_id,
                    port = port,
                    pid = pid,
                    "Reusing existing healthy Codex bridge server"
                );
                return Ok(LocalServerResult {
                    port,
                    pid,
                    was_running: true,
                });
            }

            warn!(
                environment_id = %environment_id,
                pid = pid,
                port = port,
                "Stored Codex bridge PID is alive but unhealthy; clearing stale PID"
            );
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "codexBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        } else {
            debug!(
                environment_id = %environment_id,
                pid = pid,
                "Stored Codex bridge PID is no longer alive; clearing"
            );
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "codexBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    if !is_port_available(port) {
        warn!(
            environment_id = %environment_id,
            port = port,
            "Codex bridge port already in use; attempting to recover"
        );

        if manager
            .is_running(&environment_id, ProcessType::CodexBridge)
            .await
        {
            if let Err(err) = manager
                .kill(&environment_id, ProcessType::CodexBridge)
                .await
            {
                warn!(
                    environment_id = %environment_id,
                    port = port,
                    error = %err,
                    "Failed to kill existing Codex bridge process"
                );
            }
        }

        if !is_port_available(port) {
            let all_envs = storage.get_all_environments().map_err(|e| e.to_string())?;
            let allocation = allocate_ports(&all_envs)?;
            let new_port = allocation.codex_port;
            warn!(
                environment_id = %environment_id,
                old_port = port,
                new_port = new_port,
                "Reassigning Codex bridge port"
            );
            port = new_port;
            storage
                .update_environment(
                    &environment_id,
                    json!({
                        "localCodexPort": new_port,
                        "codexBridgePid": null
                    }),
                )
                .map_err(|e| format!("Failed to update environment: {}", e))?;
        }
    }

    let bridge_path = resolve_codex_bridge_path(&app_handle);
    debug!(environment_id = %environment_id, bridge_path = %bridge_path, "Resolved codex-bridge path");
    let raw_log_dir = if load_codex_bridge_raw_event_logging()? {
        Some(
            crate::log_dir_path()
                .join("codex-raw")
                .to_string_lossy()
                .to_string(),
        )
    } else {
        None
    };

    let bundled_bun_path = resolve_bundled_bun_path(&app_handle);
    if let Some(ref bun_path) = bundled_bun_path {
        debug!(environment_id = %environment_id, bun_path = %bun_path, "Resolved bundled bun path");
    }

    let bundled_codex_path = resolve_bundled_codex_path(&app_handle);
    if let Some(ref codex_path) = bundled_codex_path {
        debug!(environment_id = %environment_id, codex_path = %codex_path, "Resolved bundled codex path");
    }

    let result = start_local_codex_bridge(
        &environment_id,
        worktree_path,
        port,
        &bridge_path,
        bundled_bun_path.as_deref(),
        bundled_codex_path.as_deref(),
        raw_log_dir.as_deref(),
    )
    .await?;

    if environment.codex_bridge_pid != Some(result.pid)
        || environment.local_codex_port != Some(result.port)
    {
        storage
            .update_environment(
                &environment_id,
                json!({
                    "codexBridgePid": result.pid,
                    "localCodexPort": result.port
                }),
            )
            .map_err(|e| format!("Failed to update environment: {}", e))?;
    }

    info!(
        environment_id = %environment_id,
        port = result.port,
        pid = result.pid,
        "Local Codex bridge server started"
    );

    Ok(result.into())
}

/// Stop the Codex bridge server for a local environment
#[tauri::command]
pub async fn stop_local_codex_server_cmd(environment_id: String) -> Result<(), String> {
    debug!(environment_id = %environment_id, "Stopping local Codex bridge server");

    stop_local_codex_bridge(&environment_id).await?;

    let storage = get_storage().map_err(|e| e.to_string())?;
    storage
        .update_environment(
            &environment_id,
            json!({
                "codexBridgePid": null
            }),
        )
        .map_err(|e| format!("Failed to update environment: {}", e))?;

    info!(environment_id = %environment_id, "Local Codex bridge server stopped");

    Ok(())
}

/// Clean up stale local server processes from previous app sessions.
///
/// Iterates all local environments and kills or recovers any orphaned bridge
/// processes. This is automatically called on app startup, but can also be
/// triggered manually from the frontend.
#[tauri::command]
pub async fn cleanup_stale_local_servers_cmd() -> Result<(), String> {
    info!("Manual stale server cleanup requested");
    crate::local::cleanup_stale_local_servers().await;
    Ok(())
}

/// Get the status of the Codex bridge server for a local environment
#[tauri::command]
pub async fn get_local_codex_server_status(
    environment_id: String,
) -> Result<LocalServerStatusResult, String> {
    debug!(environment_id = %environment_id, "Getting local Codex bridge server status");

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let status = get_local_codex_status(
        &environment_id,
        environment.local_codex_port,
        environment.codex_bridge_pid,
    )
    .await;

    Ok(status.into())
}
