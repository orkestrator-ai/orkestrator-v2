//! Port allocation for local environment servers
//!
//! Allocates unique ports for OpenCode and Claude-bridge servers
//! running in local environments.

use crate::models::Environment;
use std::net::TcpListener;
use tracing::{debug, warn};

/// Port range for local servers (14096-15096)
/// This range is chosen to avoid conflicts with common development ports
const LOCAL_PORT_RANGE_START: u16 = 14096;
const LOCAL_PORT_RANGE_END: u16 = 15096;

/// Result of port allocation
#[derive(Debug, Clone)]
pub struct PortAllocation {
    /// Port for OpenCode server
    pub opencode_port: u16,
    /// Port for Claude-bridge server
    pub claude_port: u16,
    /// Port for Codex bridge server
    pub codex_port: u16,
}

/// Check if a port is available for binding.
///
/// Checks both the loopback and wildcard addresses because on macOS a process
/// bound to `0.0.0.0:port` does not prevent a separate bind to `127.0.0.1:port`,
/// which can lead to two processes listening on the same port and
/// non-deterministic connection routing.
pub fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
        && TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// Get all ports currently in use by local environments
fn get_used_ports(environments: &[Environment]) -> Vec<u16> {
    let mut ports = Vec::new();

    for env in environments {
        if let Some(port) = env.local_opencode_port {
            ports.push(port);
        }
        if let Some(port) = env.local_claude_port {
            ports.push(port);
        }
        if let Some(port) = env.local_codex_port {
            ports.push(port);
        }
    }

    ports
}

/// Allocate two unique ports for a new local environment
///
/// # Arguments
/// * `existing_environments` - List of existing environments to check for port conflicts
///
/// # Returns
/// A `PortAllocation` with two unique available ports
pub fn allocate_ports(existing_environments: &[Environment]) -> Result<PortAllocation, String> {
    let used_ports = get_used_ports(existing_environments);
    debug!(used_ports = ?used_ports, "Checking existing port allocations");

    let mut opencode_port: Option<u16> = None;
    let mut claude_port: Option<u16> = None;
    let mut codex_port: Option<u16> = None;

    for port in LOCAL_PORT_RANGE_START..=LOCAL_PORT_RANGE_END {
        // Skip if already in use by another environment
        if used_ports.contains(&port) {
            continue;
        }

        // Skip if port is not actually available (bound by another process)
        if !is_port_available(port) {
            continue;
        }

        // Allocate ports in order
        if opencode_port.is_none() {
            opencode_port = Some(port);
            debug!(port = port, "Allocated OpenCode port");
        } else if claude_port.is_none() {
            claude_port = Some(port);
            debug!(port = port, "Allocated Claude-bridge port");
        } else if codex_port.is_none() {
            codex_port = Some(port);
            debug!(port = port, "Allocated Codex bridge port");
            break;
        }
    }

    match (opencode_port, claude_port, codex_port) {
        (Some(oport), Some(cport), Some(xport)) => Ok(PortAllocation {
            opencode_port: oport,
            claude_port: cport,
            codex_port: xport,
        }),
        _ => {
            warn!(
                "Failed to allocate ports in range {}-{}",
                LOCAL_PORT_RANGE_START, LOCAL_PORT_RANGE_END
            );
            Err(format!(
                "No available ports in range {}-{}",
                LOCAL_PORT_RANGE_START, LOCAL_PORT_RANGE_END
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_port_available() {
        // This test might be flaky depending on what ports are in use
        // but generally high ports should be available
        let port = 59999;
        // Just check that the function doesn't panic
        let _ = is_port_available(port);
    }

    #[test]
    fn test_is_port_available_detects_loopback_bind() {
        // Bind on 127.0.0.1 and verify the port is reported as unavailable
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_port_available(port));
    }

    #[test]
    fn test_is_port_available_detects_wildcard_bind() {
        // Bind on 0.0.0.0 (wildcard) and verify the port is reported as unavailable.
        // Before the fix, is_port_available only checked 127.0.0.1 and would
        // miss wildcard binds, causing port collisions with stale processes.
        let listener = TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!is_port_available(port));
    }

    #[test]
    fn test_allocate_ports_empty() {
        let result = allocate_ports(&[]);
        assert!(result.is_ok());
        let allocation = result.unwrap();
        assert!(allocation.opencode_port >= LOCAL_PORT_RANGE_START);
        assert!(allocation.claude_port >= LOCAL_PORT_RANGE_START);
        assert!(allocation.codex_port >= LOCAL_PORT_RANGE_START);
        assert_ne!(allocation.opencode_port, allocation.claude_port);
        assert_ne!(allocation.opencode_port, allocation.codex_port);
        assert_ne!(allocation.claude_port, allocation.codex_port);
    }
}
