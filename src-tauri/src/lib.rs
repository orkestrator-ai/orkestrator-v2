// Claude Code Environment Orchestrator - Rust Backend
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod claude_cli;
mod claude_tmux;
mod commands;
mod credentials;
mod docker;
mod fix_path_env;
mod local;
mod models;
mod pty;
mod storage;

use bollard::Docker;
use commands::*;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tracing::{info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Check whether debug logging to disk is enabled by reading config.json directly.
///
/// This runs before the Tauri runtime is available, so we read the config file
/// from the well-known app data directory instead of going through the storage layer.
fn is_debug_logging_enabled() -> bool {
    let config_path = dirs::data_dir()
        .or_else(|| dirs::config_dir())
        .map(|d| d.join("orkestrator-ai").join("config.json"));

    let Some(path) = config_path else {
        return false;
    };

    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };

    // Parse just enough to check global.debugLogging
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return false;
    };

    value
        .get("global")
        .and_then(|g| g.get("debugLogging"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Return the log directory path.
///
/// Used both at startup (to configure the file appender) and by the
/// `get_log_directory` Tauri command so there is a single source of truth.
pub fn log_dir_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("orkestrator-ai")
        .join("logs")
}

/// Delete log files in `dir` that are older than `max_age_days`.
fn cleanup_old_logs(dir: &std::path::Path, max_age_days: u64) {
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(max_age_days * 24 * 60 * 60);

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("log")
            || path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("orkestrator-ai.log"))
        {
            if let Ok(meta) = path.metadata() {
                if let Ok(modified) = meta.modified() {
                    if modified < cutoff {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix PATH environment on macOS before any CLI detection
    // This must be called before logging is initialized to ensure CLI tools are found
    fix_path_env::fix_path_env();

    let debug_logging = is_debug_logging_enabled();

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,orkestrator_ai_lib=debug"));

    // Always log to stderr. Optionally also write to a rolling log file
    // when the user has enabled "Save logs for debugging" in settings.
    // Log directory: ~/Library/Application Support/orkestrator-ai/logs/ (macOS)
    if debug_logging {
        let log_dir = log_dir_path();
        let _ = std::fs::create_dir_all(&log_dir);

        // Remove log files older than 7 days to prevent unbounded disk usage.
        cleanup_old_logs(&log_dir, 7);

        let file_appender = tracing_appender::rolling::daily(&log_dir, "orkestrator-ai.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

        // Keep the guard alive for the entire app lifetime by leaking it.
        // Dropping the guard would stop the background writer thread.
        // Note: this means the write buffer is not flushed on exit, so
        // the last few log lines may be lost. Acceptable for debug logging.
        std::mem::forget(_guard);

        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().with_target(false))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_target(false)
                    .with_ansi(false)
                    .with_writer(non_blocking),
            )
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(false)
            .init();
    }

    // Initialize terminal manager if Docker is available
    if Docker::connect_with_local_defaults().is_ok() {
        pty::init_terminal_manager();
        info!("Terminal manager initialized");
    } else {
        warn!("Could not initialize terminal manager - Docker not available");
    }

    // Initialize local terminal manager (always available for local environments)
    local::init_local_terminal_manager();
    info!("Local terminal manager initialized");

    // Initialize tmux session manager (local + container Claude tmux mode)
    claude_tmux::init_manager();
    info!("Claude tmux session manager initialized");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Create App menu with About and Quit (CMD+Q)
            let app_menu = SubmenuBuilder::new(app, "Orkestrator AI")
                .item(&PredefinedMenuItem::about(
                    app,
                    Some("About Orkestrator AI"),
                    None,
                )?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            // Create Edit menu with standard editing shortcuts
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            // Create View menu with zoom controls
            let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;

            let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?;

            let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&zoom_in)
                .item(&zoom_out)
                .separator()
                .item(&zoom_reset)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu])
                .build()?;

            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(move |app_handle, event| match event.id().0.as_str() {
                "zoom_in" => {
                    let _ = app_handle.emit("menu-zoom", "in");
                }
                "zoom_out" => {
                    let _ = app_handle.emit("menu-zoom", "out");
                }
                "zoom_reset" => {
                    let _ = app_handle.emit("menu-zoom", "reset");
                }
                _ => {}
            });

            // Clean up stale local server processes from previous app sessions.
            // Schedule this after Tauri's async runtime is available.
            tauri::async_runtime::spawn(async {
                local::cleanup_stale_local_servers().await;
            });

            // Keep Claude OAuth credentials in sync between the macOS Keychain
            // and any running Orkestrator containers. Refreshes expiring tokens
            // and pushes new ones to containers so they don't hit 401 errors.
            let sync_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                credentials::sync::run_sync_loop(sync_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            // Project commands
            get_projects,
            add_project,
            remove_project,
            get_project,
            update_project,
            reorder_projects,
            validate_git_url,
            get_git_remote_url,
            // Environment commands
            get_environments,
            reorder_environments,
            create_environment,
            delete_environment,
            get_environment,
            update_environment_status,
            set_environment_pr,
            set_environment_debug_mode,
            set_environment_setup_complete,
            get_setup_commands,
            rename_environment,
            rename_environment_from_prompt,
            get_environment_status,
            start_environment,
            stop_environment,
            recreate_environment,
            sync_environment_status,
            sync_all_environments_with_docker,
            reattach_container,
            add_environment_domains,
            remove_environment_domains,
            update_environment_allowed_domains,
            // Port mapping commands
            update_port_mappings,
            update_environment_agent_settings,
            // Docker commands
            check_docker,
            docker_version,
            provision_environment,
            docker_start_container,
            docker_stop_container,
            docker_remove_container,
            docker_container_status,
            list_docker_containers,
            check_base_image,
            get_docker_system_stats,
            get_orkestrator_containers,
            cleanup_orphaned_containers,
            docker_system_prune,
            get_container_logs,
            stream_container_logs,
            get_container_host_port,
            propagate_github_token_to_containers,
            // Terminal commands
            attach_terminal,
            create_terminal_session,
            start_terminal_session,
            terminal_write,
            terminal_resize,
            detach_terminal,
            list_terminal_sessions,
            get_terminal_session,
            // Session commands (persistent session tracking)
            create_session,
            get_session,
            get_sessions_by_environment,
            update_session_status,
            update_session_activity,
            delete_session,
            delete_sessions_by_environment,
            rename_session,
            set_session_has_launched_command,
            disconnect_environment_sessions,
            save_session_buffer,
            load_session_buffer,
            sync_sessions_with_container,
            reorder_sessions,
            cleanup_orphaned_buffers,
            // GitHub commands
            open_in_browser,
            reveal_in_file_manager,
            get_environment_pr_url,
            clear_environment_pr,
            detect_pr,
            detect_pr_local,
            merge_pr,
            merge_pr_local,
            // Config commands
            get_config,
            save_config,
            get_global_config,
            update_global_config,
            get_repository_config,
            update_repository_config,
            get_log_directory,
            // Credentials commands
            has_claude_credentials,
            get_credential_status,
            // CLI detection and onboarding commands
            check_claude_cli,
            check_claude_config,
            check_opencode_cli,
            check_codex_cli,
            check_github_cli,
            check_any_ai_cli,
            get_available_ai_cli,
            // Network commands
            test_domain_resolution,
            validate_domains,
            // Claude state commands
            start_claude_state_polling,
            stop_claude_state_polling,
            // Editor commands
            open_in_editor,
            open_local_in_editor,
            // File commands (container)
            get_git_status,
            get_file_tree,
            read_container_file,
            read_file_at_branch,
            read_container_file_base64,
            write_container_file,
            // File commands (local environments)
            get_local_git_status,
            get_local_file_tree,
            read_local_file,
            read_local_file_at_branch,
            read_file_base64,
            write_local_file,
            // OpenCode commands
            start_opencode_server,
            stop_opencode_server,
            get_opencode_server_status,
            get_opencode_server_log,
            get_opencode_model_preferences,
            // Claude bridge commands
            start_claude_server,
            stop_claude_server,
            get_claude_server_status,
            get_claude_server_log,
            // Codex bridge commands
            start_codex_server,
            stop_codex_server,
            get_codex_server_status,
            get_codex_server_log,
            // Local server commands (for local/worktree environments)
            start_local_opencode_server_cmd,
            stop_local_opencode_server_cmd,
            get_local_opencode_server_status,
            start_local_claude_server_cmd,
            stop_local_claude_server_cmd,
            get_local_claude_server_status,
            start_local_codex_server_cmd,
            stop_local_codex_server_cmd,
            get_local_codex_server_status,
            cleanup_stale_local_servers_cmd,
            // Kanban commands
            get_kanban_tasks,
            add_kanban_task,
            update_kanban_task,
            delete_kanban_task,
            add_kanban_comment,
            delete_kanban_comment,
            add_kanban_image,
            delete_kanban_image,
            get_kanban_image_data,
            get_project_notes,
            save_project_notes,
            // Local terminal commands (for local/worktree environments)
            create_local_terminal_session,
            start_local_terminal_session,
            local_terminal_write,
            local_terminal_resize,
            close_local_terminal_session,
            // Claude tmux mode (local + container)
            claude_tmux_start,
            claude_tmux_stop,
            claude_tmux_interrupt,
            claude_tmux_status,
            claude_tmux_transcript,
            claude_tmux_pending_hooks,
            claude_tmux_create_interactive_terminal,
            claude_tmux_start_interactive_terminal,
            claude_tmux_write_interactive_terminal,
            claude_tmux_resize_interactive_terminal,
            claude_tmux_detach_interactive_terminal,
            claude_tmux_send_text,
            claude_tmux_send_keys,
            claude_tmux_submit,
            claude_tmux_switch_model,
            claude_tmux_switch_effort,
            claude_tmux_capture_pane,
            claude_tmux_resize,
            claude_tmux_answer_pre_tool_use,
            claude_tmux_reply_hook,
            claude_tmux_list_previous_sessions,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Kill all tracked local server processes so they don't
                // linger as orphans after the app closes.
                // Use a timeout to avoid blocking indefinitely if the
                // process lock is held or the runtime is shutting down.
                tauri::async_runtime::block_on(async {
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        async {
                            local::shutdown_all_local_terminal_sessions();
                            commands::shutdown_all_tmux_sessions().await;
                            local::shutdown_all_local_servers().await;
                        },
                    )
                    .await;
                    if result.is_err() {
                        warn!("Timed out waiting for local server shutdown");
                    }
                });
            }
        });
}
