// JSON file-based storage layer
// Stores projects, environments, and config in the app data directory

use crate::models::{
    AppConfig, Environment, KanbanComment, KanbanImage, KanbanStatus, KanbanTask, Project,
    ProjectNotes, Session, SessionStatus,
};
use base64::Engine;
use chrono::Utc;
use serde::{de::DeserializeOwned, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use thiserror::Error;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum StorageError {
    #[error("Failed to get app data directory")]
    NoAppDataDir,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Project not found: {0}")]
    ProjectNotFound(String),
    #[error("Environment not found: {0}")]
    EnvironmentNotFound(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Kanban task not found: {0}")]
    KanbanTaskNotFound(String),
    #[error("Kanban image not found: {0}")]
    KanbanImageNotFound(String),
    #[error("Image processing error: {0}")]
    ImageProcessing(String),
    #[error("Duplicate project URL: {0}")]
    DuplicateProject(String),
}

/// Storage manager for persisting application data
pub struct Storage {
    data_dir: PathBuf,
    json_lock: Mutex<()>,
}

#[derive(Clone, Copy)]
enum JsonBackupPolicy {
    Never,
    Always,
    IfOlderThan(Duration),
}

impl Storage {
    const MAX_JSON_BACKUPS: usize = 5;
    const SESSIONS_BACKUP_MIN_AGE: Duration = Duration::from_secs(60);

    /// Create a new Storage instance, initializing the data directory if needed
    pub fn new() -> Result<Self, StorageError> {
        let data_dir = Self::get_data_dir()?;

        // Create data directory if it doesn't exist
        if !data_dir.exists() {
            fs::create_dir_all(&data_dir)?;
        }

        Ok(Self {
            data_dir,
            json_lock: Mutex::new(()),
        })
    }

    #[cfg(test)]
    pub(crate) fn new_for_tests(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            json_lock: Mutex::new(()),
        }
    }

    /// Get the application data directory path
    fn get_data_dir() -> Result<PathBuf, StorageError> {
        let base = dirs::config_dir().ok_or(StorageError::NoAppDataDir)?;
        Ok(base.join("orkestrator-ai"))
    }

    fn projects_file(&self) -> PathBuf {
        self.data_dir.join("projects.json")
    }

    fn environments_file(&self) -> PathBuf {
        self.data_dir.join("environments.json")
    }

    fn config_file(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }

    fn sessions_file(&self) -> PathBuf {
        self.data_dir.join("sessions.json")
    }

    fn buffers_dir(&self) -> PathBuf {
        self.data_dir.join("buffers")
    }

    fn buffer_file(&self, session_id: &str) -> PathBuf {
        self.buffers_dir().join(format!("{}.txt", session_id))
    }

    fn kanban_file(&self) -> PathBuf {
        self.data_dir.join("kanban.json")
    }

    fn kanban_images_dir(&self) -> PathBuf {
        self.data_dir.join("kanban-images")
    }

    fn kanban_image_file(&self, image_id: &str) -> PathBuf {
        self.kanban_images_dir().join(format!("{}.webp", image_id))
    }

    fn with_json_lock<T>(
        &self,
        f: impl FnOnce() -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        let _guard = self
            .json_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f()
    }

    fn json_backup_path(path: &Path, index: usize) -> PathBuf {
        path.with_file_name(format!(
            "{}.bak.{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            index
        ))
    }

    fn generate_corrupted_snapshot_path(path: &Path) -> PathBuf {
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
        path.with_file_name(format!(
            "{}.corrupted.{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            timestamp
        ))
    }

    fn should_rotate_json_backups(path: &Path, policy: JsonBackupPolicy) -> bool {
        if !path.exists() {
            return false;
        }

        match policy {
            JsonBackupPolicy::Never => false,
            JsonBackupPolicy::Always => true,
            JsonBackupPolicy::IfOlderThan(min_age) => {
                let first_backup = Self::json_backup_path(path, 1);
                if !first_backup.exists() {
                    return true;
                }

                let modified = match fs::metadata(&first_backup).and_then(|meta| meta.modified()) {
                    Ok(modified) => modified,
                    Err(error) => {
                        warn!(
                            path = %first_backup.display(),
                            error = %error,
                            "Failed to read JSON backup metadata, rotating backup"
                        );
                        return true;
                    }
                };

                match modified.elapsed() {
                    Ok(elapsed) => elapsed >= min_age,
                    Err(error) => {
                        warn!(
                            path = %first_backup.display(),
                            error = %error,
                            "JSON backup modified time is in the future, rotating backup"
                        );
                        true
                    }
                }
            }
        }
    }

    fn rotate_json_backups(path: &Path, policy: JsonBackupPolicy) -> Result<(), StorageError> {
        if !Self::should_rotate_json_backups(path, policy) {
            return Ok(());
        }

        for index in (1..Self::MAX_JSON_BACKUPS).rev() {
            let current = Self::json_backup_path(path, index);
            let next = Self::json_backup_path(path, index + 1);

            if next.exists() {
                fs::remove_file(&next)?;
            }

            if current.exists() {
                fs::rename(&current, &next)?;
            }
        }

        let first_backup = Self::json_backup_path(path, 1);
        if first_backup.exists() {
            fs::remove_file(&first_backup)?;
        }

        if path.exists() {
            fs::copy(path, &first_backup)?;
        }

        Ok(())
    }

    #[cfg(windows)]
    fn replace_file(path: &Path, temp_path: &Path) -> Result<(), StorageError> {
        use std::iter;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

        if !path.exists() {
            fs::rename(temp_path, path)?;
            return Ok(());
        }

        let encode = |value: &Path| {
            value
                .as_os_str()
                .encode_wide()
                .chain(iter::once(0))
                .collect::<Vec<u16>>()
        };

        let target = encode(path);
        let replacement = encode(temp_path);
        let replaced = unsafe {
            ReplaceFileW(
                target.as_ptr(),
                replacement.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };

        if replaced == 0 {
            return Err(StorageError::Io(std::io::Error::last_os_error()));
        }

        Ok(())
    }

    #[cfg(not(windows))]
    fn replace_file(path: &Path, temp_path: &Path) -> Result<(), StorageError> {
        fs::rename(temp_path, path)?;
        Ok(())
    }

    fn write_atomic(
        path: &Path,
        contents: &str,
        backup_policy: JsonBackupPolicy,
    ) -> Result<(), StorageError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let temp_path = path.with_file_name(format!(
            ".{}.{}.tmp",
            path.file_name().unwrap_or_default().to_string_lossy(),
            uuid::Uuid::new_v4()
        ));

        let write_result = (|| -> Result<(), StorageError> {
            let mut file = fs::File::create(&temp_path)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;

            Self::rotate_json_backups(path, backup_policy)?;
            Self::replace_file(path, &temp_path)?;

            if let Some(parent) = path.parent() {
                if let Ok(parent_dir) = fs::File::open(parent) {
                    let _ = parent_dir.sync_all();
                }
            }

            Ok(())
        })();

        if write_result.is_err() && temp_path.exists() {
            let _ = fs::remove_file(&temp_path);
        }

        write_result
    }

    fn try_repair_json_array<T>(
        contents: &str,
        error_line: usize,
        _error_column: usize,
    ) -> Option<String>
    where
        T: DeserializeOwned,
    {
        let trimmed = contents.trim();

        if !trimmed.starts_with('[') {
            return None;
        }

        let mut current_line = 1;
        let mut error_byte_pos = trimmed.len();
        for (i, c) in trimmed.char_indices() {
            if current_line >= error_line {
                error_byte_pos = i;
                break;
            }
            if c == '\n' {
                current_line += 1;
            }
        }

        if let Some(last_bracket) = trimmed[..error_byte_pos].rfind(']') {
            let candidate = &trimmed[..=last_bracket];
            if serde_json::from_str::<T>(candidate).is_ok() {
                return Some(candidate.to_string());
            }
        }

        let bracket_positions: Vec<usize> = trimmed
            .char_indices()
            .filter(|(_, c)| *c == ']')
            .map(|(i, _)| i)
            .collect();

        for &pos in bracket_positions.iter().rev() {
            let candidate = &trimmed[..=pos];
            if serde_json::from_str::<T>(candidate).is_ok() {
                return Some(candidate.to_string());
            }
        }

        None
    }

    fn archive_invalid_json(path: &Path, contents: &str, reason: &str) {
        let snapshot_path = Self::generate_corrupted_snapshot_path(path);
        match fs::write(&snapshot_path, contents) {
            Ok(_) => info!(path = %snapshot_path.display(), reason, "Archived invalid JSON file"),
            Err(error) => warn!(
                path = %path.display(),
                snapshot_path = %snapshot_path.display(),
                error = %error,
                reason,
                "Failed to archive invalid JSON file"
            ),
        }
    }

    fn restore_from_backups<T>(
        &self,
        path: &Path,
        invalid_contents: &str,
    ) -> Result<Option<T>, StorageError>
    where
        T: DeserializeOwned + Serialize,
    {
        for index in 1..=Self::MAX_JSON_BACKUPS {
            let backup_path = Self::json_backup_path(path, index);
            if !backup_path.exists() {
                continue;
            }

            let backup_contents = match fs::read_to_string(&backup_path) {
                Ok(contents) => contents,
                Err(error) => {
                    warn!(
                        path = %backup_path.display(),
                        error = %error,
                        "Failed to read JSON backup"
                    );
                    continue;
                }
            };

            match serde_json::from_str::<T>(&backup_contents) {
                Ok(value) => {
                    Self::archive_invalid_json(path, invalid_contents, "restore-from-backup");
                    Self::write_atomic(path, &backup_contents, JsonBackupPolicy::Never)?;
                    info!(
                        path = %path.display(),
                        backup_path = %backup_path.display(),
                        "Restored JSON file from backup"
                    );
                    return Ok(Some(value));
                }
                Err(error) => warn!(
                    path = %backup_path.display(),
                    error = %error,
                    "Skipping invalid JSON backup"
                ),
            }
        }

        Ok(None)
    }

    fn load_json_with_recovery<T, F>(&self, path: &Path, default: F) -> Result<T, StorageError>
    where
        T: DeserializeOwned + Serialize,
        F: FnOnce() -> T,
    {
        if !path.exists() {
            return Ok(default());
        }

        let default_value = default();
        let default_contents = serde_json::to_string_pretty(&default_value)?;

        let contents = match fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) => {
                warn!(path = %path.display(), error = %error, "Failed to read JSON file");
                if let Some(restored) = self.restore_from_backups::<T>(path, "")? {
                    return Ok(restored);
                }
                Self::write_atomic(path, &default_contents, JsonBackupPolicy::Never)?;
                return Ok(default_value);
            }
        };

        if contents.trim().is_empty() {
            warn!(path = %path.display(), "JSON file is empty, attempting recovery");
            if let Some(restored) = self.restore_from_backups::<T>(path, &contents)? {
                return Ok(restored);
            }
            Self::archive_invalid_json(path, &contents, "empty-json");
            Self::write_atomic(path, &default_contents, JsonBackupPolicy::Never)?;
            return Ok(default_value);
        }

        match serde_json::from_str::<T>(&contents) {
            Ok(value) => Ok(value),
            Err(error) => {
                warn!(
                    path = %path.display(),
                    error = %error,
                    line = error.line(),
                    column = error.column(),
                    "JSON parsing failed, attempting recovery"
                );

                if let Some(repaired_contents) =
                    Self::try_repair_json_array::<T>(&contents, error.line(), error.column())
                {
                    match serde_json::from_str::<T>(&repaired_contents) {
                        Ok(value) => {
                            Self::archive_invalid_json(path, &contents, "repaired-json");
                            Self::write_atomic(path, &repaired_contents, JsonBackupPolicy::Never)?;
                            info!(path = %path.display(), "Recovered JSON file by repairing truncated array");
                            return Ok(value);
                        }
                        Err(repair_error) => warn!(
                            path = %path.display(),
                            error = %repair_error,
                            "Repaired JSON still failed to parse"
                        ),
                    }
                }

                if let Some(restored) = self.restore_from_backups::<T>(path, &contents)? {
                    return Ok(restored);
                }

                Self::archive_invalid_json(path, &contents, "reset-to-default");
                Self::write_atomic(path, &default_contents, JsonBackupPolicy::Never)?;
                Ok(default_value)
            }
        }
    }

    // --- Project Operations ---

    fn load_projects_unlocked(&self) -> Result<Vec<Project>, StorageError> {
        let path = self.projects_file();
        let mut projects: Vec<Project> = self.load_json_with_recovery(&path, Vec::new)?;
        projects.sort_by_key(|p| p.order);
        Ok(projects)
    }

    fn save_projects_unlocked(&self, projects: &[Project]) -> Result<(), StorageError> {
        let path = self.projects_file();
        let contents = serde_json::to_string_pretty(projects)?;
        Self::write_atomic(&path, &contents, JsonBackupPolicy::Always)
    }

    /// Load all projects from storage, sorted by order
    pub fn load_projects(&self) -> Result<Vec<Project>, StorageError> {
        self.with_json_lock(|| self.load_projects_unlocked())
    }

    /// Save all projects to storage (used in tests for bulk setup)
    #[cfg(test)]
    pub fn save_projects(&self, projects: &[Project]) -> Result<(), StorageError> {
        self.with_json_lock(|| self.save_projects_unlocked(projects))
    }

    /// Add a new project
    pub fn add_project(&self, mut project: Project) -> Result<Project, StorageError> {
        self.with_json_lock(|| {
            let mut projects = self.load_projects_unlocked()?;

            if projects.iter().any(|p| p.git_url == project.git_url) {
                return Err(StorageError::DuplicateProject(project.git_url));
            }

            let max_order = projects.iter().map(|p| p.order).max().unwrap_or(-1);
            project.order = max_order + 1;

            projects.push(project.clone());
            self.save_projects_unlocked(&projects)?;
            Ok(project)
        })
    }

    /// Remove a project by ID
    pub fn remove_project(&self, project_id: &str) -> Result<(), StorageError> {
        self.with_json_lock(|| {
            let mut projects = self.load_projects_unlocked()?;
            let initial_len = projects.len();
            projects.retain(|p| p.id != project_id);

            if projects.len() == initial_len {
                return Err(StorageError::ProjectNotFound(project_id.to_string()));
            }

            self.save_projects_unlocked(&projects)?;
            Ok(())
        })
    }

    /// Get a project by ID
    pub fn get_project(&self, project_id: &str) -> Result<Option<Project>, StorageError> {
        self.with_json_lock(|| {
            let projects = self.load_projects_unlocked()?;
            Ok(projects.into_iter().find(|p| p.id == project_id))
        })
    }

    /// Update a project
    pub fn update_project(
        &self,
        project_id: &str,
        updates: serde_json::Value,
    ) -> Result<Project, StorageError> {
        self.with_json_lock(|| {
            let mut projects = self.load_projects_unlocked()?;
            let project = projects
                .iter_mut()
                .find(|p| p.id == project_id)
                .ok_or_else(|| StorageError::ProjectNotFound(project_id.to_string()))?;

            if let Some(name) = updates.get("name").and_then(|v| v.as_str()) {
                project.name = name.to_string();
            }
            if let Some(local_path) = updates.get("localPath") {
                project.local_path = local_path.as_str().map(String::from);
            }

            let updated = project.clone();
            self.save_projects_unlocked(&projects)?;
            Ok(updated)
        })
    }

    /// Reorder projects based on the provided order of IDs
    /// The order field of each project is updated to match its position in the input array
    /// Projects not in the input array are appended at the end in their current relative order
    pub fn reorder_projects(&self, project_ids: &[String]) -> Result<Vec<Project>, StorageError> {
        self.with_json_lock(|| {
            let mut projects = self.load_projects_unlocked()?;
            let provided_ids: std::collections::HashSet<&String> = project_ids.iter().collect();

            for (index, id) in project_ids.iter().enumerate() {
                if let Some(project) = projects.iter_mut().find(|p| p.id == *id) {
                    project.order = index as i32;
                }
            }

            let next_order = project_ids.len() as i32;
            let mut missing_order = next_order;
            for project in &mut projects {
                if !provided_ids.contains(&project.id) {
                    project.order = missing_order;
                    missing_order += 1;
                }
            }

            self.save_projects_unlocked(&projects)?;

            projects.sort_by_key(|p| p.order);
            Ok(projects)
        })
    }

    // --- Environment Operations ---

    fn load_environments_unlocked(&self) -> Result<Vec<Environment>, StorageError> {
        let path = self.environments_file();
        let mut environments: Vec<Environment> = self.load_json_with_recovery(&path, Vec::new)?;
        environments.sort_by_key(|e| e.order);
        Ok(environments)
    }

    fn save_environments_unlocked(&self, environments: &[Environment]) -> Result<(), StorageError> {
        let path = self.environments_file();
        let contents = serde_json::to_string_pretty(environments)?;
        Self::write_atomic(&path, &contents, JsonBackupPolicy::Always)
    }

    /// Load all environments from storage, sorted by order
    pub fn load_environments(&self) -> Result<Vec<Environment>, StorageError> {
        self.with_json_lock(|| self.load_environments_unlocked())
    }

    /// Save all environments to storage (used in tests for bulk setup)
    #[cfg(test)]
    pub fn save_environments(&self, environments: &[Environment]) -> Result<(), StorageError> {
        self.with_json_lock(|| self.save_environments_unlocked(environments))
    }

    /// Add a new environment
    pub fn add_environment(
        &self,
        mut environment: Environment,
    ) -> Result<Environment, StorageError> {
        self.with_json_lock(|| {
            let mut environments = self.load_environments_unlocked()?;

            let max_order = environments
                .iter()
                .filter(|e| e.project_id == environment.project_id)
                .map(|e| e.order)
                .max()
                .unwrap_or(-1);
            environment.order = max_order + 1;

            environments.push(environment.clone());
            self.save_environments_unlocked(&environments)?;
            Ok(environment)
        })
    }

    /// Remove an environment by ID
    pub fn remove_environment(&self, environment_id: &str) -> Result<(), StorageError> {
        self.with_json_lock(|| {
            let mut environments = self.load_environments_unlocked()?;
            let initial_len = environments.len();
            environments.retain(|e| e.id != environment_id);

            if environments.len() == initial_len {
                return Err(StorageError::EnvironmentNotFound(
                    environment_id.to_string(),
                ));
            }

            self.save_environments_unlocked(&environments)?;
            Ok(())
        })
    }

    /// Get environments for a project, sorted by order
    pub fn get_environments_by_project(
        &self,
        project_id: &str,
    ) -> Result<Vec<Environment>, StorageError> {
        self.with_json_lock(|| {
            let environments = self.load_environments_unlocked()?;
            let mut filtered: Vec<Environment> = environments
                .into_iter()
                .filter(|e| e.project_id == project_id)
                .collect();
            filtered.sort_by_key(|e| e.order);
            Ok(filtered)
        })
    }

    /// Get all environments
    pub fn get_all_environments(&self) -> Result<Vec<Environment>, StorageError> {
        self.with_json_lock(|| self.load_environments_unlocked())
    }

    /// Get an environment by ID
    pub fn get_environment(
        &self,
        environment_id: &str,
    ) -> Result<Option<Environment>, StorageError> {
        self.with_json_lock(|| {
            let environments = self.load_environments_unlocked()?;
            Ok(environments.into_iter().find(|e| e.id == environment_id))
        })
    }

    /// Update an environment
    pub fn update_environment(
        &self,
        environment_id: &str,
        updates: serde_json::Value,
    ) -> Result<Environment, StorageError> {
        self.with_json_lock(|| {
            let mut environments = self.load_environments_unlocked()?;
            let environment = environments
                .iter_mut()
                .find(|e| e.id == environment_id)
                .ok_or_else(|| StorageError::EnvironmentNotFound(environment_id.to_string()))?;

            if let Some(name) = updates.get("name").and_then(|v| v.as_str()) {
                environment.name = name.to_string();
            }
            if let Some(branch) = updates.get("branch").and_then(|v| v.as_str()) {
                environment.branch = branch.to_string();
            }
            if let Some(status) = updates.get("status").and_then(|v| v.as_str()) {
                environment.status = serde_json::from_value(serde_json::json!(status))
                    .unwrap_or(environment.status.clone());
            }
            if let Some(container_id) = updates.get("containerId") {
                environment.container_id = container_id.as_str().map(String::from);
            }
            if let Some(pr_url) = updates.get("prUrl") {
                environment.pr_url = pr_url.as_str().map(String::from);
            }
            if let Some(pr_state) = updates.get("prState") {
                if let Ok(parsed_pr_state) =
                    serde_json::from_value::<Option<crate::models::PrState>>(pr_state.clone())
                {
                    environment.pr_state = parsed_pr_state;
                }
            }
            if let Some(has_merge_conflicts) = updates.get("hasMergeConflicts") {
                if let Ok(parsed_has_merge_conflicts) =
                    serde_json::from_value::<Option<bool>>(has_merge_conflicts.clone())
                {
                    environment.has_merge_conflicts = parsed_has_merge_conflicts;
                }
            }
            if let Some(allowed_domains) = updates.get("allowedDomains") {
                environment.allowed_domains = serde_json::from_value(allowed_domains.clone()).ok();
            }
            if let Some(port_mappings) = updates.get("portMappings") {
                environment.port_mappings = serde_json::from_value(port_mappings.clone()).ok();
            }
            if let Some(env_type) = updates.get("environmentType").and_then(|v| v.as_str()) {
                environment.environment_type = serde_json::from_value(serde_json::json!(env_type))
                    .unwrap_or(environment.environment_type.clone());
            }
            if let Some(worktree_path) = updates.get("worktreePath") {
                environment.worktree_path = worktree_path.as_str().map(String::from);
            }
            if let Some(opencode_pid) = updates.get("opencodePid") {
                environment.opencode_pid = opencode_pid.as_u64().map(|v| v as u32);
            }
            if let Some(claude_pid) = updates.get("claudeBridgePid") {
                environment.claude_bridge_pid = claude_pid.as_u64().map(|v| v as u32);
            }
            if let Some(codex_pid) = updates.get("codexBridgePid") {
                environment.codex_bridge_pid = codex_pid.as_u64().map(|v| v as u32);
            }
            if let Some(opencode_port) = updates.get("localOpencodePort") {
                environment.local_opencode_port = opencode_port.as_u64().map(|v| v as u16);
            }
            if let Some(claude_port) = updates.get("localClaudePort") {
                environment.local_claude_port = claude_port.as_u64().map(|v| v as u16);
            }
            if let Some(codex_port) = updates.get("localCodexPort") {
                environment.local_codex_port = codex_port.as_u64().map(|v| v as u16);
            }
            if let Some(default_agent) = updates.get("defaultAgent") {
                environment.default_agent =
                    serde_json::from_value(default_agent.clone()).ok().flatten();
            }
            if let Some(claude_mode) = updates.get("claudeMode") {
                environment.claude_mode =
                    serde_json::from_value(claude_mode.clone()).ok().flatten();
            }
            if let Some(opencode_mode) = updates.get("opencodeMode") {
                environment.opencode_mode =
                    serde_json::from_value(opencode_mode.clone()).ok().flatten();
            }
            if let Some(entry_port) = updates.get("entryPort") {
                environment.entry_port = entry_port.as_u64().map(|v| v as u16);
            }
            if let Some(host_entry_port) = updates.get("hostEntryPort") {
                environment.host_entry_port = host_entry_port.as_u64().map(|v| v as u16);
            }
            if let Some(codex_mode) = updates.get("codexMode") {
                environment.codex_mode = serde_json::from_value(codex_mode.clone()).ok().flatten();
            }
            if let Some(setup_scripts_complete) = updates.get("setupScriptsComplete") {
                if let Some(value) = setup_scripts_complete.as_bool() {
                    environment.setup_scripts_complete = value;
                }
            }

            let updated = environment.clone();
            self.save_environments_unlocked(&environments)?;
            Ok(updated)
        })
    }

    /// Reorder environments within a project based on the provided order of IDs
    /// The order field of each environment is updated to match its position in the input array
    /// Environments not in the input array are appended at the end in their current relative order
    pub fn reorder_environments(
        &self,
        project_id: &str,
        environment_ids: &[String],
    ) -> Result<Vec<Environment>, StorageError> {
        self.with_json_lock(|| {
            let mut environments = self.load_environments_unlocked()?;
            let provided_ids: std::collections::HashSet<&String> = environment_ids.iter().collect();

            for (index, id) in environment_ids.iter().enumerate() {
                if let Some(env) = environments
                    .iter_mut()
                    .find(|e| e.id == *id && e.project_id == project_id)
                {
                    env.order = index as i32;
                }
            }

            let next_order = environment_ids.len() as i32;
            let mut missing_order = next_order;
            for env in &mut environments {
                if env.project_id == project_id && !provided_ids.contains(&env.id) {
                    env.order = missing_order;
                    missing_order += 1;
                }
            }

            self.save_environments_unlocked(&environments)?;

            let mut result: Vec<Environment> = environments
                .into_iter()
                .filter(|e| e.project_id == project_id)
                .collect();
            result.sort_by_key(|e| e.order);
            Ok(result)
        })
    }

    // --- Config Operations ---

    fn load_config_unlocked(&self) -> Result<AppConfig, StorageError> {
        let path = self.config_file();
        self.load_json_with_recovery(&path, AppConfig::default)
    }

    fn save_config_unlocked(&self, config: &AppConfig) -> Result<(), StorageError> {
        let path = self.config_file();
        debug!(path = ?path, "Saving config");
        let contents = serde_json::to_string_pretty(config)?;
        debug!(content_length = contents.len(), "Config content length");
        Self::write_atomic(&path, &contents, JsonBackupPolicy::Always)?;
        debug!("Config file written successfully");
        Ok(())
    }

    /// Load application config
    pub fn load_config(&self) -> Result<AppConfig, StorageError> {
        self.with_json_lock(|| self.load_config_unlocked())
    }

    /// Save application config
    pub fn save_config(&self, config: &AppConfig) -> Result<(), StorageError> {
        self.with_json_lock(|| self.save_config_unlocked(config))
    }

    // --- Session Operations ---

    /// Maximum number of sessions per environment (to prevent unbounded accumulation)
    const MAX_SESSIONS_PER_ENVIRONMENT: usize = 20;

    fn load_sessions_unlocked(&self) -> Result<Vec<Session>, StorageError> {
        let path = self.sessions_file();
        self.load_json_with_recovery(&path, Vec::new)
    }

    fn save_sessions_unlocked(&self, sessions: &[Session]) -> Result<(), StorageError> {
        let path = self.sessions_file();
        let contents = serde_json::to_string_pretty(sessions)?;
        Self::write_atomic(
            &path,
            &contents,
            JsonBackupPolicy::IfOlderThan(Self::SESSIONS_BACKUP_MIN_AGE),
        )
    }

    /// Load all sessions from storage (used in tests)
    #[cfg(test)]
    pub fn load_sessions(&self) -> Result<Vec<Session>, StorageError> {
        self.with_json_lock(|| self.load_sessions_unlocked())
    }

    /// Save all sessions to storage (used in tests for bulk setup)
    #[cfg(test)]
    pub fn save_sessions(&self, sessions: &[Session]) -> Result<(), StorageError> {
        self.with_json_lock(|| self.save_sessions_unlocked(sessions))
    }

    /// Add a new session
    /// If the environment already has MAX_SESSIONS_PER_ENVIRONMENT sessions,
    /// the oldest disconnected session is removed to make room.
    pub fn add_session(&self, mut session: Session) -> Result<Session, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;

            let env_sessions: Vec<&Session> = sessions
                .iter()
                .filter(|s| s.environment_id == session.environment_id)
                .collect();

            let max_order = env_sessions.iter().map(|s| s.order).max().unwrap_or(-1);
            session.order = max_order + 1;

            if env_sessions.len() >= Self::MAX_SESSIONS_PER_ENVIRONMENT {
                let oldest_disconnected = sessions
                    .iter()
                    .filter(|s| {
                        s.environment_id == session.environment_id
                            && s.status == SessionStatus::Disconnected
                    })
                    .min_by_key(|s| s.created_at);

                if let Some(to_remove) = oldest_disconnected {
                    let id_to_remove = to_remove.id.clone();
                    sessions.retain(|s| s.id != id_to_remove);
                    let _ = self.delete_session_buffer(&id_to_remove);
                }
            }

            sessions.push(session.clone());
            self.save_sessions_unlocked(&sessions)?;
            Ok(session)
        })
    }

    /// Get a session by ID
    pub fn get_session(&self, session_id: &str) -> Result<Option<Session>, StorageError> {
        self.with_json_lock(|| {
            let sessions = self.load_sessions_unlocked()?;
            Ok(sessions.into_iter().find(|s| s.id == session_id))
        })
    }

    /// Get sessions for an environment, sorted by order
    pub fn get_sessions_by_environment(
        &self,
        environment_id: &str,
    ) -> Result<Vec<Session>, StorageError> {
        self.with_json_lock(|| {
            let sessions = self.load_sessions_unlocked()?;
            let mut filtered: Vec<Session> = sessions
                .into_iter()
                .filter(|s| s.environment_id == environment_id)
                .collect();
            filtered.sort_by_key(|s| s.order);
            Ok(filtered)
        })
    }

    /// Update session status
    pub fn update_session_status(
        &self,
        session_id: &str,
        status: SessionStatus,
    ) -> Result<Session, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let session = sessions
                .iter_mut()
                .find(|s| s.id == session_id)
                .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;

            session.status = status;
            let updated = session.clone();
            self.save_sessions_unlocked(&sessions)?;
            Ok(updated)
        })
    }

    /// Update session's last activity timestamp
    pub fn touch_session(&self, session_id: &str) -> Result<Session, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let session = sessions
                .iter_mut()
                .find(|s| s.id == session_id)
                .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;

            session.touch();
            let updated = session.clone();
            self.save_sessions_unlocked(&sessions)?;
            Ok(updated)
        })
    }

    /// Rename a session
    pub fn rename_session(
        &self,
        session_id: &str,
        name: Option<String>,
    ) -> Result<Session, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let session = sessions
                .iter_mut()
                .find(|s| s.id == session_id)
                .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;

            session.name = name;
            let updated = session.clone();
            self.save_sessions_unlocked(&sessions)?;
            Ok(updated)
        })
    }

    /// Update whether a session has launched its command (e.g., Claude)
    pub fn set_session_has_launched_command(
        &self,
        session_id: &str,
        has_launched: bool,
    ) -> Result<Session, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let session = sessions
                .iter_mut()
                .find(|s| s.id == session_id)
                .ok_or_else(|| StorageError::SessionNotFound(session_id.to_string()))?;

            session.has_launched_command = has_launched;
            let updated = session.clone();
            self.save_sessions_unlocked(&sessions)?;
            Ok(updated)
        })
    }

    /// Remove a session by ID
    pub fn remove_session(&self, session_id: &str) -> Result<(), StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let initial_len = sessions.len();
            sessions.retain(|s| s.id != session_id);

            if sessions.len() == initial_len {
                return Err(StorageError::SessionNotFound(session_id.to_string()));
            }

            self.save_sessions_unlocked(&sessions)?;
            let _ = self.delete_session_buffer(session_id);

            Ok(())
        })
    }

    /// Remove all sessions for an environment
    pub fn remove_sessions_by_environment(
        &self,
        environment_id: &str,
    ) -> Result<Vec<String>, StorageError> {
        self.with_json_lock(|| {
            let sessions = self.load_sessions_unlocked()?;
            let session_ids: Vec<String> = sessions
                .iter()
                .filter(|s| s.environment_id == environment_id)
                .map(|s| s.id.clone())
                .collect();

            let remaining: Vec<Session> = sessions
                .into_iter()
                .filter(|s| s.environment_id != environment_id)
                .collect();
            self.save_sessions_unlocked(&remaining)?;

            for session_id in &session_ids {
                let _ = self.delete_session_buffer(session_id);
            }

            Ok(session_ids)
        })
    }

    /// Mark all sessions for an environment as disconnected
    pub fn disconnect_environment_sessions(
        &self,
        environment_id: &str,
    ) -> Result<Vec<Session>, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let mut updated_sessions = Vec::new();

            for session in &mut sessions {
                if session.environment_id == environment_id
                    && session.status == SessionStatus::Connected
                {
                    session.status = SessionStatus::Disconnected;
                    updated_sessions.push(session.clone());
                }
            }

            self.save_sessions_unlocked(&sessions)?;
            Ok(updated_sessions)
        })
    }

    // --- Session Buffer Operations ---

    /// Save a session's terminal buffer to a separate file
    pub fn save_session_buffer(&self, session_id: &str, buffer: &str) -> Result<(), StorageError> {
        let buffers_dir = self.buffers_dir();

        // Create buffers directory if it doesn't exist
        if !buffers_dir.exists() {
            fs::create_dir_all(&buffers_dir)?;
        }

        let buffer_path = self.buffer_file(session_id);

        // Truncate buffer if too large (500KB limit)
        const MAX_BUFFER_SIZE: usize = 500 * 1024;
        let buffer_to_save = if buffer.len() > MAX_BUFFER_SIZE {
            // Keep the last MAX_BUFFER_SIZE bytes, but ensure we don't split UTF-8 characters
            let start = buffer.len() - MAX_BUFFER_SIZE;
            // Find the next valid UTF-8 char boundary after `start`
            let safe_start = buffer[start..]
                .char_indices()
                .next()
                .map(|(offset, _)| start + offset)
                .unwrap_or(buffer.len());
            &buffer[safe_start..]
        } else {
            buffer
        };

        fs::write(buffer_path, buffer_to_save)?;
        Ok(())
    }

    /// Load a session's terminal buffer from file
    pub fn load_session_buffer(&self, session_id: &str) -> Result<Option<String>, StorageError> {
        let buffer_path = self.buffer_file(session_id);

        if !buffer_path.exists() {
            return Ok(None);
        }

        let contents = fs::read_to_string(&buffer_path)?;
        Ok(Some(contents))
    }

    /// Delete a session's buffer file
    pub fn delete_session_buffer(&self, session_id: &str) -> Result<(), StorageError> {
        let buffer_path = self.buffer_file(session_id);

        if buffer_path.exists() {
            fs::remove_file(buffer_path)?;
        }

        Ok(())
    }

    /// Reorder sessions within an environment based on the provided order of IDs
    /// The order field of each session is updated to match its position in the input array
    /// Sessions not in the input array are appended at the end in their current relative order
    pub fn reorder_sessions(
        &self,
        environment_id: &str,
        session_ids: &[String],
    ) -> Result<Vec<Session>, StorageError> {
        self.with_json_lock(|| {
            let mut sessions = self.load_sessions_unlocked()?;
            let provided_ids: std::collections::HashSet<&String> = session_ids.iter().collect();

            for (index, id) in session_ids.iter().enumerate() {
                if let Some(session) = sessions
                    .iter_mut()
                    .find(|s| s.id == *id && s.environment_id == environment_id)
                {
                    session.order = index as i32;
                }
            }

            let next_order = session_ids.len() as i32;
            let mut missing_order = next_order;
            for session in &mut sessions {
                if session.environment_id == environment_id && !provided_ids.contains(&session.id) {
                    session.order = missing_order;
                    missing_order += 1;
                }
            }

            self.save_sessions_unlocked(&sessions)?;

            let mut result: Vec<Session> = sessions
                .into_iter()
                .filter(|s| s.environment_id == environment_id)
                .collect();
            result.sort_by_key(|s| s.order);
            Ok(result)
        })
    }

    /// Clean up orphaned buffer files (buffers without corresponding sessions)
    /// Returns the list of deleted buffer file names
    pub fn cleanup_orphaned_buffers(&self) -> Result<Vec<String>, StorageError> {
        let buffers_dir = self.buffers_dir();
        if !buffers_dir.exists() {
            return Ok(Vec::new());
        }

        self.with_json_lock(|| {
            let sessions = self.load_sessions_unlocked()?;
            let session_ids: std::collections::HashSet<String> =
                sessions.iter().map(|s| s.id.clone()).collect();

            let mut deleted = Vec::new();

            if let Ok(entries) = fs::read_dir(&buffers_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(file_name) = path.file_stem() {
                            let session_id = file_name.to_string_lossy().to_string();
                            if !session_ids.contains(&session_id) {
                                if fs::remove_file(&path).is_ok() {
                                    debug!(session_id = %session_id, "Deleted orphaned buffer file");
                                    deleted.push(session_id);
                                }
                            }
                        }
                    }
                }
            }

            Ok(deleted)
        })
    }

    // --- Kanban Operations ---

    fn load_kanban_tasks_unlocked(&self) -> Result<Vec<KanbanTask>, StorageError> {
        let path = self.kanban_file();
        self.load_json_with_recovery(&path, Vec::new)
    }

    fn save_kanban_tasks_unlocked(&self, tasks: &[KanbanTask]) -> Result<(), StorageError> {
        let path = self.kanban_file();
        let contents = serde_json::to_string_pretty(tasks)?;
        Self::write_atomic(&path, &contents, JsonBackupPolicy::Always)
    }

    /// Load all kanban tasks from storage (used in tests)
    #[cfg(test)]
    pub fn load_kanban_tasks(&self) -> Result<Vec<KanbanTask>, StorageError> {
        self.with_json_lock(|| self.load_kanban_tasks_unlocked())
    }

    /// Save all kanban tasks to storage (used in tests for bulk setup)
    #[cfg(test)]
    pub fn save_kanban_tasks(&self, tasks: &[KanbanTask]) -> Result<(), StorageError> {
        self.with_json_lock(|| self.save_kanban_tasks_unlocked(tasks))
    }

    /// Add a new kanban task
    pub fn add_kanban_task(&self, mut task: KanbanTask) -> Result<KanbanTask, StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let max_order = tasks
                .iter()
                .filter(|t| t.project_id == task.project_id && t.status == task.status)
                .map(|t| t.order)
                .max()
                .unwrap_or(-1);
            task.order = max_order + 1;
            tasks.push(task.clone());
            self.save_kanban_tasks_unlocked(&tasks)?;
            Ok(task)
        })
    }

    /// Update a kanban task
    pub fn update_kanban_task(
        &self,
        task_id: &str,
        title: Option<String>,
        description: Option<String>,
        acceptance_criteria: Option<String>,
        status: Option<KanbanStatus>,
        environment_id: Option<String>,
        build_pipeline_id: Option<String>,
        pr_url: Option<String>,
        pr_state: Option<String>,
        pr_merge_commented: Option<bool>,
    ) -> Result<KanbanTask, StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let task_index = tasks
                .iter()
                .position(|t| t.id == task_id)
                .ok_or_else(|| StorageError::KanbanTaskNotFound(task_id.to_string()))?;

            if let Some(title) = title {
                tasks[task_index].title = title;
            }
            if let Some(description) = description {
                tasks[task_index].description = description;
            }
            if let Some(acceptance_criteria) = acceptance_criteria {
                tasks[task_index].acceptance_criteria = acceptance_criteria;
            }
            if let Some(new_status) = status {
                if tasks[task_index].status != new_status {
                    let project_id = tasks[task_index].project_id.clone();
                    let max_order = tasks
                        .iter()
                        .filter(|t| {
                            t.project_id == project_id && t.status == new_status && t.id != task_id
                        })
                        .map(|t| t.order)
                        .max()
                        .unwrap_or(-1);
                    tasks[task_index].status = new_status;
                    tasks[task_index].order = max_order + 1;
                }
            }
            if let Some(environment_id) = environment_id {
                tasks[task_index].environment_id = if environment_id.is_empty() {
                    None
                } else {
                    Some(environment_id)
                };
            }
            if let Some(build_pipeline_id) = build_pipeline_id {
                tasks[task_index].build_pipeline_id = if build_pipeline_id.is_empty() {
                    None
                } else {
                    Some(build_pipeline_id)
                };
            }
            if let Some(pr_url) = pr_url {
                tasks[task_index].pr_url = if pr_url.is_empty() {
                    None
                } else {
                    Some(pr_url)
                };
            }
            if let Some(pr_state) = pr_state {
                tasks[task_index].pr_state = if pr_state.is_empty() {
                    None
                } else {
                    Some(pr_state)
                };
            }
            if let Some(pr_merge_commented) = pr_merge_commented {
                tasks[task_index].pr_merge_commented = pr_merge_commented;
            }

            let updated = tasks[task_index].clone();
            self.save_kanban_tasks_unlocked(&tasks)?;
            Ok(updated)
        })
    }

    /// Delete a kanban task and its associated image files
    pub fn delete_kanban_task(&self, task_id: &str) -> Result<(), StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let task = tasks
                .iter()
                .find(|t| t.id == task_id)
                .ok_or_else(|| StorageError::KanbanTaskNotFound(task_id.to_string()))?;
            self.cleanup_kanban_task_images(task);
            tasks.retain(|t| t.id != task_id);
            self.save_kanban_tasks_unlocked(&tasks)?;
            Ok(())
        })
    }

    /// Get all kanban tasks for a project
    pub fn get_kanban_tasks_by_project(
        &self,
        project_id: &str,
    ) -> Result<Vec<KanbanTask>, StorageError> {
        self.with_json_lock(|| {
            let tasks = self.load_kanban_tasks_unlocked()?;
            Ok(tasks
                .into_iter()
                .filter(|t| t.project_id == project_id)
                .collect())
        })
    }

    /// Add a comment to a kanban task
    pub fn add_kanban_comment(
        &self,
        task_id: &str,
        text: String,
    ) -> Result<KanbanTask, StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let task = tasks
                .iter_mut()
                .find(|t| t.id == task_id)
                .ok_or_else(|| StorageError::KanbanTaskNotFound(task_id.to_string()))?;

            let comment = KanbanComment {
                id: uuid::Uuid::new_v4().to_string(),
                text,
                created_at: Utc::now(),
            };
            task.comments.push(comment);
            let updated = task.clone();
            self.save_kanban_tasks_unlocked(&tasks)?;
            Ok(updated)
        })
    }

    /// Delete a comment from a kanban task
    pub fn delete_kanban_comment(
        &self,
        task_id: &str,
        comment_id: &str,
    ) -> Result<KanbanTask, StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let task = tasks
                .iter_mut()
                .find(|t| t.id == task_id)
                .ok_or_else(|| StorageError::KanbanTaskNotFound(task_id.to_string()))?;

            task.comments.retain(|c| c.id != comment_id);
            let updated = task.clone();
            self.save_kanban_tasks_unlocked(&tasks)?;
            Ok(updated)
        })
    }

    /// Convert image bytes to WebP format, resizing so no dimension exceeds 2000px.
    fn convert_to_webp(&self, raw_bytes: &[u8]) -> Result<Vec<u8>, StorageError> {
        use image::ImageFormat;
        use std::io::Cursor;

        const MAX_DIMENSION: u32 = 2000;

        let mut img = image::ImageReader::new(Cursor::new(raw_bytes))
            .with_guessed_format()
            .map_err(|e| {
                StorageError::ImageProcessing(format!("Failed to detect image format: {}", e))
            })?
            .decode()
            .map_err(|e| StorageError::ImageProcessing(format!("Failed to decode image: {}", e)))?;

        // Resize if either dimension exceeds the limit, preserving aspect ratio
        if img.width() > MAX_DIMENSION || img.height() > MAX_DIMENSION {
            img = img.resize(
                MAX_DIMENSION,
                MAX_DIMENSION,
                image::imageops::FilterType::Lanczos3,
            );
        }

        let mut webp_data = Vec::new();
        img.write_to(&mut Cursor::new(&mut webp_data), ImageFormat::WebP)
            .map_err(|e| {
                StorageError::ImageProcessing(format!("Failed to encode as WebP: {}", e))
            })?;

        Ok(webp_data)
    }

    /// Add an image to a kanban task. Accepts base64-encoded image data (any supported format),
    /// converts to WebP, and stores the binary file on disk.
    pub fn add_kanban_image(
        &self,
        task_id: &str,
        filename: String,
        data: String,
    ) -> Result<KanbanTask, StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let task = tasks
                .iter_mut()
                .find(|t| t.id == task_id)
                .ok_or_else(|| StorageError::KanbanTaskNotFound(task_id.to_string()))?;

            let raw_bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(
                |e| StorageError::ImageProcessing(format!("Invalid base64 data: {}", e)),
            )?;
            let webp_bytes = self.convert_to_webp(&raw_bytes)?;

            let images_dir = self.kanban_images_dir();
            if !images_dir.exists() {
                fs::create_dir_all(&images_dir)?;
            }

            let image_id = uuid::Uuid::new_v4().to_string();
            let image_path = self.kanban_image_file(&image_id);
            fs::write(&image_path, &webp_bytes)?;

            debug!(image_id = %image_id, path = %image_path.display(), size_bytes = webp_bytes.len(), "Saved kanban image as WebP");

            let image = KanbanImage {
                id: image_id,
                filename,
                created_at: Utc::now(),
            };
            task.images.push(image);
            let updated = task.clone();
            self.save_kanban_tasks_unlocked(&tasks)?;
            Ok(updated)
        })
    }

    /// Delete an image from a kanban task and remove the file from disk.
    pub fn delete_kanban_image(
        &self,
        task_id: &str,
        image_id: &str,
    ) -> Result<KanbanTask, StorageError> {
        self.with_json_lock(|| {
            let mut tasks = self.load_kanban_tasks_unlocked()?;
            let task = tasks
                .iter_mut()
                .find(|t| t.id == task_id)
                .ok_or_else(|| StorageError::KanbanTaskNotFound(task_id.to_string()))?;

            task.images.retain(|i| i.id != image_id);
            let updated = task.clone();
            self.save_kanban_tasks_unlocked(&tasks)?;

            let image_path = self.kanban_image_file(image_id);
            if image_path.exists() {
                if let Err(e) = fs::remove_file(&image_path) {
                    warn!(image_id = %image_id, error = %e, "Failed to delete kanban image file");
                }
            }

            Ok(updated)
        })
    }

    /// Read a kanban image file from disk and return its data as base64-encoded WebP.
    pub fn get_kanban_image_data(&self, image_id: &str) -> Result<String, StorageError> {
        let image_path = self.kanban_image_file(image_id);
        if !image_path.exists() {
            return Err(StorageError::KanbanImageNotFound(image_id.to_string()));
        }
        let bytes = fs::read(&image_path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    }

    /// Delete all image files for a kanban task (used when deleting a task).
    fn cleanup_kanban_task_images(&self, task: &KanbanTask) {
        for image in &task.images {
            let image_path = self.kanban_image_file(&image.id);
            if image_path.exists() {
                if let Err(e) = fs::remove_file(&image_path) {
                    warn!(image_id = %image.id, error = %e, "Failed to delete kanban image file during task cleanup");
                }
            }
        }
    }

    // --- Project Notes Operations ---

    fn project_notes_file(&self) -> PathBuf {
        self.data_dir.join("project-notes.json")
    }

    fn load_project_notes_unlocked(&self) -> Result<Vec<ProjectNotes>, StorageError> {
        let path = self.project_notes_file();
        self.load_json_with_recovery(&path, Vec::new)
    }

    fn save_project_notes_unlocked(&self, notes: &[ProjectNotes]) -> Result<(), StorageError> {
        let path = self.project_notes_file();
        let contents = serde_json::to_string_pretty(notes)?;
        Self::write_atomic(&path, &contents, JsonBackupPolicy::Always)
    }

    /// Load all project notes (used in tests)
    #[cfg(test)]
    pub fn load_project_notes(&self) -> Result<Vec<ProjectNotes>, StorageError> {
        self.with_json_lock(|| self.load_project_notes_unlocked())
    }

    #[cfg(test)]
    fn save_project_notes(&self, notes: &[ProjectNotes]) -> Result<(), StorageError> {
        self.with_json_lock(|| self.save_project_notes_unlocked(notes))
    }

    /// Get notes for a specific project
    pub fn get_project_notes(&self, project_id: &str) -> Result<ProjectNotes, StorageError> {
        self.with_json_lock(|| {
            let notes = self.load_project_notes_unlocked()?;
            Ok(notes
                .into_iter()
                .find(|n| n.project_id == project_id)
                .unwrap_or(ProjectNotes {
                    project_id: project_id.to_string(),
                    content: String::new(),
                    updated_at: Utc::now(),
                }))
        })
    }

    /// Save notes for a specific project
    pub fn save_project_notes_for_project(
        &self,
        project_id: &str,
        content: String,
    ) -> Result<ProjectNotes, StorageError> {
        self.with_json_lock(|| {
            let mut all_notes = self.load_project_notes_unlocked()?;
            let now = Utc::now();

            if let Some(existing) = all_notes.iter_mut().find(|n| n.project_id == project_id) {
                existing.content = content;
                existing.updated_at = now;
            } else {
                all_notes.push(ProjectNotes {
                    project_id: project_id.to_string(),
                    content,
                    updated_at: now,
                });
            }

            let updated = all_notes
                .iter()
                .find(|n| n.project_id == project_id)
                .unwrap()
                .clone();
            self.save_project_notes_unlocked(&all_notes)?;
            Ok(updated)
        })
    }
}

static STORAGE: OnceLock<Result<Storage, String>> = OnceLock::new();
static INIT_LOCK: Mutex<()> = Mutex::new(());

/// Get the global storage instance
pub fn get_storage() -> Result<&'static Storage, StorageError> {
    let _guard = INIT_LOCK.lock().unwrap();

    let result = STORAGE.get_or_init(|| Storage::new().map_err(|e| e.to_string()));

    match result {
        Ok(storage) => Ok(storage),
        Err(e) => Err(StorageError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.clone(),
        ))),
    }
}

/// Convenience function to load config from global storage
pub fn get_config() -> Result<AppConfig, StorageError> {
    let storage = get_storage()?;
    storage.load_config()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{EnvironmentStatus, Session, SessionStatus, SessionType};
    use filetime::{set_file_mtime, FileTime};
    use tempfile::tempdir;

    fn create_test_storage() -> Storage {
        let temp_dir = tempdir().unwrap();
        Storage::new_for_tests(temp_dir.keep())
    }

    fn create_test_png_base64() -> String {
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
        let dynamic = image::DynamicImage::ImageRgba8(image);
        let mut bytes = Vec::new();
        dynamic
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    // --- Project Tests ---

    #[test]
    fn test_project_crud() {
        let storage = create_test_storage();

        // Create
        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        let saved = storage.add_project(project.clone()).unwrap();
        assert_eq!(saved.id, project.id);

        // Read
        let loaded = storage.get_project(&project.id).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().name, "repo");

        // List
        let projects = storage.load_projects().unwrap();
        assert_eq!(projects.len(), 1);

        // Delete
        storage.remove_project(&project.id).unwrap();
        let projects = storage.load_projects().unwrap();
        assert_eq!(projects.len(), 0);
    }

    #[test]
    fn test_duplicate_project_prevention() {
        let storage = create_test_storage();

        let project1 = Project::new("https://github.com/test/repo.git".to_string(), None);
        storage.add_project(project1).unwrap();

        let project2 = Project::new("https://github.com/test/repo.git".to_string(), None);
        let result = storage.add_project(project2);

        assert!(matches!(result, Err(StorageError::DuplicateProject(_))));
    }

    #[test]
    fn test_remove_nonexistent_project() {
        let storage = create_test_storage();

        let result = storage.remove_project("nonexistent-id");
        assert!(matches!(result, Err(StorageError::ProjectNotFound(_))));
    }

    #[test]
    fn test_get_nonexistent_project() {
        let storage = create_test_storage();

        let result = storage.get_project("nonexistent-id").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_update_project() {
        let storage = create_test_storage();

        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        storage.add_project(project.clone()).unwrap();

        let updates = serde_json::json!({
            "name": "updated-name",
            "localPath": "/new/path"
        });

        let updated = storage.update_project(&project.id, updates).unwrap();
        assert_eq!(updated.name, "updated-name");
        assert_eq!(updated.local_path, Some("/new/path".to_string()));

        // Verify it persisted
        let loaded = storage.get_project(&project.id).unwrap().unwrap();
        assert_eq!(loaded.name, "updated-name");
    }

    #[test]
    fn test_update_nonexistent_project() {
        let storage = create_test_storage();

        let updates = serde_json::json!({ "name": "test" });
        let result = storage.update_project("nonexistent", updates);

        assert!(matches!(result, Err(StorageError::ProjectNotFound(_))));
    }

    #[test]
    fn test_multiple_projects() {
        let storage = create_test_storage();

        let project1 = Project::new("https://github.com/test/repo1.git".to_string(), None);
        let project2 = Project::new("https://github.com/test/repo2.git".to_string(), None);
        let project3 = Project::new("https://github.com/test/repo3.git".to_string(), None);

        storage.add_project(project1.clone()).unwrap();
        storage.add_project(project2.clone()).unwrap();
        storage.add_project(project3.clone()).unwrap();

        let projects = storage.load_projects().unwrap();
        assert_eq!(projects.len(), 3);

        // Remove middle project
        storage.remove_project(&project2.id).unwrap();
        let projects = storage.load_projects().unwrap();
        assert_eq!(projects.len(), 2);

        // Verify correct ones remain
        let ids: Vec<&str> = projects.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&project1.id.as_str()));
        assert!(ids.contains(&project3.id.as_str()));
        assert!(!ids.contains(&project2.id.as_str()));
    }

    #[test]
    fn test_save_and_reorder_projects() {
        let storage = create_test_storage();

        let mut project_a = Project::new("https://github.com/test/a.git".to_string(), None);
        let mut project_b = Project::new("https://github.com/test/b.git".to_string(), None);
        let mut project_c = Project::new("https://github.com/test/c.git".to_string(), None);
        project_a.order = 2;
        project_b.order = 0;
        project_c.order = 1;

        storage
            .save_projects(&[project_a.clone(), project_b.clone(), project_c.clone()])
            .unwrap();

        let loaded = storage.load_projects().unwrap();
        let loaded_ids: Vec<&str> = loaded.iter().map(|project| project.id.as_str()).collect();
        assert_eq!(
            loaded_ids,
            vec![
                project_b.id.as_str(),
                project_c.id.as_str(),
                project_a.id.as_str()
            ]
        );

        let reordered = storage
            .reorder_projects(&[project_c.id.clone(), project_a.id.clone()])
            .unwrap();
        let reordered_ids: Vec<&str> = reordered
            .iter()
            .map(|project| project.id.as_str())
            .collect();
        assert_eq!(
            reordered_ids,
            vec![
                project_c.id.as_str(),
                project_a.id.as_str(),
                project_b.id.as_str()
            ]
        );
    }

    // --- Environment Tests ---

    #[test]
    fn test_environment_crud() {
        let storage = create_test_storage();

        // Create
        let env = Environment::new("project-123".to_string());
        let saved = storage.add_environment(env.clone()).unwrap();
        assert_eq!(saved.id, env.id);

        // Read
        let loaded = storage.get_environment(&env.id).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().project_id, "project-123");

        // List
        let environments = storage.load_environments().unwrap();
        assert_eq!(environments.len(), 1);

        // Delete
        storage.remove_environment(&env.id).unwrap();
        let environments = storage.load_environments().unwrap();
        assert_eq!(environments.len(), 0);
    }

    #[test]
    fn test_environments_by_project() {
        let storage = create_test_storage();

        let env1 = Environment::new("project-1".to_string());
        let env2 = Environment::new("project-1".to_string());
        let env3 = Environment::new("project-2".to_string());

        storage.add_environment(env1.clone()).unwrap();
        storage.add_environment(env2.clone()).unwrap();
        storage.add_environment(env3.clone()).unwrap();

        let project1_envs = storage.get_environments_by_project("project-1").unwrap();
        assert_eq!(project1_envs.len(), 2);

        let project2_envs = storage.get_environments_by_project("project-2").unwrap();
        assert_eq!(project2_envs.len(), 1);

        let project3_envs = storage.get_environments_by_project("project-3").unwrap();
        assert_eq!(project3_envs.len(), 0);
    }

    #[test]
    fn test_remove_nonexistent_environment() {
        let storage = create_test_storage();

        let result = storage.remove_environment("nonexistent-id");
        assert!(matches!(result, Err(StorageError::EnvironmentNotFound(_))));
    }

    #[test]
    fn test_update_environment() {
        let storage = create_test_storage();

        let env = Environment::new("project-123".to_string());
        storage.add_environment(env.clone()).unwrap();

        let updates = serde_json::json!({
            "status": "running",
            "containerId": "container-abc",
            "prUrl": "https://github.com/test/repo/pull/123",
            "prState": "open",
            "hasMergeConflicts": true
        });

        let updated = storage.update_environment(&env.id, updates).unwrap();
        assert_eq!(updated.status, EnvironmentStatus::Running);
        assert_eq!(updated.container_id, Some("container-abc".to_string()));
        assert_eq!(
            updated.pr_url,
            Some("https://github.com/test/repo/pull/123".to_string())
        );
        assert_eq!(updated.pr_state, Some(crate::models::PrState::Open));
        assert_eq!(updated.has_merge_conflicts, Some(true));

        // Verify it persisted
        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert_eq!(loaded.status, EnvironmentStatus::Running);
        assert_eq!(loaded.pr_state, Some(crate::models::PrState::Open));
        assert_eq!(loaded.has_merge_conflicts, Some(true));
    }

    #[test]
    fn test_update_environment_clears_pr_metadata_with_null() {
        let storage = create_test_storage();

        let mut env = Environment::new("project-123".to_string());
        env.pr_state = Some(crate::models::PrState::Open);
        env.has_merge_conflicts = Some(true);
        storage.add_environment(env.clone()).unwrap();

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "prState": null,
                    "hasMergeConflicts": null
                }),
            )
            .unwrap();

        assert!(updated.pr_state.is_none());
        assert!(updated.has_merge_conflicts.is_none());

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert!(loaded.pr_state.is_none());
        assert!(loaded.has_merge_conflicts.is_none());
    }

    #[test]
    fn test_update_environment_preserves_pr_metadata_on_invalid_values() {
        let storage = create_test_storage();

        let mut env = Environment::new("project-123".to_string());
        env.pr_state = Some(crate::models::PrState::Open);
        env.has_merge_conflicts = Some(true);
        storage.add_environment(env.clone()).unwrap();

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "prState": "not-a-real-state",
                    "hasMergeConflicts": "not-a-bool"
                }),
            )
            .unwrap();

        assert_eq!(updated.pr_state, Some(crate::models::PrState::Open));
        assert_eq!(updated.has_merge_conflicts, Some(true));

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert_eq!(loaded.pr_state, Some(crate::models::PrState::Open));
        assert_eq!(loaded.has_merge_conflicts, Some(true));
    }

    #[test]
    fn test_update_environment_port_mappings() {
        let storage = create_test_storage();

        let env = Environment::new("project-123".to_string());
        storage.add_environment(env.clone()).unwrap();

        let updates = serde_json::json!({
            "portMappings": [
                { "containerPort": 3000, "hostPort": 3001, "protocol": "tcp" },
                { "containerPort": 8080, "hostPort": 8080, "protocol": "tcp" }
            ]
        });

        let updated = storage.update_environment(&env.id, updates).unwrap();
        assert!(updated.port_mappings.is_some());
        let mappings = updated.port_mappings.unwrap();
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].container_port, 3000);
        assert_eq!(mappings[0].host_port, 3001);
        assert_eq!(mappings[1].container_port, 8080);

        // Verify it persisted
        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert!(loaded.port_mappings.is_some());
        assert_eq!(loaded.port_mappings.unwrap().len(), 2);
    }

    #[test]
    fn test_update_environment_allowed_domains() {
        let storage = create_test_storage();

        let env = Environment::new("project-123".to_string());
        storage.add_environment(env.clone()).unwrap();

        let updates = serde_json::json!({
            "allowedDomains": ["github.com", "npmjs.org", "api.anthropic.com"]
        });

        let updated = storage.update_environment(&env.id, updates).unwrap();
        assert!(updated.allowed_domains.is_some());
        let domains = updated.allowed_domains.unwrap();
        assert_eq!(domains.len(), 3);
        assert!(domains.contains(&"github.com".to_string()));

        // Verify it persisted
        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert!(loaded.allowed_domains.is_some());
        assert_eq!(loaded.allowed_domains.unwrap().len(), 3);
    }

    #[test]
    fn test_update_environment_entry_port() {
        let storage = create_test_storage();

        let env = Environment::new("project-123".to_string());
        storage.add_environment(env.clone()).unwrap();

        // Set both entry port and host entry port
        let updates = serde_json::json!({
            "entryPort": 3000,
            "hostEntryPort": 49152
        });
        let updated = storage.update_environment(&env.id, updates).unwrap();
        assert_eq!(updated.entry_port, Some(3000));
        assert_eq!(updated.host_entry_port, Some(49152));

        // Verify it persisted
        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert_eq!(loaded.entry_port, Some(3000));
        assert_eq!(loaded.host_entry_port, Some(49152));

        // Clear both by setting to null
        let clear_updates = serde_json::json!({
            "entryPort": null,
            "hostEntryPort": null
        });
        let cleared = storage.update_environment(&env.id, clear_updates).unwrap();
        assert_eq!(cleared.entry_port, None);
        assert_eq!(cleared.host_entry_port, None);

        // Verify cleared state persisted
        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert_eq!(loaded.entry_port, None);
        assert_eq!(loaded.host_entry_port, None);
    }

    #[test]
    fn test_update_environment_codex_mode() {
        let storage = create_test_storage();

        let env = Environment::new("project-123".to_string());
        storage.add_environment(env.clone()).unwrap();

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "codexMode": "terminal"
                }),
            )
            .unwrap();
        assert_eq!(updated.codex_mode, Some(crate::models::CodexMode::Terminal));

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert_eq!(loaded.codex_mode, Some(crate::models::CodexMode::Terminal));

        let cleared = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "codexMode": null
                }),
            )
            .unwrap();
        assert_eq!(cleared.codex_mode, None);

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert_eq!(loaded.codex_mode, None);
    }

    #[test]
    fn test_update_environment_setup_scripts_complete() {
        let storage = create_test_storage();

        let env = Environment::new_local("project-123".to_string(), "test-env".to_string());
        storage.add_environment(env.clone()).unwrap();

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "setupScriptsComplete": true
                }),
            )
            .unwrap();
        assert!(updated.setup_scripts_complete);

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert!(loaded.setup_scripts_complete);

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "setupScriptsComplete": false
                }),
            )
            .unwrap();
        assert!(!updated.setup_scripts_complete);

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert!(!loaded.setup_scripts_complete);
    }

    #[test]
    fn test_update_environment_ignores_invalid_setup_scripts_complete() {
        let storage = create_test_storage();

        let env = Environment::new_local("project-123".to_string(), "test-env".to_string());
        storage.add_environment(env.clone()).unwrap();

        storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "setupScriptsComplete": true
                }),
            )
            .unwrap();

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "setupScriptsComplete": "yes"
                }),
            )
            .unwrap();
        assert!(updated.setup_scripts_complete);

        let updated = storage
            .update_environment(
                &env.id,
                serde_json::json!({
                    "setupScriptsComplete": null
                }),
            )
            .unwrap();
        assert!(updated.setup_scripts_complete);

        let loaded = storage.get_environment(&env.id).unwrap().unwrap();
        assert!(loaded.setup_scripts_complete);
    }

    #[test]
    fn test_update_nonexistent_environment() {
        let storage = create_test_storage();

        let updates = serde_json::json!({ "status": "running" });
        let result = storage.update_environment("nonexistent", updates);

        assert!(matches!(result, Err(StorageError::EnvironmentNotFound(_))));
    }

    #[test]
    fn test_save_get_all_and_reorder_environments() {
        let storage = create_test_storage();

        let mut env_a = Environment::new("project-1".to_string());
        let mut env_b = Environment::new("project-1".to_string());
        let mut env_c = Environment::new("project-2".to_string());
        env_a.order = 2;
        env_b.order = 0;
        env_c.order = 1;

        storage
            .save_environments(&[env_a.clone(), env_b.clone(), env_c.clone()])
            .unwrap();

        let all = storage.get_all_environments().unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, env_b.id);

        let reordered = storage
            .reorder_environments("project-1", &[env_a.id.clone()])
            .unwrap();
        let reordered_ids: Vec<&str> = reordered.iter().map(|env| env.id.as_str()).collect();
        assert_eq!(reordered_ids, vec![env_a.id.as_str(), env_b.id.as_str()]);
    }

    #[test]
    fn test_load_environments_repairs_invalid_array_without_backup() {
        let storage = create_test_storage();

        let env = Environment::new("project-1".to_string());
        storage.save_environments(&[env.clone()]).unwrap();

        let path = storage.environments_file();
        let valid_contents = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{valid_contents}\ntrailing-garbage")).unwrap();

        let repaired = storage.load_environments().unwrap();
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0].id, env.id);
    }

    // --- Config Tests ---

    #[test]
    fn test_config_default() {
        let storage = create_test_storage();

        // Loading config before saving should return default
        let config = storage.load_config().unwrap();
        assert_eq!(config.version, "1.0.0");
        assert!(config.repositories.is_empty());
    }

    #[test]
    fn test_config_save_load() {
        let storage = create_test_storage();

        let mut config = AppConfig::default();
        config.global.container_resources.cpu_cores = 4;
        config.global.container_resources.memory_gb = 8;

        storage.save_config(&config).unwrap();

        let loaded = storage.load_config().unwrap();
        assert_eq!(loaded.global.container_resources.cpu_cores, 4);
        assert_eq!(loaded.global.container_resources.memory_gb, 8);
    }

    #[test]
    fn test_config_with_repositories() {
        let storage = create_test_storage();

        let mut config = AppConfig::default();
        config.repositories.insert(
            "repo-1".to_string(),
            crate::models::RepositoryConfig {
                default_branch: "develop".to_string(),
                pr_base_branch: "main".to_string(),
                default_port_mappings: None,
                files_to_copy: None,
                default_model: None,
                default_effort: None,
                entry_port: None,
                default_agent: None,
                agent_style: None,
            },
        );

        storage.save_config(&config).unwrap();

        let loaded = storage.load_config().unwrap();
        assert_eq!(loaded.repositories.len(), 1);
        assert!(loaded.repositories.contains_key("repo-1"));
        assert_eq!(
            loaded.repositories.get("repo-1").unwrap().default_branch,
            "develop"
        );
    }

    // --- Empty File Tests ---

    #[test]
    fn test_load_empty_projects() {
        let storage = create_test_storage();
        let projects = storage.load_projects().unwrap();
        assert!(projects.is_empty());
    }

    #[test]
    fn test_load_empty_environments() {
        let storage = create_test_storage();
        let environments = storage.load_environments().unwrap();
        assert!(environments.is_empty());
    }

    // --- Session Tests ---

    #[test]
    fn test_session_crud() {
        let storage = create_test_storage();

        // Create
        let session = Session::new(
            "env-123".to_string(),
            "container-abc".to_string(),
            "tab-default".to_string(),
            SessionType::Claude,
        );
        let saved = storage.add_session(session.clone()).unwrap();
        assert_eq!(saved.id, session.id);
        assert_eq!(saved.status, SessionStatus::Connected);

        // Read
        let loaded = storage.get_session(&session.id).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().environment_id, "env-123");

        // List by environment
        let sessions = storage.get_sessions_by_environment("env-123").unwrap();
        assert_eq!(sessions.len(), 1);

        // Update status
        let updated = storage
            .update_session_status(&session.id, SessionStatus::Disconnected)
            .unwrap();
        assert_eq!(updated.status, SessionStatus::Disconnected);

        // Delete
        storage.remove_session(&session.id).unwrap();
        let sessions = storage.get_sessions_by_environment("env-123").unwrap();
        assert_eq!(sessions.len(), 0);
    }

    #[test]
    fn test_sessions_by_environment() {
        let storage = create_test_storage();

        let session1 = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        let session2 = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-2".to_string(),
            SessionType::Claude,
        );
        let session3 = Session::new(
            "env-2".to_string(),
            "container-2".to_string(),
            "tab-1".to_string(),
            SessionType::ClaudeYolo,
        );

        storage.add_session(session1).unwrap();
        storage.add_session(session2).unwrap();
        storage.add_session(session3).unwrap();

        let env1_sessions = storage.get_sessions_by_environment("env-1").unwrap();
        assert_eq!(env1_sessions.len(), 2);

        let env2_sessions = storage.get_sessions_by_environment("env-2").unwrap();
        assert_eq!(env2_sessions.len(), 1);

        let env3_sessions = storage.get_sessions_by_environment("env-3").unwrap();
        assert_eq!(env3_sessions.len(), 0);
    }

    #[test]
    fn test_remove_sessions_by_environment() {
        let storage = create_test_storage();

        let session1 = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        let session2 = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-2".to_string(),
            SessionType::Claude,
        );
        let session3 = Session::new(
            "env-2".to_string(),
            "container-2".to_string(),
            "tab-1".to_string(),
            SessionType::ClaudeYolo,
        );

        storage.add_session(session1).unwrap();
        storage.add_session(session2).unwrap();
        storage.add_session(session3).unwrap();

        // Remove all sessions for env-1
        let deleted_ids = storage.remove_sessions_by_environment("env-1").unwrap();
        assert_eq!(deleted_ids.len(), 2);

        // Verify only env-2 sessions remain
        let all_sessions = storage.load_sessions().unwrap();
        assert_eq!(all_sessions.len(), 1);
        assert_eq!(all_sessions[0].environment_id, "env-2");
    }

    #[test]
    fn test_disconnect_environment_sessions() {
        let storage = create_test_storage();

        let session1 = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        let session2 = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-2".to_string(),
            SessionType::Claude,
        );

        storage.add_session(session1.clone()).unwrap();
        storage.add_session(session2.clone()).unwrap();

        // Both should be connected initially
        let sessions = storage.get_sessions_by_environment("env-1").unwrap();
        assert!(sessions
            .iter()
            .all(|s| s.status == SessionStatus::Connected));

        // Disconnect all sessions for env-1
        let disconnected = storage.disconnect_environment_sessions("env-1").unwrap();
        assert_eq!(disconnected.len(), 2);

        // Verify all are now disconnected
        let sessions = storage.get_sessions_by_environment("env-1").unwrap();
        assert!(sessions
            .iter()
            .all(|s| s.status == SessionStatus::Disconnected));
    }

    #[test]
    fn test_session_buffer_operations() {
        let storage = create_test_storage();

        // Save buffer
        let buffer_content = "Hello World\nLine 2\n";
        storage
            .save_session_buffer("session-123", buffer_content)
            .unwrap();

        // Load buffer
        let loaded = storage.load_session_buffer("session-123").unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap(), buffer_content);

        // Load non-existent buffer
        let non_existent = storage.load_session_buffer("session-999").unwrap();
        assert!(non_existent.is_none());

        // Delete buffer
        storage.delete_session_buffer("session-123").unwrap();
        let deleted = storage.load_session_buffer("session-123").unwrap();
        assert!(deleted.is_none());
    }

    #[test]
    fn test_session_buffer_truncation() {
        let storage = create_test_storage();

        // Create a buffer larger than the limit (500KB)
        let large_buffer: String = "x".repeat(600 * 1024);

        storage
            .save_session_buffer("session-large", &large_buffer)
            .unwrap();

        let loaded = storage
            .load_session_buffer("session-large")
            .unwrap()
            .unwrap();
        // Should be truncated to approximately 500KB (might be slightly less due to UTF-8 boundary)
        assert!(loaded.len() <= 500 * 1024);
        assert!(loaded.len() > 400 * 1024); // But not too much less
    }

    #[test]
    fn test_max_sessions_per_environment() {
        let storage = create_test_storage();

        // Create MAX_SESSIONS_PER_ENVIRONMENT sessions
        for i in 0..Storage::MAX_SESSIONS_PER_ENVIRONMENT {
            let mut session = Session::new(
                "env-1".to_string(),
                "container-1".to_string(),
                format!("tab-{}", i),
                SessionType::Plain,
            );
            // Mark older sessions as disconnected
            if i < Storage::MAX_SESSIONS_PER_ENVIRONMENT - 1 {
                session.status = SessionStatus::Disconnected;
            }
            storage.add_session(session).unwrap();
        }

        let sessions = storage.get_sessions_by_environment("env-1").unwrap();
        assert_eq!(sessions.len(), Storage::MAX_SESSIONS_PER_ENVIRONMENT);

        // Now disconnect the last session so we have all disconnected
        let last_session_id = sessions.last().unwrap().id.clone();
        storage
            .update_session_status(&last_session_id, SessionStatus::Disconnected)
            .unwrap();

        // Add one more session - should remove oldest disconnected
        let new_session = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-new".to_string(),
            SessionType::Claude,
        );
        storage.add_session(new_session).unwrap();

        // Should still have MAX_SESSIONS_PER_ENVIRONMENT sessions
        let sessions = storage.get_sessions_by_environment("env-1").unwrap();
        assert_eq!(sessions.len(), Storage::MAX_SESSIONS_PER_ENVIRONMENT);

        // The newest session should be there
        assert!(sessions.iter().any(|s| s.tab_id == "tab-new"));
    }

    #[test]
    fn test_touch_session() {
        let storage = create_test_storage();

        let session = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        let saved = storage.add_session(session.clone()).unwrap();
        let original_activity = saved.last_activity_at;

        // Wait a tiny bit to ensure time difference
        std::thread::sleep(std::time::Duration::from_millis(10));

        // Touch the session
        let touched = storage.touch_session(&saved.id).unwrap();
        assert!(touched.last_activity_at > original_activity);
    }

    #[test]
    fn test_load_empty_sessions() {
        let storage = create_test_storage();
        let sessions = storage.load_sessions().unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_save_rename_launch_and_reorder_sessions() {
        let storage = create_test_storage();

        let mut session_a = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        let mut session_b = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-2".to_string(),
            SessionType::Claude,
        );
        session_a.order = 1;
        session_b.order = 0;

        storage
            .save_sessions(&[session_a.clone(), session_b.clone()])
            .unwrap();
        assert_eq!(storage.load_sessions().unwrap().len(), 2);

        let renamed = storage
            .rename_session(&session_a.id, Some("Renamed session".to_string()))
            .unwrap();
        assert_eq!(renamed.name.as_deref(), Some("Renamed session"));

        let launched = storage
            .set_session_has_launched_command(&session_a.id, true)
            .unwrap();
        assert!(launched.has_launched_command);

        let reordered = storage
            .reorder_sessions("env-1", &[session_a.id.clone()])
            .unwrap();
        let reordered_ids: Vec<&str> = reordered
            .iter()
            .map(|session| session.id.as_str())
            .collect();
        assert_eq!(
            reordered_ids,
            vec![session_a.id.as_str(), session_b.id.as_str()]
        );
    }

    #[test]
    fn test_cleanup_orphaned_buffers_removes_only_unknown_sessions() {
        let storage = create_test_storage();

        let session = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        storage.add_session(session.clone()).unwrap();
        storage
            .save_session_buffer(&session.id, "keep this buffer")
            .unwrap();
        storage
            .save_session_buffer("orphan-session", "remove this buffer")
            .unwrap();

        let deleted = storage.cleanup_orphaned_buffers().unwrap();
        assert_eq!(deleted, vec!["orphan-session".to_string()]);
        assert!(storage.load_session_buffer(&session.id).unwrap().is_some());
        assert!(storage
            .load_session_buffer("orphan-session")
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_sessions_backups_rotate_only_after_minimum_age() {
        let storage = create_test_storage();

        let session_a = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-1".to_string(),
            SessionType::Plain,
        );
        storage.save_sessions(&[session_a.clone()]).unwrap();

        let session_b = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-2".to_string(),
            SessionType::Claude,
        );
        storage
            .save_sessions(&[session_a.clone(), session_b.clone()])
            .unwrap();

        let sessions_path = storage.sessions_file();
        let backup_path = Storage::json_backup_path(&sessions_path, 1);
        assert!(backup_path.exists());
        let first_backup: Vec<Session> =
            serde_json::from_str(&std::fs::read_to_string(&backup_path).unwrap()).unwrap();
        assert_eq!(first_backup.len(), 1);

        let session_c = Session::new(
            "env-1".to_string(),
            "container-1".to_string(),
            "tab-3".to_string(),
            SessionType::Opencode,
        );
        storage
            .save_sessions(&[session_a.clone(), session_b.clone(), session_c.clone()])
            .unwrap();

        let throttled_backup: Vec<Session> =
            serde_json::from_str(&std::fs::read_to_string(&backup_path).unwrap()).unwrap();
        assert_eq!(throttled_backup.len(), 1);

        let old_mtime =
            FileTime::from_unix_time((Utc::now() - chrono::TimeDelta::seconds(61)).timestamp(), 0);
        set_file_mtime(&backup_path, old_mtime).unwrap();

        storage
            .save_sessions(&[session_a, session_b, session_c])
            .unwrap();

        let rotated_backup: Vec<Session> =
            serde_json::from_str(&std::fs::read_to_string(&backup_path).unwrap()).unwrap();
        assert_eq!(rotated_backup.len(), 3);
    }

    // --- Kanban PR Metadata Tests ---

    #[test]
    fn test_kanban_task_pr_fields_default() {
        let task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        assert!(task.pr_url.is_none());
        assert!(task.pr_state.is_none());
        assert!(!task.pr_merge_commented);
    }

    #[test]
    fn test_update_kanban_task_pr_url() {
        let storage = create_test_storage();
        let task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        let saved = storage.add_kanban_task(task).unwrap();

        let updated = storage
            .update_kanban_task(
                &saved.id,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("https://github.com/test/repo/pull/42".to_string()),
                Some("open".to_string()),
                None,
            )
            .unwrap();

        assert_eq!(
            updated.pr_url,
            Some("https://github.com/test/repo/pull/42".to_string())
        );
        assert_eq!(updated.pr_state, Some("open".to_string()));
        assert!(!updated.pr_merge_commented);

        // Verify persistence
        let tasks = storage.get_kanban_tasks_by_project("proj-1").unwrap();
        assert_eq!(
            tasks[0].pr_url,
            Some("https://github.com/test/repo/pull/42".to_string())
        );
    }

    #[test]
    fn test_update_kanban_task_pr_merge_commented() {
        let storage = create_test_storage();
        let task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        let saved = storage.add_kanban_task(task).unwrap();

        let updated = storage
            .update_kanban_task(
                &saved.id,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("https://github.com/test/repo/pull/1".to_string()),
                Some("merged".to_string()),
                Some(true),
            )
            .unwrap();

        assert_eq!(updated.pr_state, Some("merged".to_string()));
        assert!(updated.pr_merge_commented);
    }

    #[test]
    fn test_update_kanban_task_pr_url_empty_clears() {
        let storage = create_test_storage();
        let task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        let saved = storage.add_kanban_task(task).unwrap();

        // Set a PR URL
        storage
            .update_kanban_task(
                &saved.id,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("https://github.com/test/repo/pull/1".to_string()),
                Some("open".to_string()),
                None,
            )
            .unwrap();

        // Clear it by passing empty string
        let cleared = storage
            .update_kanban_task(
                &saved.id,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(String::new()),
                Some(String::new()),
                None,
            )
            .unwrap();

        assert!(cleared.pr_url.is_none());
        assert!(cleared.pr_state.is_none());
    }

    #[test]
    fn test_kanban_task_pr_fields_serialization() {
        let mut task = KanbanTask::new(
            "proj-1".to_string(),
            "title".to_string(),
            "desc".to_string(),
        );
        task.pr_url = Some("https://github.com/test/repo/pull/99".to_string());
        task.pr_state = Some("merged".to_string());
        task.pr_merge_commented = true;

        let json = serde_json::to_string(&task).unwrap();
        assert!(json.contains("\"prUrl\":"));
        assert!(json.contains("\"prState\":"));
        assert!(json.contains("\"prMergeCommented\":true"));

        let deserialized: KanbanTask = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deserialized.pr_url,
            Some("https://github.com/test/repo/pull/99".to_string())
        );
        assert_eq!(deserialized.pr_state, Some("merged".to_string()));
        assert!(deserialized.pr_merge_commented);
    }

    #[test]
    fn test_kanban_task_pr_fields_deserialization_defaults() {
        // Simulate loading a task JSON that was saved before the PR fields existed
        let json = r#"{
            "id": "test-id",
            "projectId": "proj-1",
            "title": "Old task",
            "description": "desc",
            "acceptanceCriteria": "",
            "status": "backlog",
            "comments": [],
            "images": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "order": 0
        }"#;

        let task: KanbanTask = serde_json::from_str(json).unwrap();
        assert!(task.pr_url.is_none());
        assert!(task.pr_state.is_none());
        assert!(!task.pr_merge_commented);
    }

    #[test]
    fn test_save_comment_image_and_delete_kanban_tasks() {
        let storage = create_test_storage();

        let task_a = KanbanTask::new(
            "proj-1".to_string(),
            "Task A".to_string(),
            "desc".to_string(),
        );
        let task_b = KanbanTask::new(
            "proj-1".to_string(),
            "Task B".to_string(),
            "desc".to_string(),
        );

        storage
            .save_kanban_tasks(&[task_a.clone(), task_b.clone()])
            .unwrap();
        assert_eq!(storage.load_kanban_tasks().unwrap().len(), 2);

        let with_comment = storage
            .add_kanban_comment(&task_a.id, "first comment".to_string())
            .unwrap();
        assert_eq!(with_comment.comments.len(), 1);

        let comment_id = with_comment.comments[0].id.clone();
        let without_comment = storage
            .delete_kanban_comment(&task_a.id, &comment_id)
            .unwrap();
        assert!(without_comment.comments.is_empty());

        let with_image = storage
            .add_kanban_image(
                &task_a.id,
                "pixel.png".to_string(),
                create_test_png_base64(),
            )
            .unwrap();
        assert_eq!(with_image.images.len(), 1);

        let image_id = with_image.images[0].id.clone();
        let image_path = storage.kanban_image_file(&image_id);
        assert!(image_path.exists());
        let encoded = storage.get_kanban_image_data(&image_id).unwrap();
        assert!(!encoded.is_empty());

        let without_image = storage.delete_kanban_image(&task_a.id, &image_id).unwrap();
        assert!(without_image.images.is_empty());
        assert!(!image_path.exists());

        let with_image_again = storage
            .add_kanban_image(
                &task_a.id,
                "pixel.png".to_string(),
                create_test_png_base64(),
            )
            .unwrap();
        let task_image_path = storage.kanban_image_file(&with_image_again.images[0].id);
        assert!(task_image_path.exists());

        storage.delete_kanban_task(&task_a.id).unwrap();
        assert!(!task_image_path.exists());

        let remaining = storage.get_kanban_tasks_by_project("proj-1").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, task_b.id);
    }

    #[test]
    fn test_project_notes_crud() {
        let storage = create_test_storage();

        let default_notes = storage.get_project_notes("proj-1").unwrap();
        assert_eq!(default_notes.project_id, "proj-1");
        assert!(default_notes.content.is_empty());
        assert!(storage.load_project_notes().unwrap().is_empty());

        let saved = storage
            .save_project_notes_for_project("proj-1", "hello world".to_string())
            .unwrap();
        assert_eq!(saved.content, "hello world");

        let all_notes = storage.load_project_notes().unwrap();
        assert_eq!(all_notes.len(), 1);
        assert_eq!(all_notes[0].content, "hello world");

        let fetched = storage.get_project_notes("proj-1").unwrap();
        assert_eq!(fetched.content, "hello world");
    }

    #[test]
    fn test_should_rotate_never_policy_returns_false() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        // Never policy returns false even when the file exists
        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        storage.add_project(project).unwrap();
        assert!(path.exists());

        assert!(!Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::Never
        ));
    }

    #[test]
    fn test_should_rotate_never_policy_returns_false_when_file_missing() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        assert!(!Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::Never
        ));
    }

    #[test]
    fn test_should_rotate_always_policy_returns_true() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        storage.add_project(project).unwrap();
        assert!(path.exists());

        assert!(Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::Always
        ));
    }

    #[test]
    fn test_should_rotate_always_policy_returns_false_when_file_missing() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        assert!(!Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::Always
        ));
    }

    #[test]
    fn test_should_rotate_if_older_than_no_backup_returns_true() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        storage.add_project(project).unwrap();

        // No .bak.1 exists yet — should rotate
        assert!(Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::IfOlderThan(Duration::from_secs(60))
        ));
    }

    #[test]
    fn test_should_rotate_if_older_than_recent_backup_returns_false() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        // Create a file and its first backup (recently modified)
        std::fs::write(&path, "[]").unwrap();
        let backup = Storage::json_backup_path(&path, 1);
        std::fs::write(&backup, "[]").unwrap();

        assert!(!Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::IfOlderThan(Duration::from_secs(60))
        ));
    }

    #[test]
    fn test_should_rotate_if_older_than_old_backup_returns_true() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        std::fs::write(&path, "[]").unwrap();
        let backup = Storage::json_backup_path(&path, 1);
        std::fs::write(&backup, "[]").unwrap();

        // Set backup mtime to 61 seconds ago
        let old_mtime =
            FileTime::from_unix_time((Utc::now() - chrono::TimeDelta::seconds(61)).timestamp(), 0);
        set_file_mtime(&backup, old_mtime).unwrap();

        assert!(Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::IfOlderThan(Duration::from_secs(60))
        ));
    }

    #[test]
    fn test_should_rotate_if_older_than_future_mtime_returns_true() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        std::fs::write(&path, "[]").unwrap();
        let backup = Storage::json_backup_path(&path, 1);
        std::fs::write(&backup, "[]").unwrap();

        // Set backup mtime to the future
        let future_mtime = FileTime::from_unix_time(
            (Utc::now() + chrono::TimeDelta::seconds(3600)).timestamp(),
            0,
        );
        set_file_mtime(&backup, future_mtime).unwrap();

        assert!(Storage::should_rotate_json_backups(
            &path,
            JsonBackupPolicy::IfOlderThan(Duration::from_secs(60))
        ));
    }

    #[test]
    fn test_replace_file_creates_new_when_target_missing() {
        let storage = create_test_storage();
        let path = storage.data_dir.join("new-file.json");
        let temp = storage.data_dir.join("temp-file.json");

        std::fs::write(&temp, "new-content").unwrap();
        assert!(!path.exists());

        Storage::replace_file(&path, &temp).unwrap();

        assert!(path.exists());
        assert!(!temp.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new-content");
    }

    #[test]
    fn test_replace_file_overwrites_existing() {
        let storage = create_test_storage();
        let path = storage.data_dir.join("existing.json");
        let temp = storage.data_dir.join("replacement.json");

        std::fs::write(&path, "old-content").unwrap();
        std::fs::write(&temp, "new-content").unwrap();

        Storage::replace_file(&path, &temp).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new-content");
        assert!(!temp.exists());
    }

    #[test]
    fn test_write_atomic_creates_parent_dirs() {
        let storage = create_test_storage();
        let nested = storage.data_dir.join("a").join("b").join("c.json");

        Storage::write_atomic(&nested, "[]", JsonBackupPolicy::Never).unwrap();

        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "[]");
    }

    #[test]
    fn test_write_atomic_cleans_up_temp_on_backup_failure() {
        let storage = create_test_storage();
        let path = storage.data_dir.join("test.json");

        // First write succeeds
        Storage::write_atomic(&path, "[1]", JsonBackupPolicy::Never).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1]");

        // Second write also succeeds with Never policy
        Storage::write_atomic(&path, "[1,2]", JsonBackupPolicy::Never).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1,2]");

        // No leftover .tmp files
        let tmp_files: Vec<_> = std::fs::read_dir(&storage.data_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(tmp_files.is_empty(), "leftover temp files: {:?}", tmp_files);
    }

    #[test]
    fn test_archive_invalid_json_creates_snapshot() {
        let storage = create_test_storage();
        let path = storage.data_dir.join("test.json");

        Storage::archive_invalid_json(&path, "broken-content", "test-reason");

        let snapshots: Vec<_> = std::fs::read_dir(&storage.data_dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("test.json.corrupted.")
            })
            .collect();
        assert_eq!(snapshots.len(), 1);

        let content = std::fs::read_to_string(snapshots[0].path()).unwrap();
        assert_eq!(content, "broken-content");
    }

    #[test]
    fn test_restore_from_backups_skips_invalid_and_finds_valid() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        // Create the main file (will be "corrupt")
        std::fs::write(&path, "corrupt").unwrap();

        // .bak.1 is invalid
        let bak1 = Storage::json_backup_path(&path, 1);
        std::fs::write(&bak1, "also-invalid").unwrap();

        // .bak.2 is invalid
        let bak2 = Storage::json_backup_path(&path, 2);
        std::fs::write(&bak2, "still-invalid").unwrap();

        // .bak.3 is valid
        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        let valid_json = serde_json::to_string_pretty(&vec![&project]).unwrap();
        let bak3 = Storage::json_backup_path(&path, 3);
        std::fs::write(&bak3, &valid_json).unwrap();

        let restored: Option<Vec<Project>> =
            storage.restore_from_backups(&path, "corrupt").unwrap();

        assert!(restored.is_some());
        let projects = restored.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, project.id);

        // The valid backup should have been written to the main file
        let restored_main: Vec<Project> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(restored_main.len(), 1);
    }

    #[test]
    fn test_restore_from_backups_returns_none_when_all_invalid() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        std::fs::write(&path, "corrupt").unwrap();

        let bak1 = Storage::json_backup_path(&path, 1);
        std::fs::write(&bak1, "invalid-1").unwrap();

        let bak2 = Storage::json_backup_path(&path, 2);
        std::fs::write(&bak2, "invalid-2").unwrap();

        let restored: Option<Vec<Project>> =
            storage.restore_from_backups(&path, "corrupt").unwrap();

        assert!(restored.is_none());
    }

    #[test]
    fn test_rotate_json_backups_never_policy_is_noop() {
        let storage = create_test_storage();
        let path = storage.projects_file();

        let project = Project::new("https://github.com/test/repo.git".to_string(), None);
        storage.add_project(project).unwrap();

        Storage::rotate_json_backups(&path, JsonBackupPolicy::Never).unwrap();

        let bak1 = Storage::json_backup_path(&path, 1);
        assert!(!bak1.exists());
    }

    #[test]
    fn test_json_backup_rotation_keeps_last_five_versions() {
        let storage = create_test_storage();

        for version in 0..7 {
            storage
                .save_project_notes_for_project("proj-1", format!("version-{version}"))
                .unwrap();
        }

        let notes_path = storage.project_notes_file();
        for index in 1..=Storage::MAX_JSON_BACKUPS {
            let backup_path = Storage::json_backup_path(&notes_path, index);
            assert!(
                backup_path.exists(),
                "missing backup {}",
                backup_path.display()
            );

            let notes: Vec<ProjectNotes> =
                serde_json::from_str(&std::fs::read_to_string(&backup_path).unwrap()).unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].content, format!("version-{}", 6 - index));
        }

        assert!(!Storage::json_backup_path(&notes_path, Storage::MAX_JSON_BACKUPS + 1).exists());
    }

    #[test]
    fn test_load_config_restores_from_backup_when_current_file_is_invalid() {
        let storage = create_test_storage();

        let config_v1 = AppConfig::default();
        storage.save_config(&config_v1).unwrap();

        let mut config_v2 = AppConfig::default();
        config_v2.global.debug_logging = true;
        storage.save_config(&config_v2).unwrap();

        let config_path = storage.config_file();
        std::fs::write(&config_path, "{ not valid json").unwrap();

        let restored = storage.load_config().unwrap();
        assert!(!restored.global.debug_logging);

        let current: AppConfig =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(!current.global.debug_logging);

        let archived_count = std::fs::read_dir(&storage.data_dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("config.json.corrupted.")
            })
            .count();
        assert_eq!(archived_count, 1);
    }

    #[test]
    fn test_load_kanban_tasks_restores_from_backup_when_current_file_is_invalid() {
        let storage = create_test_storage();

        let first = KanbanTask::new(
            "proj-1".to_string(),
            "First task".to_string(),
            "desc".to_string(),
        );
        storage.add_kanban_task(first).unwrap();

        let second = KanbanTask::new(
            "proj-1".to_string(),
            "Second task".to_string(),
            "desc".to_string(),
        );
        storage.add_kanban_task(second).unwrap();

        let kanban_path = storage.kanban_file();
        std::fs::write(&kanban_path, "{ not valid json").unwrap();

        let restored = storage.load_kanban_tasks().unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].title, "First task");

        let current: Vec<KanbanTask> =
            serde_json::from_str(&std::fs::read_to_string(&kanban_path).unwrap()).unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].title, "First task");

        let archived_count = std::fs::read_dir(&storage.data_dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("kanban.json.corrupted.")
            })
            .count();
        assert_eq!(archived_count, 1);
    }
}
