// Environment management Tauri commands

use tracing::{debug, error, info, warn};

use crate::claude_cli;
use crate::credentials;
use crate::docker::{
    create_environment_container, get_container_environment_status, get_docker_client,
    remove_environment_container, start_environment_container, stop_environment_container,
    ContainerConfig, DockerError,
};
use crate::local::{
    allocate_ports, configure_local_git_artifacts, copy_env_files, copy_project_files,
    create_worktree, delete_worktree, get_setup_local_commands, isolated_opencode_data_home,
    close_local_terminal_sessions_for_environment, stop_all_local_servers,
};
use crate::models::{
    sanitize_branch_name, sanitize_environment_name, ClaudeMode, ClaudeNativeBackend, CodexMode,
    DefaultAgent, Environment, EnvironmentStatus, EnvironmentType, NetworkAccessMode, OpenCodeMode,
    PortMapping, PrState,
};
use crate::storage::{get_config, get_storage, Storage, StorageError};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;

use super::claude_tmux::stop_tmux_sessions_for_environment;

/// Event payload emitted when an environment is renamed in the background
#[derive(Clone, Serialize, Deserialize)]
pub struct EnvironmentRenamedPayload {
    pub environment_id: String,
    pub new_name: String,
    pub new_branch: String,
}

/// Result from starting an environment
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartEnvironmentResult {
    /// Setup commands to run in a terminal (for local environments with orkestrator-ai.json)
    pub setup_commands: Option<Vec<String>>,
}

/// Convert storage errors to string for Tauri
fn storage_error_to_string(err: StorageError) -> String {
    err.to_string()
}

fn resolve_base_branch_override(
    config: &crate::models::AppConfig,
    project_id: &str,
) -> Option<String> {
    config
        .repositories
        .get(project_id)
        .map(|repo| repo.default_branch.trim().to_string())
        .filter(|branch| !branch.is_empty())
}

fn resolve_container_github_token(
    configured_token: Option<&str>,
    environment_id: &str,
) -> Option<String> {
    let configured_token = configured_token
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string);

    if configured_token.is_some() {
        debug!(
            environment_id = %environment_id,
            "Using GitHub token from app configuration"
        );
        return configured_token;
    }

    let detected_token = claude_cli::get_github_token();
    if detected_token.is_some() {
        debug!(
            environment_id = %environment_id,
            "Using GitHub token from host gh auth login"
        );
    } else {
        debug!(
            environment_id = %environment_id,
            "No GitHub token available from app configuration or host gh auth login"
        );
    }

    detected_token
}

/// Fetch setup commands from orkestrator-ai.json and log if any are found
///
/// Returns `None` if no setup commands are configured, otherwise `Some(commands)`.
async fn fetch_setup_commands(worktree_path: &str, environment_id: &str) -> Option<Vec<String>> {
    let commands = get_setup_local_commands(worktree_path).await;
    if commands.is_empty() {
        None
    } else {
        info!(
            environment_id = %environment_id,
            command_count = commands.len(),
            "Found setupLocal commands to run in terminal"
        );
        Some(commands)
    }
}

async fn fetch_setup_commands_for_start(
    worktree_path: &str,
    environment_id: &str,
    setup_scripts_complete: bool,
) -> Option<Vec<String>> {
    if setup_scripts_complete {
        debug!(
            environment_id = %environment_id,
            "Skipping setupLocal commands for completed local environment"
        );
        None
    } else {
        fetch_setup_commands(worktree_path, environment_id).await
    }
}

/// Resolve and persist entry port mapping for a container environment.
///
/// When `entry_port` is `Some`, queries Docker for the host port mapped to the
/// container's entry port and stores both `entryPort` and `hostEntryPort` on the
/// environment. When `entry_port` is `None`, clears any stale port fields.
async fn resolve_and_store_entry_port(
    storage: &Storage,
    environment_id: &str,
    container_id: &str,
    entry_port: Option<u16>,
) {
    if let Some(ep) = entry_port {
        match get_docker_client() {
            Ok(docker) => match docker.get_host_port(container_id, ep, "tcp").await {
                Ok(Some(host_port)) => {
                    debug!(
                        environment_id = %environment_id,
                        container_port = ep,
                        host_port = host_port,
                        "Resolved dynamic entry port mapping"
                    );
                    let _ = storage.update_environment(
                        environment_id,
                        json!({ "entryPort": ep, "hostEntryPort": host_port }),
                    );
                }
                Ok(None) => {
                    warn!(
                        environment_id = %environment_id,
                        container_port = ep,
                        "Entry port not found in container port bindings"
                    );
                    let _ = storage.update_environment(environment_id, json!({ "entryPort": ep }));
                }
                Err(e) => {
                    warn!(
                        environment_id = %environment_id,
                        error = %e,
                        "Failed to query entry port mapping"
                    );
                    let _ = storage.update_environment(environment_id, json!({ "entryPort": ep }));
                }
            },
            Err(e) => {
                warn!(
                    environment_id = %environment_id,
                    error = %e,
                    "Failed to get docker client for port query"
                );
                let _ = storage.update_environment(environment_id, json!({ "entryPort": ep }));
            }
        }
    } else {
        // Clear stale entry port and host entry port when entry_port is no longer configured
        let _ = storage.update_environment(
            environment_id,
            json!({ "entryPort": null, "hostEntryPort": null }),
        );
    }
}

/// Get all environments for a project with verified Docker status
#[tauri::command]
pub async fn get_environments(project_id: String) -> Result<Vec<Environment>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let mut environments = storage
        .get_environments_by_project(&project_id)
        .map_err(storage_error_to_string)?;

    // Verify status against Docker for each environment with a container
    for env in &mut environments {
        if let Some(container_id) = &env.container_id {
            match get_container_environment_status(container_id).await {
                Ok(actual_status) => {
                    if actual_status != env.status {
                        debug!(
                            environment_id = %env.id,
                            stored_status = ?env.status,
                            actual_status = ?actual_status,
                            "Status mismatch, updating"
                        );
                        env.status = actual_status.clone();
                        // Update storage to match actual status
                        let _ = storage.update_environment(
                            &env.id,
                            json!({ "status": actual_status.to_string() }),
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        environment_id = %env.id,
                        error = %e,
                        "Failed to get container status"
                    );
                    // Container was removed externally - clear the stale reference
                    // and set status to stopped so user can start fresh
                    env.status = EnvironmentStatus::Stopped;
                    env.container_id = None;
                    let _ = storage.update_environment(
                        &env.id,
                        json!({ "status": "stopped", "containerId": null }),
                    );
                    info!(
                        environment_id = %env.id,
                        "Cleared stale container reference"
                    );
                }
            }
        }
    }

    Ok(environments)
}

/// Reorder environments within a project based on the provided array of environment IDs
/// The order of IDs determines the new display order
#[tauri::command]
pub async fn reorder_environments(
    project_id: String,
    environment_ids: Vec<String>,
) -> Result<Vec<Environment>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .reorder_environments(&project_id, &environment_ids)
        .map_err(storage_error_to_string)
}

/// Generate a unique string by appending an integer suffix if needed.
/// The `is_taken` predicate determines whether a candidate is already in use.
fn make_unique(base: &str, is_taken: impl Fn(&str) -> bool) -> String {
    if !is_taken(base) {
        return base.to_string();
    }

    let mut suffix = 2;
    loop {
        let candidate = format!("{}-{}", base, suffix);
        if !is_taken(&candidate) {
            return candidate;
        }
        suffix += 1;
        // Safety limit to prevent infinite loops
        if suffix > 1000 {
            let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
            return format!("{}-{}", base, timestamp);
        }
    }
}

/// Generate a unique environment name by appending an integer suffix if needed.
/// Checks both environment names and branch names to ensure uniqueness.
///
/// Superseded in production by `make_unique_environment_slug` (which unifies
/// the env name and branch slug). Retained for tests that exercise the
/// name-only collision rules.
#[cfg(test)]
fn make_unique_name(base_name: &str, existing_environments: &[Environment]) -> String {
    make_unique(base_name, |name| {
        existing_environments
            .iter()
            .any(|e| e.name == name || e.branch == name)
    })
}

/// Generate one unique slug that can be used for both the environment name and
/// git branch. This keeps UI metadata, Docker naming, and PR detection aligned.
fn make_unique_environment_slug(
    base_slug: &str,
    existing_environments: &[Environment],
    extra_branches: &[String],
) -> String {
    make_unique(base_slug, |slug| {
        existing_environments
            .iter()
            .any(|e| e.name == slug || e.branch == slug)
            || extra_branches.iter().any(|branch| branch == slug)
    })
}

/// Build a JSON update payload for renaming an environment.
/// When the branch has changed compared to `old_branch`, the PR metadata
/// (prUrl, prState, hasMergeConflicts) is cleared so stale data from the
/// old branch does not persist.
fn build_rename_update(new_name: &str, new_branch: &str, old_branch: &str) -> serde_json::Value {
    if new_branch != old_branch {
        json!({
            "name": new_name,
            "branch": new_branch,
            "prUrl": null,
            "prState": null,
            "hasMergeConflicts": null
        })
    } else {
        json!({ "name": new_name, "branch": new_branch })
    }
}

/// Generate a unique branch name by appending an integer suffix if needed.
/// Checks against existing environment branch names and an optional set of
/// extra branch names (e.g. actual git branches in the repository).
///
/// Superseded in production by `make_unique_environment_slug`. Retained for
/// tests that exercise the branch-only collision rules.
#[cfg(test)]
fn make_unique_branch(
    base_branch: &str,
    existing_environments: &[Environment],
    extra_branches: &[String],
) -> String {
    make_unique(base_branch, |branch| {
        existing_environments.iter().any(|e| e.branch == branch)
            || extra_branches.iter().any(|b| b == branch)
    })
}

fn normalize_initial_prompt(initial_prompt: Option<&str>) -> Option<String> {
    initial_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
        .map(str::to_string)
}

async fn generate_initial_environment_name(prompt: &str) -> Option<String> {
    let prompt = prompt.to_string();
    match tokio::task::spawn_blocking(move || {
        claude_cli::generate_environment_name_with_fallback(&prompt)
    })
    .await
    {
        Ok(Ok(name)) => Some(sanitize_environment_name(&name)),
        Ok(Err(e)) => {
            warn!(error = %e, "Failed to generate initial environment name");
            None
        }
        Err(e) => {
            warn!(error = %e, "Initial environment naming task panicked");
            None
        }
    }
}

/// Create a new environment for a project
#[tauri::command]
pub async fn create_environment(
    _app_handle: tauri::AppHandle,
    project_id: String,
    name: Option<String>,
    network_access_mode: Option<String>,
    initial_prompt: Option<String>,
    port_mappings: Option<Vec<PortMapping>>,
    environment_type: Option<String>,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    // Verify project exists
    let project = storage
        .get_project(&project_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Project not found: {}", project_id))?;

    // Load existing environments to check for duplicate names
    let existing_environments = storage
        .load_environments()
        .map_err(storage_error_to_string)?;

    // Parse environment type (default to containerized for backward compatibility)
    let env_type = match environment_type.as_deref() {
        Some("local") => EnvironmentType::Local,
        _ => EnvironmentType::Containerized,
    };

    // Parse network access mode (default to full access).
    // Full access is the default because restricted mode has compatibility issues
    // with many tools and workflows, and most users prefer unrestricted networking.
    // Local environments always have full network access.
    let network_mode = if env_type == EnvironmentType::Local {
        NetworkAccessMode::Full
    } else {
        match network_access_mode.as_deref() {
            Some("restricted") => NetworkAccessMode::Restricted,
            _ => NetworkAccessMode::Full,
        }
    };

    let trimmed_initial_prompt = normalize_initial_prompt(initial_prompt.as_deref());

    let generated_initial_name = if name.is_none() {
        match trimmed_initial_prompt.as_deref() {
            Some(prompt) => generate_initial_environment_name(prompt).await,
            None => None,
        }
    } else {
        None
    };

    // Determine the base name for the environment
    let base_name = match &name {
        // User provided explicit name - sanitize to kebab-case lowercase
        Some(custom_name) if !custom_name.trim().is_empty() => {
            Some(sanitize_environment_name(custom_name.trim()))
        }
        // No explicit name - use the one generated from the initial prompt, if available.
        _ => generated_initial_name,
    };

    let git_branches_for_slug = if base_name.is_some() {
        if let Some(ref local_path) = project.local_path {
            list_git_branches_at_path(local_path, true).await
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // Create the environment with a unique name
    let mut environment = match (&base_name, &env_type) {
        (Some(name), EnvironmentType::Local) => {
            let unique_name =
                make_unique_environment_slug(name, &existing_environments, &git_branches_for_slug);
            if unique_name != *name {
                debug!(
                    requested_name = %name,
                    assigned_name = %unique_name,
                    "Name already in use, using unique variant"
                );
            }
            Environment::new_local(project_id.clone(), unique_name)
        }
        (Some(name), EnvironmentType::Containerized) => {
            let unique_name =
                make_unique_environment_slug(name, &existing_environments, &git_branches_for_slug);
            if unique_name != *name {
                debug!(
                    requested_name = %name,
                    assigned_name = %unique_name,
                    "Name already in use, using unique variant"
                );
            }
            Environment::with_name(project_id.clone(), unique_name)
        }
        (None, EnvironmentType::Local) => {
            // Generate timestamp-based name for local environment
            let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
            Environment::new_local(project_id.clone(), timestamp)
        }
        (None, EnvironmentType::Containerized) => Environment::new(project_id.clone()),
    };

    // Set the network access mode
    environment.network_access_mode = network_mode;
    environment.initial_prompt = trimmed_initial_prompt.clone();

    // For local environments, allocate ports now
    if env_type == EnvironmentType::Local {
        let port_allocation = allocate_ports(&existing_environments)
            .map_err(|e| format!("Failed to allocate ports: {}", e))?;
        environment.local_opencode_port = Some(port_allocation.opencode_port);
        environment.local_claude_port = Some(port_allocation.claude_port);
        environment.local_codex_port = Some(port_allocation.codex_port);
        debug!(
            opencode_port = port_allocation.opencode_port,
            claude_port = port_allocation.claude_port,
            codex_port = port_allocation.codex_port,
            "Allocated ports for local environment"
        );
    }

    // Set port mappings if provided (only for containerized environments)
    if env_type == EnvironmentType::Containerized {
        if let Some(mappings) = port_mappings {
            if !mappings.is_empty() {
                debug!(port_mappings = ?mappings, "Setting port mappings");
                environment.port_mappings = Some(mappings);
            }
        }
    }

    // Save to storage
    let created_environment = storage
        .add_environment(environment)
        .map_err(storage_error_to_string)?;

    Ok(created_environment)
}

/// List all git branch names (local and remote) at the given repository path.
/// Strips the `origin/` prefix from remote tracking branches so they can be
/// compared directly against environment branch names.
///
/// When `fetch_first` is true, runs `git fetch --prune origin` before listing
/// so that remote-only branches are up-to-date.
/// Returns an empty vec on any error (best-effort).
async fn list_git_branches_at_path(repo_path: &str, fetch_first: bool) -> Vec<String> {
    if fetch_first {
        let _ = tokio::process::Command::new("git")
            .args(["-C", repo_path, "fetch", "--prune", "origin"])
            .output()
            .await;
    }

    match tokio::process::Command::new("git")
        .args(["-C", repo_path, "branch", "-a", "--format=%(refname:short)"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let mut branches: Vec<String> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|l| l.strip_prefix("origin/").unwrap_or(l).to_string())
                .filter(|b| b != "HEAD")
                .collect();
            branches.sort();
            branches.dedup();
            branches
        }
        _ => Vec::new(),
    }
}

/// List all git branch names in the repository that owns the given environment.
/// Fetches from origin first to ensure remote branches are up-to-date.
/// Returns an empty vec on any error (best-effort).
async fn list_repo_git_branches(
    storage: &crate::storage::Storage,
    environment_id: &str,
) -> Vec<String> {
    let repo_path = (|| -> Option<String> {
        let env = storage.get_environment(environment_id).ok()??;
        let project = storage.get_project(&env.project_id).ok()??;
        project.local_path
    })();

    let Some(path) = repo_path else {
        return Vec::new();
    };

    list_git_branches_at_path(&path, true).await
}

/// Safely rename a git branch in a local worktree.
///
/// This is careful about the agent potentially doing git operations concurrently:
/// 1. Verifies the actual current branch in the worktree (the stored name may be stale)
/// 2. If the current branch matches the expected old branch, uses `git branch -m <new>`
///    which is the safest form (renames HEAD's branch without needing the old name)
/// 3. If the current branch differs (agent switched branches), renames the old branch
///    by explicit name so we don't accidentally rename an unrelated branch
/// 4. Retries once after a brief delay if the rename fails (handles momentary ref locks
///    from concurrent git operations like commits)
async fn rename_local_worktree_branch(
    environment_id: &str,
    worktree_path: &str,
    old_branch: &str,
    new_branch: &str,
) {
    // Get the actual current branch in the worktree
    let current_branch = match tokio::process::Command::new("git")
        .args(["-C", worktree_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    };

    // Build the rename command based on whether the agent is still on the original branch
    let on_old_branch = current_branch == old_branch;
    let args: Vec<&str> = if on_old_branch {
        // Current branch IS the old branch — safest form: rename HEAD's branch directly
        vec!["-C", worktree_path, "branch", "-m", new_branch]
    } else {
        // Agent switched branches — rename the old branch by explicit name
        vec![
            "-C",
            worktree_path,
            "branch",
            "-m",
            "--",
            old_branch,
            new_branch,
        ]
    };

    // First attempt
    match tokio::process::Command::new("git")
        .args(&args)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            debug!(environment_id = %environment_id, "Git branch renamed in local worktree");
            return;
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            debug!(
                environment_id = %environment_id,
                stderr = %stderr,
                "First branch rename attempt failed, retrying after delay"
            );
        }
        Err(e) => {
            debug!(
                environment_id = %environment_id,
                error = %e,
                "First branch rename attempt errored, retrying after delay"
            );
        }
    }

    // Wait briefly then retry — handles momentary ref locks from concurrent git operations
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    match tokio::process::Command::new("git")
        .args(&args)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            debug!(environment_id = %environment_id, "Git branch renamed in local worktree (retry)");
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(
                environment_id = %environment_id,
                old_branch = %old_branch,
                new_branch = %new_branch,
                stderr = %stderr,
                "Failed to rename git branch in local worktree after retry"
            );
        }
        Err(e) => {
            warn!(
                environment_id = %environment_id,
                old_branch = %old_branch,
                new_branch = %new_branch,
                error = %e,
                "Failed to execute git branch rename command after retry"
            );
        }
    }
}

/// Background task to generate a name via Claude CLI and rename the environment
async fn background_rename_environment(
    app_handle: tauri::AppHandle,
    environment_id: String,
    old_branch: String,
    prompt: String,
) {
    debug!(environment_id = %environment_id, "Starting background naming");

    // Generate name using available AI CLI (Claude preferred, OpenCode fallback)
    // This is a blocking call, but we're in a background task
    let generated_name = match tokio::task::spawn_blocking(move || {
        claude_cli::generate_environment_name_with_fallback(&prompt)
    })
    .await
    {
        Ok(Ok(name)) => name,
        Ok(Err(e)) => {
            warn!(environment_id = %environment_id, error = %e, "Failed to generate name");
            return;
        }
        Err(e) => {
            warn!(environment_id = %environment_id, error = %e, "Task panicked");
            return;
        }
    };

    debug!(environment_id = %environment_id, generated_name = %generated_name, "Name generated");

    // Get storage and make name unique
    let storage = match get_storage() {
        Ok(s) => s,
        Err(e) => {
            warn!(environment_id = %environment_id, error = %e, "Failed to get storage");
            return;
        }
    };

    let existing_environments = match storage.load_environments() {
        Ok(envs) => envs,
        Err(e) => {
            warn!(environment_id = %environment_id, error = %e, "Failed to load environments");
            return;
        }
    };

    // Sanitize the generated name to kebab-case lowercase (matching branch/container convention)
    let sanitized_name = sanitize_environment_name(&generated_name);

    // Gather actual git branches from the repo so we don't collide with branches
    // that exist in git but have no corresponding environment in storage.
    let git_branches = list_repo_git_branches(&storage, &environment_id).await;

    let unique_slug =
        make_unique_environment_slug(&sanitized_name, &existing_environments, &git_branches);
    let unique_name = unique_slug.clone();
    let unique_branch = unique_slug;
    debug!(environment_id = %environment_id, unique_name = %unique_name, unique_branch = %unique_branch, "Unique name and branch determined");

    // Update environment name and branch in storage, clearing stale PR state
    // if the branch changed.
    let update = build_rename_update(&unique_name, &unique_branch, &old_branch);
    if let Err(e) = storage.update_environment(&environment_id, update) {
        warn!(environment_id = %environment_id, error = %e, "Failed to update environment");
        return;
    }

    debug!(environment_id = %environment_id, "Environment updated in storage");

    // Rename git branch based on environment type
    if let Ok(Some(env)) = storage.get_environment(&environment_id) {
        if env.is_local() {
            // Local environment: rename branch in the worktree directly
            if let Some(worktree_path) = &env.worktree_path {
                debug!(environment_id = %environment_id, worktree_path = %worktree_path, "Renaming git branch in local worktree");

                rename_local_worktree_branch(
                    &environment_id,
                    worktree_path,
                    &old_branch,
                    &unique_branch,
                )
                .await;
            }
        } else if env.status == EnvironmentStatus::Running {
            // Containerized environment: rename branch inside the container
            if let Some(container_id) = &env.container_id {
                debug!(environment_id = %environment_id, container_id = %container_id, "Renaming git branch in container");
                if let Ok(docker) = get_docker_client() {
                    // Wait for workspace setup to complete (max 60 seconds)
                    // The workspace-setup.sh creates /tmp/.workspace-setup-complete when done
                    let wait_cmd = r#"
                        count=0
                        while [ ! -f /tmp/.workspace-setup-complete ] && [ $count -lt 120 ]; do
                            sleep 0.5
                            count=$((count + 1))
                        done
                        [ -f /tmp/.workspace-setup-complete ]
                    "#;

                    match docker
                        .exec_command(container_id, vec!["sh", "-c", wait_cmd])
                        .await
                    {
                        Ok(_) => {
                            debug!(environment_id = %environment_id, "Workspace setup complete, proceeding with branch rename");
                        }
                        Err(e) => {
                            warn!(environment_id = %environment_id, error = %e, "Timeout waiting for workspace setup");
                            // Continue anyway - the branch rename might still work
                        }
                    }

                    // Rename the git branch: git branch -m <old_branch> <new_branch>
                    // Pass arguments directly to git to avoid shell injection vulnerabilities
                    // Using git -C to set the working directory instead of sh -c with cd
                    match docker
                        .exec_command(
                            container_id,
                            vec![
                                "git",
                                "-C",
                                "/workspace",
                                "branch",
                                "-m",
                                "--",
                                &old_branch,
                                &unique_branch,
                            ],
                        )
                        .await
                    {
                        Ok(output) => {
                            debug!(environment_id = %environment_id, output = %output, "Git branch renamed");
                        }
                        Err(e) => {
                            warn!(
                                environment_id = %environment_id,
                                old_branch = %old_branch,
                                new_branch = %unique_branch,
                                error = %e,
                                "Failed to rename git branch - branch may not exist or may have a different name"
                            );
                            // Don't return - we still want to emit the event
                        }
                    }

                    // Rename the Docker container to match the new environment name
                    match docker.rename_container(container_id, &unique_name).await {
                        Ok(_) => {
                            info!(environment_id = %environment_id, new_name = %unique_name, "Container renamed");
                        }
                        Err(e) => {
                            warn!(environment_id = %environment_id, error = %e, "Failed to rename container");
                            // Don't return - we still want to emit the event
                        }
                    }
                }
            }
        }
    }

    // Emit event to notify frontend of the rename
    let payload = EnvironmentRenamedPayload {
        environment_id: environment_id.clone(),
        new_name: unique_name.clone(),
        new_branch: unique_branch.clone(),
    };

    if let Err(e) = app_handle.emit("environment-renamed", payload) {
        warn!(environment_id = %environment_id, error = %e, "Failed to emit event");
    } else {
        debug!(environment_id = %environment_id, "Emitted environment-renamed event");
    }
}

/// Delete an environment
#[tauri::command]
pub async fn delete_environment(environment_id: String) -> Result<(), String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    // Get the environment first to check if we need to stop a container or delete a worktree
    // If this fails, we still try to remove the environment from storage
    let environment = match storage.get_environment(&environment_id) {
        Ok(env) => env,
        Err(e) => {
            warn!(environment_id = %environment_id, error = %e, "Failed to get environment details, attempting removal anyway");
            None
        }
    };

    if let Some(env) = environment {
        // Close terminal/tmux sessions for either backend. Local terminal
        // cleanup is a no-op for container envs, and tmux cleanup uses the
        // backend stored on each tracked session.
        close_local_terminal_sessions_for_environment(&environment_id);
        stop_tmux_sessions_for_environment(&environment_id).await;

        // Handle based on environment type
        if env.is_local() {
            // Local environment: stop servers and delete worktree
            info!(environment_id = %environment_id, "Deleting local environment");

            // Stop any running local servers
            if let Err(e) = stop_all_local_servers(&environment_id).await {
                warn!(environment_id = %environment_id, error = %e, "Failed to stop local servers during deletion");
            }

            // Delete the worktree if it exists
            if let (Some(worktree_path), Some(local_path)) = (
                &env.worktree_path,
                storage
                    .get_project(&env.project_id)
                    .ok()
                    .flatten()
                    .and_then(|p| p.local_path),
            ) {
                debug!(environment_id = %environment_id, worktree_path = %worktree_path, "Deleting worktree");
                if let Err(e) = delete_worktree(&local_path, worktree_path).await {
                    warn!(environment_id = %environment_id, error = %e, "Failed to delete worktree during deletion");
                }
            }

            // Remove the isolated OpenCode data directory (SQLite database etc.)
            if let Some(data_home) = isolated_opencode_data_home(&environment_id) {
                let data_path = std::path::Path::new(&data_home);
                debug!(environment_id = %environment_id, path = %data_home, "Removing isolated OpenCode data directory");
                if let Err(e) = std::fs::remove_dir_all(data_path) {
                    debug!(environment_id = %environment_id, error = %e, "Could not remove isolated OpenCode data directory (may not exist)");
                }
            }
        } else {
            // Containerized environment: stop and remove container
            if let Some(container_id) = &env.container_id {
                // Stop container if running
                if env.status == EnvironmentStatus::Running {
                    if let Err(e) = stop_environment_container(container_id).await {
                        warn!(environment_id = %environment_id, error = %e, "Failed to stop container during deletion");
                    }
                }

                // Remove container (ignore errors - container may already be deleted)
                if let Err(e) = remove_environment_container(container_id).await {
                    debug!(environment_id = %environment_id, error = %e, "Container removal skipped (may not exist)");
                }
            }
        }
    }

    // Always try to remove from storage, even if cleanup operations failed
    match storage.remove_environment(&environment_id) {
        Ok(()) => {
            info!(environment_id = %environment_id, "Environment deleted successfully");
            Ok(())
        }
        Err(e) => {
            // If environment not found in storage, that's actually success (already deleted)
            if matches!(e, StorageError::EnvironmentNotFound(_)) {
                info!(environment_id = %environment_id, "Environment already removed from storage");
                Ok(())
            } else {
                Err(storage_error_to_string(e))
            }
        }
    }
}

/// Sync all environments with Docker state
/// Clears container references for environments whose Docker containers no longer exist
/// Returns a list of environment IDs whose container references were cleared
#[tauri::command]
pub async fn sync_all_environments_with_docker() -> Result<Vec<String>, String> {
    info!("Syncing all environments with Docker state");

    let storage = get_storage().map_err(storage_error_to_string)?;

    // Load all environments
    let environments = match storage.load_environments() {
        Ok(envs) => envs,
        Err(e) => {
            error!(error = %e, "Failed to load environments for sync");
            return Err(storage_error_to_string(e));
        }
    };

    let mut cleared_ids: Vec<String> = Vec::new();
    let mut environments_to_clear: Vec<String> = Vec::new();

    // Check each environment with a container_id against Docker
    for env in &environments {
        if let Some(container_id) = &env.container_id {
            // Try to get the container status from Docker
            match get_container_environment_status(container_id).await {
                Ok(status) => {
                    debug!(
                        environment_id = %env.id,
                        container_id = %container_id,
                        status = ?status,
                        "Container exists"
                    );
                    // Container exists, update status if different
                    if status != env.status {
                        if let Err(e) = storage
                            .update_environment(&env.id, json!({ "status": status.to_string() }))
                        {
                            warn!(environment_id = %env.id, error = %e, "Failed to update environment status");
                        }
                    }
                }
                Err(e) => {
                    // Container doesn't exist or Docker error - clear the container reference
                    debug!(
                        environment_id = %env.id,
                        container_id = %container_id,
                        error = %e,
                        "Container status check failed"
                    );
                    info!(
                        environment_id = %env.id,
                        container_id = %container_id,
                        "Container no longer exists, clearing reference"
                    );
                    environments_to_clear.push(env.id.clone());
                }
            }
        }
    }

    // Clear container references for environments whose containers are gone
    for env_id in &environments_to_clear {
        if let Err(e) =
            storage.update_environment(env_id, json!({ "status": "stopped", "containerId": null }))
        {
            warn!(environment_id = %env_id, error = %e, "Failed to clear container reference");
        } else {
            cleared_ids.push(env_id.clone());
        }
    }

    info!(
        cleared_count = cleared_ids.len(),
        "Sync complete - cleared orphaned container references"
    );

    Ok(cleared_ids)
}

/// Get a specific environment by ID with verified Docker status
#[tauri::command]
pub async fn get_environment(environment_id: String) -> Result<Option<Environment>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let env_option = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?;

    // Verify status against Docker if environment has a container
    if let Some(mut env) = env_option {
        if let Some(container_id) = &env.container_id {
            match get_container_environment_status(container_id).await {
                Ok(actual_status) => {
                    if actual_status != env.status {
                        debug!(
                            environment_id = %env.id,
                            stored_status = ?env.status,
                            actual_status = ?actual_status,
                            "Status mismatch, updating"
                        );
                        env.status = actual_status.clone();
                        // Update storage to match actual status
                        let _ = storage.update_environment(
                            &env.id,
                            json!({ "status": actual_status.to_string() }),
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        environment_id = %env.id,
                        error = %e,
                        "Failed to get container status"
                    );
                    // Container was removed externally - clear the stale reference
                    env.status = EnvironmentStatus::Stopped;
                    env.container_id = None;
                    let _ = storage.update_environment(
                        &env.id,
                        json!({ "status": "stopped", "containerId": null }),
                    );
                }
            }
        }
        return Ok(Some(env));
    }

    Ok(None)
}

/// Update environment status
#[tauri::command]
pub async fn update_environment_status(
    environment_id: String,
    status: String,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    // Validate status
    let valid_statuses = ["running", "stopped", "error", "creating"];
    if !valid_statuses.contains(&status.as_str()) {
        return Err(format!(
            "Invalid status: {}. Must be one of: {:?}",
            status, valid_statuses
        ));
    }

    storage
        .update_environment(&environment_id, json!({ "status": status }))
        .map_err(storage_error_to_string)
}

/// Set the PR URL, state, and merge conflict status for an environment
#[tauri::command]
pub async fn set_environment_pr(
    environment_id: String,
    pr_url: String,
    pr_state: PrState,
    has_merge_conflicts: Option<bool>,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .update_environment(
            &environment_id,
            json!({ "prUrl": pr_url, "prState": pr_state, "hasMergeConflicts": has_merge_conflicts }),
        )
        .map_err(storage_error_to_string)
}

/// Toggle debug mode for an environment
/// When enabled, the container entrypoint outputs verbose logging
#[tauri::command]
pub async fn set_environment_debug_mode(
    environment_id: String,
    debug_mode: bool,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .update_environment(&environment_id, json!({ "debugMode": debug_mode }))
        .map_err(storage_error_to_string)
}

/// Fetch the `setupLocal` commands declared in a local environment's
/// `orkestrator-ai.json` without touching container/worktree state.
///
/// Used when re-running setup on first activation after an app restart for
/// an environment whose setup didn't complete in the previous session.
/// Returns `None` for non-local environments or when no commands are declared.
#[tauri::command]
pub async fn get_setup_commands(environment_id: String) -> Result<Option<Vec<String>>, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    if !environment.is_local() {
        return Ok(None);
    }

    let Some(worktree_path) = environment.worktree_path.as_deref() else {
        return Ok(None);
    };

    Ok(fetch_setup_commands(worktree_path, &environment_id).await)
}

/// Persist whether setup scripts have completed for an environment.
///
/// Used so the UI can skip the "waiting for setup" state across app restarts
/// and re-run setup on the next app session when it didn't finish last time.
#[tauri::command]
pub async fn set_environment_setup_complete(
    environment_id: String,
    complete: bool,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .update_environment(&environment_id, json!({ "setupScriptsComplete": complete }))
        .map_err(storage_error_to_string)
}

/// Update per-environment agent settings (default agent, claude mode, opencode mode, codex mode)
/// Pass None for any field to use the global config default
#[tauri::command]
pub async fn update_environment_agent_settings(
    environment_id: String,
    default_agent: Option<DefaultAgent>,
    claude_mode: Option<ClaudeMode>,
    claude_native_backend: Option<ClaudeNativeBackend>,
    opencode_mode: Option<OpenCodeMode>,
    codex_mode: Option<CodexMode>,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    storage
        .update_environment(
            &environment_id,
            json!({
                "defaultAgent": default_agent,
                "claudeMode": claude_mode,
                "claudeNativeBackend": claude_native_backend,
                "opencodeMode": opencode_mode,
                "codexMode": codex_mode,
            }),
        )
        .map_err(storage_error_to_string)
}

/// Rename an environment
#[tauri::command]
pub async fn rename_environment(
    environment_id: String,
    name: String,
) -> Result<Environment, String> {
    // Validate and sanitize name to kebab-case lowercase
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Environment name cannot be empty".to_string());
    }
    let name = sanitize_environment_name(trimmed);
    if name != trimmed {
        debug!(
            environment_id = %environment_id,
            original = %trimmed,
            sanitized = %name,
            "Environment name was sanitized"
        );
    }

    let storage = get_storage().map_err(storage_error_to_string)?;

    // Get the current environment to access old branch name and container info
    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Make the slug unique (consistent with background_rename_environment)
    let existing_environments = storage
        .load_environments()
        .map_err(storage_error_to_string)?;

    // Gather actual git branches from the repo so we don't collide with branches
    // that exist in git but have no corresponding environment in storage.
    let git_branches = list_repo_git_branches(&storage, &environment_id).await;
    let unique_slug = make_unique_environment_slug(&name, &existing_environments, &git_branches);
    let unique_name = unique_slug.clone();

    if unique_name != name {
        debug!(
            environment_id = %environment_id,
            requested_name = %name,
            assigned_name = %unique_name,
            "Name already in use, using unique variant"
        );
    }

    let old_branch = environment.branch.clone();
    let new_branch = sanitize_branch_name(&unique_slug);

    // Update storage with new name and branch, clearing stale PR state
    // if the branch changed.
    let update = build_rename_update(&unique_name, &new_branch, &old_branch);
    let updated_env = storage
        .update_environment(&environment_id, update)
        .map_err(storage_error_to_string)?;

    // Rename git branch based on environment type
    if environment.is_local() {
        // Local environment: rename branch in the worktree
        if let Some(worktree_path) = &environment.worktree_path {
            rename_local_worktree_branch(&environment_id, worktree_path, &old_branch, &new_branch)
                .await;
        }
    } else if let Some(container_id) = &environment.container_id {
        if environment.status == EnvironmentStatus::Running {
            if let Ok(docker) = get_docker_client() {
                // Rename the git branch inside the container
                match docker
                    .exec_command(
                        container_id,
                        vec![
                            "git",
                            "-C",
                            "/workspace",
                            "branch",
                            "-m",
                            "--",
                            &old_branch,
                            &new_branch,
                        ],
                    )
                    .await
                {
                    Ok(output) => {
                        debug!(environment_id = %environment_id, output = %output, "Git branch renamed");
                    }
                    Err(e) => {
                        // Log a clear warning that the user should be aware of
                        warn!(
                            environment_id = %environment_id,
                            old_branch = %old_branch,
                            new_branch = %new_branch,
                            error = %e,
                            "Failed to rename git branch - branch may not exist or may have a different name. \
                             The environment name has been updated but the git branch name remains unchanged."
                        );
                        // Continue - don't fail the whole operation
                    }
                }

                // Rename the Docker container
                match docker.rename_container(container_id, &unique_name).await {
                    Ok(_) => {
                        info!(environment_id = %environment_id, new_name = %unique_name, "Container renamed");
                    }
                    Err(e) => {
                        warn!(
                            environment_id = %environment_id,
                            error = %e,
                            "Failed to rename container - environment name has been updated but container name remains unchanged"
                        );
                        // Continue - don't fail the whole operation
                    }
                }
            }
        }
    }

    Ok(updated_env)
}

/// Rename an environment using an AI-generated name from a prompt.
/// This is used by native mode chat tabs to rename timestamp-named environments
/// after the first user message, mirroring the initial-prompt naming behavior.
#[tauri::command]
pub async fn rename_environment_from_prompt(
    app_handle: tauri::AppHandle,
    environment_id: String,
    prompt: String,
) -> Result<(), String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Prompt cannot be empty".to_string());
    }

    let storage = get_storage().map_err(storage_error_to_string)?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    let old_branch = environment.branch.clone();

    debug!(environment_id = %environment_id, "Running naming task from first prompt (blocking until complete)");

    // Run inline — the frontend awaits this so the prompt is only sent after
    // the branch has been renamed, avoiding git conflicts with the agent.
    background_rename_environment(app_handle, environment_id, old_branch, prompt).await;

    Ok(())
}

/// Get the current status of an environment
#[tauri::command]
pub async fn get_environment_status(environment_id: String) -> Result<EnvironmentStatus, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // If we have a container ID, check actual Docker status
    if let Some(container_id) = &environment.container_id {
        let result: Result<EnvironmentStatus, DockerError> =
            get_container_environment_status(container_id).await;
        match result {
            Ok(status) => {
                // Update stored status if it differs
                if status != environment.status {
                    let status_str = status.to_string();
                    let _ = storage
                        .update_environment(&environment_id, json!({ "status": status_str }));
                }
                return Ok(status);
            }
            Err(_) => {
                // Container might have been removed externally
                return Ok(EnvironmentStatus::Error);
            }
        }
    }

    Ok(environment.status)
}

/// Start an environment - creates and starts Docker container or git worktree
#[tauri::command]
pub async fn start_environment(environment_id: String) -> Result<StartEnvironmentResult, String> {
    info!(environment_id = %environment_id, "Starting environment");

    let storage = get_storage().map_err(storage_error_to_string)?;

    // Get environment and project info
    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    debug!(environment_id = %environment_id, environment_name = %environment.name, "Found environment");

    let project = storage
        .get_project(&environment.project_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Project not found: {}", environment.project_id))?;

    debug!(environment_id = %environment_id, project_name = %project.name, "Found project");

    // Branch based on environment type
    if environment.is_local() {
        return start_local_environment(&environment_id, &environment, &project, &storage).await;
    }

    // Get configuration
    let config = get_config().map_err(|e| e.to_string())?;

    let base_branch_override = resolve_base_branch_override(&config, &environment.project_id);

    if let Some(branch) = &base_branch_override {
        debug!(
            environment_id = %environment_id,
            project_id = %environment.project_id,
            branch = %branch,
            "Using repository default branch for container base"
        );
    }

    // If container already exists, just start it
    if let Some(container_id) = &environment.container_id {
        debug!(environment_id = %environment_id, container_id = %container_id, "Container already exists, starting it");
        storage
            .update_environment(&environment_id, json!({ "status": "creating" }))
            .map_err(storage_error_to_string)?;

        let start_result: Result<(), DockerError> = start_environment_container(container_id).await;
        start_result.map_err(|e: DockerError| {
            let err_msg = e.to_string();
            warn!(environment_id = %environment_id, error = %err_msg, "Failed to start existing container");
            let _ = storage.update_environment(&environment_id, json!({ "status": "error" }));
            err_msg
        })?;

        // Re-resolve dynamic entry port (may change on restart)
        let has_entry_port = config
            .repositories
            .get(&environment.project_id)
            .and_then(|rc| rc.entry_port);
        resolve_and_store_entry_port(storage, &environment_id, container_id, has_entry_port).await;

        storage
            .update_environment(&environment_id, json!({ "status": "running" }))
            .map_err(storage_error_to_string)?;

        info!(environment_id = %environment_id, "Container started successfully");
        return Ok(StartEnvironmentResult::default());
    }

    // Update status to creating
    debug!(environment_id = %environment_id, "Creating new container");
    storage
        .update_environment(&environment_id, json!({ "status": "creating" }))
        .map_err(storage_error_to_string)?;

    // Build container configuration from settings
    let mut container_config = ContainerConfig::new(&environment, &project.git_url)
        .with_project_local_path(project.local_path.clone())
        .with_branch(&environment.branch);

    if let Some(base_branch) = base_branch_override.as_deref() {
        container_config = container_config.with_base_branch(base_branch);
    }

    // Apply repository config settings
    let entry_port = if let Some(repo_config) = config.repositories.get(&environment.project_id) {
        if let Some(files) = &repo_config.files_to_copy {
            container_config = container_config.with_files_to_copy(files.clone());
        }
        repo_config.entry_port
    } else {
        None
    };

    // Set entry port for dynamic host port allocation
    container_config.entry_port = entry_port;

    // Apply settings from global config
    container_config.cpu_limit = Some(config.global.container_resources.cpu_cores as f64);
    container_config.memory_limit =
        Some(config.global.container_resources.memory_gb as i64 * 1024 * 1024 * 1024);
    container_config.anthropic_api_key = config.global.anthropic_api_key.clone();
    container_config.github_token =
        resolve_container_github_token(config.global.github_token.as_deref(), &environment_id);
    container_config.opencode_model = config.global.opencode_model.clone();

    // Set allowed domains from global config (for restricted network mode)
    container_config.allowed_domains = config.global.allowed_domains.clone();

    // Try to get OAuth credentials from system keychain (preferred), refreshing
    // if the token is expired or near expiry. This creates the .credentials.json
    // file in the Linux container via the entrypoint script.
    match credentials::get_or_refresh_claude_credentials().await {
        Ok(creds) => match serde_json::to_string(&creds) {
            Ok(creds_json) => {
                debug!(environment_id = %environment_id, "Retrieved OAuth credentials from system keychain");
                container_config.oauth_credentials_json = Some(creds_json);
            }
            Err(e) => {
                warn!(environment_id = %environment_id, error = ?e, "Failed to serialize credentials");
            }
        },
        Err(e) => {
            warn!(environment_id = %environment_id, error = ?e, "Failed to read/refresh keychain credentials; Claude auth in container may fail");
        }
    }

    debug!(
        environment_id = %environment_id,
        git_url = %container_config.git_url,
        branch = %container_config.branch,
        "Container config prepared"
    );

    // Create the container
    let create_result: Result<String, DockerError> =
        create_environment_container(&container_config, None).await;
    let container_id = create_result.map_err(|e: DockerError| {
        let err_msg = e.to_string();
        warn!(environment_id = %environment_id, error = %err_msg, "Failed to create container");
        // Update status to error on failure
        let _ = storage.update_environment(&environment_id, json!({ "status": "error" }));
        err_msg
    })?;

    debug!(environment_id = %environment_id, container_id = %container_id, "Container created");

    // Update environment with container ID
    storage
        .update_environment(&environment_id, json!({ "containerId": container_id }))
        .map_err(storage_error_to_string)?;

    // Start the container
    debug!(environment_id = %environment_id, "Starting container");
    let start_result: Result<(), DockerError> = start_environment_container(&container_id).await;
    start_result.map_err(|e: DockerError| {
        let err_msg = e.to_string();
        warn!(environment_id = %environment_id, error = %err_msg, "Failed to start container");
        let _ = storage.update_environment(&environment_id, json!({ "status": "error" }));
        err_msg
    })?;

    // Resolve and store entry port mapping
    resolve_and_store_entry_port(storage, &environment_id, &container_id, entry_port).await;

    // Update status to running
    storage
        .update_environment(&environment_id, json!({ "status": "running" }))
        .map_err(storage_error_to_string)?;

    info!(environment_id = %environment_id, "Environment started successfully");
    Ok(StartEnvironmentResult::default())
}

/// Start a local (worktree-based) environment
async fn start_local_environment(
    environment_id: &str,
    environment: &Environment,
    project: &crate::models::Project,
    storage: &crate::storage::Storage,
) -> Result<StartEnvironmentResult, String> {
    info!(
        environment_id = %environment_id,
        environment_name = %environment.name,
        branch = %environment.branch,
        project_id = %environment.project_id,
        project_local_path = ?project.local_path,
        existing_worktree_path = ?environment.worktree_path,
        "Starting local environment"
    );

    // Update status to creating
    storage
        .update_environment(environment_id, json!({ "status": "creating" }))
        .map_err(storage_error_to_string)?;

    // Check if worktree already exists
    if let Some(worktree_path) = &environment.worktree_path {
        if std::path::Path::new(worktree_path).exists() {
            debug!(environment_id = %environment_id, worktree_path = %worktree_path, "Worktree already exists");

            // Ensure local-only workspace artifacts stay out of Git noise.
            if let Err(e) = configure_local_git_artifacts(worktree_path).await {
                warn!(error = %e, "Failed to configure local git artifacts (non-fatal)");
            }

            let setup_commands = fetch_setup_commands_for_start(
                worktree_path,
                environment_id,
                environment.setup_scripts_complete,
            )
            .await;

            // Update status to running
            storage
                .update_environment(environment_id, json!({ "status": "running" }))
                .map_err(storage_error_to_string)?;
            info!(environment_id = %environment_id, "Local environment started (existing worktree)");
            return Ok(StartEnvironmentResult { setup_commands });
        }
    }

    // Get the source repository path
    let source_repo_path = project
        .local_path
        .as_ref()
        .ok_or("Project has no local path - cannot create worktree")?;

    // Resolve repository-specific default branch for new environment branching.
    let config = storage.load_config().ok();
    let base_branch_override = config
        .as_ref()
        .and_then(|config| resolve_base_branch_override(config, &project.id));
    let files_to_copy = config
        .as_ref()
        .and_then(|config| config.repositories.get(&project.id))
        .and_then(|repo| repo.files_to_copy.clone());

    if let Some(branch) = &base_branch_override {
        debug!(
            environment_id = %environment_id,
            project_id = %project.id,
            branch = %branch,
            "Using repository default branch for worktree base"
        );
    }

    // Create the git worktree
    let worktree_result = create_worktree(
        source_repo_path,
        &environment.branch,
        &project.name,
        base_branch_override.as_deref(),
    )
    .await
    .map_err(|e| {
        let err_msg = format!("Failed to create worktree: {}", e);
        warn!(environment_id = %environment_id, error = %err_msg);
        let _ = storage.update_environment(environment_id, json!({ "status": "error" }));
        err_msg
    })?;
    let worktree_path = worktree_result.path;

    if worktree_result.branch != environment.branch {
        debug!(
            environment_id = %environment_id,
            old_branch = %environment.branch,
            new_branch = %worktree_result.branch,
            "Local environment branch was adjusted due to worktree conflict"
        );
    }

    debug!(environment_id = %environment_id, worktree_path = %worktree_path, "Worktree created");

    // Copy .env files from source repo to worktree
    if let Err(e) = copy_env_files(source_repo_path, &worktree_path) {
        // Non-fatal - just log it
        warn!(environment_id = %environment_id, error = %e, "Failed to copy env files (non-fatal)");
    }

    if let Some(files) = files_to_copy.as_ref() {
        if let Err(e) = copy_project_files(source_repo_path, &worktree_path, files) {
            warn!(
                environment_id = %environment_id,
                error = %e,
                "Failed to copy configured project files (non-fatal)"
            );
        }
    }

    // Get setupLocal commands from orkestrator-ai.json (to be run in terminal by frontend)
    let setup_commands = fetch_setup_commands(&worktree_path, environment_id).await;

    // Update environment with worktree path, branch (if adjusted), and status
    storage
        .update_environment(
            environment_id,
            json!({
                "worktreePath": worktree_path,
                "branch": worktree_result.branch,
                "status": "running"
            }),
        )
        .map_err(storage_error_to_string)?;

    info!(environment_id = %environment_id, "Local environment started successfully");
    Ok(StartEnvironmentResult { setup_commands })
}

/// Sync environment status with actual Docker container state
#[tauri::command]
pub async fn sync_environment_status(environment_id: String) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    let mut environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // If no container ID, status should be stopped
    let Some(container_id) = &environment.container_id else {
        if environment.status != EnvironmentStatus::Stopped {
            environment.status = EnvironmentStatus::Stopped;
            let _ = storage.update_environment(&environment_id, json!({ "status": "stopped" }));
        }
        return Ok(environment);
    };

    // Check actual Docker status
    match get_container_environment_status(container_id).await {
        Ok(actual_status) => {
            if actual_status != environment.status {
                debug!(
                    environment_id = %environment_id,
                    stored_status = ?environment.status,
                    actual_status = ?actual_status,
                    "Syncing status"
                );
                environment.status = actual_status.clone();
                storage
                    .update_environment(
                        &environment_id,
                        json!({ "status": actual_status.to_string() }),
                    )
                    .map_err(storage_error_to_string)?;
            }
        }
        Err(e) => {
            warn!(
                environment_id = %environment_id,
                container_id = %container_id,
                error = %e,
                "Container not found or error during sync"
            );
            // Container doesn't exist anymore - clear container ID and set to stopped
            environment.status = EnvironmentStatus::Stopped;
            environment.container_id = None;
            storage
                .update_environment(
                    &environment_id,
                    json!({ "status": "stopped", "containerId": null }),
                )
                .map_err(storage_error_to_string)?;
        }
    }

    Ok(environment)
}

/// Stop an environment - stops Docker container or local servers
#[tauri::command]
pub async fn stop_environment(environment_id: String) -> Result<(), String> {
    info!(environment_id = %environment_id, "Stopping environment");

    let storage = get_storage().map_err(storage_error_to_string)?;

    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    debug!(
        environment_id = %environment_id,
        environment_name = %environment.name,
        container_id = ?environment.container_id,
        environment_type = ?environment.environment_type,
        "Found environment"
    );

    // Close terminal/tmux sessions before either-backend container stop.
    // Local terminal cleanup is a no-op for container envs; tmux cleanup
    // uses the backend stored on each tracked session.
    close_local_terminal_sessions_for_environment(&environment_id);
    stop_tmux_sessions_for_environment(&environment_id).await;

    // Handle local environments differently
    if environment.is_local() {
        // Stop any running local servers
        if let Err(e) = stop_all_local_servers(&environment_id).await {
            warn!(environment_id = %environment_id, error = %e, "Error stopping local servers");
        }

        // Clear PIDs and update status
        storage
            .update_environment(
                &environment_id,
                json!({
                    "status": "stopped",
                    "opencodePid": null,
                    "claudeBridgePid": null,
                    "codexBridgePid": null
                }),
            )
            .map_err(storage_error_to_string)?;

        info!(environment_id = %environment_id, "Local environment stopped");
        return Ok(());
    }

    // Stop the container if it exists (containerized environments)
    if let Some(container_id) = &environment.container_id {
        debug!(environment_id = %environment_id, container_id = %container_id, "Stopping container");
        let stop_result: Result<(), DockerError> = stop_environment_container(container_id).await;
        stop_result.map_err(|e: DockerError| {
            warn!(environment_id = %environment_id, error = %e, "Error stopping container");
            e.to_string()
        })?;
        debug!(environment_id = %environment_id, "Container stopped successfully");
    } else {
        debug!(environment_id = %environment_id, "No container to stop");
    }

    storage
        .update_environment(&environment_id, json!({ "status": "stopped" }))
        .map_err(storage_error_to_string)?;

    info!(environment_id = %environment_id, "Environment stopped");
    Ok(())
}

/// Recreate an environment - preserves filesystem state via docker commit, then creates new container with updated port mappings
/// This is needed when port mappings change, as Docker port bindings are set at container creation time
/// Note: All running processes will be terminated, but installed packages and file changes are preserved
/// Note: This operation does not apply to local environments - they don't have containers to restart
#[tauri::command]
pub async fn recreate_environment(environment_id: String) -> Result<(), String> {
    info!(environment_id = %environment_id, "Recreating environment with docker commit (preserving filesystem state)");

    let storage = get_storage().map_err(storage_error_to_string)?;
    let docker = get_docker_client().map_err(|e| e.to_string())?;

    // Get environment and project info
    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Local environments don't support recreate/restart - they always "exist" as worktrees
    if environment.is_local() {
        debug!(environment_id = %environment_id, "Ignoring recreate request for local environment");
        return Ok(());
    }

    let project = storage
        .get_project(&environment.project_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Project not found: {}", environment.project_id))?;

    let config = get_config().map_err(|e| e.to_string())?;

    let base_branch_override = resolve_base_branch_override(&config, &environment.project_id);

    if let Some(branch) = &base_branch_override {
        debug!(
            environment_id = %environment_id,
            project_id = %environment.project_id,
            branch = %branch,
            "Using repository default branch for recreated container base"
        );
    }

    // If no container exists, just start a new one
    let container_id = match &environment.container_id {
        Some(id) => id.clone(),
        None => {
            info!(environment_id = %environment_id, "No existing container, creating fresh");
            return start_environment(environment_id).await.map(|_| ());
        }
    };

    // Update status to creating
    storage
        .update_environment(&environment_id, json!({ "status": "creating" }))
        .map_err(storage_error_to_string)?;

    // Step 1: Stop the container if running (processes will be terminated)
    debug!(environment_id = %environment_id, container_id = %container_id, "Stopping container for commit");
    if environment.status == EnvironmentStatus::Running {
        if let Err(e) = stop_environment_container(&container_id).await {
            warn!(environment_id = %environment_id, error = %e, "Error stopping container during recreate");
        }
    }

    // Step 2: Commit the container to a temporary image (preserves filesystem state)
    let temp_image_name = format!("orkestrator-temp-{}", environment_id);
    let temp_image_tag = "recreate";
    debug!(environment_id = %environment_id, image = %temp_image_name, "Committing container to temporary image");

    let commit_result = docker
        .commit_container(&container_id, &temp_image_name, temp_image_tag)
        .await;
    if let Err(e) = &commit_result {
        warn!(environment_id = %environment_id, error = %e, "Failed to commit container, falling back to fresh container");
        // Fall back to fresh container creation
        if let Err(e) = remove_environment_container(&container_id).await {
            warn!(environment_id = %environment_id, error = %e, "Error removing container");
        }
        storage
            .update_environment(
                &environment_id,
                json!({ "containerId": null, "status": "stopped" }),
            )
            .map_err(storage_error_to_string)?;
        return start_environment(environment_id).await.map(|_| ());
    }

    let temp_image_full = format!("{}:{}", temp_image_name, temp_image_tag);
    info!(environment_id = %environment_id, image = %temp_image_full, "Container committed to temporary image");

    // Step 3: Remove the old container
    debug!(environment_id = %environment_id, container_id = %container_id, "Removing old container");
    if let Err(e) = remove_environment_container(&container_id).await {
        warn!(environment_id = %environment_id, error = %e, "Error removing container during recreate");
    }

    // Step 4: Build container configuration (same as start_environment)
    let mut container_config = ContainerConfig::new(&environment, &project.git_url)
        .with_project_local_path(project.local_path.clone())
        .with_branch(&environment.branch);

    if let Some(base_branch) = base_branch_override.as_deref() {
        container_config = container_config.with_base_branch(base_branch);
    }

    // Apply repository config settings
    let entry_port = if let Some(repo_config) = config.repositories.get(&environment.project_id) {
        if let Some(files) = &repo_config.files_to_copy {
            container_config = container_config.with_files_to_copy(files.clone());
        }
        repo_config.entry_port
    } else {
        None
    };

    // Set entry port for dynamic host port allocation
    container_config.entry_port = entry_port;

    container_config.cpu_limit = Some(config.global.container_resources.cpu_cores as f64);
    container_config.memory_limit =
        Some(config.global.container_resources.memory_gb as i64 * 1024 * 1024 * 1024);
    container_config.anthropic_api_key = config.global.anthropic_api_key.clone();
    container_config.github_token =
        resolve_container_github_token(config.global.github_token.as_deref(), &environment_id);
    container_config.opencode_model = config.global.opencode_model.clone();
    container_config.allowed_domains = config.global.allowed_domains.clone();

    // Get OAuth credentials (refresh if near expiry so the rehydrated container
    // doesn't start with a stale access token).
    match credentials::get_or_refresh_claude_credentials().await {
        Ok(creds) => {
            if let Ok(creds_json) = serde_json::to_string(&creds) {
                container_config.oauth_credentials_json = Some(creds_json);
            }
        }
        Err(e) => {
            warn!(environment_id = %environment_id, error = ?e, "Failed to read/refresh keychain credentials; Claude auth in recreated container may fail");
        }
    }

    // Step 5: Create new container from the committed image (with new port mappings)
    debug!(environment_id = %environment_id, "Creating new container from committed image");
    let create_result =
        create_environment_container(&container_config, Some(&temp_image_full)).await;

    let new_container_id = match create_result {
        Ok(id) => id,
        Err(e) => {
            let err_msg = e.to_string();
            warn!(environment_id = %environment_id, error = %err_msg, "Failed to create container from committed image");
            // Clean up temp image
            let _ = docker.remove_image(&temp_image_full, true).await;
            let _ = storage.update_environment(
                &environment_id,
                json!({ "containerId": null, "status": "error" }),
            );
            return Err(err_msg);
        }
    };

    debug!(environment_id = %environment_id, container_id = %new_container_id, "New container created");

    // Update environment with new container ID
    storage
        .update_environment(&environment_id, json!({ "containerId": new_container_id }))
        .map_err(storage_error_to_string)?;

    // Step 6: Start the new container
    debug!(environment_id = %environment_id, "Starting new container");
    if let Err(e) = start_environment_container(&new_container_id).await {
        let err_msg = e.to_string();
        warn!(environment_id = %environment_id, error = %err_msg, "Failed to start new container");
        let _ = docker.remove_image(&temp_image_full, true).await;
        let _ = storage.update_environment(&environment_id, json!({ "status": "error" }));
        return Err(err_msg);
    }

    // Resolve and store entry port mapping
    resolve_and_store_entry_port(storage, &environment_id, &new_container_id, entry_port).await;

    // Update status to running
    storage
        .update_environment(&environment_id, json!({ "status": "running" }))
        .map_err(storage_error_to_string)?;

    // Step 7: Clean up the temporary image
    debug!(environment_id = %environment_id, image = %temp_image_full, "Cleaning up temporary image");
    if let Err(e) = docker.remove_image(&temp_image_full, true).await {
        // Non-fatal - just log it
        warn!(environment_id = %environment_id, error = %e, "Failed to remove temporary image (non-fatal)");
    }

    info!(environment_id = %environment_id, "Environment recreated successfully with preserved state");
    Ok(())
}

/// Add domains to the firewall whitelist of a running environment
/// Only works for environments in restricted network mode with a running container
#[tauri::command]
pub async fn add_environment_domains(
    environment_id: String,
    domains: Vec<String>,
) -> Result<String, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Verify environment is running
    if environment.status != EnvironmentStatus::Running {
        return Err("Environment must be running to update firewall rules".to_string());
    }

    // Verify environment is in restricted mode
    if environment.network_access_mode == NetworkAccessMode::Full {
        return Err("Cannot add domains to an environment with full network access".to_string());
    }

    // Get container ID
    let container_id = environment
        .container_id
        .as_ref()
        .ok_or("Environment has no container")?;

    // Execute the update-firewall.sh script in the container
    let domains_csv = domains.join(",");
    let docker = get_docker_client().map_err(|e| e.to_string())?;

    let output = docker
        .exec_command(
            container_id,
            vec![
                "sudo",
                "/usr/local/bin/update-firewall.sh",
                "--add",
                &domains_csv,
            ],
        )
        .await
        .map_err(|e| format!("Failed to execute firewall update: {}", e))?;

    // Update stored allowed domains for the environment
    let mut current_domains = environment.allowed_domains.unwrap_or_default();
    for domain in domains {
        if !current_domains.contains(&domain) {
            current_domains.push(domain);
        }
    }
    storage
        .update_environment(
            &environment_id,
            json!({ "allowedDomains": current_domains }),
        )
        .map_err(storage_error_to_string)?;

    Ok(output)
}

/// Remove domains from the firewall whitelist of a running environment
/// Only works for environments in restricted network mode with a running container
#[tauri::command]
pub async fn remove_environment_domains(
    environment_id: String,
    domains: Vec<String>,
) -> Result<String, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Verify environment is running
    if environment.status != EnvironmentStatus::Running {
        return Err("Environment must be running to update firewall rules".to_string());
    }

    // Verify environment is in restricted mode
    if environment.network_access_mode == NetworkAccessMode::Full {
        return Err(
            "Cannot remove domains from an environment with full network access".to_string(),
        );
    }

    // Get container ID
    let container_id = environment
        .container_id
        .as_ref()
        .ok_or("Environment has no container")?;

    // Execute the update-firewall.sh script in the container
    let domains_csv = domains.join(",");
    let docker = get_docker_client().map_err(|e| e.to_string())?;

    let output = docker
        .exec_command(
            container_id,
            vec![
                "sudo",
                "/usr/local/bin/update-firewall.sh",
                "--remove",
                &domains_csv,
            ],
        )
        .await
        .map_err(|e| format!("Failed to execute firewall update: {}", e))?;

    // Update stored allowed domains for the environment
    let mut current_domains = environment.allowed_domains.unwrap_or_default();
    current_domains.retain(|d| !domains.contains(d));
    storage
        .update_environment(
            &environment_id,
            json!({ "allowedDomains": current_domains }),
        )
        .map_err(storage_error_to_string)?;

    Ok(output)
}

/// Update the allowed domains for an environment
/// This updates both the stored configuration and the running container (if applicable)
#[tauri::command]
pub async fn update_environment_allowed_domains(
    environment_id: String,
    domains: Vec<String>,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    let environment = storage
        .get_environment(&environment_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Update stored domains
    let updated = storage
        .update_environment(&environment_id, json!({ "allowedDomains": domains }))
        .map_err(storage_error_to_string)?;

    // If environment is running and in restricted mode, sync to container
    if environment.status == EnvironmentStatus::Running
        && environment.network_access_mode == NetworkAccessMode::Restricted
    {
        if let Some(container_id) = &environment.container_id {
            let docker = get_docker_client().map_err(|e| e.to_string())?;

            // First, we'd need to figure out what changed. For simplicity,
            // just add all the new domains (ipset ignores duplicates)
            let domains_csv = domains.join(",");
            let _ = docker
                .exec_command(
                    container_id,
                    vec![
                        "sudo",
                        "/usr/local/bin/update-firewall.sh",
                        "--add",
                        &domains_csv,
                    ],
                )
                .await;
            // Note: We don't fail if this errors - the storage update succeeded
        }
    }

    Ok(updated)
}

/// Update port mappings for an environment
/// If the environment has a container, this will require a restart to take effect
#[tauri::command]
pub async fn update_port_mappings(
    environment_id: String,
    port_mappings: Vec<PortMapping>,
) -> Result<Environment, String> {
    let storage = get_storage().map_err(storage_error_to_string)?;

    // Validate port numbers
    for mapping in &port_mappings {
        if mapping.container_port == 0 || mapping.host_port == 0 {
            return Err("Port numbers must be between 1 and 65535".to_string());
        }
    }

    storage
        .update_environment(&environment_id, json!({ "portMappings": port_mappings }))
        .map_err(storage_error_to_string)
}

/// Reattach an orphaned container to a project by creating a new environment entry
/// This allows recovery of containers that have become disconnected from their environment entries
#[tauri::command]
pub async fn reattach_container(
    project_id: String,
    container_id: String,
    name: Option<String>,
) -> Result<Environment, String> {
    info!(
        project_id = %project_id,
        container_id = %container_id,
        name = ?name,
        "Reattaching container to project"
    );

    let storage = get_storage().map_err(storage_error_to_string)?;

    // Verify project exists
    let _ = storage
        .get_project(&project_id)
        .map_err(storage_error_to_string)?
        .ok_or_else(|| format!("Project not found: {}", project_id))?;

    // Get container info to verify it exists and get its name/status
    let docker = get_docker_client().map_err(|e| e.to_string())?;
    let container_info = docker
        .inspect_container(&container_id)
        .await
        .map_err(|e| format!("Container not found: {}", e))?;

    // Verify it's an orkestrator-ai container by checking labels
    let labels = container_info
        .config
        .as_ref()
        .and_then(|c| c.labels.as_ref());

    let is_orkestrator = labels
        .map(|l| l.get("app").map(|v| v == "orkestrator-ai").unwrap_or(false))
        .unwrap_or(false);

    if !is_orkestrator {
        return Err("Container is not an Orkestrator-managed container".to_string());
    }

    // Get the container name (strip leading '/' if present)
    let container_name = container_info
        .name
        .as_ref()
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_else(|| format!("reattached-{}", &container_id[..12.min(container_id.len())]));

    // Determine environment name: use provided name, or fall back to container name
    let env_name = sanitize_environment_name(&name.unwrap_or_else(|| container_name.clone()));

    // Load existing environments to check for duplicate names and existing attachments
    let existing_environments = storage
        .load_environments()
        .map_err(storage_error_to_string)?;

    // Check if this container is already attached to an environment
    let already_attached = existing_environments
        .iter()
        .find(|e| e.container_id.as_ref() == Some(&container_id));

    if let Some(existing_env) = already_attached {
        return Err(format!(
            "Container is already attached to environment '{}' (ID: {})",
            existing_env.name, existing_env.id
        ));
    }

    // Make one slug unique for both name and branch.
    let unique_name = make_unique_environment_slug(&env_name, &existing_environments, &[]);
    if unique_name != env_name {
        debug!(
            requested_name = %env_name,
            assigned_name = %unique_name,
            "Name already in use, using unique variant"
        );
    }

    // Determine the container's current status
    let status = match get_container_environment_status(&container_id).await {
        Ok(s) => s,
        Err(_) => EnvironmentStatus::Stopped,
    };

    // Create the environment with the container already attached
    // Note: The branch field will be auto-generated from the environment name.
    // This branch may not exist in the container's git repository - the container
    // retains whatever git state it had when orphaned. The branch field serves as
    // a placeholder identifier for the reattached environment.
    let mut environment = Environment::with_name(project_id.clone(), unique_name.clone());
    environment.container_id = Some(container_id.clone());
    environment.status = status;

    // Save to storage
    let created_environment = storage
        .add_environment(environment)
        .map_err(storage_error_to_string)?;

    info!(
        environment_id = %created_environment.id,
        container_id = %container_id,
        "Container reattached successfully"
    );

    Ok(created_environment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AppConfig, RepositoryConfig};
    use std::collections::HashMap;

    #[test]
    fn test_valid_statuses() {
        let valid = ["running", "stopped", "error", "creating"];
        for status in valid {
            assert!(valid.contains(&status));
        }
    }

    #[test]
    fn test_resolve_base_branch_override_trims_value() {
        let mut config = AppConfig::default();
        config.repositories = HashMap::from([(
            "project-123".to_string(),
            RepositoryConfig {
                default_branch: "  develop  ".to_string(),
                ..RepositoryConfig::default()
            },
        )]);

        let branch = resolve_base_branch_override(&config, "project-123");
        assert_eq!(branch, Some("develop".to_string()));
    }

    #[test]
    fn test_resolve_base_branch_override_returns_none_for_missing_or_empty() {
        let mut config = AppConfig::default();
        config.repositories = HashMap::from([(
            "project-123".to_string(),
            RepositoryConfig {
                default_branch: "   ".to_string(),
                ..RepositoryConfig::default()
            },
        )]);

        assert_eq!(resolve_base_branch_override(&config, "project-123"), None);
        assert_eq!(
            resolve_base_branch_override(&config, "missing-project"),
            None
        );
    }

    #[test]
    fn test_resolve_container_github_token_prefers_configured_token() {
        let token = resolve_container_github_token(Some("  ghp-configured  "), "env-123");
        assert_eq!(token, Some("ghp-configured".to_string()));
    }

    #[tokio::test]
    async fn test_fetch_setup_commands_for_start_skips_completed_environment() {
        let temp_dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            temp_dir.path().join("orkestrator-ai.json"),
            r#"{"setupLocal":["bun install"]}"#,
        )
        .unwrap();
        let worktree_path = temp_dir.path().to_str().unwrap();

        let completed = fetch_setup_commands_for_start(worktree_path, "env-complete", true).await;
        assert_eq!(completed, None);

        let incomplete =
            fetch_setup_commands_for_start(worktree_path, "env-incomplete", false).await;
        assert_eq!(incomplete, Some(vec!["bun install".to_string()]));
    }

    fn env_with_branch(name: &str, branch: &str) -> Environment {
        let mut env = Environment::with_name("proj".to_string(), name.to_string());
        env.branch = branch.to_string();
        env
    }

    #[test]
    fn test_make_unique_returns_base_when_available() {
        let result = make_unique("hello", |_| false);
        assert_eq!(result, "hello");
    }

    #[test]
    fn test_make_unique_appends_suffix_when_taken() {
        let taken = vec!["feat".to_string(), "feat-2".to_string()];
        let result = make_unique("feat", |name| taken.contains(&name.to_string()));
        assert_eq!(result, "feat-3");
    }

    #[test]
    fn test_make_unique_name_avoids_name_and_branch_collisions() {
        let envs = vec![
            env_with_branch("my-feature", "my-feature"),
            env_with_branch("other", "my-feature-2"),
        ];
        let result = make_unique_name("my-feature", &envs);
        // "my-feature" taken by name, "my-feature-2" taken by branch
        assert_eq!(result, "my-feature-3");
    }

    #[test]
    fn test_make_unique_environment_slug_uses_same_value_for_name_and_branch() {
        let envs = vec![env_with_branch("other", "agent-hangup")];
        let git_branches = vec!["agent-hangup-2".to_string()];

        let result = make_unique_environment_slug("agent-hangup", &envs, &git_branches);

        assert_eq!(result, "agent-hangup-3");
    }

    #[test]
    fn test_make_unique_environment_slug_avoids_env_name_collisions() {
        let envs = vec![
            env_with_branch("agent-hangup", "other-branch"),
            env_with_branch("agent-hangup-2", "another-branch"),
        ];

        let result = make_unique_environment_slug("agent-hangup", &envs, &[]);

        assert_eq!(result, "agent-hangup-3");
    }

    #[test]
    fn test_make_unique_environment_slug_avoids_git_branch_collisions() {
        let envs = vec![];
        let git_branches = vec!["agent-hangup".to_string(), "agent-hangup-2".to_string()];

        let result = make_unique_environment_slug("agent-hangup", &envs, &git_branches);

        assert_eq!(result, "agent-hangup-3");
    }

    #[test]
    fn test_make_unique_branch_avoids_env_branches() {
        let envs = vec![
            env_with_branch("A", "my-feature"),
            env_with_branch("B", "my-feature-2"),
        ];
        let result = make_unique_branch("my-feature", &envs, &[]);
        assert_eq!(result, "my-feature-3");
    }

    #[test]
    fn test_make_unique_branch_avoids_extra_git_branches() {
        let envs = vec![env_with_branch("A", "feat")];
        let git_branches = vec!["feat-2".to_string(), "feat-3".to_string()];
        let result = make_unique_branch("feat", &envs, &git_branches);
        // "feat" taken by env, "feat-2" and "feat-3" taken by git
        assert_eq!(result, "feat-4");
    }

    #[test]
    fn test_make_unique_branch_returns_base_when_available() {
        let envs = vec![env_with_branch("A", "other-branch")];
        let result = make_unique_branch("my-branch", &envs, &[]);
        assert_eq!(result, "my-branch");
    }

    #[test]
    fn test_normalize_initial_prompt_trims_and_filters_blank_text() {
        assert_eq!(
            normalize_initial_prompt(Some("  Review the migration plan\n")),
            Some("Review the migration plan".to_string())
        );
        assert_eq!(normalize_initial_prompt(Some("   \n\t")), None);
        assert_eq!(normalize_initial_prompt(None), None);
    }

    #[test]
    fn test_sanitize_then_unique_branch_handles_collision() {
        // Two different display names that sanitize to the same branch
        let envs = vec![env_with_branch("my feature!", "my-feature")];
        let sanitized = sanitize_branch_name("My Feature?");
        assert_eq!(sanitized, "my-feature");
        let result = make_unique_branch(&sanitized, &envs, &[]);
        assert_eq!(result, "my-feature-2");
    }

    #[test]
    fn test_build_rename_update_clears_pr_state_when_branch_changed() {
        let update = build_rename_update("new-name", "new-branch", "old-branch");
        assert_eq!(update["name"], "new-name");
        assert_eq!(update["branch"], "new-branch");
        assert!(update["prUrl"].is_null());
        assert!(update["prState"].is_null());
        assert!(update["hasMergeConflicts"].is_null());
    }

    #[test]
    fn test_build_rename_update_preserves_pr_state_when_branch_unchanged() {
        let update = build_rename_update("new-name", "same-branch", "same-branch");
        assert_eq!(update["name"], "new-name");
        assert_eq!(update["branch"], "same-branch");
        // prUrl/prState/hasMergeConflicts should not be present at all
        assert!(update.get("prUrl").is_none());
        assert!(update.get("prState").is_none());
        assert!(update.get("hasMergeConflicts").is_none());
    }

    /// Detect the default branch name in a cloned repo (could be main or master).
    async fn get_default_branch(repo_path: &str) -> String {
        let output = tokio::process::Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo_path)
            .output()
            .await
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn test_list_git_branches_at_path_returns_local_and_remote_branches() {
        use tempfile::TempDir;

        // Create a "remote" repo
        let remote_dir = TempDir::new().unwrap();
        let remote_path = remote_dir.path().to_str().unwrap();
        run_git(remote_path, &["init", "--bare"]).await;

        // Clone it to create a "local" repo with an origin
        let local_dir = TempDir::new().unwrap();
        let local_path = local_dir.path().to_str().unwrap();
        run_git_at(
            local_dir.path().parent().unwrap().to_str().unwrap(),
            &["clone", remote_path, local_path],
        )
        .await;
        run_git(local_path, &["config", "user.email", "test@test.com"]).await;
        run_git(local_path, &["config", "user.name", "Test"]).await;

        // Create an initial commit on the default branch
        std::fs::write(local_dir.path().join("file.txt"), "hello").unwrap();
        run_git(local_path, &["add", "."]).await;
        run_git(local_path, &["commit", "-m", "init"]).await;
        run_git(local_path, &["push", "-u", "origin", "HEAD"]).await;

        let default_branch = get_default_branch(local_path).await;

        // Create a remote-only branch by pushing then deleting locally
        run_git(local_path, &["checkout", "-b", "remote-only-branch"]).await;
        std::fs::write(local_dir.path().join("file2.txt"), "world").unwrap();
        run_git(local_path, &["add", "."]).await;
        run_git(local_path, &["commit", "-m", "remote branch"]).await;
        run_git(local_path, &["push", "origin", "remote-only-branch"]).await;
        run_git(local_path, &["checkout", &default_branch]).await;
        run_git(local_path, &["branch", "-D", "remote-only-branch"]).await;

        // Create a local-only branch
        run_git(local_path, &["checkout", "-b", "local-only-branch"]).await;
        run_git(local_path, &["checkout", &default_branch]).await;

        let branches = list_git_branches_at_path(local_path, false).await;

        // Should include the default branch, local-only-branch, and remote-only-branch
        assert!(
            branches.contains(&default_branch),
            "Should contain '{}', got: {:?}",
            default_branch,
            branches
        );
        assert!(
            branches.contains(&"local-only-branch".to_string()),
            "Should contain 'local-only-branch', got: {:?}",
            branches
        );
        assert!(
            branches.contains(&"remote-only-branch".to_string()),
            "Should contain 'remote-only-branch', got: {:?}",
            branches
        );
    }

    #[tokio::test]
    async fn test_list_git_branches_at_path_strips_origin_prefix_and_deduplicates() {
        use tempfile::TempDir;

        let remote_dir = TempDir::new().unwrap();
        let remote_path = remote_dir.path().to_str().unwrap();
        run_git(remote_path, &["init", "--bare"]).await;

        let local_dir = TempDir::new().unwrap();
        let local_path = local_dir.path().to_str().unwrap();
        run_git_at(
            local_dir.path().parent().unwrap().to_str().unwrap(),
            &["clone", remote_path, local_path],
        )
        .await;
        run_git(local_path, &["config", "user.email", "test@test.com"]).await;
        run_git(local_path, &["config", "user.name", "Test"]).await;

        std::fs::write(local_dir.path().join("f.txt"), "x").unwrap();
        run_git(local_path, &["add", "."]).await;
        run_git(local_path, &["commit", "-m", "init"]).await;
        run_git(local_path, &["push", "-u", "origin", "HEAD"]).await;

        let default_branch = get_default_branch(local_path).await;
        let branches = list_git_branches_at_path(local_path, false).await;

        // The default branch appears both as local and as origin/<branch> — should be deduplicated
        let count = branches.iter().filter(|b| **b == default_branch).count();
        assert_eq!(
            count, 1,
            "{} should appear exactly once, got: {:?}",
            default_branch, branches
        );
        // No entry should start with "origin/"
        assert!(
            !branches.iter().any(|b| b.starts_with("origin/")),
            "No branch should retain origin/ prefix, got: {:?}",
            branches
        );
    }

    #[tokio::test]
    async fn test_list_git_branches_at_path_returns_empty_for_invalid_path() {
        let branches = list_git_branches_at_path("/nonexistent/path", false).await;
        assert!(branches.is_empty());
    }

    async fn run_git(dir: &str, args: &[&str]) {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} in {} failed: {}",
            args,
            dir,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    async fn run_git_at(dir: &str, args: &[&str]) {
        run_git(dir, args).await;
    }
}
