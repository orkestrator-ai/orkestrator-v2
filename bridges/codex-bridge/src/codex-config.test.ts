import { afterEach, describe, expect, test } from "bun:test";
import {
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  MAX_CODEX_CONCURRENT_THREADS,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  codexAppServerConfigOverrides,
  resolveCodexMaxConcurrentThreads,
} from "./codex-config.js";

/** A fully configured coordinator launch: the only shape that hardens Codex. */
const COORDINATOR_ENV = {
  CODEX_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
  CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-conversation-1",
  CODEX_BRIDGE_READABLE_RUNTIME_ROOT: "/opt/orkestrator/codex",
  CWD: "/projects/example",
} as const;

const originalConfiguredLimit = process.env[CODEX_MAX_CONCURRENT_THREADS_ENV];
const originalAgentMcpUrl = process.env[ORKESTRATOR_AGENT_MCP_URL_ENV];
const originalAgentMcpToken = process.env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV];

afterEach(() => {
  if (originalConfiguredLimit === undefined) {
    delete process.env[CODEX_MAX_CONCURRENT_THREADS_ENV];
  } else {
    process.env[CODEX_MAX_CONCURRENT_THREADS_ENV] = originalConfiguredLimit;
  }
  if (originalAgentMcpUrl === undefined) {
    delete process.env[ORKESTRATOR_AGENT_MCP_URL_ENV];
  } else {
    process.env[ORKESTRATOR_AGENT_MCP_URL_ENV] = originalAgentMcpUrl;
  }
  if (originalAgentMcpToken === undefined) {
    delete process.env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV];
  } else {
    process.env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV] = originalAgentMcpToken;
  }
});

describe("Codex app-server configuration", () => {
  test("defaults the concurrent spawned-thread limit to five", () => {
    expect(resolveCodexMaxConcurrentThreads(undefined)).toBe(5);
    expect(codexAppServerConfigOverrides({})).toEqual({
      "features.mcp_2026_07_28": "true",
      "agents.max_concurrent_threads_per_session": "5",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "6",
    });
  });

  test("makes the child limit authoritative in legacy and root-inclusive V2 config", () => {
    expect(
      codexAppServerConfigOverrides({
        [CODEX_MAX_CONCURRENT_THREADS_ENV]: "8",
      }),
    ).toEqual({
      "features.mcp_2026_07_28": "true",
      "agents.max_concurrent_threads_per_session": "8",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "9",
    });
  });

  test("uses process.env when no explicit environment is supplied", () => {
    process.env[CODEX_MAX_CONCURRENT_THREADS_ENV] = " 12 ";

    expect(codexAppServerConfigOverrides()).toMatchObject({
      "agents.max_concurrent_threads_per_session": "12",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "13",
    });
  });

  test("injects the scoped agent MCP server without putting its token in argv", () => {
    const overrides = codexAppServerConfigOverrides({
      [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://host.docker.internal:4567/mcp",
      [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
    });

    expect(overrides).toMatchObject({
      "mcp_servers.orkestrator.url": '"http://host.docker.internal:4567/mcp"',
      "mcp_servers.orkestrator.bearer_token_env_var": `"${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}"`,
      "mcp_servers.orkestrator.required": "false",
      "mcp_servers.orkestrator.startup_timeout_sec": "3",
    });
    expect(overrides["mcp_servers.orkestrator.default_tools_approval_mode"]).toBeUndefined();
    expect(JSON.stringify(overrides)).not.toContain("project-secret");
  });

  // Codex refuses an MCP tool that is not annotated read-only when the thread
  // runs `approvalPolicy: "never"` without full disk write, which is exactly a
  // coordinator. Losing this key does not degrade delegation, it removes it:
  // `launch_environment` fails before the backend ever sees the request.
  test("keeps mutating control tools dispatchable under a read-only coordinator", () => {
    const overrides = codexAppServerConfigOverrides({
      ...COORDINATOR_ENV,
      [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://127.0.0.1:4567/mcp",
      [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
    });

    expect(overrides["mcp_servers.orkestrator.default_tools_approval_mode"]).toBe('"approve"');
    // Approving the backend's control surface must not have relaxed the
    // enforcement that makes the checkout itself read-only.
    expect(overrides["permissions.coordinator-conversation-1.network.enabled"]).toBe("false");
    expect(overrides["permissions.coordinator-conversation-1.filesystem"]).not.toContain('"write"');
  });

  test("keeps coordinator credentials out of model-created execution environments", () => {
    const overrides = codexAppServerConfigOverrides({
      CODEX_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-conversation-1",
      CODEX_BRIDGE_READABLE_RUNTIME_ROOT: "/opt/orkestrator/codex",
      CWD: "/projects/example",
      [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://127.0.0.1:4567/mcp",
      [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
    });

    expect(overrides).toMatchObject({
      default_permissions: '"coordinator-conversation-1"',
      "permissions.coordinator-conversation-1.network.enabled": "false",
      'projects."/projects/example".trust_level': '"untrusted"',
      "features.apps": "false",
      "features.hooks": "false",
      "features.plugins": "false",
      "features.workspace_dependencies": "false",
      "shell_environment_policy.inherit": '"core"',
      "shell_environment_policy.ignore_default_excludes": "false",
    });
    expect(JSON.parse(overrides["shell_environment_policy.exclude"]!)).toEqual(
      expect.arrayContaining([
        "*_TOKEN",
        "CODEX_HOME",
        "CODEX_BRIDGE_TOKEN",
        "CODEX_BRIDGE_PERMISSION_PROFILE",
        "CODEX_BRIDGE_READABLE_RUNTIME_ROOT",
        ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
      ]),
    );
    expect(overrides["permissions.coordinator-conversation-1.filesystem"]).toContain(
      '":root" = "deny"',
    );
    expect(overrides["permissions.coordinator-conversation-1.filesystem"]).toContain(
      '"/opt/orkestrator/codex" = "read"',
    );
    expect(JSON.stringify(overrides)).not.toContain("project-secret");
  });

  test("leaves the code-mode host enabled so coordinator tool calls can dispatch", () => {
    const overrides = codexAppServerConfigOverrides(COORDINATOR_ENV);

    // Every catalogued model is `tool_mode = "code_mode_only"`, so disabling the
    // host fails every tool call with "code-mode host is disabled" rather than
    // narrowing the coordinator to inspection. Read-only enforcement is the
    // permission profile's job.
    expect(overrides["features.code_mode_host"]).toBeUndefined();
    expect(overrides["permissions.coordinator-conversation-1.network.enabled"]).toBe("false");
    expect(overrides["permissions.coordinator-conversation-1.filesystem"]).toContain(
      '":workspace_roots" = { "." = "read" }',
    );
  });

  // The code-mode host executes model-authored TypeScript in its own process and
  // delegates every tool call back to `codex_core::tools::router`, so these
  // overrides — not the host toggle — are the coordinator's whole security
  // boundary. Enabling code mode was only safe because they hold, and the
  // coordinator runs on the host machine rather than behind a container, so
  // nothing catches it if one is dropped. Pin them together: any change that
  // leaves the host enabled while weakening one of them must fail here.
  test("cannot enable code mode without the full read-only enforcement set", () => {
    const overrides = codexAppServerConfigOverrides(COORDINATOR_ENV);
    const filesystem = overrides["permissions.coordinator-conversation-1.filesystem"]!;

    expect(overrides["features.code_mode_host"]).toBeUndefined();

    // 1. Tool calls resolve under the coordinator's profile, not Codex defaults.
    expect(overrides.default_permissions).toBe('"coordinator-conversation-1"');
    // 2. Read-only, deny-by-default, and no write grant anywhere in the profile.
    expect(filesystem).toContain('":root" = "deny"');
    expect(filesystem).toContain('":tmpdir" = "deny"');
    expect(filesystem).toContain('":slash_tmp" = "deny"');
    expect(filesystem).toContain('":workspace_roots" = { "." = "read" }');
    expect(filesystem).not.toContain('"write"');
    // 3. No network egress from delegated tool calls.
    expect(overrides["permissions.coordinator-conversation-1.network.enabled"]).toBe("false");
    // 4. The checkout stays data, so repository-local config/hooks cannot run.
    expect(overrides['projects."/projects/example".trust_level']).toBe('"untrusted"');
    // 5. Credentials are excluded from model-created execution environments.
    expect(overrides["shell_environment_policy.inherit"]).toBe('"core"');
    expect(overrides["shell_environment_policy.ignore_default_excludes"]).toBe("false");
    expect(JSON.parse(overrides["shell_environment_policy.exclude"]!)).toEqual(
      expect.arrayContaining(["*_KEY", "*_SECRET", "*_TOKEN", ORKESTRATOR_AGENT_MCP_TOKEN_ENV]),
    );
  });

  // `code_mode_host` was removed from this list on purpose. Removing any other
  // entry re-opens a capability — browser control, plugins, hooks — that the
  // code-mode host can now reach through a delegated tool call.
  test("keeps every other risky feature disabled for a coordinator", () => {
    const overrides = codexAppServerConfigOverrides(COORDINATOR_ENV);

    for (const feature of [
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "hooks",
      "image_generation",
      "in_app_browser",
      "plugin_sharing",
      "plugins",
      "remote_plugin",
      "skill_mcp_dependency_install",
      "tool_call_mcp_elicitation",
      "tool_suggest",
      "workspace_dependencies",
    ]) {
      expect(overrides[`features.${feature}`]).toBe("false");
    }
  });

  test("applies none of the coordinator hardening outside the coordinator policy", () => {
    const overrides = codexAppServerConfigOverrides({ CWD: "/projects/example" });

    // A normal environment is isolated by its container, configures no
    // permission profile, and must not inherit a half-applied coordinator
    // boundary that would read as enforcement without being it.
    expect(overrides.default_permissions).toBeUndefined();
    expect(overrides["shell_environment_policy.exclude"]).toBeUndefined();
    expect(overrides['projects."/projects/example".trust_level']).toBeUndefined();
    expect(Object.keys(overrides).filter((key) => key.startsWith("permissions."))).toEqual([]);
  });

  test("rejects incomplete coordinator permission-profile authority", () => {
    expect(() =>
      codexAppServerConfigOverrides({
        CODEX_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      }),
    ).toThrow("permission profile configuration is invalid");
  });

  test("accepts both loopback host spellings for local agent tools", () => {
    for (const hostname of ["127.0.0.1", "localhost"]) {
      const overrides = codexAppServerConfigOverrides({
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: `http://${hostname}:4567/mcp`,
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      });
      expect(overrides["mcp_servers.orkestrator.url"]).toBe(`"http://${hostname}:4567/mcp"`);
      expect(overrides["mcp_servers.orkestrator.bearer_token_env_var"]).toBe(
        `"${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}"`,
      );
    }
  });

  test("ignores missing, malformed, remote, or otherwise untrusted endpoints", () => {
    for (const env of [
      {},
      { [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://127.0.0.1:4567/mcp" },
      { [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret" },
      {
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: "not a URL",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
      {
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: "https://127.0.0.1:4567/mcp",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
      {
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://attacker.example/mcp",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
      {
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://127.0.0.1:4567/wrong",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
      {
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://user@127.0.0.1:4567/mcp",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
      {
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://user:password@127.0.0.1:4567/mcp",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
    ]) {
      const overrides = codexAppServerConfigOverrides(env);
      expect(overrides["mcp_servers.orkestrator.url"]).toBeUndefined();
      expect(overrides["mcp_servers.orkestrator.bearer_token_env_var"]).toBeUndefined();
    }
  });

  test("uses process.env when agent credentials are already installed", () => {
    process.env[ORKESTRATOR_AGENT_MCP_URL_ENV] = "http://127.0.0.1:4567/mcp";
    process.env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV] = "project-secret";

    const overrides = codexAppServerConfigOverrides();

    expect(overrides["mcp_servers.orkestrator.url"]).toBe('"http://127.0.0.1:4567/mcp"');
    expect(overrides["mcp_servers.orkestrator.bearer_token_env_var"]).toBe(
      `"${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}"`,
    );
    expect(JSON.stringify(overrides)).not.toContain("project-secret");
  });

  test("emits authoritative overrides for the reserved server name", () => {
    const overrides = codexAppServerConfigOverrides({
      [ORKESTRATOR_AGENT_MCP_URL_ENV]: "http://127.0.0.1:4567/mcp",
      [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
    });

    // CLI `-c` values take precedence over config.toml, so always targeting
    // this reserved key prevents a user-configured collision from redirecting
    // the backend-provided ticket connection.
    expect(Object.keys(overrides).filter((key) => key.startsWith("mcp_servers."))).toEqual([
      "mcp_servers.orkestrator.url",
      "mcp_servers.orkestrator.bearer_token_env_var",
      "mcp_servers.orkestrator.required",
      "mcp_servers.orkestrator.startup_timeout_sec",
    ]);
  });

  test("accepts whitespace and the largest safely convertible child limit", () => {
    expect(resolveCodexMaxConcurrentThreads(" \t7\n")).toBe(7);
    expect(resolveCodexMaxConcurrentThreads(String(MAX_CODEX_CONCURRENT_THREADS))).toBe(
      MAX_CODEX_CONCURRENT_THREADS,
    );
    expect(
      codexAppServerConfigOverrides({
        [CODEX_MAX_CONCURRENT_THREADS_ENV]: String(MAX_CODEX_CONCURRENT_THREADS),
      }),
    ).toMatchObject({
      "agents.max_concurrent_threads_per_session": String(MAX_CODEX_CONCURRENT_THREADS),
      "features.multi_agent_v2.max_concurrent_threads_per_session": String(Number.MAX_SAFE_INTEGER),
    });
  });

  test("falls back for values Codex would reject", () => {
    for (const value of [
      "",
      "   ",
      "0",
      "-1",
      "2.5",
      "many",
      "Infinity",
      String(Number.MAX_SAFE_INTEGER),
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(resolveCodexMaxConcurrentThreads(value)).toBe(DEFAULT_CODEX_MAX_CONCURRENT_THREADS);
    }
  });
});
