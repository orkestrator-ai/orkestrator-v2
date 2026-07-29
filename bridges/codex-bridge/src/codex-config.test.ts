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
      "features.goals": "true",
      "agents.max_concurrent_threads_per_session": "5",
      "features.multi_agent_v2.max_concurrent_threads_per_session": "6",
    });
  });

  test("makes the child limit authoritative in legacy and root-inclusive V2 config", () => {
    expect(codexAppServerConfigOverrides({
      [CODEX_MAX_CONCURRENT_THREADS_ENV]: "8",
    })).toEqual({
      "features.goals": "true",
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
      "mcp_servers.orkestrator.url":
        "\"http://host.docker.internal:4567/mcp\"",
      "mcp_servers.orkestrator.bearer_token_env_var":
        `"${ORKESTRATOR_AGENT_MCP_TOKEN_ENV}"`,
    });
    expect(JSON.stringify(overrides)).not.toContain("project-secret");
  });

  test("accepts both loopback host spellings for local agent tools", () => {
    for (const hostname of ["127.0.0.1", "localhost"]) {
      const overrides = codexAppServerConfigOverrides({
        [ORKESTRATOR_AGENT_MCP_URL_ENV]: `http://${hostname}:4567/mcp`,
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      });
      expect(overrides["mcp_servers.orkestrator.url"]).toBe(
        `"http://${hostname}:4567/mcp"`,
      );
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
        [ORKESTRATOR_AGENT_MCP_URL_ENV]:
          "http://user:password@127.0.0.1:4567/mcp",
        [ORKESTRATOR_AGENT_MCP_TOKEN_ENV]: "project-secret",
      },
    ]) {
      const overrides = codexAppServerConfigOverrides(env);
      expect(overrides["mcp_servers.orkestrator.url"]).toBeUndefined();
      expect(overrides["mcp_servers.orkestrator.bearer_token_env_var"])
        .toBeUndefined();
    }
  });

  test("uses process.env when agent credentials are already installed", () => {
    process.env[ORKESTRATOR_AGENT_MCP_URL_ENV] =
      "http://127.0.0.1:4567/mcp";
    process.env[ORKESTRATOR_AGENT_MCP_TOKEN_ENV] = "project-secret";

    const overrides = codexAppServerConfigOverrides();

    expect(overrides["mcp_servers.orkestrator.url"]).toBe(
      "\"http://127.0.0.1:4567/mcp\"",
    );
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
    expect(Object.keys(overrides).filter((key) => key.startsWith("mcp_servers.")))
      .toEqual([
        "mcp_servers.orkestrator.url",
        "mcp_servers.orkestrator.bearer_token_env_var",
      ]);
  });

  test("accepts whitespace and the largest safely convertible child limit", () => {
    expect(resolveCodexMaxConcurrentThreads(" \t7\n")).toBe(7);
    expect(resolveCodexMaxConcurrentThreads(String(MAX_CODEX_CONCURRENT_THREADS)))
      .toBe(MAX_CODEX_CONCURRENT_THREADS);
    expect(codexAppServerConfigOverrides({
      [CODEX_MAX_CONCURRENT_THREADS_ENV]: String(MAX_CODEX_CONCURRENT_THREADS),
    })).toMatchObject({
      "agents.max_concurrent_threads_per_session": String(
        MAX_CODEX_CONCURRENT_THREADS,
      ),
      "features.multi_agent_v2.max_concurrent_threads_per_session": String(
        Number.MAX_SAFE_INTEGER,
      ),
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
      expect(resolveCodexMaxConcurrentThreads(value)).toBe(
        DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
      );
    }
  });
});
