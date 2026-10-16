import { describe, expect, test } from "bun:test";
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
  coordinatorCapabilityPolicy,
  coordinatorResearchMcpServerProblem,
  coordinatorResearchMcpServersFromEnv,
  coordinatorWebResearchEnv,
  coordinatorWebResearchFromEnv,
  coordinatorWebResearchSetting,
  MAX_COORDINATOR_RESEARCH_MCP_SERVERS,
  normalizeCoordinatorResearchMcpServers,
} from "./coordinator-web-research";
import { nativeAgentPolicyDeniesWebSearch, type NativeAgentExecutionPolicy } from "./native-agent";

const CONTEXT7 = { name: "context7", url: "https://mcp.context7.com/mcp" };

describe("coordinator web research", () => {
  test("a stored mode defaults to search plus research servers, and a bad one is off", () => {
    expect(coordinatorWebResearchSetting(undefined)).toBe("search-and-mcp");
    expect(coordinatorWebResearchSetting("search")).toBe("search");
    expect(coordinatorWebResearchSetting("live")).toBe("off");
    expect(coordinatorWebResearchSetting(null)).toBe("off");
  });

  test("a launched process without the setting keeps search off", () => {
    // An older launcher, or a review turn in an ordinary bridge.
    expect(coordinatorWebResearchFromEnv({})).toBe("off");
    expect(coordinatorWebResearchFromEnv({ [COORDINATOR_WEB_RESEARCH_ENV]: "everything" })).toBe(
      "off",
    );
    expect(coordinatorWebResearchFromEnv({ [COORDINATOR_WEB_RESEARCH_ENV]: "search" })).toBe(
      "search",
    );
  });

  test("only remote, plainly named servers are accepted", () => {
    expect(coordinatorResearchMcpServerProblem(CONTEXT7)).toBeUndefined();
    for (const [server, problem] of [
      [{ name: "context7", url: "http://mcp.context7.com/mcp" }, "https://"],
      [{ name: "local", url: "file:///tmp/server" }, "https://"],
      [{ name: "context7", url: "not a url" }, "not valid"],
      [{ name: "context7", url: "https://user:secret@example.com/mcp" }, "Credentials"],
      [{ name: "orkestrator-docs", url: "https://example.com/mcp" }, "reserved"],
      // An underscore could make one server's tool names read as another's.
      [{ name: "context_7", url: "https://example.com/mcp" }, "lowercase"],
      [{ name: "Context7", url: "https://example.com/mcp" }, "lowercase"],
    ] as const) {
      expect(coordinatorResearchMcpServerProblem(server)).toContain(problem);
    }
  });

  test("a server list keeps exactly the acceptable, unique entries up to the limit", () => {
    expect(normalizeCoordinatorResearchMcpServers(undefined)).toEqual([CONTEXT7]);
    expect(normalizeCoordinatorResearchMcpServers([])).toEqual([]);
    expect(normalizeCoordinatorResearchMcpServers("context7")).toEqual([]);
    expect(
      normalizeCoordinatorResearchMcpServers([
        CONTEXT7,
        { ...CONTEXT7, url: "https://other.example/mcp" },
        { name: "local", url: "http://127.0.0.1:9000/mcp" },
        { name: " docs ", url: " https://docs.example/mcp " },
        null,
        { name: 7 },
      ]),
    ).toEqual([CONTEXT7, { name: "docs", url: "https://docs.example/mcp" }]);
    const many = Array.from({ length: 12 }, (_, index) => ({
      name: `server-${index}`,
      url: `https://server-${index}.example/mcp`,
    }));
    expect(normalizeCoordinatorResearchMcpServers(many)).toHaveLength(
      MAX_COORDINATOR_RESEARCH_MCP_SERVERS,
    );
  });

  test("research servers travel to a bridge only with the mode that loads them", () => {
    expect(coordinatorWebResearchEnv("search-and-mcp", [CONTEXT7])).toEqual({
      [COORDINATOR_WEB_RESEARCH_ENV]: "search-and-mcp",
      [COORDINATOR_RESEARCH_MCP_ENV]: JSON.stringify([CONTEXT7]),
    });
    expect(coordinatorWebResearchEnv("search", [CONTEXT7])).toEqual({
      [COORDINATOR_WEB_RESEARCH_ENV]: "search",
    });
    const env = coordinatorWebResearchEnv("search-and-mcp", [CONTEXT7]);
    expect(coordinatorResearchMcpServersFromEnv(env)).toEqual([CONTEXT7]);
    // A list without the mode, or a corrupt list, loads nothing.
    expect(
      coordinatorResearchMcpServersFromEnv({
        [COORDINATOR_RESEARCH_MCP_ENV]: env[COORDINATOR_RESEARCH_MCP_ENV],
      }),
    ).toEqual([]);
    expect(
      coordinatorResearchMcpServersFromEnv({ ...env, [COORDINATOR_RESEARCH_MCP_ENV]: "{" }),
    ).toEqual([]);
  });

  test("research only ever adds the search exception to the same denials", () => {
    const policy = (mode: "off" | "search" | "search-and-mcp"): NativeAgentExecutionPolicy => ({
      id: "coordinator-read-only",
      sandbox: "provider",
      approvals: "deny",
      projectResources: false,
      capabilityPolicy: coordinatorCapabilityPolicy(mode),
      networkAccess: "restricted",
    });
    for (const mode of ["off", "search", "search-and-mcp"] as const) {
      expect(coordinatorCapabilityPolicy(mode).deny).toEqual([
        "file.write",
        "file.patch",
        "shell.mutate",
        "network",
      ]);
    }
    expect(coordinatorCapabilityPolicy("off").allow).toBeUndefined();
    expect(nativeAgentPolicyDeniesWebSearch(policy("off"))).toBe(true);
    expect(nativeAgentPolicyDeniesWebSearch(policy("search"))).toBe(false);
    expect(nativeAgentPolicyDeniesWebSearch(policy("search-and-mcp"))).toBe(false);
  });
});
