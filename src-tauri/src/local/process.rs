//! Process management for local environment servers
//!
//! Handles spawning, tracking, and killing child processes for
//! OpenCode and Claude-bridge servers in local environments.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// Type of server process
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProcessType {
    OpenCode,
    ClaudeBridge,
    CodexBridge,
}

impl std::fmt::Display for ProcessType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcessType::OpenCode => write!(f, "opencode"),
            ProcessType::ClaudeBridge => write!(f, "claude-bridge"),
            ProcessType::CodexBridge => write!(f, "codex-bridge"),
        }
    }
}

/// Handle to a running process
pub struct ProcessHandle {
    pub pid: u32,
    #[allow(dead_code)]
    pub process_type: ProcessType,
    child: Option<Child>,
}

impl ProcessHandle {
    /// Create a new handle from a spawned child process
    pub fn from_child(child: Child, process_type: ProcessType) -> Option<Self> {
        let pid = child.id()?;
        Some(Self {
            pid,
            process_type,
            child: Some(child),
        })
    }

    /// Create a handle for a recovered process (PID only, no child handle)
    pub fn recovered(pid: u32, process_type: ProcessType) -> Self {
        Self {
            pid,
            process_type,
            child: None,
        }
    }

    /// Kill this process
    pub async fn kill(&mut self) -> Result<(), std::io::Error> {
        if let Some(ref mut child) = self.child {
            // Try graceful shutdown first
            child.kill().await?;
        } else {
            // For recovered processes, use the kill command
            kill_process(self.pid)?;
        }
        Ok(())
    }
}

/// Manager for local server processes
pub struct LocalProcessManager {
    /// Map of environment_id -> (ProcessType -> ProcessHandle)
    processes: Arc<Mutex<HashMap<String, HashMap<ProcessType, ProcessHandle>>>>,
}

impl LocalProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a new server process
    pub async fn spawn(
        &self,
        environment_id: &str,
        process_type: ProcessType,
        command: &str,
        args: &[&str],
        working_dir: &str,
        env_vars: HashMap<String, String>,
    ) -> Result<u32, std::io::Error> {
        debug!(
            environment_id = %environment_id,
            process_type = %process_type,
            command = %command,
            "Spawning local server process"
        );
        debug!(
            environment_id = %environment_id,
            process_type = %process_type,
            args = ?args,
            working_dir = %working_dir,
            "Local server spawn params"
        );

        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(working_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Add environment variables
        for (key, value) in env_vars {
            cmd.env(&key, &value);
        }

        let mut child = cmd.spawn()?;

        if let Some(stdout) = child.stdout.take() {
            let env_id = environment_id.to_string();
            let proc_name = process_type.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    debug!(
                        environment_id = %env_id,
                        process_type = %proc_name,
                        stream = "stdout",
                        line = %line,
                        "Local server output"
                    );
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let env_id = environment_id.to_string();
            let proc_name = process_type.to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    warn!(
                        environment_id = %env_id,
                        process_type = %proc_name,
                        stream = "stderr",
                        line = %line,
                        "Local server stderr"
                    );
                }
            });
        }

        let handle = ProcessHandle::from_child(child, process_type)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "Failed to get PID"))?;

        let pid = handle.pid;

        // Store the handle
        let mut processes = self.processes.lock().await;
        let env_processes = processes
            .entry(environment_id.to_string())
            .or_insert_with(HashMap::new);
        env_processes.insert(process_type, handle);

        info!(
            environment_id = %environment_id,
            process_type = %process_type,
            pid = pid,
            "Spawned local server process"
        );

        Ok(pid)
    }

    /// Kill a specific process for an environment
    pub async fn kill(
        &self,
        environment_id: &str,
        process_type: ProcessType,
    ) -> Result<(), std::io::Error> {
        let mut processes = self.processes.lock().await;

        if let Some(env_processes) = processes.get_mut(environment_id) {
            if let Some(mut handle) = env_processes.remove(&process_type) {
                info!(
                    environment_id = %environment_id,
                    process_type = %process_type,
                    pid = handle.pid,
                    "Killing local server process"
                );
                handle.kill().await?;
            }

            // Clean up empty environment entries
            if env_processes.is_empty() {
                processes.remove(environment_id);
            }
        }

        Ok(())
    }

    /// Kill every tracked process across all environments.
    /// Called during app shutdown to prevent orphaned processes.
    pub async fn shutdown_all(&self) {
        let mut processes = self.processes.lock().await;
        for (environment_id, mut env_processes) in processes.drain() {
            for (process_type, mut handle) in env_processes.drain() {
                info!(
                    environment_id = %environment_id,
                    process_type = %process_type,
                    pid = handle.pid,
                    "Killing local server process (app shutdown)"
                );
                if let Err(e) = handle.kill().await {
                    warn!(
                        environment_id = %environment_id,
                        process_type = %process_type,
                        error = %e,
                        "Failed to kill process during shutdown"
                    );
                }
            }
        }
    }

    /// Kill all processes for an environment
    pub async fn kill_all(&self, environment_id: &str) -> Result<(), std::io::Error> {
        let mut processes = self.processes.lock().await;

        if let Some(mut env_processes) = processes.remove(environment_id) {
            for (process_type, mut handle) in env_processes.drain() {
                info!(
                    environment_id = %environment_id,
                    process_type = %process_type,
                    pid = handle.pid,
                    "Killing local server process"
                );
                if let Err(e) = handle.kill().await {
                    warn!(
                        environment_id = %environment_id,
                        process_type = %process_type,
                        error = %e,
                        "Failed to kill process"
                    );
                }
            }
        }

        Ok(())
    }

    /// Get the PID for a specific process
    pub async fn get_pid(&self, environment_id: &str, process_type: ProcessType) -> Option<u32> {
        let processes = self.processes.lock().await;
        processes
            .get(environment_id)
            .and_then(|env| env.get(&process_type))
            .map(|h| h.pid)
    }

    /// Recover a process handle from a stored PID
    pub async fn recover_from_pid(
        &self,
        environment_id: &str,
        process_type: ProcessType,
        pid: u32,
    ) {
        if is_process_alive(pid) {
            debug!(
                environment_id = %environment_id,
                process_type = %process_type,
                pid = pid,
                "Recovering process from stored PID"
            );

            let handle = ProcessHandle::recovered(pid, process_type);
            let mut processes = self.processes.lock().await;
            let env_processes = processes
                .entry(environment_id.to_string())
                .or_insert_with(HashMap::new);
            env_processes.insert(process_type, handle);
        } else {
            debug!(
                environment_id = %environment_id,
                process_type = %process_type,
                pid = pid,
                "Stored PID is no longer alive"
            );
        }
    }

    /// Check if a specific process is running
    pub async fn is_running(&self, environment_id: &str, process_type: ProcessType) -> bool {
        let processes = self.processes.lock().await;
        if let Some(env_processes) = processes.get(environment_id) {
            if let Some(handle) = env_processes.get(&process_type) {
                return is_process_alive(handle.pid);
            }
        }
        false
    }
}

impl Default for LocalProcessManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Check if a process with the given PID is alive
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    // kill with signal None (0) doesn't send a signal but checks if process exists
    kill(Pid::from_raw(pid as i32), None)
        .map(|_| true)
        .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn is_process_alive(pid: u32) -> bool {
    // On non-Unix systems, try to open the process
    // This is a best-effort check
    use std::process::Command;

    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid)])
        .output()
        .map(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.contains(&pid.to_string())
        })
        .unwrap_or(false)
}

/// Kill a process by PID
#[cfg(unix)]
pub fn kill_process(pid: u32) -> Result<(), std::io::Error> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    debug!(pid = pid, "Sending SIGTERM to process");

    // Try SIGTERM first
    let pid = Pid::from_raw(pid as i32);
    if let Err(e) = kill(pid, Some(Signal::SIGTERM)) {
        warn!(pid = %pid, error = %e, "SIGTERM failed");
    }

    // Wait a bit for graceful shutdown
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Check if still alive (signal 0) and send SIGKILL if needed
    if kill(pid, None).is_ok() {
        debug!(pid = %pid, "Process still alive, sending SIGKILL");
        if let Err(e) = kill(pid, Some(Signal::SIGKILL)) {
            error!(pid = %pid, error = %e, "SIGKILL failed");
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to kill process {}: {}", pid, e),
            ));
        }
    }

    Ok(())
}

#[cfg(not(unix))]
pub fn kill_process(pid: u32) -> Result<(), std::io::Error> {
    use std::process::Command;

    Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map(|_| ())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
}

/// Global process manager instance
static PROCESS_MANAGER: std::sync::OnceLock<LocalProcessManager> = std::sync::OnceLock::new();

/// Get the global process manager
pub fn get_process_manager() -> &'static LocalProcessManager {
    PROCESS_MANAGER.get_or_init(LocalProcessManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_type_display() {
        assert_eq!(ProcessType::OpenCode.to_string(), "opencode");
        assert_eq!(ProcessType::ClaudeBridge.to_string(), "claude-bridge");
    }
}
