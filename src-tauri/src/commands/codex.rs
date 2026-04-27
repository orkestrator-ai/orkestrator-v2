// Codex bridge server management commands
// Handles starting, stopping, and checking the status of the Codex bridge server in containers

use crate::docker;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tracing::{debug, error, info, warn};

use std::sync::LazyLock;

/// Codex bridge server port inside the container
const CODEX_BRIDGE_PORT: u16 = 4098;

/// Maximum number of health check attempts when waiting for server startup
const SERVER_STARTUP_MAX_ATTEMPTS: u32 = 75;

/// Delay between health check attempts in milliseconds
const SERVER_STARTUP_POLL_INTERVAL_MS: u64 = 200;

/// Shared HTTP client with a 2-second timeout for health checks
static HEALTH_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .expect("Failed to build HTTP client")
});

const CONTAINER_CODEX_RAW_LOG_DIR: &str = "/tmp/orkestrator-ai/codex-raw";

/// Result of starting the Codex bridge server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServerStartResult {
    pub host_port: u16,
    pub was_running: bool,
}

/// Status of the Codex bridge server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServerStatus {
    pub running: bool,
    pub host_port: Option<u16>,
}

fn resolve_codex_bridge_path(#[allow(unused)] app_handle: &tauri::AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let workspace_root = PathBuf::from(manifest_dir)
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let dev_path = workspace_root.join("bridges").join("codex-bridge");
            if dev_path.exists() {
                debug!(path = %dev_path.display(), "Using dev codex-bridge path");
                return dev_path;
            }
        }
    }

    #[cfg(not(debug_assertions))]
    {
        if let Ok(bundled) = app_handle
            .path()
            .resolve("codex-bridge", tauri::path::BaseDirectory::Resource)
        {
            if bundled.exists() {
                debug!(path = %bundled.display(), "Using bundled codex-bridge path");
                return bundled;
            }
        }

        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let bundled = res_dir.join("codex-bridge");
            if bundled.exists() {
                debug!(path = %bundled.display(), "Using resource_dir codex-bridge path");
                return bundled;
            }
        }
    }

    PathBuf::from("bridges").join("codex-bridge")
}

fn collect_dist_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| {
        format!(
            "Failed to read Codex bridge dist directory {}: {}",
            dir.display(),
            e
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to read Codex bridge dist entry in {}: {}",
                dir.display(),
                e
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| {
            format!(
                "Failed to inspect Codex bridge dist entry {}: {}",
                path.display(),
                e
            )
        })?;

        if file_type.is_dir() {
            files.extend(collect_dist_files(&path)?);
        } else if file_type.is_file() {
            files.push(path);
        }
    }

    Ok(files)
}

fn resolve_container_dist_path(dist_path: &Path, dist_file_path: &Path) -> Result<String, String> {
    let relative_path = dist_file_path.strip_prefix(dist_path).map_err(|e| {
        format!(
            "Failed to resolve Codex bridge dist path {} relative to {}: {}",
            dist_file_path.display(),
            dist_path.display(),
            e
        )
    })?;

    Ok(format!(
        "/opt/codex-bridge/dist/{}",
        relative_path.to_string_lossy().replace('\\', "/")
    ))
}

fn build_codex_bridge_start_command(raw_event_logging: bool) -> String {
    let command = r#"
        cd /workspace
        rm -f /tmp/codex-bridge.log
        mkdir -p /tmp/orkestrator-ai
        source /etc/profile 2>/dev/null || true
        source ~/.profile 2>/dev/null || true
        source ~/.bashrc 2>/dev/null || true
        source ~/.zshrc 2>/dev/null || true
        source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
        orkestrator_source_runtime_env 2>/dev/null || true
        export PORT=4098
        export HOSTNAME=0.0.0.0
        export CWD=/workspace
        export CODEX_PATH="$(command -v codex 2>/dev/null || echo codex)"
        export ORKESTRATOR_CODEX_RAW_LOG_DIR="%CODEX_RAW_LOG_DIR%"
        setsid node /opt/codex-bridge/dist/index.js > /tmp/codex-bridge.log 2>&1 &
        disown
        sleep 0.5
        echo "Started Codex bridge server"
    "#;

    command.replace(
        "%CODEX_RAW_LOG_DIR%",
        if raw_event_logging {
            CONTAINER_CODEX_RAW_LOG_DIR
        } else {
            ""
        },
    )
}

async fn ensure_codex_bridge_present(
    app_handle: &tauri::AppHandle,
    client: &crate::docker::client::DockerClient,
    container_id: &str,
) -> Result<(), String> {
    let (_, _, bridge_exit_code) = client
        .exec_command_with_status(
            container_id,
            vec![
                "bash",
                "-lc",
                "test -f /opt/codex-bridge/package.json -a -f /opt/codex-bridge/dist/index.js",
            ],
        )
        .await
        .map_err(|e| format!("Failed to inspect Codex bridge in container: {}", e))?;

    let bridge_path = resolve_codex_bridge_path(app_handle);
    let package_json_path = bridge_path.join("package.json");
    let dist_path = bridge_path.join("dist");

    let package_json = fs::read(&package_json_path).map_err(|e| {
        format!(
            "Failed to read Codex bridge package.json from {}: {}",
            package_json_path.display(),
            e
        )
    })?;
    let dist_files = collect_dist_files(&dist_path)?;
    if dist_files.is_empty() {
        return Err(format!(
            "Codex bridge dist directory is empty: {}",
            dist_path.display()
        ));
    }

    client
        .exec_in_container(
            container_id,
            vec![
                "bash",
                "-lc",
                "rm -rf /opt/codex-bridge/dist && mkdir -p /opt/codex-bridge/dist",
            ],
            None,
        )
        .await
        .map_err(|e| {
            format!(
                "Failed to create Codex bridge directory in container: {}",
                e
            )
        })?;

    client
        .upload_file_to_container(container_id, "/opt/codex-bridge/package.json", package_json)
        .await
        .map_err(|e| format!("Failed to upload Codex bridge package.json: {}", e))?;

    for dist_file_path in dist_files {
        let container_path = resolve_container_dist_path(&dist_path, &dist_file_path)?;
        let dist_file = fs::read(&dist_file_path).map_err(|e| {
            format!(
                "Failed to read Codex bridge dist file {}: {}",
                dist_file_path.display(),
                e
            )
        })?;
        if let Some(parent) = Path::new(&container_path).parent() {
            let parent = parent.to_string_lossy().to_string();
            client
                .exec_in_container(container_id, vec!["mkdir", "-p", &parent], None)
                .await
                .map_err(|e| {
                    format!(
                        "Failed to create Codex bridge dist directory {}: {}",
                        parent, e
                    )
                })?;
        }
        client
            .upload_file_to_container(container_id, &container_path, dist_file)
            .await
            .map_err(|e| {
                format!(
                    "Failed to upload Codex bridge dist file {}: {}",
                    container_path, e
                )
            })?;
    }

    let (_, _, node_modules_exit_code) = client
        .exec_command_with_status(
            container_id,
            vec!["bash", "-lc", "test -d /opt/codex-bridge/node_modules"],
        )
        .await
        .map_err(|e| format!("Failed to inspect Codex bridge dependencies: {}", e))?;

    if bridge_exit_code == 0 && node_modules_exit_code == 0 {
        debug!(container_id = %container_id, "Synced Codex bridge bundle into container");
        return Ok(());
    }

    info!(container_id = %container_id, "Bootstrapping Codex bridge dependencies into container");

    let (stdout, stderr, install_exit_code) = client
        .exec_command_with_status(
            container_id,
            vec![
                "bash",
                "-lc",
                "cd /opt/codex-bridge && npm install --omit=dev --no-audit --no-fund",
            ],
        )
        .await
        .map_err(|e| format!("Failed to install Codex bridge dependencies: {}", e))?;

    if install_exit_code != 0 {
        return Err(format!(
            "Failed to install Codex bridge dependencies (exit {}): {}{}{}",
            install_exit_code,
            stdout.trim(),
            if !stdout.trim().is_empty() && !stderr.trim().is_empty() {
                "\n"
            } else {
                ""
            },
            stderr.trim()
        ));
    }

    Ok(())
}

use super::load_codex_bridge_raw_event_logging;

#[tauri::command]
pub async fn start_codex_server(
    app_handle: tauri::AppHandle,
    container_id: String,
) -> Result<CodexServerStartResult, String> {
    info!(container_id = %container_id, "Starting Codex bridge server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    let host_port = client
        .get_host_port(&container_id, CODEX_BRIDGE_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Codex bridge server port (4098) is not mapped".to_string())?;

    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    if let Ok(response) = HEALTH_CLIENT.get(&health_url).send().await {
        if response.status().is_success() {
            return Ok(CodexServerStartResult {
                host_port,
                was_running: true,
            });
        }
    }

    ensure_codex_bridge_present(&app_handle, &client, &container_id).await?;
    let raw_event_logging = load_codex_bridge_raw_event_logging()?;

    let command = build_codex_bridge_start_command(raw_event_logging);

    let exec_result = client
        .exec_in_container(&container_id, vec!["bash", "-c", &command], None)
        .await
        .map_err(|e| format!("Failed to start Codex bridge server: {}", e))?;

    debug!(container_id = %container_id, result = %exec_result, "Exec result from starting Codex bridge server");

    let mut attempts: u32 = 0;
    loop {
        attempts += 1;
        tokio::time::sleep(tokio::time::Duration::from_millis(
            SERVER_STARTUP_POLL_INTERVAL_MS,
        ))
        .await;

        match HEALTH_CLIENT.get(&health_url).send().await {
            Ok(response) => {
                if response.status().is_success() {
                    info!(container_id = %container_id, host_port = host_port, attempts = attempts, "Codex bridge server started successfully");
                    return Ok(CodexServerStartResult {
                        host_port,
                        was_running: false,
                    });
                }
            }
            Err(error) => {
                debug!(container_id = %container_id, error = %error, attempts = attempts, "Codex bridge health check failed");
            }
        }

        if attempts >= SERVER_STARTUP_MAX_ATTEMPTS {
            if let Ok(log_content) = client
                .exec_in_container(&container_id, vec!["cat", "/tmp/codex-bridge.log"], None)
                .await
            {
                error!(container_id = %container_id, log = %log_content, "Codex bridge log on timeout");
            }

            if let Ok((stdout, stderr, exit_code)) = client
                .exec_command_with_status(
                    &container_id,
                    vec![
                        "bash",
                        "-lc",
                        "test -f /opt/codex-bridge/dist/index.js; echo dist:$?; test -d /opt/codex-bridge/node_modules; echo node_modules:$?; pgrep -f '/opt/codex-bridge/dist/index.js' || true",
                    ],
                )
                .await
            {
                error!(
                    container_id = %container_id,
                    stdout = %stdout,
                    stderr = %stderr,
                    exit_code = exit_code,
                    "Codex bridge process/bootstrap status on timeout"
                );
            }

            warn!(container_id = %container_id, "Codex bridge server did not start within timeout");
            return Err("Codex bridge server did not start within timeout".to_string());
        }
    }
}

#[tauri::command]
pub async fn stop_codex_server(container_id: String) -> Result<(), String> {
    info!(container_id = %container_id, "Stopping Codex bridge server");

    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(());
    }

    client
        .exec_in_container(
            &container_id,
            vec!["bash", "-c", "pkill -f 'codex-bridge' || true"],
            None,
        )
        .await
        .map_err(|e| format!("Failed to stop Codex bridge server: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_codex_server_log(container_id: String) -> Result<String, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    let log_content = client
        .exec_in_container(&container_id, vec!["cat", "/tmp/codex-bridge.log"], None)
        .await
        .map_err(|e| format!("Failed to read log: {}", e))?;

    if log_content.trim().is_empty() {
        return Ok("Codex bridge log is empty".to_string());
    }

    Ok(log_content)
}

#[tauri::command]
pub async fn get_codex_server_status(container_id: String) -> Result<CodexServerStatus, String> {
    let client = docker::client::get_docker_client().map_err(|e| e.to_string())?;
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Ok(CodexServerStatus {
            running: false,
            host_port: None,
        });
    }

    let host_port = match client
        .get_host_port(&container_id, CODEX_BRIDGE_PORT, "tcp")
        .await
        .map_err(|e| e.to_string())?
    {
        Some(port) => port,
        None => {
            return Ok(CodexServerStatus {
                running: false,
                host_port: None,
            });
        }
    };

    let health_url = format!("http://127.0.0.1:{}/global/health", host_port);
    let running = match HEALTH_CLIENT.get(&health_url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    Ok(CodexServerStatus {
        running,
        host_port: if running { Some(host_port) } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs as std_fs;
    use tempfile::tempdir;

    fn relative_paths(root: &Path, files: Vec<PathBuf>) -> Vec<String> {
        let mut paths: Vec<String> = files
            .into_iter()
            .map(|path| {
                path.strip_prefix(root)
                    .expect("file should be under root")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn collect_dist_files_recurses_and_returns_only_files() {
        let temp = tempdir().expect("create temp dir");
        let dist = temp.path().join("dist");
        let nested = dist.join("chunks");
        std_fs::create_dir_all(&nested).expect("create nested dir");
        std_fs::write(dist.join("index.js"), "entry").expect("write entry");
        std_fs::write(nested.join("worker.js"), "worker").expect("write nested file");
        std_fs::create_dir_all(dist.join("empty-dir")).expect("create empty dir");

        let files = collect_dist_files(&dist).expect("collect files");

        assert_eq!(
            relative_paths(&dist, files),
            vec!["chunks/worker.js".to_string(), "index.js".to_string()]
        );
    }

    #[test]
    fn collect_dist_files_returns_empty_for_empty_directory() {
        let temp = tempdir().expect("create temp dir");

        let files = collect_dist_files(temp.path()).expect("collect empty directory");

        assert!(files.is_empty());
    }

    #[test]
    fn collect_dist_files_reports_missing_directory() {
        let temp = tempdir().expect("create temp dir");
        let missing = temp.path().join("missing-dist");

        let error = collect_dist_files(&missing).expect_err("missing directory should error");

        assert!(error.contains("Failed to read Codex bridge dist directory"));
        assert!(error.contains("missing-dist"));
    }

    #[test]
    fn resolve_container_dist_path_preserves_nested_relative_path() {
        let dist = Path::new("/repo/bridges/codex-bridge/dist");
        let file = dist.join("chunks").join("worker.js");

        let container_path = resolve_container_dist_path(dist, &file).expect("resolve path");

        assert_eq!(container_path, "/opt/codex-bridge/dist/chunks/worker.js");
    }

    #[test]
    fn resolve_container_dist_path_rejects_files_outside_dist() {
        let dist = Path::new("/repo/bridges/codex-bridge/dist");
        let file = Path::new("/repo/bridges/codex-bridge/package.json");

        let error = resolve_container_dist_path(dist, file).expect_err("outside file should error");

        assert!(error.contains("Failed to resolve Codex bridge dist path"));
    }

    #[test]
    fn build_codex_bridge_start_command_includes_raw_log_dir_when_enabled() {
        let command = build_codex_bridge_start_command(true);

        assert!(command.contains(&format!(
            "export ORKESTRATOR_CODEX_RAW_LOG_DIR=\"{}\"",
            CONTAINER_CODEX_RAW_LOG_DIR
        )));
        assert!(command.contains("source /usr/local/bin/orkestrator-runtime-env.sh"));
        assert!(command.contains("orkestrator_source_runtime_env"));
        assert!(command.contains("setsid node /opt/codex-bridge/dist/index.js"));
        assert!(!command.contains("%CODEX_RAW_LOG_DIR%"));
    }

    #[test]
    fn build_codex_bridge_start_command_omits_raw_log_dir_when_disabled() {
        let command = build_codex_bridge_start_command(false);

        assert!(command.contains("export ORKESTRATOR_CODEX_RAW_LOG_DIR=\"\""));
        assert!(!command.contains(CONTAINER_CODEX_RAW_LOG_DIR));
        assert!(!command.contains("%CODEX_RAW_LOG_DIR%"));
    }
}
