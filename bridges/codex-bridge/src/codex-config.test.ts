import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COORDINATOR_CODEX_USER_SKILLS_DIR_ENV } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  BRIDGE_ATTACHMENT_ROOT_ENV,
  CODEX_MAX_CONCURRENT_THREADS_ENV,
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  MAX_CODEX_CONCURRENT_THREADS,
  MAX_CODEX_DISABLED_SKILLS,
  ORKESTRATOR_AGENT_MCP_TOKEN_ENV,
  ORKESTRATOR_AGENT_MCP_URL_ENV,
  codexAppServerConfigOverrides,
  codexCoordinatorPolicy,
  codexCoordinatorSkillExtraRoots,
  codexCoordinatorSkillReadRoots,
  codexLoadsProjectSkills,
  codexHostedNetworkLockGaps,
  codexToolHistoryGaps,
  codexNetworkDeniedConfig,
  codexNetworkDeniedSearchMode,
  codexProjectSkillsConfig,
  codexProjectTrustConfig,
  codexRequestUserInputConfig,
  codexReadOnlyTurnPolicy,
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
      "agents.max_concurrent_threads_per_session": "5",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "6",
      // Tools stay out of thread history, on every bridge (codex 0.164).
      "features.incremental_tools": "false",
    });
    // Native sessions must inherit Codex's default (flag off) so 2025-era
    // HTTP MCP servers such as Paper.design can complete initialize.
    expect(codexAppServerConfigOverrides({})["features.mcp_2026_07_28"]).toBeUndefined();
  });

  test("makes the child limit authoritative in legacy and root-inclusive V2 config", () => {
    expect(
      codexAppServerConfigOverrides({
        [CODEX_MAX_CONCURRENT_THREADS_ENV]: "8",
      }),
    ).toEqual({
      "agents.max_concurrent_threads_per_session": "8",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "9",
      "features.incremental_tools": "false",
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
      "mcp_servers.orkestrator.startup_timeout_sec": "15",
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

  test("grants read on the conversation's attachment directory, and only when one is named", () => {
    // A coordinator's attachments are staged outside the checkout, so without
    // this grant a pasted image resolves to a path the profile denies.
    const withAttachments = codexAppServerConfigOverrides({
      ...COORDINATOR_ENV,
      [BRIDGE_ATTACHMENT_ROOT_ENV]: "/data/coordinator-attachments/c1/conv1",
    });
    expect(withAttachments["permissions.coordinator-conversation-1.filesystem"]).toContain(
      '"/data/coordinator-attachments/c1/conv1" = "read"',
    );
    expect(withAttachments["permissions.coordinator-conversation-1.filesystem"]).not.toContain(
      '"write"',
    );

    // A relative value is launcher misconfiguration, not a root: Codex would
    // resolve it against its own working directory.
    const relative = codexAppServerConfigOverrides({
      ...COORDINATOR_ENV,
      [BRIDGE_ATTACHMENT_ROOT_ENV]: "attachments",
    });
    expect(relative["permissions.coordinator-conversation-1.filesystem"]).not.toContain(
      "attachments",
    );
    expect(
      codexAppServerConfigOverrides(COORDINATOR_ENV)[
        "permissions.coordinator-conversation-1.filesystem"
      ],
    ).toBe(relative["permissions.coordinator-conversation-1.filesystem"]);
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
    // 3. No network egress from delegated tool calls, and no hosted web search,
    //    which reaches the internet from OpenAI's servers and so is untouched
    //    by the profile's network switch.
    expect(overrides["permissions.coordinator-conversation-1.network.enabled"]).toBe("false");
    expect(overrides.web_search).toBe('"disabled"');
    expect(overrides["features.standalone_web_search"]).toBe("false");
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

  test("turns hosted web search off for a coordinator in the TOML form -c expects", () => {
    // No research setting from the launcher is the same as `off`.
    const overrides = codexAppServerConfigOverrides(COORDINATOR_ENV);
    // Each value is parsed as TOML by `codex -c key=value`; a bare `disabled`
    // would not parse as a string and app-server would refuse to start.
    expect(overrides.web_search).toBe('"disabled"');
    expect(overrides["features.standalone_web_search"]).toBe("false");
    // Naming the deprecated switches would only add a deprecation notice to
    // every thread: `web_search` already wins over them.
    expect(overrides["features.web_search_request"]).toBeUndefined();
    expect(overrides["features.web_search_cached"]).toBeUndefined();
  });

  test("a research setting gives a coordinator cached search, never live", () => {
    for (const mode of ["search", "search-and-mcp"]) {
      const overrides = codexAppServerConfigOverrides({
        ...COORDINATOR_ENV,
        [COORDINATOR_WEB_RESEARCH_ENV]: mode,
      });
      expect(overrides.web_search).toBe('"cached"');
      expect(overrides["features.standalone_web_search"]).toBe("false");
    }
    // An unknown value is not a mode, so search stays off.
    expect(
      codexAppServerConfigOverrides({ ...COORDINATOR_ENV, [COORDINATOR_WEB_RESEARCH_ENV]: "live" })
        .web_search,
    ).toBe('"disabled"');
  });

  test("adds the launcher's research servers to a coordinator, approved and optional", () => {
    const env = {
      ...COORDINATOR_ENV,
      [COORDINATOR_WEB_RESEARCH_ENV]: "search-and-mcp",
      [COORDINATOR_RESEARCH_MCP_ENV]: JSON.stringify([
        { name: "context7", url: "https://mcp.context7.com/mcp" },
        // Refused: a local endpoint, a reserved name, and a non-https URL.
        { name: "local", url: "http://127.0.0.1:9000/mcp" },
        { name: "orkestrator", url: "https://example.com/mcp" },
      ]),
    };
    const overrides = codexAppServerConfigOverrides(env);
    expect(overrides["mcp_servers.context7.url"]).toBe('"https://mcp.context7.com/mcp"');
    expect(overrides["mcp_servers.context7.required"]).toBe("false");
    expect(overrides["mcp_servers.context7.default_tools_approval_mode"]).toBe('"approve"');
    expect(Object.keys(overrides).filter((key) => key.startsWith("mcp_servers."))).toEqual(
      Object.keys(overrides).filter((key) => key.startsWith("mcp_servers.context7.")),
    );

    // Search alone loads no servers, whatever the list says.
    const searchOnly = codexAppServerConfigOverrides({
      ...env,
      [COORDINATOR_WEB_RESEARCH_ENV]: "search",
    });
    expect(Object.keys(searchOnly).some((key) => key.startsWith("mcp_servers.context7"))).toBe(
      false,
    );
    // And an ordinary bridge never loads them.
    const worker = codexAppServerConfigOverrides({
      CWD: "/projects/example",
      [COORDINATOR_WEB_RESEARCH_ENV]: "search-and-mcp",
      [COORDINATOR_RESEARCH_MCP_ENV]: env[COORDINATOR_RESEARCH_MCP_ENV],
    });
    expect(Object.keys(worker).some((key) => key.startsWith("mcp_servers.context7"))).toBe(false);
  });

  test("a network-denied thread searches only from the cache, and only when allowed", () => {
    const denied = { ...codexCoordinatorPolicy({}) };
    expect(codexNetworkDeniedSearchMode(denied)).toBe("disabled");
    expect(codexNetworkDeniedConfig(denied)).toEqual({
      web_search: "disabled",
      "features.standalone_web_search": false,
    });
    const research = codexCoordinatorPolicy({ [COORDINATOR_WEB_RESEARCH_ENV]: "search" });
    expect(codexNetworkDeniedSearchMode(research)).toBe("cached");
    expect(codexNetworkDeniedConfig(research)).toEqual({
      web_search: "cached",
      "features.standalone_web_search": false,
    });
    // A policy that does not deny the network leaves Codex's own choice alone.
    expect(
      codexNetworkDeniedConfig({
        id: "interactive-container",
        sandbox: "container",
        approvals: "auto-approve",
        projectResources: true,
        networkAccess: "restricted",
      }),
    ).toEqual({});
  });

  test("a read-only turn denies the network and drops a search exception", () => {
    const host = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    } as const;
    const turn = codexReadOnlyTurnPolicy(host);
    expect(turn).toEqual({ ...host, capabilityPolicy: { deny: ["network"] } });
    expect(codexNetworkDeniedConfig(turn)).toEqual({
      web_search: "disabled",
      "features.standalone_web_search": false,
    });
    // Existing denials are kept; an exception without the denial it carves
    // out of never turns search back on.
    expect(
      codexReadOnlyTurnPolicy({
        ...host,
        capabilityPolicy: { deny: ["file.write"], allow: ["web.search"] },
      }).capabilityPolicy,
    ).toEqual({ deny: ["file.write", "network"] });
    // A session restored without a policy still loses search.
    expect(codexNetworkDeniedSearchMode(codexReadOnlyTurnPolicy(undefined))).toBe("disabled");
    // A coordinator keeps the research mode its process configuration holds.
    const research = codexCoordinatorPolicy({ [COORDINATOR_WEB_RESEARCH_ENV]: "search" });
    expect(codexReadOnlyTurnPolicy(research)).toBe(research);
    expect(codexNetworkDeniedSearchMode(codexReadOnlyTurnPolicy(research))).toBe("cached");
  });

  test("reads the hosted web search mode back from an effective configuration", () => {
    const off = { incremental_tools: false };
    expect(
      codexHostedNetworkLockGaps({
        web_search: "disabled",
        features: { standalone_web_search: false, ...off },
      }),
    ).toEqual([]);
    expect(codexHostedNetworkLockGaps({ web_search: "disabled", features: off })).toEqual([]);
    expect(codexHostedNetworkLockGaps({ web_search: "cached", features: off }, "cached")).toEqual(
      [],
    );
    // No setting leaves the mode to Codex, which is not a confirmation.
    expect(codexHostedNetworkLockGaps({ web_search: null, features: off })).toEqual([
      'web_search is null, not "disabled"',
    ]);
    expect(codexHostedNetworkLockGaps({ web_search: "cached", features: off })).toEqual([
      'web_search is "cached", not "disabled"',
    ]);
    // `live` opens any URL the model names; it never passes.
    expect(codexHostedNetworkLockGaps({ web_search: "live", features: off }, "cached")).toEqual([
      'web_search is "live", not "cached"',
    ]);
    expect(
      codexHostedNetworkLockGaps({
        web_search: "disabled",
        features: { standalone_web_search: true, ...off },
      }),
    ).toEqual(["features.standalone_web_search is on"]);
    // Tools declared into history would outlive the mode (codex 0.164).
    expect(codexHostedNetworkLockGaps({ web_search: "disabled" })).toEqual([
      "features.incremental_tools is null, not false",
    ]);
    expect(codexToolHistoryGaps({ features: { incremental_tools: true } })).toEqual([
      "features.incremental_tools is true, not false",
    ]);
    expect(codexToolHistoryGaps({ features: off })).toEqual([]);
    for (const malformed of [undefined, null, "disabled", ["disabled"]]) {
      expect(codexHostedNetworkLockGaps(malformed)).toEqual([
        "config/read returned no configuration",
      ]);
    }
  });

  test("the coordinator policy names the network denial the panel and thread config read", () => {
    expect(codexCoordinatorPolicy({})).toMatchObject({
      id: "coordinator-read-only",
      approvals: "deny",
      networkAccess: "restricted",
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
    });
    expect(codexCoordinatorPolicy({}).capabilityPolicy?.allow).toBeUndefined();
    expect(
      codexCoordinatorPolicy({ [COORDINATOR_WEB_RESEARCH_ENV]: "search-and-mcp" }).capabilityPolicy,
    ).toEqual({
      deny: ["file.write", "file.patch", "shell.mutate", "network"],
      allow: ["web.search"],
    });
  });

  test("applies none of the coordinator hardening outside the coordinator policy", () => {
    const overrides = codexAppServerConfigOverrides({ CWD: "/projects/example" });
    // Search stays a per-thread decision on a bridge that serves many policies.
    expect(overrides.web_search).toBeUndefined();

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
      // The mail and artifact tools alone are approved; the server default is untouched.
      ...[...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES].map(
        (name) => `mcp_servers.orkestrator.tools.${name}.approval_mode`,
      ),
    ]);
    expect(overrides["mcp_servers.orkestrator.tools.send_message.approval_mode"]).toBe(
      JSON.stringify("approve"),
    );
    expect(overrides["mcp_servers.orkestrator.default_tools_approval_mode"]).toBeUndefined();
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

describe("codexRequestUserInputConfig", () => {
  const policy = {
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
  } as const;

  test("lets every watched session ask, the coordinator included", () => {
    for (const id of [
      "interactive-host",
      "interactive-container",
      "coordinator-read-only",
    ] as const) {
      expect(codexRequestUserInputConfig({ ...policy, id })).toEqual({
        "features.default_mode_request_user_input": true,
      });
    }
  });

  test("keeps Codex's refusal for unattended sessions and older backends", () => {
    expect(codexRequestUserInputConfig({ ...policy, id: "pipeline" })).toEqual({});
    expect(codexRequestUserInputConfig(undefined)).toEqual({});
  });
});

describe("codexProjectTrustConfig", () => {
  const policy = {
    id: "interactive-host",
    sandbox: "none",
    approvals: "auto-approve",
    networkAccess: "full",
  } as const;

  test("pins the cwd untrusted as a nested table when project resources are off", () => {
    expect(
      codexProjectTrustConfig({ ...policy, projectResources: false }, "/no/such/checkout"),
    ).toEqual({ projects: { "/no/such/checkout": { trust_level: "untrusted" } } });
  });

  test("leaves Codex's own trust decision alone when project resources are on or unknown", () => {
    expect(codexProjectTrustConfig({ ...policy, projectResources: true }, "/checkout")).toEqual({});
    expect(codexProjectTrustConfig(undefined, "/checkout")).toEqual({});
    expect(codexProjectTrustConfig({ ...policy, projectResources: false }, undefined)).toEqual({});
    expect(codexProjectTrustConfig({ ...policy, projectResources: false }, "relative")).toEqual({});
  });

  test("pins both the given path and its canonical form", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-trust-pin-"));
    try {
      const link = join(root, "link");
      await symlink(root, link);
      const canonical = await realpath(root);
      const pinned = codexProjectTrustConfig({ ...policy, projectResources: false }, link) as {
        projects: Record<string, unknown>;
      };
      expect(Object.keys(pinned.projects).sort()).toEqual([canonical, link].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("codexProjectSkillsConfig", () => {
  const listed = (skills: unknown[]) => ({ data: [{ cwd: "/w", errors: [], skills }] });

  test("disables repo, unknown-scope and already-disabled skills, keeping enabled user skills", () => {
    expect(
      codexProjectSkillsConfig(
        listed([
          { name: "repo", path: "/w/.agents/skills/repo/SKILL.md", scope: "repo", enabled: true },
          { name: "user", path: "/u/skills/user/SKILL.md", scope: "user", enabled: true },
          { name: "system", path: "/c/skills/.system/s/SKILL.md", scope: "system", enabled: true },
          { name: "off", path: "/u/skills/off/SKILL.md", scope: "user", enabled: false },
          { name: "new", path: "/x/new/SKILL.md", scope: "workspace", enabled: true },
        ]),
      ),
    ).toEqual({
      skills: {
        config: [
          { path: "/w/.agents/skills/repo/SKILL.md", enabled: false },
          { path: "/u/skills/off/SKILL.md", enabled: false },
          { path: "/x/new/SKILL.md", enabled: false },
        ],
      },
    });
  });

  test("adds nothing when every listed skill is the user's and enabled", () => {
    expect(
      codexProjectSkillsConfig(
        listed([{ name: "user", path: "/u/skills/user/SKILL.md", scope: "user", enabled: true }]),
      ),
    ).toEqual({});
    expect(codexProjectSkillsConfig({ data: [] })).toEqual({});
  });

  test("refuses what it cannot disable", () => {
    expect(() => codexProjectSkillsConfig({})).toThrow("no skill inventory");
    expect(() =>
      codexProjectSkillsConfig(listed([{ name: "repo", scope: "repo", enabled: true }])),
    ).toThrow("without a path");
    const many = Array.from({ length: MAX_CODEX_DISABLED_SKILLS + 1 }, (_, index) => ({
      name: `s${index}`,
      path: `/w/.codex/skills/s${index}/SKILL.md`,
      scope: "repo",
      enabled: true,
    }));
    expect(() => codexProjectSkillsConfig(listed(many))).toThrow("more than");
  });
});

describe("coordinator skills", () => {
  let root: string;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function skill(dir: string, name: string): Promise<string> {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    return join(dir, name);
  }

  test("only a coordinator process loads the checkout's skills with project resources off", () => {
    const off = { ...codexCoordinatorPolicy({}) };
    expect(codexLoadsProjectSkills(off, COORDINATOR_ENV)).toBe(true);
    // The same policy outside a coordinator process, and an ordinary host
    // session, keep them out.
    expect(codexLoadsProjectSkills(off, {})).toBe(false);
    expect(
      codexLoadsProjectSkills(
        {
          id: "interactive-host",
          sandbox: "provider",
          approvals: "ask",
          projectResources: false,
          networkAccess: "full",
        },
        COORDINATOR_ENV,
      ),
    ).toBe(false);
    expect(codexLoadsProjectSkills(undefined, {})).toBe(true);
  });

  test("extra roots are the account's skills and the checkout's Claude skills, in a coordinator only", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "codex-skill-roots-")));
    const userSkills = join(root, "account", "skills");
    const checkout = join(root, "checkout");
    await mkdir(userSkills, { recursive: true });
    await mkdir(join(checkout, ".claude", "skills"), { recursive: true });
    const env = {
      ...COORDINATOR_ENV,
      CWD: checkout,
      [COORDINATOR_CODEX_USER_SKILLS_DIR_ENV]: userSkills,
    };
    expect(codexCoordinatorSkillExtraRoots(env)).toEqual([
      userSkills,
      join(checkout, ".claude", "skills"),
    ]);
    expect(
      codexCoordinatorSkillExtraRoots({ ...env, CODEX_BRIDGE_EXECUTION_POLICY: undefined }),
    ).toEqual([]);
    // A directory that does not exist is not handed to Codex.
    await rm(join(checkout, ".claude"), { recursive: true });
    expect(codexCoordinatorSkillExtraRoots(env)).toEqual([userSkills]);
  });

  test("read grants follow the user's skill links, never HOME, the root or the checkout's links", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "codex-skill-grants-")));
    const home = join(root, "home");
    const userSkills = join(root, "account", "skills");
    const agentsSkills = join(home, ".agents", "skills");
    await mkdir(userSkills, { recursive: true });
    await skill(userSkills, "local");
    await skill(agentsSkills, "shared");
    // A user skill linked from elsewhere is granted where it really lives.
    const elsewhere = await skill(join(root, "elsewhere"), "linked");
    await symlink(elsewhere, join(userSkills, "linked"));
    // Links that would widen the profile are not followed.
    await symlink(home, join(userSkills, "home"));
    await symlink("/", join(userSkills, "slash"));
    await mkdir(join(root, "no-skill"), { recursive: true });
    await symlink(join(root, "no-skill"), join(userSkills, "not-a-skill"));
    await writeFile(join(home, "SKILL.md"), "home is never a skill root\n");

    const grants = codexCoordinatorSkillReadRoots(
      { ...COORDINATOR_ENV, [COORDINATOR_CODEX_USER_SKILLS_DIR_ENV]: userSkills },
      home,
    );
    expect(grants.toSorted()).toEqual([agentsSkills, userSkills, elsewhere].toSorted());

    const overrides = codexAppServerConfigOverrides({
      ...COORDINATOR_ENV,
      HOME: home,
      [COORDINATOR_CODEX_USER_SKILLS_DIR_ENV]: userSkills,
    });
    const filesystem = overrides["permissions.coordinator-conversation-1.filesystem"]!;
    for (const grant of grants) expect(filesystem).toContain(`${JSON.stringify(grant)} = "read"`);
    expect(filesystem).not.toContain('"write"');
    expect(filesystem).toContain('":root" = "deny"');
    expect(overrides["features.skill_env_var_dependency_prompt"]).toBe("false");
  });
});
