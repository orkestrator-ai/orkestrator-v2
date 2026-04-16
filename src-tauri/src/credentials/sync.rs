// Background task that keeps Claude credentials in sync between the macOS
// Keychain and any running Orkestrator containers. Without this, a container
// created with a snapshot of credentials will start failing once the host's
// copy is refreshed (refresh tokens are single-use and get rotated).

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::{debug, info, warn};

use crate::credentials::{self, ClaudeCredentials, CredentialsError};
use crate::docker::{
    container::{CONTAINER_LABEL_APP, CONTAINER_LABEL_APP_VALUE},
    get_docker_client,
};

const SYNC_INTERVAL: Duration = Duration::from_secs(60);
const CREDENTIALS_PATH_IN_CONTAINER: &str = "/home/node/.claude/.credentials.json";
const NODE_UID: u64 = 1000;
const NODE_GID: u64 = 1000;
const CREDENTIALS_EVENT: &str = "claude-credentials-error";
/// Emit a refresh-failure toast only after this many consecutive ticks fail,
/// to avoid flapping on transient network hiccups.
const REFRESH_FAILURE_TOAST_THRESHOLD: u32 = 2;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsErrorPayload {
    pub message: String,
    pub kind: &'static str,
}

/// Outcome of a single sync tick. Used to decide whether to count a tick as
/// a consecutive failure for toast escalation — transient Docker hiccups
/// should not poison the failure counter.
#[derive(Debug)]
enum SyncOutcome {
    /// No running containers, or Docker was unreachable. No refresh attempted.
    Idle,
    /// Token hadn't changed since the last sync; nothing was pushed.
    Unchanged,
    /// Credentials pushed to at least one container (possibly with per-container failures).
    /// Fields are consumed by tests; the production loop only matches on the variant.
    Pushed {
        #[allow(dead_code)]
        succeeded: usize,
        #[allow(dead_code)]
        failed: usize,
    },
    /// Refresh against the OAuth server failed.
    RefreshFailed(CredentialsError),
}

fn emit_error(app: &AppHandle, kind: &'static str, message: impl Into<String>) {
    let payload = CredentialsErrorPayload {
        message: message.into(),
        kind,
    };
    if let Err(e) = app.emit(CREDENTIALS_EVENT, &payload) {
        warn!(error = ?e, "Failed to emit credentials error event");
    }
}

/// Push a credentials JSON blob into a single container.
async fn push_to_container(container_id: &str, creds_json: &[u8]) -> Result<(), String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;
    client
        .upload_file_to_container_with_metadata(
            container_id,
            CREDENTIALS_PATH_IN_CONTAINER,
            creds_json.to_vec(),
            0o600,
            NODE_UID,
            NODE_GID,
        )
        .await
        .map_err(|e| e.to_string())
}

/// List running orkestrator-managed container IDs.
async fn list_running_managed_containers() -> Result<Vec<String>, String> {
    let client = get_docker_client().map_err(|e| e.to_string())?;
    let label = format!("{}={}", CONTAINER_LABEL_APP, CONTAINER_LABEL_APP_VALUE);
    let containers = client
        .list_containers(false, Some(&label))
        .await
        .map_err(|e| e.to_string())?;
    Ok(containers.into_iter().filter_map(|c| c.id).collect())
}

// Boxed-future type aliases for dependency injection. Keeps sync_once pure
// enough to unit-test without pulling in `async_trait`.
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
type ListFn<'a> = &'a (dyn Fn() -> BoxFuture<'a, Result<Vec<String>, String>> + Send + Sync);
type RefreshFn<'a> =
    &'a (dyn Fn() -> BoxFuture<'a, Result<ClaudeCredentials, CredentialsError>> + Send + Sync);
type PushFn<'a> = &'a (dyn Fn(String, Vec<u8>) -> BoxFuture<'a, Result<(), String>> + Send + Sync);

/// Testable core. Decides whether to push, serializes once per unique token,
/// and aggregates per-container failures.
async fn sync_once_with(
    app: Option<&AppHandle>,
    last_synced_token: &mut Option<String>,
    list: ListFn<'_>,
    refresh: RefreshFn<'_>,
    push: PushFn<'_>,
) -> SyncOutcome {
    let running = match list().await {
        Ok(ids) => ids,
        Err(e) => {
            debug!(error = %e, "Skipping credential sync tick: could not list containers");
            return SyncOutcome::Idle;
        }
    };

    if running.is_empty() {
        return SyncOutcome::Idle;
    }

    let creds = match refresh().await {
        Ok(c) => c,
        Err(e) => return SyncOutcome::RefreshFailed(e),
    };
    let token = creds.claude_ai_oauth.access_token.clone();

    if last_synced_token.as_deref() == Some(token.as_str()) {
        return SyncOutcome::Unchanged;
    }

    let json = match serde_json::to_vec(&creds) {
        Ok(v) => v,
        Err(e) => {
            return SyncOutcome::RefreshFailed(CredentialsError::ParseError(format!(
                "Failed to serialize credentials: {}",
                e
            )));
        }
    };

    let mut failures: Vec<String> = Vec::new();
    for container_id in &running {
        if let Err(e) = push(container_id.clone(), json.clone()).await {
            failures.push(format!(
                "{}: {}",
                &container_id[..12.min(container_id.len())],
                e
            ));
        }
    }

    if !failures.is_empty() {
        if let Some(app) = app {
            emit_error(
                app,
                "push_failed",
                format!(
                    "Failed to push refreshed Claude credentials to {} container(s): {}",
                    failures.len(),
                    failures.join("; ")
                ),
            );
        }
    }

    let succeeded = running.len() - failures.len();
    // Only remember the token once every target received it. If any push
    // failed we leave `last_synced_token` alone so the next tick retries.
    if failures.is_empty() {
        *last_synced_token = Some(token);
    }

    info!(
        succeeded,
        failed = failures.len(),
        "Synced refreshed Claude credentials to running containers"
    );
    SyncOutcome::Pushed {
        succeeded,
        failed: failures.len(),
    }
}

/// Run the credential-sync loop forever. Intended to be spawned as a background
/// task from the Tauri `setup` hook.
pub async fn run_sync_loop(app: AppHandle) {
    let mut interval = tokio::time::interval(SYNC_INTERVAL);
    // Skip the immediate first tick; wait a full interval before the first run
    // so startup doesn't race with container creation.
    interval.tick().await;

    let mut last_synced_token: Option<String> = None;
    let mut consecutive_refresh_errors: u32 = 0;

    let list: ListFn = &|| Box::pin(list_running_managed_containers());
    let refresh: RefreshFn = &|| Box::pin(credentials::get_or_refresh_claude_credentials());
    let push: PushFn =
        &|id: String, json: Vec<u8>| Box::pin(async move { push_to_container(&id, &json).await });

    loop {
        interval.tick().await;

        let outcome =
            sync_once_with(Some(&app), &mut last_synced_token, list, refresh, push).await;

        match outcome {
            SyncOutcome::RefreshFailed(e) => {
                consecutive_refresh_errors = consecutive_refresh_errors.saturating_add(1);
                if consecutive_refresh_errors == REFRESH_FAILURE_TOAST_THRESHOLD {
                    emit_error(
                        &app,
                        "refresh_failed",
                        format!(
                            "Claude credential refresh is failing: {}. Containers may hit 401 errors until the host's `claude` CLI re-authenticates.",
                            e
                        ),
                    );
                }
                warn!(
                    error = ?e,
                    consecutive_refresh_errors,
                    "Credential sync tick failed"
                );
            }
            SyncOutcome::Pushed { .. } | SyncOutcome::Unchanged => {
                // An actual successful evaluation — clear the counter.
                consecutive_refresh_errors = 0;
            }
            SyncOutcome::Idle => {
                // Docker unreachable or no containers. Don't touch the
                // counter: we never attempted a refresh, so we shouldn't
                // mask earlier genuine failures.
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{ClaudeCredentials, ClaudeOAuthCredentials};

    fn make_creds(access_token: &str) -> ClaudeCredentials {
        ClaudeCredentials {
            claude_ai_oauth: ClaudeOAuthCredentials {
                access_token: access_token.to_string(),
                refresh_token: "r".to_string(),
                expires_at: 0,
                scopes: vec!["s".to_string()],
                subscription_type: None,
                rate_limit_tier: None,
            },
        }
    }

    #[tokio::test]
    async fn test_sync_once_idle_when_no_containers() {
        let list: ListFn = &|| Box::pin(async { Ok(vec![]) });
        let refresh: RefreshFn = &|| {
            panic!("refresh should not be called when there are no running containers");
        };
        let push: PushFn = &|_id, _json| Box::pin(async { Ok(()) });

        let mut last = None;
        let outcome = sync_once_with(None, &mut last, list, refresh, push).await;
        assert!(matches!(outcome, SyncOutcome::Idle));
        assert!(last.is_none());
    }

    #[tokio::test]
    async fn test_sync_once_idle_on_docker_error() {
        let list: ListFn = &|| Box::pin(async { Err("docker down".to_string()) });
        let refresh: RefreshFn = &|| panic!("refresh should not be called when listing fails");
        let push: PushFn = &|_id, _json| Box::pin(async { Ok(()) });

        let mut last = Some("x".to_string());
        let outcome = sync_once_with(None, &mut last, list, refresh, push).await;
        assert!(matches!(outcome, SyncOutcome::Idle));
        // last_synced_token should not be cleared on a Docker hiccup.
        assert_eq!(last.as_deref(), Some("x"));
    }

    #[tokio::test]
    async fn test_sync_once_unchanged_skips_push() {
        let list: ListFn = &|| Box::pin(async { Ok(vec!["a".to_string()]) });
        let refresh: RefreshFn = &|| Box::pin(async { Ok(make_creds("same-token")) });
        let pushed = std::sync::atomic::AtomicUsize::new(0);
        let pushed_ref = &pushed;
        let push: PushFn = &|_id, _json| {
            pushed_ref.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        };

        let mut last = Some("same-token".to_string());
        let outcome = sync_once_with(None, &mut last, list, refresh, push).await;
        assert!(matches!(outcome, SyncOutcome::Unchanged));
        assert_eq!(pushed.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn test_sync_once_pushes_when_token_rotates() {
        let list: ListFn = &|| Box::pin(async { Ok(vec!["a".to_string(), "b".to_string()]) });
        let refresh: RefreshFn = &|| Box::pin(async { Ok(make_creds("new-token")) });
        let pushed = std::sync::Mutex::new(Vec::<String>::new());
        let pushed_ref = &pushed;
        let push: PushFn = &|id, _json| {
            pushed_ref.lock().unwrap().push(id);
            Box::pin(async { Ok(()) })
        };

        let mut last = Some("old-token".to_string());
        let outcome = sync_once_with(None, &mut last, list, refresh, push).await;
        assert!(matches!(
            outcome,
            SyncOutcome::Pushed {
                succeeded: 2,
                failed: 0
            }
        ));
        assert_eq!(pushed.lock().unwrap().len(), 2);
        assert_eq!(last.as_deref(), Some("new-token"));
    }

    #[tokio::test]
    async fn test_sync_once_refresh_failure_does_not_advance_token() {
        let list: ListFn = &|| Box::pin(async { Ok(vec!["a".to_string()]) });
        let refresh: RefreshFn =
            &|| Box::pin(async { Err(CredentialsError::RefreshFailed("boom".to_string())) });
        let push: PushFn = &|_id, _json| panic!("push should not run on refresh failure");

        let mut last = Some("old".to_string());
        let outcome = sync_once_with(None, &mut last, list, refresh, push).await;
        match outcome {
            SyncOutcome::RefreshFailed(CredentialsError::RefreshFailed(msg)) => {
                assert!(msg.contains("boom"));
            }
            other => panic!("expected RefreshFailed, got {:?}", other),
        }
        assert_eq!(last.as_deref(), Some("old"));
    }

    #[tokio::test]
    async fn test_sync_once_partial_push_failure_retries_next_tick() {
        let list: ListFn = &|| Box::pin(async { Ok(vec!["aaaa".to_string(), "bbbb".to_string()]) });
        let refresh: RefreshFn = &|| Box::pin(async { Ok(make_creds("new-token")) });
        let push: PushFn = &|id, _json| {
            Box::pin(async move {
                if id == "aaaa" {
                    Err("boom".to_string())
                } else {
                    Ok(())
                }
            })
        };

        let mut last = Some("old".to_string());
        let outcome = sync_once_with(None, &mut last, list, refresh, push).await;
        assert!(matches!(
            outcome,
            SyncOutcome::Pushed {
                succeeded: 1,
                failed: 1
            }
        ));
        // Because one push failed, we should NOT record the new token, so the
        // next tick retries.
        assert_eq!(last.as_deref(), Some("old"));
    }
}
