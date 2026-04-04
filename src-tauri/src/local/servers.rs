//! Local server management for OpenCode and Claude-bridge
//!
//! Handles starting, stopping, and monitoring local server processes
//! for local (non-Docker) environments.

use super::process::{get_process_manager, is_process_alive, ProcessType};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::process::Command;
use tracing::{debug, info, warn};

static START_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

/// Flag indicating whether startup cleanup has completed.
/// Server start functions wait for this before proceeding to avoid races.
static STARTUP_CLEANUP_COMPLETE: AtomicBool = AtomicBool::new(false);

/// Wait for startup cleanup to finish (with a timeout).
async fn wait_for_startup_cleanup() {
    const MAX_WAIT_MS: u64 = 10_000;
    const POLL_INTERVAL_MS: u64 = 50;
    let mut waited = 0u64;
    while !STARTUP_CLEANUP_COMPLETE.load(Ordering::Acquire) && waited < MAX_WAIT_MS {
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
        waited += POLL_INTERVAL_MS;
    }
    if waited >= MAX_WAIT_MS {
        warn!("Timed out waiting for startup cleanup to complete, proceeding anyway");
    }
}

fn get_start_lock(environment_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = START_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap();
    map.entry(environment_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Result of starting a local server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStartResult {
    pub port: u16,
    pub pid: u32,
    pub was_running: bool,
}

/// Status of a local server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

/// Maximum attempts to wait for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;
/// Interval between health check attempts (200ms)
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

/// Check if a server is healthy by making a request to its health endpoint
async fn check_server_health(port: u16) -> bool {
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();

    if let Some(client) = client {
        let url = format!("http://127.0.0.1:{}/global/health", port);
        match client.get(&url).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    } else {
        false
    }
}

/// Wait for a server to become healthy
async fn wait_for_server_health(port: u16) -> bool {
    for attempt in 1..=SERVER_STARTUP_MAX_ATTEMPTS {
        if check_server_health(port).await {
            debug!(port = port, attempt = attempt, "Server is healthy");
            return true;
        }
        tokio::time::sleep(Duration::from_millis(SERVER_STARTUP_POLL_INTERVAL_MS)).await;
    }
    warn!(port = port, "Server did not become healthy within timeout");
    false
}

/// Probe a server endpoint that exercises OpenCode's provider/config paths rather
/// than just the shallow health route.
async fn check_opencode_server_readiness(port: u16) -> bool {
    let client = Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok();

    let Some(client) = client else {
        return false;
    };

    for endpoint in ["/provider", "/config/providers"] {
        let url = format!("http://127.0.0.1:{port}{endpoint}");
        match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                debug!(
                    port = port,
                    endpoint = endpoint,
                    "OpenCode readiness probe succeeded"
                );
                return true;
            }
            Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {
                debug!(
                    port = port,
                    endpoint = endpoint,
                    "OpenCode readiness probe endpoint unavailable, trying fallback"
                );
            }
            Ok(response) => {
                warn!(
                    port = port,
                    endpoint = endpoint,
                    status = %response.status(),
                    "OpenCode readiness probe failed"
                );
                return false;
            }
            Err(error) => {
                warn!(
                    port = port,
                    endpoint = endpoint,
                    error = %error,
                    "OpenCode readiness probe request failed"
                );
                return false;
            }
        }
    }

    warn!(
        port = port,
        "OpenCode readiness probe endpoints unavailable"
    );
    false
}

#[cfg(unix)]
fn read_process_command(pid: u32, include_env: bool) -> Option<String> {
    let mut command = StdCommand::new("ps");
    if include_env {
        command.args(["eww", "-o", "command=", "-p"]);
    } else {
        command.args(["-o", "command=", "-p"]);
    }

    let output = command.arg(pid.to_string()).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_string())
}

#[cfg(unix)]
fn is_opencode_server_command(command_line: &str) -> bool {
    command_line.contains("opencode") && command_line.contains("serve")
}

#[cfg(unix)]
fn extract_env_var(process_with_env: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    process_with_env
        .split_whitespace()
        .find_map(|token| token.strip_prefix(&prefix).map(str::to_string))
}

#[cfg(unix)]
fn is_expected_opencode_process(environment_id: &str, pid: u32) -> bool {
    let Some(command_line) = read_process_command(pid, false) else {
        return false;
    };

    if !is_opencode_server_command(&command_line) {
        debug!(
            environment_id = %environment_id,
            pid = pid,
            command = %command_line,
            "Stored PID does not look like an OpenCode server"
        );
        return false;
    }

    let Some(expected_data_home) = isolated_opencode_data_home(environment_id) else {
        return true;
    };
    let Some(process_with_env) = read_process_command(pid, true) else {
        return false;
    };
    let actual_data_home = extract_env_var(&process_with_env, "XDG_DATA_HOME");
    if actual_data_home.as_deref() != Some(expected_data_home.as_str()) {
        warn!(
            environment_id = %environment_id,
            pid = pid,
            expected_data_home = %expected_data_home,
            actual_data_home = actual_data_home.as_deref().unwrap_or("<missing>"),
            "Stored OpenCode PID belongs to a different environment"
        );
        return false;
    }

    true
}

#[cfg(not(unix))]
fn is_expected_opencode_process(_environment_id: &str, _pid: u32) -> bool {
    true
}

/// Start the OpenCode server for a local environment
///
/// # Arguments
/// * `environment_id` - The environment ID
/// * `worktree_path` - Path to the git worktree (working directory)
/// * `port` - Port to run the server on
///
/// # Returns
/// Result with server start information
pub async fn start_local_opencode_server(
    environment_id: &str,
    worktree_path: &str,
    port: u16,
    bundled_opencode_path: Option<&str>,
) -> Result<LocalServerStartResult, String> {
    wait_for_startup_cleanup().await;
    let start_lock = get_start_lock(environment_id);
    let _guard = start_lock.lock().await;

    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        "Starting local OpenCode server"
    );

    let manager = get_process_manager();

    // Check if already running
    if manager
        .is_running(environment_id, ProcessType::OpenCode)
        .await
    {
        if let Some(pid) = manager.get_pid(environment_id, ProcessType::OpenCode).await {
            debug!(environment_id = %environment_id, pid = pid, "OpenCode server already running");
            return Ok(LocalServerStartResult {
                port,
                pid,
                was_running: true,
            });
        }
    }

    // Prepare environment variables
    let mut env_vars = HashMap::new();
    env_vars.insert("TERM".to_string(), "xterm-256color".to_string());
    let path = build_comprehensive_path(None);
    env_vars.insert("PATH".to_string(), path.clone());

    // Isolate each OpenCode instance's SQLite database by giving it a unique
    // XDG_DATA_HOME.  OpenCode stores its database at
    // $XDG_DATA_HOME/opencode/opencode.db and uses SQLite locking that does
    // not support concurrent writers, so multiple `opencode serve` processes
    // sharing the default ~/.local/share will conflict.
    let mut isolated_opencode_dir: Option<PathBuf> = None;
    if let Some(data_home) = isolated_opencode_data_home(environment_id) {
        let isolated_dir = PathBuf::from(&data_home).join("opencode");
        if let Err(e) = std::fs::create_dir_all(&isolated_dir) {
            warn!(
                environment_id = %environment_id,
                path = %data_home,
                error = %e,
                "Failed to create isolated XDG_DATA_HOME; falling back to shared default"
            );
        } else {
            // Symlink shared files (auth, config) from the real data home so that
            // OAuth tokens and other credentials are available in the isolated
            // environment.  Only the SQLite database needs true isolation.
            symlink_shared_opencode_files(&isolated_dir);

            debug!(
                environment_id = %environment_id,
                path = %data_home,
                "Using isolated XDG_DATA_HOME for OpenCode server"
            );
            env_vars.insert("XDG_DATA_HOME".to_string(), data_home);
            isolated_opencode_dir = Some(isolated_dir);
        }
    }

    // Prefer bundled binary, then system binary, then PATH fallback
    let opencode_cmd = resolve_opencode_binary(bundled_opencode_path);
    if opencode_cmd == "opencode" {
        warn!(
            environment_id = %environment_id,
            path = %path,
            "OpenCode binary not found in known locations; falling back to PATH lookup"
        );
    } else {
        debug!(
            environment_id = %environment_id,
            opencode_path = %opencode_cmd,
            path = %path,
            "Resolved OpenCode binary for local server"
        );
    }

    let mut pid = spawn_local_opencode_process(
        manager,
        environment_id,
        worktree_path,
        port,
        &opencode_cmd,
        env_vars.clone(),
    )
    .await?;

    // Wait for server to become healthy
    if !wait_for_server_health(port).await {
        let _ = manager.kill(environment_id, ProcessType::OpenCode).await;
        return Err("OpenCode server failed to start within timeout".to_string());
    }

    if !check_opencode_server_readiness(port).await {
        let _ = manager.kill(environment_id, ProcessType::OpenCode).await;

        let Some(isolated_opencode_dir) = isolated_opencode_dir.as_ref() else {
            return Err("OpenCode server failed readiness check after startup".to_string());
        };

        warn!(
            environment_id = %environment_id,
            port = port,
            path = %isolated_opencode_dir.display(),
            "OpenCode readiness check failed; retrying once after resetting isolated database"
        );

        reset_isolated_opencode_database(isolated_opencode_dir);

        pid = spawn_local_opencode_process(
            manager,
            environment_id,
            worktree_path,
            port,
            &opencode_cmd,
            env_vars,
        )
        .await?;

        if !wait_for_server_health(port).await {
            let _ = manager.kill(environment_id, ProcessType::OpenCode).await;
            return Err(
                "OpenCode server failed to start within timeout after database recovery"
                    .to_string(),
            );
        }

        if !check_opencode_server_readiness(port).await {
            let _ = manager.kill(environment_id, ProcessType::OpenCode).await;
            return Err(
                "OpenCode server failed readiness check after database recovery".to_string(),
            );
        }
    }

    info!(
        environment_id = %environment_id,
        port = port,
        pid = pid,
        "OpenCode server started successfully"
    );

    Ok(LocalServerStartResult {
        port,
        pid,
        was_running: false,
    })
}

async fn spawn_local_opencode_process(
    manager: &super::process::LocalProcessManager,
    environment_id: &str,
    worktree_path: &str,
    port: u16,
    opencode_cmd: &str,
    env_vars: HashMap<String, String>,
) -> Result<u32, String> {
    manager
        .spawn(
            environment_id,
            ProcessType::OpenCode,
            opencode_cmd,
            &[
                "serve",
                "--port",
                &port.to_string(),
                "--hostname",
                "0.0.0.0",
            ],
            worktree_path,
            env_vars,
        )
        .await
        .map_err(|e| format!("Failed to spawn OpenCode server: {}", e))
}

/// Stop the OpenCode server for a local environment
pub async fn stop_local_opencode_server(environment_id: &str) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping local OpenCode server");

    let manager = get_process_manager();
    manager
        .kill(environment_id, ProcessType::OpenCode)
        .await
        .map_err(|e| format!("Failed to stop OpenCode server: {}", e))?;

    Ok(())
}

/// Get the status of the OpenCode server for a local environment
pub async fn get_local_opencode_status(
    environment_id: &str,
    port: Option<u16>,
    pid: Option<u32>,
) -> LocalServerStatus {
    let manager = get_process_manager();

    // Check if we're tracking this process
    let is_running = if let Some(p) = pid {
        // Check if stored PID is still alive
        if is_process_alive(p) && is_expected_opencode_process(environment_id, p) {
            // Verify it's responding to health checks
            if let Some(port) = port {
                check_server_health(port).await
            } else {
                true
            }
        } else {
            false
        }
    } else {
        manager
            .is_running(environment_id, ProcessType::OpenCode)
            .await
    };

    LocalServerStatus {
        running: is_running,
        port,
        pid,
    }
}

/// Start the Claude-bridge server for a local environment
///
/// # Arguments
/// * `environment_id` - The environment ID
/// * `worktree_path` - Path to the git worktree (working directory)
/// * `port` - Port to run the server on
/// * `bridge_path` - Path to the claude-bridge dist directory
/// * `bundled_bun_path` - Optional path to bundled bun binary (for packaged apps)
///
/// # Returns
/// Result with server start information
pub async fn start_local_claude_bridge(
    environment_id: &str,
    worktree_path: &str,
    port: u16,
    bridge_path: &str,
    bundled_bun_path: Option<&str>,
) -> Result<LocalServerStartResult, String> {
    wait_for_startup_cleanup().await;
    let start_lock = get_start_lock(environment_id);
    let _guard = start_lock.lock().await;

    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        bridge_path = %bridge_path,
        "Starting local Claude-bridge server"
    );

    let manager = get_process_manager();

    // Check if already running
    if manager
        .is_running(environment_id, ProcessType::ClaudeBridge)
        .await
    {
        if let Some(pid) = manager
            .get_pid(environment_id, ProcessType::ClaudeBridge)
            .await
        {
            debug!(
                environment_id = %environment_id,
                pid = pid,
                "Claude-bridge server already running"
            );
            return Ok(LocalServerStartResult {
                port,
                pid,
                was_running: true,
            });
        }
    }
    debug!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        bridge_path = %bridge_path,
        "Claude-bridge not running; will attempt start"
    );

    // Prepare environment variables
    let mut env_vars = HashMap::new();
    env_vars.insert("PORT".to_string(), port.to_string());
    // Bind to localhost to avoid PNA/CORS restrictions in WebView
    env_vars.insert("HOSTNAME".to_string(), "127.0.0.1".to_string());
    env_vars.insert("TERM".to_string(), "xterm-256color".to_string());
    // Increase bash output limit for code reviews and large diffs (default is 30000)
    env_vars.insert("BASH_MAX_OUTPUT_LENGTH".to_string(), "200000".to_string());

    // Build a comprehensive PATH for packaged apps and GUI launches.
    let path = build_comprehensive_path(bundled_bun_path);

    // Add node's directory if found
    let node_binary = resolve_node_binary();
    if let Some(ref node_path) = node_binary {
        env_vars.insert("NODE_BINARY".to_string(), node_path.clone());
        env_vars.insert("NODE".to_string(), node_path.clone());
    } else {
        // Hint the SDK where node lives if it supports NODE_BINARY/NODE
        env_vars.insert("NODE_BINARY".to_string(), "node".to_string());
        env_vars.insert("NODE".to_string(), "node".to_string());
    }

    env_vars.insert("PATH".to_string(), path.clone());
    debug!(path = %path, "Set PATH for claude-bridge process");

    // The bridge is a Node.js application
    // We need to run: node/bun <bridge_path>/dist/index.js
    let entry_point = format!("{}/dist/index.js", bridge_path);
    ensure_bridge_ready("claude-bridge", bridge_path, &entry_point).await?;
    if !Path::new(&entry_point).exists() {
        return Err(format!(
            "Claude-bridge entrypoint missing after readiness check: {}",
            entry_point
        ));
    }

    let (runtime_cmd, runtime_args) = resolve_js_runtime(&entry_point, bundled_bun_path);
    let runtime_args_ref: Vec<&str> = runtime_args.iter().map(String::as_str).collect();

    // The bridge must run from its own directory (where node_modules is located)
    // But we set CWD env var so the Claude SDK operates on the worktree
    env_vars.insert("CWD".to_string(), worktree_path.to_string());

    let pid = manager
        .spawn(
            environment_id,
            ProcessType::ClaudeBridge,
            runtime_cmd,
            &runtime_args_ref,
            bridge_path, // Run from bridge directory so node_modules is accessible
            env_vars,
        )
        .await
        .map_err(|e| format!("Failed to spawn Claude-bridge server: {}", e))?;
    debug!(environment_id = %environment_id, pid = pid, cwd = %bridge_path, "Spawned claude-bridge process");

    // Wait for server to become healthy
    if !wait_for_server_health(port).await {
        // Try to kill the process if it didn't start properly
        let _ = manager
            .kill(environment_id, ProcessType::ClaudeBridge)
            .await;
        return Err("Claude-bridge server failed to start within timeout".to_string());
    }

    info!(
        environment_id = %environment_id,
        port = port,
        pid = pid,
        "Claude-bridge server started successfully"
    );

    Ok(LocalServerStartResult {
        port,
        pid,
        was_running: false,
    })
}

/// Stop the Claude-bridge server for a local environment
pub async fn stop_local_claude_bridge(environment_id: &str) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping local Claude-bridge server");

    let manager = get_process_manager();
    manager
        .kill(environment_id, ProcessType::ClaudeBridge)
        .await
        .map_err(|e| format!("Failed to stop Claude-bridge server: {}", e))?;

    Ok(())
}

/// Get the status of the Claude-bridge server for a local environment
pub async fn get_local_claude_status(
    environment_id: &str,
    port: Option<u16>,
    pid: Option<u32>,
) -> LocalServerStatus {
    let manager = get_process_manager();

    // Check if we're tracking this process
    let is_running = if let Some(p) = pid {
        // Check if stored PID is still alive
        if is_process_alive(p) {
            // Verify it's responding to health checks
            if let Some(port) = port {
                check_server_health(port).await
            } else {
                true
            }
        } else {
            false
        }
    } else {
        manager
            .is_running(environment_id, ProcessType::ClaudeBridge)
            .await
    };

    LocalServerStatus {
        running: is_running,
        port,
        pid,
    }
}

/// Start the Codex bridge server for a local environment
pub async fn start_local_codex_bridge(
    environment_id: &str,
    worktree_path: &str,
    port: u16,
    bridge_path: &str,
    bundled_bun_path: Option<&str>,
) -> Result<LocalServerStartResult, String> {
    wait_for_startup_cleanup().await;
    let start_lock = get_start_lock(environment_id);
    let _guard = start_lock.lock().await;

    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        port = port,
        bridge_path = %bridge_path,
        "Starting local Codex bridge server"
    );

    let manager = get_process_manager();

    if manager
        .is_running(environment_id, ProcessType::CodexBridge)
        .await
    {
        if let Some(pid) = manager
            .get_pid(environment_id, ProcessType::CodexBridge)
            .await
        {
            return Ok(LocalServerStartResult {
                port,
                pid,
                was_running: true,
            });
        }
    }

    let mut env_vars = HashMap::new();
    env_vars.insert("PORT".to_string(), port.to_string());
    env_vars.insert("HOSTNAME".to_string(), "127.0.0.1".to_string());
    env_vars.insert("TERM".to_string(), "xterm-256color".to_string());
    env_vars.insert(
        "PATH".to_string(),
        build_comprehensive_path(bundled_bun_path),
    );
    env_vars.insert("CWD".to_string(), worktree_path.to_string());

    if let Ok(openai_api_key) = std::env::var("OPENAI_API_KEY") {
        if !openai_api_key.trim().is_empty() {
            env_vars.insert("OPENAI_API_KEY".to_string(), openai_api_key);
        }
    }

    let entry_point = format!("{}/dist/index.js", bridge_path);
    ensure_bridge_ready("codex-bridge", bridge_path, &entry_point).await?;
    if !Path::new(&entry_point).exists() {
        return Err(format!(
            "Codex bridge entrypoint missing after readiness check: {}",
            entry_point
        ));
    }

    let (runtime_cmd, runtime_args) = resolve_js_runtime(&entry_point, bundled_bun_path);
    let runtime_args_ref: Vec<&str> = runtime_args.iter().map(String::as_str).collect();

    let pid = manager
        .spawn(
            environment_id,
            ProcessType::CodexBridge,
            runtime_cmd,
            &runtime_args_ref,
            bridge_path,
            env_vars,
        )
        .await
        .map_err(|e| format!("Failed to spawn Codex bridge server: {}", e))?;

    if !wait_for_server_health(port).await {
        let _ = manager.kill(environment_id, ProcessType::CodexBridge).await;
        return Err("Codex bridge server failed to start within timeout".to_string());
    }

    Ok(LocalServerStartResult {
        port,
        pid,
        was_running: false,
    })
}

/// Stop the Codex bridge server for a local environment
pub async fn stop_local_codex_bridge(environment_id: &str) -> Result<(), String> {
    let manager = get_process_manager();
    manager
        .kill(environment_id, ProcessType::CodexBridge)
        .await
        .map_err(|e| format!("Failed to stop Codex bridge server: {}", e))?;
    Ok(())
}

/// Get the status of the Codex bridge server for a local environment
pub async fn get_local_codex_status(
    environment_id: &str,
    port: Option<u16>,
    pid: Option<u32>,
) -> LocalServerStatus {
    let manager = get_process_manager();
    let is_running = if let Some(p) = pid {
        if is_process_alive(p) {
            if let Some(port) = port {
                check_server_health(port).await
            } else {
                true
            }
        } else {
            false
        }
    } else {
        manager
            .is_running(environment_id, ProcessType::CodexBridge)
            .await
    };

    LocalServerStatus {
        running: is_running,
        port,
        pid,
    }
}

/// Kill every tracked local server process across all environments.
/// Called during app shutdown to prevent orphaned processes.
pub async fn shutdown_all_local_servers() {
    info!("Shutting down all local server processes");
    let manager = get_process_manager();
    manager.shutdown_all().await;
}

/// Stop all local servers for an environment
pub async fn stop_all_local_servers(environment_id: &str) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping all local servers");

    let manager = get_process_manager();
    manager
        .kill_all(environment_id)
        .await
        .map_err(|e| format!("Failed to stop local servers: {}", e))?;

    Ok(())
}

async fn ensure_bridge_ready(
    bridge_name: &str,
    bridge_path: &str,
    entry_point: &str,
) -> Result<(), String> {
    let entry_path = Path::new(entry_point);
    if entry_path.exists() {
        return Ok(());
    }

    let bridge_dir = Path::new(bridge_path);
    if !bridge_dir.exists() {
        return Err(format!(
            "{} directory not found at {}",
            bridge_name, bridge_path
        ));
    }

    let has_package_json = bridge_dir.join("package.json").exists();
    if !has_package_json {
        return Err(format!(
            "{} entrypoint missing at {} (no package.json found to build)",
            bridge_name, entry_point
        ));
    }

    info!(
        bridge_name = %bridge_name,
        bridge_path = %bridge_path,
        entry_point = %entry_point,
        "Bridge dist missing; attempting build"
    );

    // Resolve the bun binary path explicitly. When Tauri runs as a GUI app
    // (launched from Finder/Spotlight), the process inherits a minimal PATH
    // that may not include ~/.bun/bin or /opt/homebrew/bin.
    let bun_cmd = find_bun_binary().unwrap_or_else(|| "bun".to_string());
    debug!(
        bridge_name = %bridge_name,
        bun_cmd = %bun_cmd,
        "Resolved bun binary for bridge build"
    );

    let install_output = Command::new(&bun_cmd)
        .args(["install"])
        .current_dir(bridge_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run bun install for {}: {}", bridge_name, e))?;

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        let stdout = String::from_utf8_lossy(&install_output.stdout);
        return Err(format!(
            "{} bun install failed: {}\n{}",
            bridge_name, stderr, stdout
        ));
    }

    let build_output = Command::new(&bun_cmd)
        .args(["run", "build"])
        .current_dir(bridge_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run bun build for {}: {}", bridge_name, e))?;

    if !build_output.status.success() {
        let stderr = String::from_utf8_lossy(&build_output.stderr);
        let stdout = String::from_utf8_lossy(&build_output.stdout);
        return Err(format!(
            "{} bun build failed: {}\n{}",
            bridge_name, stderr, stdout
        ));
    }

    if !entry_path.exists() {
        return Err(format!(
            "{} build completed but entrypoint is still missing at {}",
            bridge_name, entry_point
        ));
    }

    Ok(())
}

/// Verify that a runtime binary can actually execute by running `<binary> --version`.
///
/// On macOS, a bundled binary may exist on disk but get SIGKILL'd (exit 137)
/// if its code-signing identity doesn't match the enclosing app bundle.
/// This check catches that scenario so we can fall through to system runtimes.
fn verify_runtime_executable(binary_path: &str) -> bool {
    match StdCommand::new(binary_path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        Ok(status) => {
            if status.success() {
                true
            } else {
                warn!(
                    binary = %binary_path,
                    exit_code = status.code().unwrap_or(-1),
                    "Runtime binary exited with non-zero status"
                );
                false
            }
        }
        Err(e) => {
            warn!(
                binary = %binary_path,
                error = %e,
                "Runtime binary failed to execute"
            );
            false
        }
    }
}

fn resolve_js_runtime(
    entry_point: &str,
    bundled_bun_path: Option<&str>,
) -> (&'static str, Vec<String>) {
    // First, try the bundled bun binary (highest priority for packaged apps)
    if let Some(bun_path) = bundled_bun_path {
        let path = PathBuf::from(bun_path);
        if path.exists() {
            // Ensure the bundled binary has executable permissions
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    let mut perms = metadata.permissions();
                    let mode = perms.mode();
                    // Check if executable bit is set for owner
                    if mode & 0o100 == 0 {
                        debug!(bun_path = %bun_path, "Setting executable permission on bundled bun");
                        perms.set_mode(mode | 0o755);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }

            // Verify the binary can actually execute. On macOS, code-signing
            // mismatches between the app bundle and the bundled binary cause
            // SIGKILL (exit 137). Fall through to system runtimes if so.
            if verify_runtime_executable(bun_path) {
                debug!(bun_path = %bun_path, "Using bundled bun runtime");
                let bun_static: &'static str = Box::leak(bun_path.to_string().into_boxed_str());
                return (bun_static, vec![entry_point.to_string()]);
            }
            warn!(bun_path = %bun_path, "Bundled bun failed verification, falling back to system runtime");
        }
    }

    // Try to find bun in system locations
    if let Some(bun_path) = find_bun_binary() {
        debug!(bun_path = %bun_path, "Using system bun runtime");
        // Leak the string to get a static lifetime - this is fine as we only call this once per server start
        let bun_static: &'static str = Box::leak(bun_path.into_boxed_str());
        return (bun_static, vec![entry_point.to_string()]);
    }

    // Fall back to node
    if let Some(node_path) = resolve_node_binary() {
        debug!(node_path = %node_path, "Using node runtime");
        let node_static: &'static str = Box::leak(node_path.into_boxed_str());
        return (node_static, vec![entry_point.to_string()]);
    }

    // Last resort - try bare commands (works in dev, may fail in packaged app)
    warn!("Could not find bun or node in known locations, falling back to bare command");
    ("node", vec![entry_point.to_string()])
}

fn path_has_entry(path: &str, entry: &str) -> bool {
    path.split(':').any(|candidate| candidate == entry)
}

fn prepend_path_entry(path: &mut String, entry: &str) {
    if entry.is_empty() || path_has_entry(path, entry) {
        return;
    }

    if path.is_empty() {
        *path = entry.to_string();
    } else {
        *path = format!("{}:{}", entry, path);
    }
}

fn append_path_entry(path: &mut String, entry: &str) {
    if entry.is_empty() || path_has_entry(path, entry) {
        return;
    }

    if path.is_empty() {
        *path = entry.to_string();
    } else {
        *path = format!("{}:{}", path, entry);
    }
}

/// Build a robust PATH for child processes started from GUI apps.
fn build_comprehensive_path(bundled_bun_path: Option<&str>) -> String {
    let mut path = std::env::var("PATH").unwrap_or_else(|_| String::new());

    // Ensure common system locations are always present.
    let common_paths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    for common in common_paths {
        append_path_entry(&mut path, common);
    }

    // Prefer discovered OpenCode/Bun/Node locations first.
    if let Some(opencode_path) = find_opencode_binary() {
        if let Some(parent) = PathBuf::from(opencode_path).parent() {
            prepend_path_entry(&mut path, parent.to_string_lossy().as_ref());
        }
    }

    if let Some(codex_path) = find_codex_binary() {
        if let Some(parent) = PathBuf::from(codex_path).parent() {
            prepend_path_entry(&mut path, parent.to_string_lossy().as_ref());
        }
    }

    if let Some(bun_path) = find_bun_binary() {
        if let Some(parent) = PathBuf::from(bun_path).parent() {
            prepend_path_entry(&mut path, parent.to_string_lossy().as_ref());
        }
    }

    if let Some(node_path) = resolve_node_binary() {
        if let Some(parent) = PathBuf::from(node_path).parent() {
            prepend_path_entry(&mut path, parent.to_string_lossy().as_ref());
        }
    }

    if let Some(bun_path) = bundled_bun_path {
        if let Some(parent) = PathBuf::from(bun_path).parent() {
            prepend_path_entry(&mut path, parent.to_string_lossy().as_ref());
        }
    }

    path
}

/// Get the user's home directory using multiple methods
fn get_home_dir() -> Option<PathBuf> {
    // Try dirs crate first (most reliable)
    if let Some(home) = dirs::home_dir() {
        return Some(home);
    }
    // Fallback to HOME env var
    std::env::var("HOME").ok().map(PathBuf::from)
}

/// Find bun binary by checking common installation locations
fn find_bun_binary() -> Option<String> {
    // Check environment variable first
    if let Ok(path) = std::env::var("BUN_INSTALL") {
        let bun_path = PathBuf::from(&path).join("bin").join("bun");
        if bun_path.exists() {
            return Some(bun_path.to_string_lossy().to_string());
        }
    }

    // Get home directory for user-specific paths
    let home = get_home_dir();

    // Common bun installation locations on macOS
    let candidates: Vec<PathBuf> = vec![
        // Homebrew on Apple Silicon
        PathBuf::from("/opt/homebrew/bin/bun"),
        // Homebrew on Intel
        PathBuf::from("/usr/local/bin/bun"),
        // Optional user-level symlink location
        home.as_ref()
            .map(|h| PathBuf::from(h).join(".local/bin/bun"))
            .unwrap_or_default(),
        // Bun's default install location
        home.as_ref()
            .map(|h| PathBuf::from(h).join(".bun/bin/bun"))
            .unwrap_or_default(),
    ];

    for candidate in candidates {
        if candidate.exists() && candidate.to_string_lossy() != "" {
            debug!(path = %candidate.display(), "Found bun binary");
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Try which as last resort (works if PATH is set correctly)
    if let Ok(output) = std::process::Command::new("which").arg("bun").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

/// Resolve the OpenCode binary, preferring bundled over system-installed.
///
/// Priority: bundled binary (with verification) > system binary > PATH fallback
fn resolve_opencode_binary(bundled_opencode_path: Option<&str>) -> String {
    // First, try the bundled binary (highest priority for packaged apps)
    if let Some(opencode_path) = bundled_opencode_path {
        let path = PathBuf::from(opencode_path);
        if path.exists() {
            // Ensure the bundled binary has executable permissions
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    let mut perms = metadata.permissions();
                    let mode = perms.mode();
                    if mode & 0o100 == 0 {
                        debug!(opencode_path = %opencode_path, "Setting executable permission on bundled opencode");
                        perms.set_mode(mode | 0o755);
                        let _ = std::fs::set_permissions(&path, perms);
                    }
                }
            }

            // Verify the binary can actually execute (code-signing check on macOS)
            if verify_runtime_executable(opencode_path) {
                debug!(opencode_path = %opencode_path, "Using bundled opencode binary");
                return opencode_path.to_string();
            }
            warn!(opencode_path = %opencode_path, "Bundled opencode failed verification, falling back to system binary");
        }
    }

    // Fall back to system binary search
    find_opencode_binary().unwrap_or_else(|| "opencode".to_string())
}

/// Find OpenCode binary by checking common installation locations.
fn find_opencode_binary() -> Option<String> {
    // Check explicit environment variable overrides first.
    for var_name in ["OPENCODE_BINARY", "OPENCODE_CLI_PATH"] {
        if let Ok(path) = std::env::var(var_name) {
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    let home = get_home_dir();
    let candidates: Vec<PathBuf> = vec![
        // Homebrew on Apple Silicon
        PathBuf::from("/opt/homebrew/bin/opencode"),
        // Homebrew on Intel
        PathBuf::from("/usr/local/bin/opencode"),
        // Common Linux location
        PathBuf::from("/usr/bin/opencode"),
        // User-local location
        home.as_ref()
            .map(|h| PathBuf::from(h).join(".local/bin/opencode"))
            .unwrap_or_default(),
        // OpenCode install script location
        home.as_ref()
            .map(|h| PathBuf::from(h).join(".opencode/bin/opencode"))
            .unwrap_or_default(),
    ];

    for candidate in candidates {
        if !candidate.as_os_str().is_empty() && candidate.exists() {
            debug!(path = %candidate.display(), "Found opencode binary");
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("opencode").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

/// Find Codex binary by checking common installation locations.
fn find_codex_binary() -> Option<String> {
    for var_name in ["CODEX_BINARY", "CODEX_CLI_PATH"] {
        if let Ok(path) = std::env::var(var_name) {
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    let home = get_home_dir();
    let candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
        home.as_ref()
            .map(|h| PathBuf::from(h).join(".local/bin/codex"))
            .unwrap_or_default(),
    ];

    for candidate in candidates {
        if !candidate.as_os_str().is_empty() && candidate.exists() {
            debug!(path = %candidate.display(), "Found codex binary");
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    if let Ok(output) = std::process::Command::new("which").arg("codex").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

fn resolve_node_binary() -> Option<String> {
    // Check environment variable first
    if let Ok(path) = std::env::var("NODE_BINARY") {
        if !path.is_empty() && PathBuf::from(&path).exists() {
            return Some(path);
        }
    }

    // Get home directory for user-specific paths
    let home = std::env::var("HOME").ok();

    // Common node installation locations on macOS
    let mut candidates: Vec<PathBuf> = vec![
        // Homebrew on Apple Silicon
        PathBuf::from("/opt/homebrew/bin/node"),
        // Homebrew on Intel
        PathBuf::from("/usr/local/bin/node"),
        // System node
        PathBuf::from("/usr/bin/node"),
    ];

    // Add NVM paths if home is available
    if let Some(ref h) = home {
        let nvm_dir = PathBuf::from(h).join(".nvm/versions/node");
        if nvm_dir.exists() {
            // Try to find the default or latest node version
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                let mut versions: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .collect();
                // Sort by name descending to get latest version first
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for version in versions {
                    let node_path = version.path().join("bin/node");
                    if node_path.exists() {
                        candidates.insert(0, node_path);
                        break;
                    }
                }
            }
        }

        // Also check fnm (Fast Node Manager)
        let fnm_dir = PathBuf::from(h).join(".fnm/node-versions");
        if fnm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&fnm_dir) {
                let mut versions: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .collect();
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
                for version in versions {
                    let node_path = version.path().join("installation/bin/node");
                    if node_path.exists() {
                        candidates.insert(0, node_path);
                        break;
                    }
                }
            }
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            debug!(path = %candidate.display(), "Found node binary");
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Try which as last resort
    if let Ok(output) = std::process::Command::new("which").arg("node").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() && PathBuf::from(&path).exists() {
                return Some(path);
            }
        }
    }

    None
}

/// Return an isolated XDG_DATA_HOME directory for an OpenCode environment.
///
/// OpenCode stores its SQLite database at `$XDG_DATA_HOME/opencode/opencode.db`.
/// The default `~/.local/share` is shared by all instances, and SQLite's locking
/// protocol does not support concurrent writers.  By giving each `opencode serve`
/// process its own data home we avoid "database is locked" errors when multiple
/// local environments are active simultaneously.
pub fn isolated_opencode_data_home(environment_id: &str) -> Option<String> {
    let xdg_base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| get_home_dir().map(|h| h.join(".local").join("share")))?;
    let isolated = xdg_base
        .join("orkestrator-ai")
        .join("opencode-data")
        .join(environment_id);
    Some(isolated.to_string_lossy().to_string())
}

/// Symlink shared OpenCode files (auth tokens, etc.) from the default data
/// directory into an isolated `opencode/` subdirectory.
///
/// This ensures OAuth credentials and other shared state are accessible
/// while keeping the SQLite database isolated per environment.
fn shared_opencode_data_dir() -> Option<PathBuf> {
    let xdg_base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| get_home_dir().map(|h| h.join(".local").join("share")))?;

    Some(xdg_base.join("opencode"))
}

fn symlink_shared_opencode_files(isolated_opencode_dir: &Path) {
    let default_opencode_dir = shared_opencode_data_dir();

    let Some(source_dir) = default_opencode_dir else {
        return;
    };

    if !source_dir.exists() {
        return;
    }

    // Files that should be shared (not isolated) across environments
    let shared_files = ["auth.json"];

    for filename in &shared_files {
        let source = source_dir.join(filename);
        let target = isolated_opencode_dir.join(filename);

        if !source.exists() {
            continue;
        }

        // Skip if target already exists (could be a symlink or real file)
        if target.exists() || target.symlink_metadata().is_ok() {
            continue;
        }

        #[cfg(unix)]
        {
            if let Err(e) = std::os::unix::fs::symlink(&source, &target) {
                warn!(
                    source = %source.display(),
                    target = %target.display(),
                    error = %e,
                    "Failed to symlink shared OpenCode file"
                );
            } else {
                debug!(
                    source = %source.display(),
                    target = %target.display(),
                    "Symlinked shared OpenCode file"
                );
            }
        }

        #[cfg(windows)]
        {
            if let Err(e) = std::os::windows::fs::symlink_file(&source, &target) {
                warn!(
                    source = %source.display(),
                    target = %target.display(),
                    error = %e,
                    "Failed to symlink shared OpenCode file"
                );
            }
        }
    }
}

/// Reset isolated SQLite artifacts before starting a fresh local OpenCode server.
///
/// The per-environment database is only used to avoid cross-environment locking,
/// and it can become unusable after interrupted runs, later surfacing as
/// `SQLiteError: disk I/O error` when native tabs create sessions. Keep shared
/// auth/config intact, but drop the isolated database so OpenCode can recreate it.
fn reset_isolated_opencode_database(isolated_opencode_dir: &Path) {
    for filename in ["opencode.db", "opencode.db-shm", "opencode.db-wal"] {
        let path = isolated_opencode_dir.join(filename);
        if !path.exists() {
            continue;
        }

        if let Err(error) = std::fs::remove_file(&path) {
            warn!(
                path = %path.display(),
                error = %error,
                "Failed to remove stale isolated OpenCode database file"
            );
        } else {
            debug!(
                path = %path.display(),
                "Removed stale isolated OpenCode database file"
            );
        }
    }
}

/// Clean up stale local server processes from a previous app session.
///
/// This should be called during app startup. It iterates all local environments,
/// checks any stored PIDs, and either:
/// - Recovers healthy processes into the process manager (so they can be reused)
/// - Kills unhealthy/stale processes and clears their PIDs from storage
/// - Clears dead PIDs from storage
///
/// This prevents the common issue where restarting the app leaves orphaned bridge
/// processes holding ports, causing new servers to fail to start.
pub async fn cleanup_stale_local_servers() {
    use crate::storage::get_storage;
    use serde_json::json;

    let storage = match get_storage() {
        Ok(s) => s,
        Err(e) => {
            warn!("Failed to get storage for stale server cleanup: {}", e);
            STARTUP_CLEANUP_COMPLETE.store(true, Ordering::Release);
            return;
        }
    };

    let environments = match storage.get_all_environments() {
        Ok(envs) => envs,
        Err(e) => {
            warn!(
                "Failed to load environments for stale server cleanup: {}",
                e
            );
            STARTUP_CLEANUP_COMPLETE.store(true, Ordering::Release);
            return;
        }
    };

    let manager = get_process_manager();

    for env in environments {
        if !env.is_local() {
            continue;
        }

        let env_id = &env.id;

        // Check each server type: OpenCode, Claude-bridge, Codex-bridge
        let servers: Vec<(ProcessType, Option<u32>, Option<u16>, &str)> = vec![
            (
                ProcessType::OpenCode,
                env.opencode_pid,
                env.local_opencode_port,
                "opencodePid",
            ),
            (
                ProcessType::ClaudeBridge,
                env.claude_bridge_pid,
                env.local_claude_port,
                "claudeBridgePid",
            ),
            (
                ProcessType::CodexBridge,
                env.codex_bridge_pid,
                env.local_codex_port,
                "codexBridgePid",
            ),
        ];

        for (process_type, stored_pid, stored_port, pid_field) in servers {
            let Some(pid) = stored_pid else {
                continue;
            };

            if !is_process_alive(pid) {
                // Process is dead — just clear the stale PID
                debug!(
                    environment_id = %env_id,
                    process_type = %process_type,
                    pid = pid,
                    "Clearing dead stale PID on startup"
                );
                if let Err(e) = storage.update_environment(env_id, json!({ pid_field: null })) {
                    debug!(
                        environment_id = %env_id,
                        pid_field = pid_field,
                        error = %e,
                        "Failed to clear dead PID from storage"
                    );
                }
                continue;
            }

            // Process is alive — verify it looks like one of our server processes
            // before taking any action. This guards against PID reuse by the OS.
            if !is_likely_server_process(pid, process_type) {
                warn!(
                    environment_id = %env_id,
                    process_type = %process_type,
                    pid = pid,
                    "Stored PID does not match expected server process, clearing without killing"
                );
                if let Err(e) = storage.update_environment(env_id, json!({ pid_field: null })) {
                    debug!(
                        environment_id = %env_id,
                        pid_field = pid_field,
                        error = %e,
                        "Failed to clear mismatched PID from storage"
                    );
                }
                continue;
            }

            // Process is alive and looks like ours — check if it's healthy
            let is_healthy = if let Some(port) = stored_port {
                check_server_health(port).await
            } else {
                false
            };

            if is_healthy {
                // Recover the healthy process into the manager so it can be reused
                info!(
                    environment_id = %env_id,
                    process_type = %process_type,
                    pid = pid,
                    port = ?stored_port,
                    "Recovered healthy server from previous session on startup"
                );
                manager.recover_from_pid(env_id, process_type, pid).await;
            } else {
                // Alive but unhealthy — kill it and free the port
                warn!(
                    environment_id = %env_id,
                    process_type = %process_type,
                    pid = pid,
                    port = ?stored_port,
                    "Killing stale unhealthy server on startup"
                );
                if let Err(e) = super::process::kill_process(pid) {
                    warn!(
                        environment_id = %env_id,
                        process_type = %process_type,
                        pid = pid,
                        error = %e,
                        "Failed to kill stale process"
                    );
                }
                if let Err(e) = storage.update_environment(env_id, json!({ pid_field: null })) {
                    debug!(
                        environment_id = %env_id,
                        pid_field = pid_field,
                        error = %e,
                        "Failed to clear stale PID from storage"
                    );
                }
            }
        }
    }

    info!("Stale local server cleanup completed");
    STARTUP_CLEANUP_COMPLETE.store(true, Ordering::Release);
}

/// Check if a process looks like one of our server processes by inspecting its
/// command line. This mitigates PID reuse — if the OS recycled the PID for an
/// unrelated process, we won't accidentally kill it.
#[cfg(unix)]
fn is_likely_server_process(pid: u32, process_type: ProcessType) -> bool {
    let Some(command_line) = read_process_command(pid, false) else {
        // Can't read the command — be conservative, assume it could be ours
        return true;
    };

    match process_type {
        ProcessType::OpenCode => is_opencode_server_command(&command_line),
        ProcessType::ClaudeBridge => {
            command_line.contains("claude-bridge") || command_line.contains("claude_bridge")
        }
        ProcessType::CodexBridge => {
            command_line.contains("codex-bridge") || command_line.contains("codex_bridge")
        }
    }
}

#[cfg(not(unix))]
fn is_likely_server_process(_pid: u32, _process_type: ProcessType) -> bool {
    // On non-Unix, we can't easily inspect the command — assume it's ours
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_check_server_health_no_server() {
        // This should return false since no server is running
        let result = check_server_health(59999).await;
        assert!(!result);
    }

    #[test]
    fn test_isolated_opencode_data_home() {
        let result = isolated_opencode_data_home("test-env-123");
        assert!(result.is_some());
        let path = result.unwrap();
        assert!(path.contains("orkestrator-ai/opencode-data/test-env-123"));
    }

    #[test]
    fn test_shared_opencode_data_dir_defaults_to_home() {
        let home = get_home_dir().expect("expected home directory for test");
        let expected = home.join(".local").join("share").join("opencode");

        assert_eq!(shared_opencode_data_dir(), Some(expected));
    }

    #[cfg(unix)]
    #[test]
    fn test_is_opencode_server_command() {
        assert!(is_opencode_server_command(
            "/usr/local/bin/opencode serve --port 14096"
        ));
        assert!(!is_opencode_server_command(
            "/usr/local/bin/opencode auth login"
        ));
        assert!(!is_opencode_server_command("/usr/bin/python worker.py"));
    }

    #[cfg(unix)]
    #[test]
    fn test_extract_env_var() {
        let process = "XDG_DATA_HOME=/tmp/opencode-data PATH=/usr/bin opencode serve --port 14096";
        assert_eq!(
            extract_env_var(process, "XDG_DATA_HOME").as_deref(),
            Some("/tmp/opencode-data")
        );
        assert_eq!(extract_env_var(process, "HOME"), None);
    }
}
