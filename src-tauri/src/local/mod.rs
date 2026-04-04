//! Local environment management module
//!
//! This module handles local (non-Docker) environments that use git worktrees
//! and run agent servers as native child processes on the host machine.

pub mod ports;
pub mod process;
pub mod pty;
pub mod servers;
pub mod worktree;

// Re-export commonly used items
pub use ports::allocate_ports;
pub use pty::{get_local_terminal_manager, init_local_terminal_manager};
pub use servers::{
    cleanup_stale_local_servers, get_local_claude_status, get_local_codex_status,
    get_local_opencode_status, isolated_opencode_data_home, shutdown_all_local_servers,
    start_local_claude_bridge, start_local_codex_bridge, start_local_opencode_server,
    stop_all_local_servers, stop_local_claude_bridge, stop_local_codex_bridge,
    stop_local_opencode_server, LocalServerStartResult, LocalServerStatus,
};
pub use worktree::{
    configure_local_git_artifacts, copy_env_files, copy_project_files, create_worktree,
    delete_worktree, get_setup_local_commands,
};
