// Claude Code credentials management
// Reads OAuth tokens from macOS Keychain using the security CLI,
// refreshes them when expired, and writes updated tokens back.

pub mod sync;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use tracing::{debug, error, warn};

/// Claude Code OAuth client ID (override via `CLAUDE_CODE_OAUTH_CLIENT_ID`).
const DEFAULT_CLIENT_ID: &str = "22422756-60c9-4084-8eb7-27705fd5cf9a";
/// Claude Code OAuth token endpoint (override via `CLAUDE_CODE_OAUTH_TOKEN_URL`).
const DEFAULT_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const DEFAULT_SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];
/// Refresh the token if it expires within this window (ms).
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

/// Serializes the read-refresh-write critical section across the process so
/// concurrent callers can't both spend the same single-use refresh token.
static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Error, Debug)]
pub enum CredentialsError {
    #[error("Keychain access error: {0}")]
    KeychainError(String),
    #[error("Credentials not found")]
    NotFound,
    #[error("Failed to parse credentials: {0}")]
    ParseError(String),
    #[error("Token refresh failed: {0}")]
    RefreshFailed(String),
    #[allow(dead_code)]
    #[error("Platform not supported")]
    UnsupportedPlatform,
}

/// OAuth credentials for Claude Code
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeOAuthCredentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub scopes: Vec<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

/// Full credentials structure from keychain
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCredentials {
    pub claude_ai_oauth: ClaudeOAuthCredentials,
}

fn client_id() -> String {
    std::env::var("CLAUDE_CODE_OAUTH_CLIENT_ID").unwrap_or_else(|_| DEFAULT_CLIENT_ID.to_string())
}

fn token_url() -> String {
    std::env::var("CLAUDE_CODE_OAUTH_TOKEN_URL").unwrap_or_else(|_| DEFAULT_TOKEN_URL.to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read Claude Code credentials from the system keychain.
///
/// Uses the macOS `security` CLI tool instead of the `security-framework` crate.
/// This is a deliberate tradeoff: the CLI is slightly slower (spawns a subprocess)
/// but doesn't require knowing the account name - only the service name is needed.
#[cfg(target_os = "macos")]
pub fn get_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .map_err(|e| {
            CredentialsError::KeychainError(format!("Failed to run security command: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("could not be found") || stderr.contains("SecKeychainSearchCopyNext") {
            return Err(CredentialsError::NotFound);
        }
        return Err(CredentialsError::KeychainError(format!(
            "security command failed: {}",
            stderr
        )));
    }

    let json_str = String::from_utf8(output.stdout)
        .map_err(|e| CredentialsError::ParseError(format!("Invalid UTF-8 in credentials: {}", e)))?
        .trim()
        .to_string();

    if json_str.is_empty() {
        return Err(CredentialsError::NotFound);
    }

    let credentials: ClaudeCredentials = serde_json::from_str(&json_str).map_err(|e| {
        CredentialsError::ParseError(format!("Failed to parse credentials JSON: {}", e))
    })?;

    Ok(credentials)
}

#[cfg(not(target_os = "macos"))]
pub fn get_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    Err(CredentialsError::UnsupportedPlatform)
}

/// Parse the account ("acct") attribute from `security find-generic-password`
/// output. `security` emits the value either as a quoted string
/// (`"acct"<blob>="me@example.com"`) or, when non-UTF8 or containing control
/// chars, as a hex blob (`"acct"<blob>=0x6D65...`). Both forms are handled.
fn parse_account_from_security_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        let rest = match trimmed.strip_prefix("\"acct\"<blob>=") {
            Some(r) => r,
            None => continue,
        };

        // Hex form: 0x<hex>  (may be followed by a quoted string copy — ignore it)
        if let Some(hex_part) = rest.strip_prefix("0x") {
            let hex_only: String = hex_part
                .chars()
                .take_while(|c| c.is_ascii_hexdigit())
                .collect();
            if !hex_only.is_empty() && hex_only.len() % 2 == 0 {
                if let Ok(bytes) = hex::decode(&hex_only) {
                    if let Ok(s) = String::from_utf8(bytes) {
                        return Some(s);
                    }
                }
            }
            return None;
        }

        // Quoted form: "value" — handle simple backslash escapes defensively.
        if let Some(inner) = rest.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            return Some(unescape_security_quoted(inner));
        }
    }
    None
}

fn unescape_security_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Look up the account ("acct") attribute for the Claude Code credentials entry.
/// Needed to update the entry in place via `security add-generic-password -U`.
#[cfg(target_os = "macos")]
fn get_claude_credentials_account() -> Result<String, CredentialsError> {
    use std::process::Command;

    let output = Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE])
        .output()
        .map_err(|e| {
            CredentialsError::KeychainError(format!("Failed to run security command: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("could not be found") {
            return Err(CredentialsError::NotFound);
        }
        return Err(CredentialsError::KeychainError(format!(
            "security command failed: {}",
            stderr
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_account_from_security_output(&stdout).ok_or_else(|| {
        CredentialsError::KeychainError(
            "Could not parse account name from keychain entry".to_string(),
        )
    })
}

/// Write credentials back to the macOS keychain, overwriting any existing entry.
///
/// Known limitation: the credentials JSON is passed as a `-w` argument to the
/// `security` CLI, which makes it briefly visible in `ps(1)` output to other
/// local users during the call. macOS's `security` CLI doesn't support reading
/// the password from stdin for `add-generic-password`, so this matches the
/// exposure of Claude Code's own CLI. The `security-framework` crate would
/// avoid the argv leak but can't locate the entry by service name alone (see
/// note in `Cargo.toml`).
#[cfg(target_os = "macos")]
fn write_claude_credentials(credentials: &ClaudeCredentials) -> Result<(), CredentialsError> {
    use std::process::Command;

    let account = get_claude_credentials_account()?;
    let json = serde_json::to_string(credentials).map_err(|e| {
        CredentialsError::ParseError(format!("Failed to serialize credentials: {}", e))
    })?;

    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            &account,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            &json,
        ])
        .output()
        .map_err(|e| {
            CredentialsError::KeychainError(format!("Failed to run security command: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CredentialsError::KeychainError(format!(
            "Failed to update keychain entry: {}",
            stderr
        )));
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write_claude_credentials(_credentials: &ClaudeCredentials) -> Result<(), CredentialsError> {
    Err(CredentialsError::UnsupportedPlatform)
}

#[derive(Debug, Deserialize)]
struct RefreshTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
    #[serde(default)]
    scope: Option<String>,
}

/// POST to the Claude OAuth token endpoint to refresh the access token.
/// Returns updated credentials with preserved subscription/rate-limit metadata.
pub async fn refresh_credentials(
    existing: &ClaudeOAuthCredentials,
) -> Result<ClaudeOAuthCredentials, CredentialsError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| CredentialsError::RefreshFailed(format!("Client build failed: {}", e)))?;
    refresh_credentials_with(&client, &token_url(), existing).await
}

/// Testable inner refresh: takes an explicit client and URL so tests can
/// target a mock HTTP server without touching real Claude infrastructure.
async fn refresh_credentials_with(
    client: &reqwest::Client,
    url: &str,
    existing: &ClaudeOAuthCredentials,
) -> Result<ClaudeOAuthCredentials, CredentialsError> {
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": existing.refresh_token,
        "client_id": client_id(),
        "scope": DEFAULT_SCOPES.join(" "),
    });

    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| CredentialsError::RefreshFailed(format!("Request failed: {}", e)))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(CredentialsError::RefreshFailed(format!(
            "HTTP {}: {}",
            status, text
        )));
    }

    let parsed: RefreshTokenResponse = response.json().await.map_err(|e| {
        CredentialsError::RefreshFailed(format!("Failed to parse refresh response: {}", e))
    })?;

    let scopes = parsed
        .scope
        .map(|s| s.split_whitespace().map(String::from).collect())
        .unwrap_or_else(|| existing.scopes.clone());

    Ok(ClaudeOAuthCredentials {
        access_token: parsed.access_token,
        refresh_token: parsed
            .refresh_token
            .unwrap_or_else(|| existing.refresh_token.clone()),
        expires_at: now_ms() + parsed.expires_in * 1000,
        scopes,
        subscription_type: existing.subscription_type.clone(),
        rate_limit_tier: existing.rate_limit_tier.clone(),
    })
}

/// Pure decision helper: given current expiry and "now", should we refresh?
fn should_refresh(expires_at_ms: i64, now_ms: i64) -> bool {
    expires_at_ms - now_ms <= REFRESH_SKEW_MS
}

/// Read credentials from keychain and refresh if within the expiry skew window.
///
/// On successful refresh, persists the new credentials back to the keychain so
/// the host's `claude` CLI and container injections stay in sync. A single
/// process-wide mutex serializes refresh attempts so two concurrent callers
/// can't both spend the same single-use refresh token.
///
/// If the refresh succeeds but the keychain write fails (even on retry), this
/// returns an error rather than silently handing back tokens that have been
/// rotated in the OAuth server but not persisted locally — persisting the
/// rotated refresh token is required for the *next* refresh to succeed.
pub async fn get_or_refresh_claude_credentials() -> Result<ClaudeCredentials, CredentialsError> {
    // Fast path: if current creds are comfortably fresh, skip the lock.
    let current = get_claude_credentials()?;
    if !should_refresh(current.claude_ai_oauth.expires_at, now_ms()) {
        return Ok(current);
    }

    let _guard = REFRESH_LOCK.lock().await;

    // Re-read after acquiring the lock: another task may have already
    // refreshed while we were waiting.
    let current = get_claude_credentials()?;
    if !should_refresh(current.claude_ai_oauth.expires_at, now_ms()) {
        return Ok(current);
    }

    debug!(
        remaining_ms = current.claude_ai_oauth.expires_at - now_ms(),
        "Claude credentials near/past expiry, attempting refresh"
    );

    let refreshed = refresh_credentials(&current.claude_ai_oauth)
        .await
        .inspect_err(|e| warn!(error = ?e, "Failed to refresh Claude credentials"))?;
    let updated = ClaudeCredentials {
        claude_ai_oauth: refreshed,
    };

    // Persist rotated refresh token. Retry once on transient keychain errors
    // (e.g. a locked keychain that the user just unlocked).
    let persisted = match write_claude_credentials(&updated) {
        Ok(()) => Ok(()),
        Err(first) => {
            warn!(error = ?first, "Keychain write failed after refresh; retrying once");
            write_claude_credentials(&updated)
        }
    };

    if let Err(e) = persisted {
        // The OAuth server has rotated the refresh token, but we failed to
        // persist it. Escalate loudly: next refresh attempt will fail with
        // `invalid_grant` until the user re-runs `claude login`.
        error!(
            error = ?e,
            "Refreshed Claude OAuth token but failed to persist rotated refresh token to keychain. \
             Next refresh will fail until the user re-authenticates."
        );
        return Err(CredentialsError::KeychainError(format!(
            "Refreshed OAuth tokens but could not persist rotated refresh token to keychain: {}. \
             Re-authenticate with `claude login` to recover.",
            e
        )));
    }

    debug!("Refreshed Claude credentials and updated keychain");
    Ok(updated)
}

/// Check if Claude credentials are available
#[allow(dead_code)]
pub fn has_claude_credentials() -> bool {
    get_claude_credentials().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_creds() -> ClaudeOAuthCredentials {
        ClaudeOAuthCredentials {
            access_token: "old-access".to_string(),
            refresh_token: "old-refresh".to_string(),
            expires_at: 0,
            scopes: vec!["user:inference".to_string()],
            subscription_type: Some("max".to_string()),
            rate_limit_tier: Some("high".to_string()),
        }
    }

    #[test]
    fn test_credentials_parsing() {
        let json = r#"{"claudeAiOauth":{"accessToken":"sk-test","refreshToken":"sk-refresh","expiresAt":1234567890,"scopes":["user:inference"],"subscriptionType":null,"rateLimitTier":null}}"#;
        let creds: ClaudeCredentials = serde_json::from_str(json).unwrap();
        assert_eq!(creds.claude_ai_oauth.access_token, "sk-test");
        assert_eq!(creds.claude_ai_oauth.scopes, vec!["user:inference"]);
    }

    #[test]
    fn test_credentials_roundtrip_preserves_fields() {
        let json = r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r","expiresAt":1,"scopes":["s"],"subscriptionType":"max","rateLimitTier":"high"}}"#;
        let creds: ClaudeCredentials = serde_json::from_str(json).unwrap();
        let serialized = serde_json::to_string(&creds).unwrap();
        let reparsed: ClaudeCredentials = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            reparsed.claude_ai_oauth.subscription_type.as_deref(),
            Some("max")
        );
        assert_eq!(
            reparsed.claude_ai_oauth.rate_limit_tier.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn test_should_refresh_skew() {
        let now = 1_000_000_000i64;
        assert!(should_refresh(now, now), "expired should refresh");
        assert!(
            should_refresh(now + REFRESH_SKEW_MS - 1, now),
            "inside skew window should refresh"
        );
        assert!(
            !should_refresh(now + REFRESH_SKEW_MS + 1, now),
            "outside skew window should not refresh"
        );
        assert!(
            should_refresh(now - 10_000, now),
            "already expired should refresh"
        );
    }

    #[test]
    fn test_parse_account_quoted_form() {
        let stdout = r#"keychain: "/Users/me/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials"
    "acct"<blob>="me@example.com"
    "svce"<blob>="Claude Code-credentials"
"#;
        assert_eq!(
            parse_account_from_security_output(stdout).as_deref(),
            Some("me@example.com")
        );
    }

    #[test]
    fn test_parse_account_hex_form() {
        // 0x6D6540626C6F622E636F6D = "me@blob.com"
        let stdout = r#"attributes:
    "acct"<blob>=0x6D6540626C6F622E636F6D
"#;
        assert_eq!(
            parse_account_from_security_output(stdout).as_deref(),
            Some("me@blob.com")
        );
    }

    #[test]
    fn test_parse_account_hex_with_trailing_quoted_copy() {
        // `security` sometimes prints both forms: `=0x...  "value"`.
        let stdout = "    \"acct\"<blob>=0x6D6540626C6F622E636F6D  \"me@blob.com\"\n";
        assert_eq!(
            parse_account_from_security_output(stdout).as_deref(),
            Some("me@blob.com")
        );
    }

    #[test]
    fn test_parse_account_with_escaped_quote() {
        let stdout = "    \"acct\"<blob>=\"weird\\\"name\"\n";
        assert_eq!(
            parse_account_from_security_output(stdout).as_deref(),
            Some("weird\"name")
        );
    }

    #[test]
    fn test_parse_account_missing() {
        let stdout = "class: \"genp\"\n";
        assert!(parse_account_from_security_output(stdout).is_none());
    }

    #[tokio::test]
    async fn test_refresh_credentials_happy_path() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/v1/oauth/token"))
            .and(wiremock::matchers::header(
                "content-type",
                "application/json",
            ))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "access_token": "new-access",
                    "refresh_token": "new-refresh",
                    "expires_in": 3600,
                    "scope": "user:profile user:inference"
                })),
            )
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let existing = sample_creds();
        let before = now_ms();
        let refreshed = refresh_credentials_with(
            &client,
            &format!("{}/v1/oauth/token", server.uri()),
            &existing,
        )
        .await
        .expect("refresh should succeed");

        assert_eq!(refreshed.access_token, "new-access");
        assert_eq!(refreshed.refresh_token, "new-refresh");
        assert_eq!(
            refreshed.scopes,
            vec!["user:profile".to_string(), "user:inference".to_string()]
        );
        // Subscription metadata preserved from existing creds.
        assert_eq!(refreshed.subscription_type.as_deref(), Some("max"));
        assert_eq!(refreshed.rate_limit_tier.as_deref(), Some("high"));
        assert!(refreshed.expires_at >= before + 3600 * 1000);
    }

    #[tokio::test]
    async fn test_refresh_credentials_preserves_refresh_token_when_server_omits() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "access_token": "new-access",
                    "expires_in": 60
                })),
            )
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let existing = sample_creds();
        let refreshed =
            refresh_credentials_with(&client, &format!("{}/token", server.uri()), &existing)
                .await
                .expect("refresh should succeed");

        // When the server doesn't rotate the refresh token, keep the existing one.
        assert_eq!(refreshed.refresh_token, "old-refresh");
        // When the server omits scope, keep existing scopes.
        assert_eq!(refreshed.scopes, existing.scopes);
    }

    #[tokio::test]
    async fn test_refresh_credentials_http_error_bubbles_up() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(
                wiremock::ResponseTemplate::new(400)
                    .set_body_string("{\"error\":\"invalid_grant\"}"),
            )
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let err =
            refresh_credentials_with(&client, &format!("{}/token", server.uri()), &sample_creds())
                .await
                .expect_err("400 should produce RefreshFailed");
        match err {
            CredentialsError::RefreshFailed(msg) => {
                assert!(
                    msg.contains("400"),
                    "message should mention status: {}",
                    msg
                );
                assert!(
                    msg.contains("invalid_grant"),
                    "message should include server body: {}",
                    msg
                );
            }
            other => panic!("unexpected error variant: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_refresh_credentials_malformed_response() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let err =
            refresh_credentials_with(&client, &format!("{}/token", server.uri()), &sample_creds())
                .await
                .expect_err("malformed body should produce RefreshFailed");
        assert!(matches!(err, CredentialsError::RefreshFailed(_)));
    }
}
