//! Process-wide registry of running tmux Claude sessions, keyed by `tab_id`.
//!
//! Each tab in the UI maps to its own `TmuxSession`. Multiple tabs can live
//! inside the same workspace (env); the manager exposes a count of active
//! sessions per env so callers can decide when it's safe to uninstall the
//! workspace-level hook artifacts.

use super::session::{TmuxSession, TmuxSessionStatus};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

pub struct TmuxSessionManager {
    /// Keyed by `tab_id`.
    sessions: Mutex<HashMap<String, Arc<TmuxSession>>>,
    /// Per-env mutex that serializes workspace-hook install/uninstall so
    /// two concurrent tab starts can't race on the settings backup.
    /// See `install_workspace_hooks` in `hooks.rs` for why this matters.
    install_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl TmuxSessionManager {
    fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            install_locks: Mutex::new(HashMap::new()),
        }
    }

    pub async fn insert(&self, tab_id: String, session: Arc<TmuxSession>) {
        let mut map = self.sessions.lock().await;
        map.insert(tab_id, session);
    }

    pub async fn get(&self, tab_id: &str) -> Option<Arc<TmuxSession>> {
        let map = self.sessions.lock().await;
        map.get(tab_id).cloned()
    }

    pub async fn remove(&self, tab_id: &str) -> Option<Arc<TmuxSession>> {
        let mut map = self.sessions.lock().await;
        map.remove(tab_id)
    }

    /// Number of active sessions in the given workspace (env). Used to gate
    /// uninstalling workspace-level hook artifacts on the *last* tab to stop.
    pub async fn sessions_in_env(&self, environment_id: &str) -> usize {
        let map = self.sessions.lock().await;
        map.values()
            .filter(|s| s.environment_id == environment_id)
            .count()
    }

    /// Return (creating if needed) the per-env install mutex. Callers should
    /// hold this lock around the entire install-or-uninstall sequence so
    /// concurrent tab starts in the same workspace can't both read
    /// `backup=None` and race on writing the settings backup.
    pub async fn install_lock(&self, environment_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.install_locks.lock().await;
        map.entry(environment_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn status(&self, tab_id: &str) -> Option<TmuxSessionStatus> {
        let session = self.get(tab_id).await?;
        let alive = session.tmux_alive().await.unwrap_or(false);
        Some(session.status(alive))
    }
}

static MANAGER: OnceLock<TmuxSessionManager> = OnceLock::new();

pub fn init_manager() {
    let _ = MANAGER.set(TmuxSessionManager::new());
}

pub fn get_manager() -> &'static TmuxSessionManager {
    MANAGER.get_or_init(TmuxSessionManager::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_tmux::backend::Backend;
    use tempfile::TempDir;

    fn fake_session(env: &str, tab: &str, tmp: &TempDir) -> Arc<TmuxSession> {
        Arc::new(TmuxSession::build(
            env.to_string(),
            tab.to_string(),
            Backend::Local {
                cwd: tmp.path().to_string_lossy().into_owned(),
            },
            None,
            None,
        ))
    }

    #[tokio::test]
    async fn sessions_in_env_returns_zero_for_empty_manager() {
        let mgr = TmuxSessionManager::new();
        assert_eq!(mgr.sessions_in_env("env-x").await, 0);
    }

    #[tokio::test]
    async fn sessions_in_env_counts_only_matching_environment() {
        let tmp = TempDir::new().unwrap();
        let mgr = TmuxSessionManager::new();
        mgr.insert("tab-a".to_string(), fake_session("env-1", "tab-a", &tmp))
            .await;
        mgr.insert("tab-b".to_string(), fake_session("env-1", "tab-b", &tmp))
            .await;
        mgr.insert("tab-c".to_string(), fake_session("env-2", "tab-c", &tmp))
            .await;

        assert_eq!(mgr.sessions_in_env("env-1").await, 2);
        assert_eq!(mgr.sessions_in_env("env-2").await, 1);
        assert_eq!(mgr.sessions_in_env("env-missing").await, 0);
    }

    #[tokio::test]
    async fn sessions_in_env_decrements_after_remove() {
        let tmp = TempDir::new().unwrap();
        let mgr = TmuxSessionManager::new();
        mgr.insert("tab-a".to_string(), fake_session("env-1", "tab-a", &tmp))
            .await;
        mgr.insert("tab-b".to_string(), fake_session("env-1", "tab-b", &tmp))
            .await;
        assert_eq!(mgr.sessions_in_env("env-1").await, 2);

        let removed = mgr.remove("tab-a").await;
        assert!(removed.is_some());
        assert_eq!(mgr.sessions_in_env("env-1").await, 1);

        mgr.remove("tab-b").await;
        // Last tab gone → the call site uses this to gate hook uninstall.
        assert_eq!(mgr.sessions_in_env("env-1").await, 0);
    }

    #[tokio::test]
    async fn install_lock_returns_the_same_mutex_for_one_env_and_distinct_per_env() {
        let mgr = TmuxSessionManager::new();
        let a1 = mgr.install_lock("env-1").await;
        let a2 = mgr.install_lock("env-1").await;
        let b = mgr.install_lock("env-2").await;
        assert!(Arc::ptr_eq(&a1, &a2), "same env must share one mutex");
        assert!(
            !Arc::ptr_eq(&a1, &b),
            "different envs must NOT share a mutex"
        );
    }
}
