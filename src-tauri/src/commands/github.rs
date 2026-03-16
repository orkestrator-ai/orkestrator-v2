// GitHub integration Tauri commands

use crate::docker::client::get_docker_client;
use crate::models::PrState;

/// PR detection result containing both URL and state
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetectionResult {
    pub url: String,
    pub state: PrState,
    pub has_merge_conflicts: bool,
}

/// Detect PR URL and state for the environment's branch by running gh pr view in the container
/// Passes branch as positional arg to check the correct branch regardless of what's currently checked out
#[tauri::command]
pub async fn detect_pr(
    container_id: String,
    branch: String,
) -> Result<Option<PrDetectionResult>, String> {
    if branch.trim().is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    // Run: gh pr view <branch> --json url,state,mergeable -q '{...}'
    // Pass the branch as a positional argument to check the environment's branch explicitly,
    // not the currently checked out branch.
    // After a PR merge with --delete-branch, the workspace may switch to main, so relying on
    // the current branch would check the wrong PR.
    // Use exec_command_stdout to only capture stdout, as gh CLI may output
    // progress messages to stderr which would corrupt JSON parsing
    let output = client
        .exec_command_stdout(
            &container_id,
            vec![
                "gh",
                "pr",
                "view",
                &branch,
                "--json",
                "url,state,mergeable",
                "-q",
                "{url: .url, state: .state, mergeable: .mergeable}",
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    let trimmed = output.trim();

    // If output is empty, no PR exists
    if trimmed.is_empty() {
        return Ok(None);
    }

    // Try to parse the JSON output first
    // This is the expected success path when a PR exists
    #[derive(serde::Deserialize)]
    struct GhPrView {
        url: String,
        state: String,
        mergeable: Option<String>,
    }

    let pr_view: GhPrView = match serde_json::from_str(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            // JSON parsing failed - this likely means no PR exists
            // or gh CLI returned an error message instead of JSON
            // Fall back to checking for common error indicators
            let trimmed_lower = trimmed.to_lowercase();
            if trimmed_lower.contains("no pull request")
                || trimmed_lower.contains("could not resolve")
                || trimmed_lower.contains("not found")
                || trimmed_lower.contains("error")
                || trimmed_lower.contains("failed")
            {
                return Ok(None);
            }
            // Unexpected non-JSON output that doesn't match known errors
            // Log and return None rather than erroring
            tracing::debug!(output = %trimmed, "Unexpected non-JSON output from gh pr view");
            return Ok(None);
        }
    };

    // Validate URL format
    if !pr_view.url.starts_with("https://")
        || !pr_view.url.contains("github.com/")
        || !pr_view.url.contains("/pull/")
    {
        return Ok(None);
    }

    // Convert state string to PrState enum
    let state = match pr_view.state.to_uppercase().as_str() {
        "OPEN" => PrState::Open,
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => return Ok(None), // Unknown state
    };

    // Check for merge conflicts
    // mergeable can be: "MERGEABLE", "CONFLICTING", "UNKNOWN"
    let has_merge_conflicts = pr_view
        .mergeable
        .map(|m| m.to_uppercase() == "CONFLICTING")
        .unwrap_or(false);

    Ok(Some(PrDetectionResult {
        url: pr_view.url,
        state,
        has_merge_conflicts,
    }))
}

/// Detect PR URL and state for the environment's branch by running gh pr view locally
/// Passes branch as positional arg to check the correct branch regardless of what's currently checked out
/// Used for local (worktree-based) environments where there's no container
#[tauri::command]
pub async fn detect_pr_local(
    environment_id: String,
    branch: String,
) -> Result<Option<PrDetectionResult>, String> {
    use crate::storage::get_storage;
    use tokio::process::Command;
    use tracing::debug;

    if branch.trim().is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }

    // Get the environment to find the worktree path
    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Get the worktree path - this only works for local environments
    let worktree_path = environment
        .worktree_path
        .ok_or_else(|| "Environment is not a local environment (no worktree path)".to_string())?;

    debug!(environment_id = %environment_id, worktree_path = %worktree_path, branch = %branch, "Detecting PR for local environment");

    // Run: gh pr view <branch> --json url,state,mergeable -q '{...}'
    // Pass the branch as a positional argument to check the environment's branch explicitly
    let output = Command::new("gh")
        .args([
            "pr",
            "view",
            &branch,
            "--json",
            "url,state,mergeable",
            "-q",
            "{url: .url, state: .state, mergeable: .mergeable}",
        ])
        .current_dir(&worktree_path)
        .output()
        .await
        .map_err(|e| format!("Failed to execute gh command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stdout.trim();

    debug!(stdout = %trimmed, stderr = %stderr, "gh pr view output");

    // If output is empty or command failed, no PR exists
    if trimmed.is_empty() || !output.status.success() {
        return Ok(None);
    }

    // Try to parse the JSON output
    #[derive(serde::Deserialize)]
    struct GhPrView {
        url: String,
        state: String,
        mergeable: Option<String>,
    }

    let pr_view: GhPrView = match serde_json::from_str(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            let trimmed_lower = trimmed.to_lowercase();
            if trimmed_lower.contains("no pull request")
                || trimmed_lower.contains("could not resolve")
                || trimmed_lower.contains("not found")
                || trimmed_lower.contains("error")
                || trimmed_lower.contains("failed")
            {
                return Ok(None);
            }
            debug!(output = %trimmed, "Unexpected non-JSON output from gh pr view (local)");
            return Ok(None);
        }
    };

    // Validate URL format
    if !pr_view.url.starts_with("https://")
        || !pr_view.url.contains("github.com/")
        || !pr_view.url.contains("/pull/")
    {
        return Ok(None);
    }

    // Convert state string to PrState enum
    let state = match pr_view.state.to_uppercase().as_str() {
        "OPEN" => PrState::Open,
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => return Ok(None),
    };

    // Check for merge conflicts
    let has_merge_conflicts = pr_view
        .mergeable
        .map(|m| m.to_uppercase() == "CONFLICTING")
        .unwrap_or(false);

    Ok(Some(PrDetectionResult {
        url: pr_view.url,
        state,
        has_merge_conflicts,
    }))
}

/// Open a URL in the default browser
/// This uses Tauri's opener plugin
#[tauri::command]
pub async fn open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))
}

/// Reveal a file or directory in the system file manager (Finder / Explorer)
#[tauri::command]
pub async fn reveal_in_file_manager(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .reveal_item_in_dir(std::path::Path::new(&path))
        .map_err(|e| format!("Failed to reveal path: {}", e))
}

/// Get the PR URL for an environment (reads from storage)
#[tauri::command]
pub async fn get_environment_pr_url(environment_id: String) -> Result<Option<String>, String> {
    use crate::storage::get_storage;

    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?;

    Ok(environment.and_then(|e| e.pr_url))
}

/// Clear the PR URL, state, and merge conflicts for an environment (for resetting)
#[tauri::command]
pub async fn clear_environment_pr(environment_id: String) -> Result<(), String> {
    use crate::storage::get_storage;
    use serde_json::json;

    let storage = get_storage().map_err(|e| e.to_string())?;

    // Set pr_url, pr_state, and has_merge_conflicts to null
    storage
        .update_environment(
            &environment_id,
            json!({ "prUrl": null, "prState": null, "hasMergeConflicts": null }),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Merge method for PR merging
#[derive(serde::Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    #[default]
    Squash,
    Merge,
    Rebase,
}

impl MergeMethod {
    fn as_flag(&self) -> &'static str {
        match self {
            MergeMethod::Squash => "--squash",
            MergeMethod::Merge => "--merge",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// Merge the current branch's PR using gh pr merge
#[tauri::command]
pub async fn merge_pr(
    container_id: String,
    method: Option<MergeMethod>,
    delete_branch: Option<bool>,
) -> Result<(), String> {
    use tracing::info;

    let client = get_docker_client().map_err(|e| e.to_string())?;

    // Check if container is running
    let is_running = client
        .is_container_running(&container_id)
        .await
        .map_err(|e| e.to_string())?;

    if !is_running {
        return Err("Container is not running".to_string());
    }

    let merge_method = method.unwrap_or_default();
    let should_delete_branch = delete_branch.unwrap_or(true);

    // Build the command
    let mut cmd = vec!["gh", "pr", "merge", merge_method.as_flag()];

    if should_delete_branch {
        cmd.push("--delete-branch");
    }

    info!(
        container_id = %container_id,
        method = ?merge_method.as_flag(),
        delete_branch = should_delete_branch,
        "Merging PR"
    );

    // Run: gh pr merge --squash --delete-branch (or other options)
    // Use exec_command_with_status to check the exit code for success/failure.
    // String-based error detection is unreliable because after a successful merge with
    // --delete-branch, git may auto-pull and output file paths that contain words like
    // "permission" or "error" (e.g. "permissions-check/page.tsx").
    let (stdout, stderr, exit_code) = client
        .exec_command_with_status(&container_id, cmd)
        .await
        .map_err(|e| e.to_string())?;

    tracing::debug!(
        container_id = %container_id,
        stdout = %stdout.trim(),
        stderr = %stderr.trim(),
        exit_code = exit_code,
        "gh pr merge output"
    );

    if exit_code != 0 {
        // On failure, stderr contains the error message from gh CLI
        let error_msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "Unknown error".to_string()
        };
        return Err(format!("Failed to merge PR: {}", error_msg));
    }

    info!(container_id = %container_id, "PR merged successfully");

    Ok(())
}

/// Merge the current branch's PR locally using gh pr merge
/// Used for local (worktree-based) environments where there's no container
#[tauri::command]
pub async fn merge_pr_local(
    environment_id: String,
    method: Option<MergeMethod>,
    _delete_branch: Option<bool>,
) -> Result<(), String> {
    use crate::storage::get_storage;
    use tokio::process::Command;
    use tracing::{debug, info};

    // Get the environment to find the worktree path
    let storage = get_storage().map_err(|e| e.to_string())?;
    let environment = storage
        .get_environment(&environment_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Environment not found: {}", environment_id))?;

    // Get the worktree path - this only works for local environments
    let worktree_path = environment
        .worktree_path
        .ok_or_else(|| "Environment is not a local environment (no worktree path)".to_string())?;

    let merge_method = method.unwrap_or_default();

    // Note: We intentionally do NOT use --delete-branch for worktree-based environments.
    // Worktrees cannot switch to another branch (like main) after merge because that branch
    // is already checked out in the main repository. The user should delete the environment
    // when done, which properly removes the worktree.

    info!(
        environment_id = %environment_id,
        worktree_path = %worktree_path,
        method = ?merge_method.as_flag(),
        "Merging PR (local)"
    );

    // Build the command arguments - no --delete-branch for worktrees
    let args = vec!["pr", "merge", merge_method.as_flag()];

    // Run: gh pr merge --squash (or --merge/--rebase)
    let output = Command::new("gh")
        .args(&args)
        .current_dir(&worktree_path)
        .output()
        .await
        .map_err(|e| format!("Failed to execute gh command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stdout.trim();
    let stderr_trimmed = stderr.trim();

    debug!(stdout = %trimmed, stderr = %stderr_trimmed, status = ?output.status, "gh pr merge output (local)");

    // Primary check: rely on exit status
    // gh pr merge returns non-zero on actual failures
    if !output.status.success() {
        let error_msg = if !stderr_trimmed.is_empty() {
            stderr_trimmed
        } else if !trimmed.is_empty() {
            trimmed
        } else {
            "Unknown error"
        };
        return Err(format!("Failed to merge PR: {}", error_msg));
    }

    info!(environment_id = %environment_id, "PR merged successfully (local)");

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_url_format() {
        // Simple test to ensure URLs are valid
        let url = "https://github.com/user/repo/pull/123";
        assert!(url.starts_with("https://"));
    }
}
