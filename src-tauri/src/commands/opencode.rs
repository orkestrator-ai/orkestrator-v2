// OpenCode server management commands
// Handles starting, stopping, and checking the status of the OpenCode server in containers

use crate::docker;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{debug, error, info, warn};

/// OpenCode server port inside the container
const OPENCODE_SERVER_PORT: u16 = 4096;

/// Maximum number of health check attempts when waiting for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;

/// Delay between health check attempts in milliseconds
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

fn build_opencode_server_start_command() -> &'static str {
    r#"
        cd /workspace
        rm -f /tmp/opencode-serve.log
        source /etc/profile 2>/dev/null || true
        source ~/.profile 2>/dev/null || true
        source ~/.bashrc 2>/dev/null || true
        source ~/.zshrc 2>/dev/null || true
        source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
        orkestrator_source_runtime_env 2>/dev/null || true
        OPENCODE_BIN="${OPENCODE_CLI_PATH:-}"
        if [ -n "$OPENCODE_BIN" ] && [ ! -x "$OPENCODE_BIN" ]; then
            OPENCODE_BIN=""
        fi
        if [ -z "$OPENCODE_BIN" ] && [ -x /home/node/.opencode/bin/opencode ]; then
            OPENCODE_BIN="/home/node/.opencode/bin/opencode"
        fi
        if [ -z "$OPENCODE_BIN" ]; then
            OPENCODE_BIN="$(command -v opencode 2>/dev/null || true)"
        fi
        if [ -z "$OPENCODE_BIN" ]; then
            echo "OpenCode binary not found. PATH=$PATH" > /tmp/opencode-serve.log
            exit 1
        fi
        setsid "$OPENCODE_BIN" serve --port 4096 --hostname 0.0.0.0 > /tmp/opencode-serve.log 2>&1 &
        disown
        sleep 0.5
        echo "Started opencode serve"
    "#
}

/// Result of starting the OpenCode server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeServerStartResult {
    /// The host port mapped to the server
    pub host_port: u16,
    /// Whether the server was already running
    pub was_running: bool,
}

/// Status of the OpenCode server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeServerStatus {
    /// Whether the server is running
    pub running: bool,
    /// The host port if running
    pub host_port: Option<u16>,
}

/// Model reference in OpenCode model preferences (provider/model pair)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OpenCodeModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

/// OpenCode model preferences from ~/.local/state/opencode/model.json
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OpenCodeModelPreferences {
    #[serde(default)]
    pub recent: Vec<OpenCodeModelRef>,
    #[serde(default)]
    pub favorite: Vec<OpenCodeModelRef>,
    #[serde(default)]
    pub variant: HashMap<String, String>,
}

fn load_opencode_model_preferences_from_path(
    model_path: &std::path::Path,
) -> OpenCodeModelPreferences {
    if !model_path.exists() || !model_path.is_file() {
        debug!(path = %model_path.display(), "OpenCode model.json not found");
        return OpenCodeModelPreferences::default();
    }

    let content = match std::fs::read_to_string(model_path) {
        Ok(content) => content,
        Err(error) => {
            warn!(path = %model_path.display(), error = %error, "Failed to read OpenCode model.json");
            return OpenCodeModelPreferences::default();
        }
    };

    match serde_json::from_str::<OpenCodeModelPreferences>(&content) {
        Ok(preferences) => preferences,
        Err(error) => {
            warn!(path = %model_path.display(), error = %error, "Failed to parse OpenCode model.json");
            OpenCodeModelPreferences::default()
        }
    }
}

/// Get OpenCode model preferences from ~/.local/state/opencode/model.json
#[tauri::command]
pub async fn get_opencode_model_preferences() -> Result<OpenCodeModelPreferences, String> {
    let Some(home) = dirs::home_dir() else {
        warn!("Failed to resolve home directory for OpenCode model preferences");
        return Ok(OpenCodeModelPreferences::default());
    };

    let model_path = home
        .join(".local")
        .join("state")
        .join("opencode")
        .join("model.json");

    Ok(load_opencode_model_preferences_from_path(&model_path))
}

/// Start the OpenCode server in a container
/// Runs `opencode serve` in the container's workspace directory
#[tauri::command]
pub async fn start_opencode_server(
    container_id: String,
) -> Result<OpenCodeServerStartResult, String> {
    info!(container_id = %container_id, "Starting OpenCode server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Get the host port for the OpenCode server
    let host_port = client
        .get_host_port(&container_id, OPENCODE_SERVER_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "OpenCode server port (4096) is not mapped".to_string())?;

    // Check if server is already running by trying to ping it
    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let base_url = format!("http://127.0.0.1:{}", host_port);
    debug!(container_id = %container_id, base_url = %base_url, health_url = %health_url, "OpenCode server URLs");
    if let Ok(response) = reqwest::get(&health_url).await {
        if response.status().is_success() {
            debug!(container_id = %container_id, host_port = host_port, "OpenCode server already running");
            return Ok(OpenCodeServerStartResult {
                host_port,
                was_running: true,
            });
        }
    }

    // Start the server in the background using docker exec.
    // Use setsid to create a new session so the process survives exec termination.
    // Source the captured runtime environment so user-installed tools from
    // setup scripts are visible to the server and agent subprocesses.
    // --port 4096: listen on the mapped container port
    // --hostname 0.0.0.0: bind to all interfaces so it's accessible from host
    let command = build_opencode_server_start_command();

    // Execute the command in the container
    let (exec_stdout, exec_stderr, exec_exit_code) = client
        .exec_command_with_status(&container_id, vec!["bash", "-c", command])
        .await
        .map_err(|e| format!("Failed to start OpenCode server: {}", e))?;

    if exec_exit_code != 0 {
        let startup_log = client
            .exec_in_container(
                &container_id,
                vec![
                    "bash",
                    "-c",
                    "cat /tmp/opencode-serve.log 2>/dev/null || true",
                ],
                None,
            )
            .await
            .unwrap_or_default();

        let detail = if !startup_log.trim().is_empty() {
            startup_log.trim().to_string()
        } else if !exec_stderr.trim().is_empty() {
            exec_stderr.trim().to_string()
        } else if !exec_stdout.trim().is_empty() {
            exec_stdout.trim().to_string()
        } else {
            "Unknown error while launching OpenCode server".to_string()
        };

        error!(
            container_id = %container_id,
            exit_code = exec_exit_code,
            stdout = %exec_stdout,
            stderr = %exec_stderr,
            startup_log = %startup_log,
            "OpenCode startup command failed"
        );

        return Err(format!(
            "Failed to launch OpenCode server (exit code {}): {}",
            exec_exit_code, detail
        ));
    }

    debug!(
        container_id = %container_id,
        exit_code = exec_exit_code,
        stdout = %exec_stdout,
        stderr = %exec_stderr,
        "Exec result from starting OpenCode server"
    );

    // Wait for the server to start (poll health endpoint)
    // OpenCode server may need time to initialize, especially on first run
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
                    info!(container_id = %container_id, host_port = host_port, attempts = attempts, "OpenCode server started successfully");
                    return Ok(OpenCodeServerStartResult {
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
                .exec_in_container(&container_id, vec!["cat", "/tmp/opencode-serve.log"], None)
                .await;

            if let Ok(log_content) = log_result {
                error!(container_id = %container_id, log = %log_content, "OpenCode server log on timeout");
            }

            // Also check if process is running
            let ps_result = client
                .exec_in_container(
                    &container_id,
                    vec![
                        "bash",
                        "-c",
                        "pgrep -f 'opencode serve' || echo 'No process found'",
                    ],
                    None,
                )
                .await;

            if let Ok(ps_output) = ps_result {
                error!(container_id = %container_id, ps = %ps_output, "Process check on timeout");
            }

            warn!(container_id = %container_id, "OpenCode server did not start within timeout");
            return Err("OpenCode server did not start within timeout".to_string());
        }
    }
}

/// Stop the OpenCode server in a container
#[tauri::command]
pub async fn stop_opencode_server(container_id: String) -> Result<(), String> {
    info!(container_id = %container_id, "Stopping OpenCode server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(()); // Nothing to stop if container isn't running
    }

    // Kill the opencode serve process
    let command = "pkill -f 'opencode serve' || true";

    client
        .exec_in_container(&container_id, vec!["bash", "-c", command], None)
        .await
        .map_err(|e| format!("Failed to stop OpenCode server: {}", e))?;

    info!(container_id = %container_id, "OpenCode server stopped");
    Ok(())
}

/// Get the OpenCode server log from a container (for debugging)
#[tauri::command]
pub async fn get_opencode_server_log(container_id: String) -> Result<String, String> {
    debug!(container_id = %container_id, "Getting OpenCode server log");

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
        .exec_in_container(&container_id, vec!["cat", "/tmp/opencode-serve.log"], None)
        .await
        .map_err(|e| format!("Failed to read log: {}", e))?;

    Ok(log_content)
}

/// Get the status of the OpenCode server in a container
#[tauri::command]
pub async fn get_opencode_server_status(
    container_id: String,
) -> Result<OpenCodeServerStatus, String> {
    debug!(container_id = %container_id, "Checking OpenCode server status");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(OpenCodeServerStatus {
            running: false,
            host_port: None,
        });
    }

    // Get the host port
    let host_port = match client
        .get_host_port(&container_id, OPENCODE_SERVER_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
    {
        Some(port) => port,
        None => {
            return Ok(OpenCodeServerStatus {
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

    Ok(OpenCodeServerStatus {
        running,
        host_port: if running { Some(host_port) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn model_preferences_defaults_for_missing_file() {
        let temp = tempdir().expect("create temp dir");
        let missing_path = temp.path().join("missing-model.json");

        let preferences = load_opencode_model_preferences_from_path(&missing_path);

        assert!(preferences.recent.is_empty());
        assert!(preferences.favorite.is_empty());
        assert!(preferences.variant.is_empty());
    }

    #[test]
    fn model_preferences_defaults_for_invalid_json() {
        let temp = tempdir().expect("create temp dir");
        let model_path = temp.path().join("model.json");
        fs::write(&model_path, "{ not-valid-json").expect("write invalid json");

        let preferences = load_opencode_model_preferences_from_path(&model_path);

        assert!(preferences.recent.is_empty());
        assert!(preferences.favorite.is_empty());
        assert!(preferences.variant.is_empty());
    }

    #[test]
    fn model_preferences_parses_valid_json() {
        let temp = tempdir().expect("create temp dir");
        let model_path = temp.path().join("model.json");

        let json = r#"{
            "recent": [{"providerID": "anthropic", "modelID": "claude-3-7-sonnet"}],
            "favorite": [{"providerID": "openai", "modelID": "gpt-5"}],
            "variant": {"anthropic/claude-3-7-sonnet": "fast"}
        }"#;
        fs::write(&model_path, json).expect("write valid json");

        let preferences = load_opencode_model_preferences_from_path(&model_path);

        assert_eq!(preferences.recent.len(), 1);
        assert_eq!(preferences.recent[0].provider_id, "anthropic");
        assert_eq!(preferences.recent[0].model_id, "claude-3-7-sonnet");

        assert_eq!(preferences.favorite.len(), 1);
        assert_eq!(preferences.favorite[0].provider_id, "openai");
        assert_eq!(preferences.favorite[0].model_id, "gpt-5");

        assert_eq!(
            preferences.variant.get("anthropic/claude-3-7-sonnet"),
            Some(&"fast".to_string())
        );
    }

    #[test]
    fn build_opencode_server_start_command_sources_runtime_environment() {
        let command = build_opencode_server_start_command();

        assert!(command.contains("source /usr/local/bin/orkestrator-runtime-env.sh"));
        assert!(command.contains("orkestrator_source_runtime_env"));
        assert!(command.contains("OPENCODE_BIN=\"${OPENCODE_CLI_PATH:-}\""));
        assert!(command.contains("/home/node/.opencode/bin/opencode"));
        assert!(command.contains("OPENCODE_BIN=\"$(command -v opencode"));
        assert!(command.contains("serve --port 4096 --hostname 0.0.0.0"));
    }
}
