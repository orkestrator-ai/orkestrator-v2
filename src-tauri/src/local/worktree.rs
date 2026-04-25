//! Git worktree operations for local environments
//!
//! Handles creating, deleting, and managing git worktrees in the
//! ~/orkestrator-ai/workspaces/ directory.

use rand::Rng;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use tokio::process::Command;
use tracing::{debug, error, info, warn};

/// Error type for worktree operations
#[derive(Error, Debug)]
pub enum WorktreeError {
    #[error("Source repository not found: {0}")]
    SourceNotFound(String),

    #[error("Failed to create worktree directory: {0}")]
    DirectoryCreationFailed(String),

    #[error("Failed to create worktree: {0}")]
    WorktreeCreationFailed(String),

    #[error("Failed to delete worktree: {0}")]
    WorktreeDeletionFailed(String),

    #[error("Failed to detect default branch: {0}")]
    BranchDetectionFailed(String),

    #[error("Failed to copy project files: {0}")]
    FileCopyFailed(String),

    #[error("Failed to configure local git behavior: {0}")]
    GitConfigurationFailed(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Home directory not found")]
    HomeDirNotFound,
}

pub struct WorktreeCreateResult {
    pub path: String,
    pub branch: String,
}

const LOCAL_GIT_EXCLUDE_PATTERNS: &[&str] = &[".orkestrator", "CONTINUITY.md"];
const LOCAL_SKIP_WORKTREE_PATHS: &[&str] = &["CONTINUITY.md"];

/// Base directory for local worktrees
const WORKTREE_BASE_DIR: &str = "orkestrator-ai/workspaces";

/// Get the base path for worktrees: ~/orkestrator-ai/workspaces/
fn get_worktree_base_path() -> Result<PathBuf, WorktreeError> {
    let home = dirs::home_dir().ok_or(WorktreeError::HomeDirNotFound)?;
    Ok(home.join(WORKTREE_BASE_DIR))
}

/// Generate a unique 6-character alphanumeric suffix
fn generate_unique_suffix() -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| {
            let idx = rng.gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

/// Maximum attempts to generate a unique worktree path
const MAX_WORKTREE_PATH_ATTEMPTS: u32 = 100;

/// Generate a unique worktree path with a random suffix
///
/// Always includes a unique 6-character alphanumeric suffix to ensure all
/// worktree paths are distinct, even the first one created for a project.
///
/// # Path Format
///
/// Generated paths follow the pattern: `<base_path>/<project_name>-<suffix>`
///
/// For example: `~/orkestrator-ai/workspaces/my-project-abc123`
///
/// # Note
///
/// This function always generates a suffix. Existing environments store their
/// `worktree_path` in storage and are not affected by this behavior.
pub fn generate_worktree_path(project_name: &str) -> Result<PathBuf, WorktreeError> {
    let base_path = get_worktree_base_path()?;

    // Always generate a unique suffix for the worktree path
    let mut attempts = 0;
    loop {
        attempts += 1;
        if attempts > MAX_WORKTREE_PATH_ATTEMPTS {
            return Err(WorktreeError::DirectoryCreationFailed(format!(
                "Failed to generate unique worktree path after {} attempts for project: {}",
                MAX_WORKTREE_PATH_ATTEMPTS, project_name
            )));
        }

        let suffix = generate_unique_suffix();
        let name_with_suffix = format!("{}-{}", project_name, suffix);
        let worktree_path = base_path.join(name_with_suffix);

        if !worktree_path.exists() {
            return Ok(worktree_path);
        }
    }
}

/// Detect the default branch (main or master) of a git repository
pub async fn get_default_branch(repo_path: &str) -> Result<String, WorktreeError> {
    debug!(repo_path = %repo_path, "Detecting default branch");

    // First, try to get the remote HEAD
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::BranchDetectionFailed(e.to_string()))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string()
            .replace("origin/", "");
        if !branch.is_empty() {
            debug!(branch = %branch, "Detected default branch from remote HEAD");
            return Ok(branch);
        }
    }

    // Fallback: check if main exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "refs/heads/main"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::BranchDetectionFailed(e.to_string()))?;

    if output.status.success() {
        debug!("Detected 'main' as default branch");
        return Ok("main".to_string());
    }

    // Fallback: check if master exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "refs/heads/master"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::BranchDetectionFailed(e.to_string()))?;

    if output.status.success() {
        debug!("Detected 'master' as default branch");
        return Ok("master".to_string());
    }

    // Final fallback
    warn!(repo_path = %repo_path, "Could not detect default branch, falling back to 'main'");
    Ok("main".to_string())
}

/// Resolve the common git directory for a repository or worktree
///
/// For regular repositories, this returns the `.git` directory.
/// For worktrees, this reads the `commondir` file to find the main repository's `.git` directory.
async fn resolve_common_git_dir(git_path: &Path) -> Result<PathBuf, WorktreeError> {
    // For worktrees, .git is a file containing "gitdir: <path>"
    let git_dir = if git_path.is_file() {
        let content = tokio::fs::read_to_string(git_path)
            .await
            .map_err(WorktreeError::Io)?;
        let gitdir_line = content
            .lines()
            .find(|line| line.starts_with("gitdir:"))
            .ok_or_else(|| {
                WorktreeError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "No gitdir line found in .git file",
                ))
            })?;
        let gitdir = gitdir_line.strip_prefix("gitdir:").unwrap().trim();
        PathBuf::from(gitdir)
    } else if git_path.is_dir() {
        return Ok(git_path.to_path_buf());
    } else {
        return Err(WorktreeError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(".git not found at {}", git_path.display()),
        )));
    };

    // For worktrees, git_dir points to .git/worktrees/<name>
    // The commondir file contains the path to the main .git directory (usually "../..")
    let commondir_path = git_dir.join("commondir");
    if tokio::fs::try_exists(&commondir_path)
        .await
        .unwrap_or(false)
    {
        let commondir_content = tokio::fs::read_to_string(&commondir_path)
            .await
            .map_err(WorktreeError::Io)?;
        let commondir = commondir_content.trim();

        // commondir is relative to git_dir
        let common_git_dir = tokio::fs::canonicalize(git_dir.join(commondir))
            .await
            .map_err(|e| {
                WorktreeError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to resolve commondir path: {}", e),
                ))
            })?;

        debug!(
            worktree_git_dir = %git_dir.display(),
            common_git_dir = %common_git_dir.display(),
            "Resolved common git directory for worktree"
        );

        Ok(common_git_dir)
    } else {
        // Not a worktree, just return the git_dir
        Ok(git_dir)
    }
}

/// Add a pattern to the .git/info/exclude file
///
/// For worktrees, this resolves the main repository's git directory via the
/// `commondir` file, since git uses the main repo's `info/exclude` for all worktrees.
/// The pattern is only added if it doesn't already exist in the exclude file.
pub async fn add_to_git_exclude(worktree_path: &str, pattern: &str) -> Result<(), WorktreeError> {
    let worktree = Path::new(worktree_path);
    let git_path = worktree.join(".git");

    // Resolve to the common git directory (main repo's .git for worktrees)
    let git_dir = resolve_common_git_dir(&git_path).await?;

    // Create info directory if it doesn't exist
    let info_dir = git_dir.join("info");
    if !info_dir.exists() {
        tokio::fs::create_dir_all(&info_dir)
            .await
            .map_err(WorktreeError::Io)?;
    }

    let exclude_file = info_dir.join("exclude");

    // Read existing content if file exists
    let existing_content = match tokio::fs::read_to_string(&exclude_file).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(WorktreeError::Io(e)),
    };

    // Check if pattern already exists
    if existing_content.lines().any(|line| line.trim() == pattern) {
        debug!(pattern = %pattern, "Pattern already in git exclude");
        return Ok(());
    }

    // Append the pattern
    let mut new_content = existing_content;
    if !new_content.is_empty() && !new_content.ends_with('\n') {
        new_content.push('\n');
    }
    new_content.push_str(pattern);
    new_content.push('\n');

    tokio::fs::write(&exclude_file, new_content)
        .await
        .map_err(WorktreeError::Io)?;

    debug!(pattern = %pattern, exclude_file = %exclude_file.display(), "Added pattern to git exclude");

    Ok(())
}

async fn git_path_is_tracked(worktree_path: &str, path: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args(["ls-files", "--error-unmatch", "--", path])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitConfigurationFailed(e.to_string()))?;

    Ok(output.status.success())
}

async fn mark_path_skip_worktree(worktree_path: &str, path: &str) -> Result<(), WorktreeError> {
    if !git_path_is_tracked(worktree_path, path).await? {
        debug!(worktree_path = %worktree_path, path = %path, "Skipping skip-worktree for untracked path");
        return Ok(());
    }

    let output = Command::new("git")
        .args(["update-index", "--skip-worktree", "--", path])
        .current_dir(worktree_path)
        .output()
        .await
        .map_err(|e| WorktreeError::GitConfigurationFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(WorktreeError::GitConfigurationFailed(
            stderr.trim().to_string(),
        ));
    }

    debug!(worktree_path = %worktree_path, path = %path, "Marked path skip-worktree");
    Ok(())
}

pub async fn configure_local_git_artifacts(worktree_path: &str) -> Result<(), WorktreeError> {
    for pattern in LOCAL_GIT_EXCLUDE_PATTERNS {
        add_to_git_exclude(worktree_path, pattern).await?;
    }

    for path in LOCAL_SKIP_WORKTREE_PATHS {
        mark_path_skip_worktree(worktree_path, path).await?;
    }

    Ok(())
}

/// Create a git worktree for a local environment
///
/// # Arguments
/// * `source_repo_path` - Path to the source git repository
/// * `branch_name` - Name of the new branch to create in the worktree
/// * `project_name` - Name of the project (used for worktree directory name)
/// * `base_branch_override` - Optional configured default branch override
///
/// # Returns
/// The path to the created worktree
pub async fn create_worktree(
    source_repo_path: &str,
    branch_name: &str,
    project_name: &str,
    base_branch_override: Option<&str>,
) -> Result<WorktreeCreateResult, WorktreeError> {
    info!(
        source = %source_repo_path,
        branch = %branch_name,
        project = %project_name,
        "Creating git worktree for local environment"
    );

    // Verify source repo exists
    if !Path::new(source_repo_path).exists() {
        return Err(WorktreeError::SourceNotFound(source_repo_path.to_string()));
    }

    // Create base directory if it doesn't exist
    let base_path = get_worktree_base_path()?;
    if !base_path.exists() {
        debug!(path = %base_path.display(), "Creating worktree base directory");
        std::fs::create_dir_all(&base_path).map_err(|e| {
            WorktreeError::DirectoryCreationFailed(format!("{}: {}", base_path.display(), e))
        })?;
    }

    // Generate unique worktree path
    let worktree_path = generate_worktree_path(project_name)?;
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    // Resolve the branch to base the worktree on.
    // Repository settings can provide an explicit branch override.
    let default_branch = match base_branch_override
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        Some(branch) => {
            debug!(branch = %branch, "Using configured default branch override");
            branch.to_string()
        }
        None => get_default_branch(source_repo_path).await?,
    };

    // Fetch from origin to ensure we have the latest commits
    debug!(source = %source_repo_path, "Fetching from origin to get latest commits");
    let fetch_output = Command::new("git")
        .args(["fetch", "origin", &default_branch])
        .current_dir(source_repo_path)
        .output()
        .await;

    if let Err(e) = &fetch_output {
        warn!(error = %e, "Failed to fetch from origin, will branch from local");
    } else if let Ok(output) = &fetch_output {
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(error = %stderr, "Git fetch failed, will branch from local");
        }
    }

    // Use origin/<default_branch> as the start point to get latest remote commits
    let start_point = format!("origin/{}", default_branch);

    debug!(
        source = %source_repo_path,
        branch = %branch_name,
        default_branch = %default_branch,
        start_point = %start_point,
        worktree_path = %worktree_path_str,
        "Preparing git worktree command"
    );

    // Resolve a usable branch name (avoid branches already checked out in another worktree)
    let mut target_branch = branch_name.to_string();
    let mut attempt = 0;

    loop {
        attempt += 1;
        let local_exists = branch_exists(source_repo_path, &target_branch).await?;
        let in_use = branch_checked_out(source_repo_path, &target_branch).await?;
        let on_remote = remote_branch_exists(source_repo_path, &target_branch).await?;

        if local_exists && in_use {
            debug!(
                branch = %target_branch,
                "Branch is already checked out in another worktree; generating a new name"
            );
            target_branch =
                generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
            continue;
        }

        // If branch only exists on the remote, avoid reusing it — it may have
        // an associated PR from a previous environment.
        if !local_exists && on_remote {
            debug!(
                branch = %target_branch,
                "Branch exists on remote but not locally; generating a new name to avoid PR collision"
            );
            target_branch =
                generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
            continue;
        }

        if local_exists {
            debug!(branch = %target_branch, "Branch exists locally; reusing for worktree");
        }

        // Create the worktree
        // If branch exists locally, reuse it: git worktree add <path> <branch>
        // Otherwise create a new branch: git worktree add -b <branch> <path> <start-point>
        let output = if local_exists {
            Command::new("git")
                .args(["worktree", "add", &worktree_path_str, &target_branch])
                .current_dir(source_repo_path)
                .output()
                .await
                .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?
        } else {
            Command::new("git")
                .args([
                    "worktree",
                    "add",
                    "-b",
                    &target_branch,
                    &worktree_path_str,
                    &start_point,
                ])
                .current_dir(source_repo_path)
                .output()
                .await
                .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?
        };

        if output.status.success() {
            break;
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        error!(
            branch = %target_branch,
            worktree_path = %worktree_path_str,
            start_point = %start_point,
            status = ?output.status.code(),
            stdout = %stdout,
            stderr = %stderr,
            "Failed to create git worktree"
        );

        if is_branch_in_use_error(&stderr) || is_branch_exists_error(&stderr) {
            target_branch =
                generate_unique_branch_name(source_repo_path, branch_name, attempt).await?;
            continue;
        }

        return Err(WorktreeError::WorktreeCreationFailed(stderr.to_string()));
    }

    info!(
        worktree_path = %worktree_path_str,
        branch = %branch_name,
        "Successfully created git worktree"
    );

    // Configure local-only Git behavior for workspace artifacts.
    if let Err(e) = configure_local_git_artifacts(&worktree_path_str).await {
        warn!(error = %e, "Failed to configure local git artifacts (non-fatal)");
    }

    Ok(WorktreeCreateResult {
        path: worktree_path_str,
        branch: target_branch,
    })
}

async fn branch_exists(repo_path: &str, branch_name: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/heads/{}", branch_name),
        ])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?;

    Ok(output.status.success())
}

async fn remote_branch_exists(repo_path: &str, branch_name: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args([
            "rev-parse",
            "--verify",
            &format!("refs/remotes/origin/{}", branch_name),
        ])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?;

    Ok(output.status.success())
}

async fn branch_checked_out(repo_path: &str, branch_name: &str) -> Result<bool, WorktreeError> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeCreationFailed(e.to_string()))?;

    if !output.status.success() {
        return Ok(false);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let target = format!("branch refs/heads/{}", branch_name);
    Ok(stdout.lines().any(|line| line.trim() == target))
}

async fn generate_unique_branch_name(
    repo_path: &str,
    base_name: &str,
    attempt: usize,
) -> Result<String, WorktreeError> {
    for idx in attempt..=50 {
        let candidate = format!("{}-{}", base_name, idx);
        let exists = branch_exists(repo_path, &candidate).await?;
        let in_use = branch_checked_out(repo_path, &candidate).await?;
        let on_remote = remote_branch_exists(repo_path, &candidate).await?;
        if !exists && !in_use && !on_remote {
            return Ok(candidate);
        }
    }

    Err(WorktreeError::WorktreeCreationFailed(
        "Failed to generate unique branch name for worktree".to_string(),
    ))
}

fn is_branch_in_use_error(stderr: &str) -> bool {
    stderr.contains("is already used by worktree")
}

fn is_branch_exists_error(stderr: &str) -> bool {
    stderr.contains("already exists")
}

/// Delete a git worktree
///
/// # Arguments
/// * `source_repo_path` - Path to the source git repository
/// * `worktree_path` - Path to the worktree to delete
pub async fn delete_worktree(
    source_repo_path: &str,
    worktree_path: &str,
) -> Result<(), WorktreeError> {
    info!(
        source = %source_repo_path,
        worktree = %worktree_path,
        "Deleting git worktree"
    );

    // First, remove the worktree from git's tracking
    let output = Command::new("git")
        .args(["worktree", "remove", "--force", worktree_path])
        .current_dir(source_repo_path)
        .output()
        .await
        .map_err(|e| WorktreeError::WorktreeDeletionFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!(error = %stderr, "Git worktree remove failed, attempting manual cleanup");

        // If git worktree remove fails, try to clean up manually
        if Path::new(worktree_path).exists() {
            std::fs::remove_dir_all(worktree_path).map_err(|e| {
                WorktreeError::WorktreeDeletionFailed(format!(
                    "Failed to remove directory {}: {}",
                    worktree_path, e
                ))
            })?;
        }

        // Also try to prune the worktree reference
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(source_repo_path)
            .output()
            .await;
    }

    info!(worktree_path = %worktree_path, "Successfully deleted git worktree");

    Ok(())
}

/// Copy .env and .env.local files from source to destination
///
/// # Arguments
/// * `source_path` - Path to the source directory (original project)
/// * `dest_path` - Path to the destination directory (worktree)
pub fn copy_env_files(source_path: &str, dest_path: &str) -> Result<(), WorktreeError> {
    debug!(
        source = %source_path,
        dest = %dest_path,
        "Copying env files to worktree"
    );

    let source = Path::new(source_path);
    let dest = Path::new(dest_path);

    let env_files = [".env", ".env.local"];
    let mut copied_count = 0;

    for file_name in env_files {
        let source_file = source.join(file_name);
        let dest_file = dest.join(file_name);

        if source_file.exists() {
            std::fs::copy(&source_file, &dest_file).map_err(|e| {
                WorktreeError::FileCopyFailed(format!(
                    "Failed to copy {} to {}: {}",
                    source_file.display(),
                    dest_file.display(),
                    e
                ))
            })?;
            debug!(file = %file_name, "Copied env file");
            copied_count += 1;
        }
    }

    info!(count = copied_count, "Copied env files to worktree");

    Ok(())
}

/// Copy configured project files from source to destination, preserving relative paths.
pub fn copy_project_files(
    source_path: &str,
    dest_path: &str,
    relative_paths: &[String],
) -> Result<(), WorktreeError> {
    debug!(
        source = %source_path,
        dest = %dest_path,
        count = relative_paths.len(),
        "Copying configured project files to worktree"
    );

    let source = Path::new(source_path);
    let dest = Path::new(dest_path);
    let mut copied_count = 0;

    for relative_path in relative_paths {
        let relative_path = relative_path.trim();

        if relative_path.is_empty() {
            debug!("Skipping empty configured file path");
            continue;
        }

        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            debug!(path = %relative_path, "Skipping invalid configured file path");
            continue;
        }

        let source_file = source.join(relative);
        if !source_file.exists() {
            debug!(path = %source_file.display(), "Configured file not found");
            continue;
        }

        if source_file.is_symlink() {
            debug!(path = %source_file.display(), "Skipping symlink for safety");
            continue;
        }

        if !source_file.is_file() {
            debug!(path = %source_file.display(), "Configured path is not a file");
            continue;
        }

        let dest_file = dest.join(relative);
        if let Some(parent) = dest_file.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!(
                    path = %relative_path,
                    error = %e,
                    "Failed to create parent directory, skipping file"
                );
                continue;
            }
        }

        match std::fs::copy(&source_file, &dest_file) {
            Ok(_) => {
                debug!(
                    source = %source_file.display(),
                    dest = %dest_file.display(),
                    "Copied configured project file"
                );
                copied_count += 1;
            }
            Err(e) => {
                warn!(
                    path = %relative_path,
                    error = %e,
                    "Failed to copy configured project file, skipping"
                );
            }
        }
    }

    info!(
        count = copied_count,
        "Copied configured project files to worktree"
    );

    Ok(())
}

/// Get setupLocal commands from orkestrator-ai.json without executing them
///
/// Reads the orkestrator-ai.json file from the worktree directory and returns
/// the commands specified in the `setupLocal` field. Does not execute the commands.
///
/// # Arguments
/// * `worktree_path` - Path to the worktree directory
///
/// # Returns
/// A vector of commands to run, or an empty vector if no config file or no commands
pub async fn get_setup_local_commands(worktree_path: &str) -> Vec<String> {
    let config_path = Path::new(worktree_path).join("orkestrator-ai.json");

    // Read and parse the config file
    let config_content = match tokio::fs::read_to_string(&config_path).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            debug!(worktree_path = %worktree_path, "No orkestrator-ai.json found");
            return vec![];
        }
        Err(e) => {
            warn!(error = %e, "Failed to read orkestrator-ai.json");
            return vec![];
        }
    };

    let config: serde_json::Value = match serde_json::from_str(&config_content) {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, "Failed to parse orkestrator-ai.json");
            return vec![];
        }
    };

    // Extract setupLocal field - can be string or array of strings
    match config.get("setupLocal") {
        Some(serde_json::Value::String(s)) => {
            if s.is_empty() {
                vec![]
            } else {
                vec![s.clone()]
            }
        }
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect(),
        _ => {
            debug!(worktree_path = %worktree_path, "No setupLocal field found in orkestrator-ai.json");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn run_git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn test_generate_unique_suffix() {
        let suffix = generate_unique_suffix();
        assert_eq!(suffix.len(), 6);
        assert!(suffix.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_get_worktree_base_path() {
        let path = get_worktree_base_path();
        assert!(path.is_ok());
        let path = path.unwrap();
        assert!(path.to_string_lossy().contains("orkestrator-ai/workspaces"));
    }

    #[test]
    fn test_generate_worktree_path_contains_project_name() {
        let project_name = "my-test-project";
        let path = generate_worktree_path(project_name).unwrap();
        let path_str = path.to_string_lossy();

        // Path should contain the project name
        assert!(
            path_str.contains(project_name),
            "Path '{}' should contain project name '{}'",
            path_str,
            project_name
        );
    }

    #[test]
    fn test_generate_worktree_path_has_unique_suffix() {
        let project_name = "test-project";
        let path = generate_worktree_path(project_name).unwrap();
        let filename = path.file_name().unwrap().to_string_lossy();

        // Filename should be in format "project-name-suffix" where suffix is 6 chars
        let expected_prefix = format!("{}-", project_name);
        assert!(
            filename.starts_with(&expected_prefix),
            "Filename '{}' should start with '{}'",
            filename,
            expected_prefix
        );

        // Extract and validate the suffix (6 alphanumeric characters)
        let suffix = &filename[expected_prefix.len()..];
        assert_eq!(
            suffix.len(),
            6,
            "Suffix '{}' should be 6 characters",
            suffix
        );
        assert!(
            suffix.chars().all(|c| c.is_ascii_alphanumeric()),
            "Suffix '{}' should be alphanumeric",
            suffix
        );
    }

    #[test]
    fn test_generate_worktree_path_under_base_directory() {
        let project_name = "base-dir-test";
        let path = generate_worktree_path(project_name).unwrap();
        let base_path = get_worktree_base_path().unwrap();

        assert!(
            path.starts_with(&base_path),
            "Path '{}' should be under base directory '{}'",
            path.display(),
            base_path.display()
        );
    }

    #[test]
    fn test_generate_worktree_path_unique_each_call() {
        let project_name = "unique-test";
        let path1 = generate_worktree_path(project_name).unwrap();
        let path2 = generate_worktree_path(project_name).unwrap();

        // Each call should generate a different path (different suffix)
        assert_ne!(path1, path2, "Each call should generate a unique path");
    }

    #[test]
    fn test_copy_project_files_preserves_relative_paths() {
        let source_dir = TempDir::new().unwrap();
        let dest_dir = TempDir::new().unwrap();

        let nested_source_dir = source_dir.path().join("config/environments");
        std::fs::create_dir_all(&nested_source_dir).unwrap();
        std::fs::write(nested_source_dir.join(".env.local"), "TEST=1\n").unwrap();

        copy_project_files(
            source_dir.path().to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
            &["config/environments/.env.local".to_string()],
        )
        .unwrap();

        let copied_file = dest_dir.path().join("config/environments/.env.local");
        assert!(copied_file.exists());
        assert_eq!(std::fs::read_to_string(copied_file).unwrap(), "TEST=1\n");
    }

    #[test]
    fn test_copy_project_files_skips_invalid_paths() {
        let source_dir = TempDir::new().unwrap();
        let dest_dir = TempDir::new().unwrap();

        std::fs::write(source_dir.path().join("allowed.env"), "SAFE=1\n").unwrap();

        copy_project_files(
            source_dir.path().to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
            &[
                "../secret.env".to_string(),
                "/absolute/path.env".to_string(),
                "allowed.env".to_string(),
            ],
        )
        .unwrap();

        assert!(dest_dir.path().join("allowed.env").exists());
        assert!(!dest_dir.path().join("secret.env").exists());
    }

    #[test]
    fn test_copy_project_files_skips_symlinks() {
        let source_dir = TempDir::new().unwrap();
        let dest_dir = TempDir::new().unwrap();

        let secret = source_dir.path().join("secret.txt");
        std::fs::write(&secret, "SECRET\n").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, source_dir.path().join("link.txt")).unwrap();

        std::fs::write(source_dir.path().join("regular.txt"), "REGULAR\n").unwrap();

        copy_project_files(
            source_dir.path().to_str().unwrap(),
            dest_dir.path().to_str().unwrap(),
            &["link.txt".to_string(), "regular.txt".to_string()],
        )
        .unwrap();

        assert!(dest_dir.path().join("regular.txt").exists());
        #[cfg(unix)]
        assert!(
            !dest_dir.path().join("link.txt").exists(),
            "Symlinks should be skipped"
        );
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_no_config_file() {
        let temp_dir = TempDir::new().unwrap();
        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_empty_array() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, r#"{"setupLocal": []}"#)
            .await
            .unwrap();

        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_no_setup_local_field() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, r#"{"run": ["echo hello"]}"#)
            .await
            .unwrap();

        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_single_command_string() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, r#"{"setupLocal": "echo hello"}"#)
            .await
            .unwrap();

        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "echo hello");
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_multiple_commands() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(
            &config_path,
            r#"{"setupLocal": ["echo one", "echo two", "echo three"]}"#,
        )
        .await
        .unwrap();

        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert_eq!(result.len(), 3);
        assert_eq!(result[0], "echo one");
        assert_eq!(result[1], "echo two");
        assert_eq!(result[2], "echo three");
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_filters_empty_strings() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(
            &config_path,
            r#"{"setupLocal": ["echo one", "", "echo two"]}"#,
        )
        .await
        .unwrap();

        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert_eq!(result.len(), 2);
        assert_eq!(result[0], "echo one");
        assert_eq!(result[1], "echo two");
    }

    #[tokio::test]
    async fn test_get_setup_local_commands_invalid_json() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("orkestrator-ai.json");
        tokio::fs::write(&config_path, "not valid json")
            .await
            .unwrap();

        let result = get_setup_local_commands(temp_dir.path().to_str().unwrap()).await;

        assert!(result.is_empty());
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_regular_repo() {
        let temp_dir = TempDir::new().unwrap();
        let git_dir = temp_dir.path().join(".git");
        tokio::fs::create_dir_all(&git_dir).await.unwrap();

        let result = add_to_git_exclude(temp_dir.path().to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_ok());

        // Verify the pattern was added
        let exclude_content = tokio::fs::read_to_string(git_dir.join("info/exclude"))
            .await
            .unwrap();
        assert!(exclude_content.contains(".orkestrator"));
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_pattern_already_exists() {
        let temp_dir = TempDir::new().unwrap();
        let git_dir = temp_dir.path().join(".git");
        let info_dir = git_dir.join("info");
        tokio::fs::create_dir_all(&info_dir).await.unwrap();

        // Pre-populate with the pattern
        tokio::fs::write(info_dir.join("exclude"), ".orkestrator\n")
            .await
            .unwrap();

        let result = add_to_git_exclude(temp_dir.path().to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_ok());

        // Verify pattern wasn't duplicated
        let exclude_content = tokio::fs::read_to_string(info_dir.join("exclude"))
            .await
            .unwrap();
        assert_eq!(exclude_content.matches(".orkestrator").count(), 1);
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_worktree() {
        let temp_dir = TempDir::new().unwrap();

        // Create a fake worktree structure that mimics real git worktrees:
        // - main_repo/.git/ - the main repository's git directory
        // - main_repo/.git/worktrees/my-worktree/ - worktree-specific git data
        // - worktree/ - the actual worktree directory with .git file

        let main_git_dir = temp_dir.path().join("main_repo/.git");
        let worktree_git_dir = main_git_dir.join("worktrees/my-worktree");
        tokio::fs::create_dir_all(&worktree_git_dir).await.unwrap();

        let worktree_dir = temp_dir.path().join("worktree");
        tokio::fs::create_dir_all(&worktree_dir).await.unwrap();

        // Create .git file (not directory) with gitdir reference pointing to worktree git dir
        let git_file_content = format!("gitdir: {}", worktree_git_dir.display());
        tokio::fs::write(worktree_dir.join(".git"), &git_file_content)
            .await
            .unwrap();

        // Create commondir file in worktree git dir pointing to main .git (relative path)
        tokio::fs::write(worktree_git_dir.join("commondir"), "../..")
            .await
            .unwrap();

        let result = add_to_git_exclude(worktree_dir.to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_ok());

        // Verify the pattern was added to the MAIN repository's git directory, not the worktree's
        let exclude_content = tokio::fs::read_to_string(main_git_dir.join("info/exclude"))
            .await
            .unwrap();
        assert!(exclude_content.contains(".orkestrator"));

        // Verify the worktree-specific git dir does NOT have the exclude file
        assert!(
            !worktree_git_dir.join("info/exclude").exists(),
            "Exclude should be in main repo, not worktree git dir"
        );
    }

    #[tokio::test]
    async fn test_add_to_git_exclude_no_git_dir() {
        let temp_dir = TempDir::new().unwrap();

        let result = add_to_git_exclude(temp_dir.path().to_str().unwrap(), ".orkestrator").await;
        assert!(result.is_err());
    }

    /// Helper: create a bare "remote" repo, clone it locally, and make an
    /// initial commit so there is a valid default branch.  Returns (remote_dir,
    /// local_dir, default_branch) – both `TempDir` so the caller controls lifetimes.
    async fn setup_repo_with_remote() -> (TempDir, TempDir, String) {
        let remote_dir = TempDir::new().unwrap();
        let local_dir = TempDir::new().unwrap();

        // Init bare remote
        run_git(remote_dir.path(), &["init", "--bare"]).await;

        // Clone into local_dir (needs parent to exist)
        let local_path = local_dir.path().to_str().unwrap();
        let remote_path = remote_dir.path().to_str().unwrap();
        Command::new("git")
            .args(["clone", remote_path, local_path])
            .output()
            .await
            .unwrap();

        // Configure identity
        run_git(local_dir.path(), &["config", "user.email", "t@t.com"]).await;
        run_git(local_dir.path(), &["config", "user.name", "T"]).await;

        // Initial commit on the default branch
        std::fs::write(local_dir.path().join("init.txt"), "x").unwrap();
        run_git(local_dir.path(), &["add", "."]).await;
        run_git(local_dir.path(), &["commit", "-m", "init"]).await;
        run_git(local_dir.path(), &["push", "-u", "origin", "HEAD"]).await;

        // Detect default branch name (could be main or master)
        let output = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(local_dir.path())
            .output()
            .await
            .unwrap();
        let default_branch = String::from_utf8_lossy(&output.stdout).trim().to_string();

        (remote_dir, local_dir, default_branch)
    }

    #[tokio::test]
    async fn test_remote_branch_exists_returns_true_for_pushed_branch() {
        let (_remote, local, _default_branch) = setup_repo_with_remote().await;
        let local_path = local.path().to_str().unwrap();

        // Create and push a branch
        run_git(local.path(), &["checkout", "-b", "pushed-branch"]).await;
        std::fs::write(local.path().join("f.txt"), "y").unwrap();
        run_git(local.path(), &["add", "."]).await;
        run_git(local.path(), &["commit", "-m", "push"]).await;
        run_git(local.path(), &["push", "origin", "pushed-branch"]).await;

        assert!(remote_branch_exists(local_path, "pushed-branch")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn test_remote_branch_exists_returns_false_for_local_only_branch() {
        let (_remote, local, _default_branch) = setup_repo_with_remote().await;
        let local_path = local.path().to_str().unwrap();

        run_git(local.path(), &["checkout", "-b", "local-only"]).await;

        assert!(!remote_branch_exists(local_path, "local-only")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn test_remote_branch_exists_returns_false_for_nonexistent_branch() {
        let (_remote, local, _default_branch) = setup_repo_with_remote().await;
        let local_path = local.path().to_str().unwrap();

        assert!(!remote_branch_exists(local_path, "does-not-exist")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn test_generate_unique_branch_name_avoids_remote_branches() {
        let (_remote, local, default_branch) = setup_repo_with_remote().await;
        let local_path = local.path().to_str().unwrap();

        // Create and push feat-1 to remote (then delete locally)
        run_git(local.path(), &["checkout", "-b", "feat-1"]).await;
        std::fs::write(local.path().join("f1.txt"), "1").unwrap();
        run_git(local.path(), &["add", "."]).await;
        run_git(local.path(), &["commit", "-m", "f1"]).await;
        run_git(local.path(), &["push", "origin", "feat-1"]).await;
        run_git(local.path(), &["checkout", &default_branch]).await;
        run_git(local.path(), &["branch", "-D", "feat-1"]).await;

        // generate_unique_branch_name starts from attempt=1, generating "feat-1"
        // but feat-1 exists on remote, so it should skip to feat-2
        let result = generate_unique_branch_name(local_path, "feat", 1)
            .await
            .unwrap();
        assert_eq!(
            result, "feat-2",
            "Should skip feat-1 (on remote) and return feat-2"
        );
    }

    #[tokio::test]
    async fn test_create_worktree_avoids_remote_only_branch() {
        let (_remote, local, default_branch) = setup_repo_with_remote().await;
        let local_path = local.path().to_str().unwrap();

        // Push a branch to remote then delete locally — simulates a previous
        // environment whose branch was cleaned up locally but still exists on origin
        run_git(local.path(), &["checkout", "-b", "my-feature"]).await;
        std::fs::write(local.path().join("feat.txt"), "f").unwrap();
        run_git(local.path(), &["add", "."]).await;
        run_git(local.path(), &["commit", "-m", "feat"]).await;
        run_git(local.path(), &["push", "origin", "my-feature"]).await;
        run_git(local.path(), &["checkout", &default_branch]).await;
        run_git(local.path(), &["branch", "-D", "my-feature"]).await;

        // Create a worktree requesting branch "my-feature" — should get a
        // different name because my-feature exists on remote.
        // Args: (source_repo_path, branch_name, project_name, base_branch_override)
        let result = create_worktree(local_path, "my-feature", "test-project", None)
            .await
            .unwrap();

        assert_ne!(
            result.branch, "my-feature",
            "Should not reuse a branch that exists only on remote"
        );
        assert!(
            result.branch.starts_with("my-feature-"),
            "Should be a suffixed variant, got: {}",
            result.branch
        );

        // Clean up the worktree
        let _ = delete_worktree(local_path, &result.path).await;
    }

    #[tokio::test]
    async fn test_configure_local_git_artifacts_marks_continuity_skip_worktree() {
        let temp_dir = TempDir::new().unwrap();

        run_git(temp_dir.path(), &["init"]).await;
        run_git(
            temp_dir.path(),
            &["config", "user.email", "test@example.com"],
        )
        .await;
        run_git(temp_dir.path(), &["config", "user.name", "Test User"]).await;

        tokio::fs::write(temp_dir.path().join("CONTINUITY.md"), "initial\n")
            .await
            .unwrap();
        run_git(temp_dir.path(), &["add", "CONTINUITY.md"]).await;
        run_git(temp_dir.path(), &["commit", "-m", "init"]).await;

        let result = configure_local_git_artifacts(temp_dir.path().to_str().unwrap()).await;
        assert!(result.is_ok());

        let exclude_content = tokio::fs::read_to_string(temp_dir.path().join(".git/info/exclude"))
            .await
            .unwrap();
        assert!(exclude_content.contains(".orkestrator"));
        assert!(exclude_content.contains("CONTINUITY.md"));

        tokio::fs::write(temp_dir.path().join("CONTINUITY.md"), "changed\n")
            .await
            .unwrap();

        let flags = Command::new("git")
            .args(["ls-files", "-v", "CONTINUITY.md"])
            .current_dir(temp_dir.path())
            .output()
            .await
            .unwrap();
        assert!(flags.status.success());
        assert!(
            String::from_utf8_lossy(&flags.stdout).starts_with("S "),
            "Expected skip-worktree flag, got: {}",
            String::from_utf8_lossy(&flags.stdout)
        );

        let status = Command::new("git")
            .args(["status", "--short"])
            .current_dir(temp_dir.path())
            .output()
            .await
            .unwrap();
        assert!(status.status.success());
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "Expected clean status, got: {}",
            String::from_utf8_lossy(&status.stdout)
        );
    }
}
