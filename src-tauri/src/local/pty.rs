//! Local PTY (pseudo-terminal) management for local environments
//!
//! Handles terminal sessions that spawn local shell processes in worktree directories,
//! as opposed to Docker exec sessions for containerized environments.

use super::process::kill_process;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum LocalPtyError {
    #[error("PTY error: {0}")]
    Pty(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Wrapper to hold either a full PtyPair (before start) or just the master (after start)
enum PtyHandle {
    /// Full pair before the session is started
    Pair(PtyPair),
    /// Just the master after start (for resize operations)
    Master(Box<dyn MasterPty + Send>),
}

/// A local terminal session running a shell in a worktree directory
pub struct LocalTerminalSession {
    pub session_id: String,
    #[allow(dead_code)]
    pub environment_id: String,
    pub worktree_path: String,
    pub cols: u16,
    pub rows: u16,
    pub is_active: bool,
    pub bundled_bin_dir: Option<String>,
    pty_handle: Option<PtyHandle>,
    child_pid: Option<u32>,
    child_killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl LocalTerminalSession {
    pub fn new(
        environment_id: &str,
        worktree_path: &str,
        cols: u16,
        rows: u16,
        bundled_bin_dir: Option<String>,
    ) -> Self {
        Self {
            session_id: uuid::Uuid::new_v4().to_string(),
            environment_id: environment_id.to_string(),
            worktree_path: worktree_path.to_string(),
            cols,
            rows,
            is_active: false,
            bundled_bin_dir,
            pty_handle: None,
            child_pid: None,
            child_killer: None,
        }
    }
}

/// Manager for local terminal sessions
pub struct LocalTerminalManager {
    sessions: Arc<Mutex<HashMap<String, LocalTerminalSession>>>,
    input_senders: Arc<Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>>,
}

impl LocalTerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            input_senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Create a new local terminal session
    pub async fn create_session(
        &self,
        environment_id: &str,
        worktree_path: &str,
        cols: u16,
        rows: u16,
        bundled_bin_dir: Option<String>,
    ) -> Result<String, LocalPtyError> {
        debug!(
            environment_id = %environment_id,
            worktree_path = %worktree_path,
            cols = cols,
            rows = rows,
            "Creating local terminal session"
        );

        // Create the PTY system
        let pty_system = native_pty_system();

        // Create a PTY pair with the specified size
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;

        // Create and store session
        let mut session =
            LocalTerminalSession::new(environment_id, worktree_path, cols, rows, bundled_bin_dir);
        session.pty_handle = Some(PtyHandle::Pair(pair));
        session.is_active = true;

        let session_id = session.session_id.clone();

        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(session_id.clone(), session);
        }

        debug!(session_id = %session_id, "Local terminal session created");
        Ok(session_id)
    }

    /// Start a local terminal session and return output receiver
    pub async fn start_session(
        &self,
        session_id: &str,
    ) -> Result<mpsc::Receiver<Vec<u8>>, LocalPtyError> {
        debug!(session_id = %session_id, "Starting local terminal session");

        let (worktree_path, bundled_bin_dir, pair) = {
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?;

            let pty_handle = session
                .pty_handle
                .take()
                .ok_or_else(|| LocalPtyError::Pty("PTY handle already taken".to_string()))?;

            let pair = match pty_handle {
                PtyHandle::Pair(p) => p,
                PtyHandle::Master(_) => {
                    return Err(LocalPtyError::Pty("Session already started".to_string()));
                }
            };

            (
                session.worktree_path.clone(),
                session.bundled_bin_dir.clone(),
                pair,
            )
        };

        // Get the user's default shell
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        // Build the command to run in the PTY
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&worktree_path);

        // Set up environment variables
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let current_path = std::env::var("PATH").unwrap_or_default();
        for (key, value) in build_bundled_bin_env(bundled_bin_dir.as_deref(), &current_path) {
            cmd.env(key, value);
        }

        // Spawn the shell in the PTY
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        let child_pid = child.process_id();
        let child_killer = child.clone_killer();

        // Drop the slave - we don't need it after spawning
        drop(pair.slave);

        // Create channels for input/output
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1024);
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(1024);

        // Store the input sender
        {
            let mut senders = self.input_senders.lock().unwrap();
            senders.insert(session_id.to_string(), input_tx);
        }

        // Get writer and reader from the master
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| LocalPtyError::Pty(e.to_string()))?;

        // Store just the master for resize operations (no need for a dummy slave)
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.get_mut(session_id) {
                session.pty_handle = Some(PtyHandle::Master(pair.master));
                session.child_pid = child_pid;
                session.child_killer = Some(child_killer);
            }
        }

        let session_id_clone = session_id.to_string();

        // Spawn task to read output
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        debug!(session_id = %session_id_clone, "PTY reader got EOF");
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if output_tx.blocking_send(data).is_err() {
                            debug!(session_id = %session_id_clone, "Output channel closed");
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(session_id = %session_id_clone, error = %e, "Error reading from PTY");
                        break;
                    }
                }
            }
            debug!(session_id = %session_id_clone, "PTY reader thread ended");
        });

        let session_id_clone2 = session_id.to_string();

        // Spawn task to write input
        tokio::spawn(async move {
            loop {
                match input_rx.recv().await {
                    Some(data) => {
                        if let Err(e) = writer.write_all(&data) {
                            warn!(session_id = %session_id_clone2, error = %e, "Error writing to PTY");
                            break;
                        }
                        if let Err(e) = writer.flush() {
                            warn!(session_id = %session_id_clone2, error = %e, "Error flushing PTY");
                        }
                    }
                    None => {
                        debug!(session_id = %session_id_clone2, "Input channel closed");
                        break;
                    }
                }
            }
            debug!(session_id = %session_id_clone2, "PTY writer task ended");
        });

        // Wait for the child process in a separate thread
        let session_id_clone3 = session_id.to_string();
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            debug!(session_id = %session_id_clone3, "PTY child process exited");
            // Mark session as inactive
            if let Ok(mut sessions) = sessions.lock() {
                if let Some(session) = sessions.get_mut(&session_id_clone3) {
                    session.is_active = false;
                }
            }
        });

        info!(session_id = %session_id, "Local terminal session started");
        Ok(output_rx)
    }

    /// Write data to a local terminal session
    pub async fn write_to_session(
        &self,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<(), LocalPtyError> {
        let sender = {
            let senders = self.input_senders.lock().unwrap();
            senders
                .get(session_id)
                .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?
                .clone()
        };

        sender
            .send(data)
            .await
            .map_err(|_| LocalPtyError::Pty("Failed to send data to terminal".to_string()))?;
        Ok(())
    }

    /// Resize a local terminal session
    pub fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), LocalPtyError> {
        debug!(session_id = %session_id, cols = cols, rows = rows, "Resizing local terminal session");

        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?;

        session.cols = cols;
        session.rows = rows;

        if let Some(ref pty_handle) = session.pty_handle {
            let master: &dyn MasterPty = match pty_handle {
                PtyHandle::Pair(pair) => pair.master.as_ref(),
                PtyHandle::Master(m) => m.as_ref(),
            };
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| LocalPtyError::Pty(e.to_string()))?;
        }

        Ok(())
    }

    /// Close a local terminal session
    pub fn close_session(&self, session_id: &str) -> Result<(), LocalPtyError> {
        debug!(session_id = %session_id, "Closing local terminal session");

        // Remove input sender (this will cause the input task to end)
        {
            let mut senders = self.input_senders.lock().unwrap();
            senders.remove(session_id);
        }

        // Remove session
        let mut session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .remove(session_id)
                .ok_or_else(|| LocalPtyError::SessionNotFound(session_id.to_string()))?
        };

        if let Some(mut killer) = session.child_killer.take() {
            if let Err(e) = killer.kill() {
                warn!(session_id = %session_id, error = %e, "Failed to kill local terminal child via PTY killer");
            }
        } else if let Some(pid) = session.child_pid {
            if let Err(e) = kill_process(pid) {
                warn!(session_id = %session_id, pid = pid, error = %e, "Failed to kill local terminal child process");
            }
        }

        info!(session_id = %session_id, "Local terminal session closed");
        Ok(())
    }

    /// Close every local terminal session for an environment.
    pub fn close_sessions_for_environment(&self, environment_id: &str) {
        let session_ids: Vec<String> = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .values()
                .filter(|session| session.environment_id == environment_id)
                .map(|session| session.session_id.clone())
                .collect()
        };

        for session_id in session_ids {
            if let Err(e) = self.close_session(&session_id) {
                warn!(session_id = %session_id, error = %e, "Failed to close local terminal session for environment");
            }
        }
    }

    /// Close every tracked local terminal session.
    pub fn shutdown_all(&self) {
        let session_ids: Vec<String> = {
            let sessions = self.sessions.lock().unwrap();
            sessions.keys().cloned().collect()
        };

        for session_id in session_ids {
            if let Err(e) = self.close_session(&session_id) {
                warn!(session_id = %session_id, error = %e, "Failed to close local terminal session during shutdown");
            }
        }
    }

    /// Get session info
    #[allow(dead_code)]
    pub fn get_session(&self, session_id: &str) -> Option<(String, String, u16, u16)> {
        let sessions = self.sessions.lock().unwrap();
        sessions.get(session_id).map(|s| {
            (
                s.environment_id.clone(),
                s.worktree_path.clone(),
                s.cols,
                s.rows,
            )
        })
    }

    /// List all active sessions
    #[allow(dead_code)]
    pub fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    }
}

impl Default for LocalTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the bundled-binary env vars to layer on top of the inherited
/// environment. Returns an empty list if no bundled bin dir was provided.
///
/// `PATH` is always prepended when `bin_dir` is set. Per-CLI env vars
/// (`CLAUDE_CLI_PATH`, `OPENCODE_CLI_PATH`, `CODEX_CLI_PATH`) are only emitted
/// when the corresponding binary actually exists at `<bin_dir>/<name>`, so a
/// partial bundle never points consumers at a non-existent file.
fn build_bundled_bin_env(bin_dir: Option<&str>, current_path: &str) -> Vec<(String, String)> {
    let Some(bin_dir) = bin_dir else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(4);
    out.push(("PATH".to_string(), format!("{bin_dir}:{current_path}")));
    let dir = Path::new(bin_dir);
    for (env_var, binary) in [
        ("CLAUDE_CLI_PATH", "claude"),
        ("OPENCODE_CLI_PATH", "opencode"),
        ("CODEX_CLI_PATH", "codex"),
    ] {
        let path = dir.join(binary);
        if path.exists() {
            out.push((env_var.to_string(), path.to_string_lossy().into_owned()));
        }
    }
    out
}

// Global local terminal manager instance
static LOCAL_TERMINAL_MANAGER: std::sync::OnceLock<LocalTerminalManager> =
    std::sync::OnceLock::new();

/// Initialize the global local terminal manager
pub fn init_local_terminal_manager() {
    let _ = LOCAL_TERMINAL_MANAGER.set(LocalTerminalManager::new());
}

/// Get the global local terminal manager
pub fn get_local_terminal_manager() -> Option<&'static LocalTerminalManager> {
    LOCAL_TERMINAL_MANAGER.get()
}

pub fn close_local_terminal_sessions_for_environment(environment_id: &str) {
    if let Some(manager) = get_local_terminal_manager() {
        manager.close_sessions_for_environment(environment_id);
    }
}

pub fn shutdown_all_local_terminal_sessions() {
    if let Some(manager) = get_local_terminal_manager() {
        manager.shutdown_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn new_session_plumbs_bundled_bin_dir() {
        let s = LocalTerminalSession::new(
            "env-1",
            "/tmp/work",
            80,
            24,
            Some("/opt/bin".to_string()),
        );
        assert_eq!(s.environment_id, "env-1");
        assert_eq!(s.worktree_path, "/tmp/work");
        assert_eq!(s.cols, 80);
        assert_eq!(s.rows, 24);
        assert_eq!(s.bundled_bin_dir.as_deref(), Some("/opt/bin"));
        assert!(!s.is_active);
        assert!(!s.session_id.is_empty());
    }

    #[test]
    fn new_session_accepts_no_bundled_bin_dir() {
        let s = LocalTerminalSession::new("env-1", "/tmp/work", 80, 24, None);
        assert!(s.bundled_bin_dir.is_none());
    }

    #[tokio::test]
    async fn close_sessions_for_environment_removes_only_matching_sessions() {
        let tmp = TempDir::new().unwrap();
        let manager = LocalTerminalManager::new();
        let worktree = tmp.path().to_string_lossy();
        let env1_a = manager
            .create_session("env-1", &worktree, 80, 24, None)
            .await
            .unwrap();
        let env1_b = manager
            .create_session("env-1", &worktree, 80, 24, None)
            .await
            .unwrap();
        let env2 = manager
            .create_session("env-2", &worktree, 80, 24, None)
            .await
            .unwrap();

        manager.close_sessions_for_environment("env-1");

        assert!(manager.get_session(&env1_a).is_none());
        assert!(manager.get_session(&env1_b).is_none());
        assert!(manager.get_session(&env2).is_some());
    }

    #[tokio::test]
    async fn shutdown_all_removes_all_sessions() {
        let tmp = TempDir::new().unwrap();
        let manager = LocalTerminalManager::new();
        let worktree = tmp.path().to_string_lossy();
        let first = manager
            .create_session("env-1", &worktree, 80, 24, None)
            .await
            .unwrap();
        let second = manager
            .create_session("env-2", &worktree, 80, 24, None)
            .await
            .unwrap();

        manager.shutdown_all();

        assert!(manager.get_session(&first).is_none());
        assert!(manager.get_session(&second).is_none());
        assert!(manager.list_sessions().is_empty());
    }

    #[test]
    fn build_bundled_bin_env_returns_empty_when_dir_missing() {
        let env = build_bundled_bin_env(None, "/usr/bin:/bin");
        assert!(env.is_empty());
    }

    #[test]
    fn build_bundled_bin_env_prepends_path() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path().to_string_lossy().into_owned();
        let env = build_bundled_bin_env(Some(&bin_dir), "/usr/bin:/bin");
        let path = env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.as_str())
            .expect("PATH should be set");
        assert_eq!(path, &format!("{bin_dir}:/usr/bin:/bin"));
    }

    #[test]
    fn build_bundled_bin_env_only_emits_existing_binaries() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path();
        // Only Claude exists in this fake bundle.
        fs::write(bin_dir.join("claude"), "#!/bin/sh\n").unwrap();

        let env = build_bundled_bin_env(Some(&bin_dir.to_string_lossy()), "");
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"PATH"));
        assert!(keys.contains(&"CLAUDE_CLI_PATH"));
        assert!(
            !keys.contains(&"OPENCODE_CLI_PATH"),
            "OPENCODE_CLI_PATH should not be set when opencode is missing"
        );
        assert!(
            !keys.contains(&"CODEX_CLI_PATH"),
            "CODEX_CLI_PATH should not be set when codex is missing"
        );
    }

    #[test]
    fn build_bundled_bin_env_emits_all_when_all_exist() {
        let tmp = TempDir::new().unwrap();
        let bin_dir = tmp.path();
        for name in ["claude", "opencode", "codex"] {
            fs::write(bin_dir.join(name), "#!/bin/sh\n").unwrap();
        }

        let env = build_bundled_bin_env(Some(&bin_dir.to_string_lossy()), "");
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(
            map.get("CLAUDE_CLI_PATH").map(String::as_str),
            Some(bin_dir.join("claude").to_string_lossy().as_ref())
        );
        assert_eq!(
            map.get("OPENCODE_CLI_PATH").map(String::as_str),
            Some(bin_dir.join("opencode").to_string_lossy().as_ref())
        );
        assert_eq!(
            map.get("CODEX_CLI_PATH").map(String::as_str),
            Some(bin_dir.join("codex").to_string_lossy().as_ref())
        );
    }
}
