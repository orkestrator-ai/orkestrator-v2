// PTY (pseudo-terminal) management for Docker containers
// Handles terminal sessions, stdin/stdout streaming, and resize events

use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions};
use bollard::Docker;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tracing::{debug, error, instrument, warn};

#[derive(Error, Debug)]
pub enum PtyError {
    #[error("Docker error: {0}")]
    Docker(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Failed to create exec: {0}")]
    ExecFailed(String),
}

impl From<bollard::errors::Error> for PtyError {
    fn from(err: bollard::errors::Error) -> Self {
        PtyError::Docker(err.to_string())
    }
}

/// A terminal session connected to a Docker container
#[derive(Debug)]
pub struct TerminalSession {
    pub session_id: String,
    pub container_id: String,
    pub exec_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub is_active: bool,
}

impl TerminalSession {
    pub fn new(container_id: &str, cols: u16, rows: u16) -> Self {
        Self {
            session_id: uuid::Uuid::new_v4().to_string(),
            container_id: container_id.to_string(),
            exec_id: None,
            cols,
            rows,
            is_active: false,
        }
    }
}

fn build_container_terminal_start_command() -> &'static str {
    "/bin/bash /usr/local/bin/workspace-setup.sh; source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true; orkestrator_source_runtime_env 2>/dev/null || true; exec /bin/zsh"
}

/// Manager for terminal sessions
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    input_senders: Arc<Mutex<HashMap<String, mpsc::Sender<Vec<u8>>>>>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            input_senders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn connect_docker() -> Result<Docker, PtyError> {
        // Use a fresh client to avoid hijacked exec connections blocking new requests.
        Docker::connect_with_local_defaults().map_err(|e| PtyError::Docker(e.to_string()))
    }

    /// Create a new terminal session for a container
    #[instrument(skip(self), fields(container_id = %container_id, cols, rows, user))]
    pub async fn create_session(
        &self,
        container_id: &str,
        cols: u16,
        rows: u16,
        user: Option<&str>,
    ) -> Result<String, PtyError> {
        debug!("Creating terminal session");
        let docker = Self::connect_docker()?;

        // Fetch the container's environment variables so we can pass them to exec
        // This is necessary because docker exec doesn't inherit container env vars
        let container_info = docker.inspect_container(container_id, None).await?;
        let container_env: Vec<String> = container_info
            .config
            .and_then(|c| c.env)
            .unwrap_or_default();

        // Build environment variables - start with container's env
        let mut env_vars: Vec<String> = container_env;

        // Add/override terminal-specific vars
        env_vars.push(format!("COLUMNS={}", cols));
        env_vars.push(format!("LINES={}", rows));
        env_vars.push("TERM=xterm-256color".to_string());

        // Convert to references for the API
        let env_refs: Vec<&str> = env_vars.iter().map(|s| s.as_str()).collect();

        // Create exec instance with TTY
        // Run workspace-setup.sh first (handles clone, env files, project setup)
        // then exec into zsh - all visible in the terminal
        let config = CreateExecOptions {
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            cmd: Some(vec![
                "/bin/zsh",
                "-c",
                build_container_terminal_start_command(),
            ]),
            working_dir: Some("/workspace"),
            env: Some(env_refs),
            user: Some(user.unwrap_or("node")), // Use provided user or default to node
            ..Default::default()
        };

        let exec = docker.create_exec(container_id, config).await?;
        let exec_id = exec.id;

        // Create and store session
        let mut session = TerminalSession::new(container_id, cols, rows);
        session.exec_id = Some(exec_id.clone());
        session.is_active = true;

        let session_id = session.session_id.clone();

        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(session_id.clone(), session);
        }

        debug!(session_id = %session_id, exec_id = %exec_id, "Terminal session created");
        Ok(session_id)
    }

    /// Start a terminal session and return output receiver
    /// The input sender is stored internally and accessed via write_to_session
    #[instrument(skip(self), fields(session_id = %session_id))]
    pub async fn start_session(
        &self,
        session_id: &str,
    ) -> Result<mpsc::Receiver<Vec<u8>>, PtyError> {
        debug!("Starting terminal session");
        let docker = Self::connect_docker()?;

        let exec_id = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(session_id)
                .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;
            session
                .exec_id
                .clone()
                .ok_or_else(|| PtyError::ExecFailed("No exec ID".to_string()))?
        };

        // Start the exec with detach: false to get attached streams
        let options = StartExecOptions {
            detach: false,
            ..Default::default()
        };
        let attach = docker.start_exec(&exec_id, Some(options)).await?;

        // Create channels for input/output
        // Use larger buffers to prevent backpressure issues
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(1024);
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>(1024);

        // Store the input sender for later use
        {
            let mut senders = self.input_senders.lock().unwrap();
            senders.insert(session_id.to_string(), input_tx);
        }

        // Handle the exec output
        if let bollard::exec::StartExecResults::Attached {
            mut output,
            mut input,
        } = attach
        {
            debug!(exec_id = %exec_id, "Exec attached successfully");
            let exec_id_for_output = exec_id.clone();
            let exec_id_for_input = exec_id.clone();

            // Spawn task to read output (runs independently)
            tokio::spawn(async move {
                while let Some(result) = output.next().await {
                    match result {
                        Ok(chunk) => {
                            let data = chunk.into_bytes().to_vec();
                            if output_tx.send(data).await.is_err() {
                                debug!(exec_id = %exec_id_for_output, "Output channel closed, receiver dropped");
                                break;
                            }
                        }
                        Err(e) => {
                            warn!(exec_id = %exec_id_for_output, error = ?e, "Error reading exec output");
                        }
                    }
                }
                debug!(exec_id = %exec_id_for_output, "Output reader task ended");
            });

            // Spawn task to write input (runs independently)
            tokio::spawn(async move {
                loop {
                    match input_rx.recv().await {
                        Some(data) => {
                            if let Err(e) = input.write_all(&data).await {
                                warn!(exec_id = %exec_id_for_input, error = ?e, "Error writing to exec input");
                            } else if let Err(e) = input.flush().await {
                                warn!(exec_id = %exec_id_for_input, error = ?e, "Error flushing exec input");
                            }
                        }
                        None => {
                            debug!(exec_id = %exec_id_for_input, "Input channel closed, sender dropped");
                            break;
                        }
                    }
                }
                debug!(exec_id = %exec_id_for_input, "Input writer task ended");
            });
        } else {
            error!("Exec did not attach (detached mode?)");
            return Err(PtyError::ExecFailed("Exec did not attach".to_string()));
        }

        // Resize the exec to initialize the PTY properly
        // This is important for TTY echo to work correctly
        let (cols, rows) = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions.get(session_id).unwrap();
            (session.cols, session.rows)
        };

        debug!(exec_id = %exec_id, cols, rows, "Resizing exec for initial PTY setup");
        let resize_options = ResizeExecOptions {
            width: cols,
            height: rows,
        };
        // Resize errors are non-fatal - the terminal may still work without proper dimensions
        match Self::connect_docker() {
            Ok(resize_docker) => {
                if let Err(e) = resize_docker.resize_exec(&exec_id, resize_options).await {
                    warn!(exec_id = %exec_id, error = ?e, "Failed to resize exec (non-fatal)");
                }
            }
            Err(e) => {
                warn!(exec_id = %exec_id, error = ?e, "Failed to connect for resize (non-fatal)");
            }
        }

        debug!(session_id = %session_id, "Terminal session started");
        Ok(output_rx)
    }

    /// Write data to a terminal session
    #[instrument(skip(self, data), fields(session_id = %session_id, data_len = data.len()))]
    pub async fn write_to_session(&self, session_id: &str, data: Vec<u8>) -> Result<(), PtyError> {
        let sender = {
            let senders = self.input_senders.lock().unwrap();
            senders
                .get(session_id)
                .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?
                .clone()
        };

        sender
            .send(data)
            .await
            .map_err(|_| PtyError::ExecFailed("Failed to send data to terminal".to_string()))?;
        Ok(())
    }

    /// Resize a terminal session
    #[instrument(skip(self), fields(session_id = %session_id, cols, rows))]
    pub async fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), PtyError> {
        debug!("Resizing terminal session");
        let docker = Self::connect_docker()?;

        let exec_id = {
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get_mut(session_id)
                .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;

            session.cols = cols;
            session.rows = rows;

            session
                .exec_id
                .clone()
                .ok_or_else(|| PtyError::ExecFailed("No exec ID".to_string()))?
        };

        let options = ResizeExecOptions {
            width: cols,
            height: rows,
        };

        docker.resize_exec(&exec_id, options).await?;

        Ok(())
    }

    /// Close a terminal session
    #[instrument(skip(self), fields(session_id = %session_id))]
    pub fn close_session(&self, session_id: &str) -> Result<(), PtyError> {
        debug!("Closing terminal session");
        // Remove input sender
        {
            let mut senders = self.input_senders.lock().unwrap();
            senders.remove(session_id);
        }

        // Remove session
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.remove(session_id).is_none() {
            return Err(PtyError::SessionNotFound(session_id.to_string()));
        }
        debug!("Terminal session closed");
        Ok(())
    }

    /// Get session info
    pub fn get_session(&self, session_id: &str) -> Option<(String, u16, u16)> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(session_id)
            .map(|s| (s.container_id.clone(), s.cols, s.rows))
    }

    /// List all active sessions
    pub fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    }
}

// Global terminal manager instance
use std::sync::OnceLock;

static TERMINAL_MANAGER: OnceLock<TerminalManager> = OnceLock::new();

/// Initialize the global terminal manager
pub fn init_terminal_manager() {
    let _ = TERMINAL_MANAGER.set(TerminalManager::new());
}

/// Get the global terminal manager
pub fn get_terminal_manager() -> Option<&'static TerminalManager> {
    TERMINAL_MANAGER.get()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_start_command_sources_runtime_environment_after_setup() {
        let command = build_container_terminal_start_command();

        assert!(command.starts_with("/bin/bash /usr/local/bin/workspace-setup.sh"));
        assert!(command.contains("source /usr/local/bin/orkestrator-runtime-env.sh"));
        assert!(command.contains("orkestrator_source_runtime_env"));
        assert!(command.ends_with("exec /bin/zsh"));
    }
}
