/**
 * Valid answers of the `environments` commands, for suites that mock `invoke`
 * and assert only what was sent (plan item 7003). The domain client decodes
 * every result with its command's schema, so a mock answering `undefined`
 * where the command answers an environment now fails the call.
 * `environments-results.test.ts` checks every answer here decodes.
 */
import type { ClientEnvironment } from "@orkestrator/protocol/contract/domains/environments";

/** A stopped containerized environment with every required field. */
export function clientEnvironmentFixture(
  overrides: Partial<ClientEnvironment> = {},
): ClientEnvironment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "environment",
    branch: "environment",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

const LIMITS = { cpus: null, memoryMiB: null, pids: null };

const NETWORK_POLICY = {
  environmentId: "env-1",
  configured: { mode: "restricted", domains: 0, domainsRevision: "r" },
  policyVersion: null,
  domains: null,
  effective: null,
};

const RESOURCE_POLICY = {
  environmentId: "env-1",
  requested: LIMITS,
  source: "none",
  applied: null,
  unsupported: [],
};

/**
 * An answer `command`'s result schema accepts, or `undefined` for a command
 * outside the `environments` domain (and for the ones answering nothing).
 */
export function environmentsResultFixture(command: string): unknown {
  const environment = clientEnvironmentFixture();
  switch (command) {
    case "create_environment":
    case "ensure_project_home_environment":
    case "fork_environment":
    case "move_environment":
    case "rename_environment":
    case "sync_environment_status":
    case "set_environment_pr":
    case "override_environment_setup":
    case "approve_environment_setup":
    case "run_environment_setup":
    case "update_port_mappings":
    case "update_environment_agent_settings":
    case "set_environment_pending_agent_launch":
    case "acknowledge_startup_agent_session":
    case "set_environment_initial_prompt":
    case "update_environment_allowed_domains":
      return environment;
    case "start_environment":
    case "ensure_environment_setup":
      return { setupStarted: false, environment };
    case "get_environments":
    case "get_environment_snapshots":
    case "reorder_environments":
    case "sync_all_environments_with_docker":
    case "get_environment_extensions":
      return [];
    case "get_environment_snapshot":
    case "get_environment":
    case "get_claude_terminal_state":
    case "await_environment_setup_session":
    case "get_environment_pr_url":
      return null;
    case "get_environment_pr_health":
      return {};
    case "get_log_directory":
      return "/logs";
    case "get_log_storage_stats":
    case "cleanup_logs":
      return { totalBytes: 0, fileCount: 0, essentialBytes: 0, essentialFileCount: 0 };
    case "add_environment_domains":
    case "remove_environment_domains":
      return "";
    case "get_environment_status":
      return "stopped";
    case "reconcile_pending_environment_renames":
      return { pending: 0 };
    case "get_container_lifecycle_snapshot":
      return {
        revision: 0,
        supported: true,
        runtimeGeneration: null,
        imageId: null,
        storageFormat: "legacy-layer",
        workspaceGeneration: 1,
        operation: null,
        lastOutcome: null,
        bootPhase: null,
      };
    case "get_rebuild_preview":
      return {
        environmentId: "env-1",
        containerId: null,
        available: false,
        unavailableReason: "no-container",
        kind: "rebuild",
        preservedPaths: [],
        notPreserved: [],
        providers: [],
        retainedCopies: 0,
        retainedCopyLimit: 16,
      };
    case "list_recovery_copies":
      return { environmentId: "env-1", revision: 0, copies: [], limit: 16 };
    case "get_environment_resources":
    case "update_environment_resources":
      return RESOURCE_POLICY;
    case "set_container_resource_limits":
      return { limits: null };
    case "get_environment_network_policy":
      return NETWORK_POLICY;
    case "apply_environment_allowed_domains":
      return { kind: "not-running", policy: NETWORK_POLICY };
    case "get_environment_inputs":
      return {
        environmentId: "env-1",
        mode: "none",
        revision: null,
        stagedAt: null,
        providers: [],
        missingProviders: [],
        disabledProviders: [],
        revokedProviders: [],
      };
    case "revoke_provider_credentials":
      return { provider: "claude", removed: false, pendingRebuild: false, processesStopped: false };
    case "restore_provider_credentials":
      return { provider: "claude", pendingRebuild: false };
    case "cancel_container_operation":
      return { cancelled: false };
    case "get_environment_setup_approval":
      return {
        environmentId: "env-1",
        projectId: "project-1",
        hash: "h",
        commands: [],
        defaultBranch: "main",
        defaultBranchCommands: null,
        approvalRequired: false,
      };
    case "approve_project_setup_commands":
      return { approved: true };
    case "teardown_tab":
      return { completed: true };
    case "reconcile_tab_teardowns":
      return { completed: 0 };
    case "reconcile_orphaned_tab_resources":
      return { terminals: 0, nativeSessions: 0, tmuxSessions: 0 };
    default:
      return undefined;
  }
}
