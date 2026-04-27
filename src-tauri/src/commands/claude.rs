// Claude bridge server management commands
// Handles starting, stopping, and checking the status of the Claude bridge server in containers

use crate::docker;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

/// Claude bridge server port inside the container
const CLAUDE_BRIDGE_PORT: u16 = 4097;

/// Maximum number of health check attempts when waiting for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;

/// Delay between health check attempts in milliseconds
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

fn build_claude_bridge_start_command() -> &'static str {
    r#"
        cd /workspace
        rm -f /tmp/claude-bridge.log
        source /etc/profile 2>/dev/null || true
        source ~/.profile 2>/dev/null || true
        source ~/.bashrc 2>/dev/null || true
        source ~/.zshrc 2>/dev/null || true
        source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
        orkestrator_source_runtime_env 2>/dev/null || true
        export PORT=4097
        export HOSTNAME=0.0.0.0
        setsid node /opt/claude-bridge/dist/index.js > /tmp/claude-bridge.log 2>&1 &
        disown
        sleep 0.5
        echo "Started Claude bridge server"
    "#
}

/// Result of starting the Claude bridge server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeServerStartResult {
    /// The host port mapped to the server
    pub host_port: u16,
    /// Whether the server was already running
    pub was_running: bool,
}

/// Status of the Claude bridge server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeServerStatus {
    /// Whether the server is running
    pub running: bool,
    /// The host port if running
    pub host_port: Option<u16>,
}

/// Start the Claude bridge server in a container
/// Runs the Node.js bridge server in the container's workspace directory
#[tauri::command]
pub async fn start_claude_server(container_id: String) -> Result<ClaudeServerStartResult, String> {
    info!(container_id = %container_id, "Starting Claude bridge server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Get the host port for the Claude bridge server
    let host_port = client
        .get_host_port(&container_id, CLAUDE_BRIDGE_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Claude bridge server port (4097) is not mapped".to_string())?;

    // Check if server is already running by trying to ping it
    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let base_url = format!("http://127.0.0.1:{}", host_port);
    debug!(container_id = %container_id, base_url = %base_url, health_url = %health_url, "Claude bridge server URLs");
    if let Ok(response) = reqwest::get(&health_url).await {
        if response.status().is_success() {
            debug!(container_id = %container_id, host_port = host_port, "Claude bridge server already running");
            return Ok(ClaudeServerStartResult {
                host_port,
                was_running: true,
            });
        }
    }

    // Start the server in the background using docker exec
    // Use setsid to create a new session so the process survives exec termination
    // --port 4097: listen on the mapped container port
    // PORT and HOSTNAME are set as environment variables
    // Source the captured runtime environment so agent subprocesses inherit
    // PATH modifications from setup scripts.
    let command = build_claude_bridge_start_command();

    // Execute the command in the container
    let exec_result = client
        .exec_in_container(&container_id, vec!["bash", "-c", command], None)
        .await
        .map_err(|e| format!("Failed to start Claude bridge server: {}", e))?;

    debug!(container_id = %container_id, result = %exec_result, "Exec result from starting Claude bridge server");

    // Wait for the server to start (poll health endpoint)
    // The server may need time to initialize
    let mut attempts: u32 = 0;

    loop {
        attempts += 1;
        tokio::time::sleep(tokio::time::Duration::from_millis(
            SERVER_STARTUP_POLL_INTERVAL_MS,
        ))
        .await;

        // Check health endpoint
        match reqwest::get(&health_url).await {
            Ok(response) => {
                if response.status().is_success() {
                    info!(container_id = %container_id, host_port = host_port, attempts = attempts, "Claude bridge server started successfully");
                    return Ok(ClaudeServerStartResult {
                        host_port,
                        was_running: false,
                    });
                }
                debug!(container_id = %container_id, status = %response.status(), attempts = attempts, "Health check returned non-success status");
            }
            Err(e) => {
                debug!(container_id = %container_id, error = %e, attempts = attempts, "Health check failed");
            }
        }

        if attempts >= SERVER_STARTUP_MAX_ATTEMPTS {
            // Read server log for debugging before returning error
            let log_result = client
                .exec_in_container(&container_id, vec!["cat", "/tmp/claude-bridge.log"], None)
                .await;

            if let Ok(log_content) = log_result {
                error!(container_id = %container_id, log = %log_content, "Claude bridge server log on timeout");
            }

            // Also check if process is running
            let ps_result = client
                .exec_in_container(
                    &container_id,
                    vec![
                        "bash",
                        "-c",
                        "pgrep -f 'claude-bridge' || echo 'No process found'",
                    ],
                    None,
                )
                .await;

            if let Ok(ps_output) = ps_result {
                error!(container_id = %container_id, ps = %ps_output, "Process check on timeout");
            }

            warn!(container_id = %container_id, "Claude bridge server did not start within timeout");
            return Err("Claude bridge server did not start within timeout".to_string());
        }
    }
}

/// Stop the Claude bridge server in a container
#[tauri::command]
pub async fn stop_claude_server(container_id: String) -> Result<(), String> {
    info!(container_id = %container_id, "Stopping Claude bridge server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(()); // Nothing to stop if container isn't running
    }

    // Kill the claude-bridge process
    let command = "pkill -f 'claude-bridge' || true";

    client
        .exec_in_container(&container_id, vec!["bash", "-c", command], None)
        .await
        .map_err(|e| format!("Failed to stop Claude bridge server: {}", e))?;

    info!(container_id = %container_id, "Claude bridge server stopped");
    Ok(())
}

/// Get the Claude bridge server log from a container (for debugging)
#[tauri::command]
pub async fn get_claude_server_log(container_id: String) -> Result<String, String> {
    debug!(container_id = %container_id, "Getting Claude bridge server log");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Read the log file
    let log_content = client
        .exec_in_container(&container_id, vec!["cat", "/tmp/claude-bridge.log"], None)
        .await
        .map_err(|e| format!("Failed to read log: {}", e))?;

    Ok(log_content)
}

/// Get the status of the Claude bridge server in a container
#[tauri::command]
pub async fn get_claude_server_status(container_id: String) -> Result<ClaudeServerStatus, String> {
    debug!(container_id = %container_id, "Checking Claude bridge server status");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(ClaudeServerStatus {
            running: false,
            host_port: None,
        });
    }

    // Get the host port
    let host_port = match client
        .get_host_port(&container_id, CLAUDE_BRIDGE_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
    {
        Some(port) => port,
        None => {
            return Ok(ClaudeServerStatus {
                running: false,
                host_port: None,
            });
        }
    };

    // Check if server is responding
    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let running = match reqwest::get(&health_url).await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    Ok(ClaudeServerStatus {
        running,
        host_port: if running { Some(host_port) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_claude_bridge_start_command_sources_runtime_environment() {
        let command = build_claude_bridge_start_command();

        assert!(command.contains("source /usr/local/bin/orkestrator-runtime-env.sh"));
        assert!(command.contains("orkestrator_source_runtime_env"));
        assert!(command.contains("setsid node /opt/claude-bridge/dist/index.js"));
        assert!(command.contains("export PORT=4097"));
    }
}
