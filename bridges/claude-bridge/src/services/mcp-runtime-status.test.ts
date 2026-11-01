import { describe, expect, test } from "bun:test";

import { initMcpServerStatus, mcpScope } from "./mcp-runtime-status.js";

describe("the live panel's MCP layer", () => {
  test("a plugin server is a plugin server, whatever config scope the CLI reports", () => {
    // `mcpServerStatus()` on the pinned CLI (2.1.309) reports plugin servers this way.
    expect(mcpScope("dynamic", "plugin:docs:search", "plugin")).toBe("plugin");
    expect(mcpScope("plugin", "plugin:docs:search")).toBe("plugin");
    expect(initMcpServerStatus({ name: "plugin:docs:search", source: "plugin" }).scope).toBe(
      "plugin",
    );
  });

  test("file layers, Orkestrator's own server and the user default", () => {
    expect(mcpScope("project", "db", "project")).toBe("project");
    expect(mcpScope("local", "db")).toBe("local");
    expect(mcpScope("user", "db", "user")).toBe("user");
    expect(mcpScope("dynamic", "db", "dynamic")).toBe("user");
    expect(mcpScope(undefined, "orkestrator", "plugin")).toBe("orkestrator");
  });

  test("the session's launch record decides over the CLI's report", () => {
    const layers = new Map([
      ["db", "project"],
      ["orkestrator", "project"],
      ["plugin:docs:search", "user"],
    ] as const);
    // An inline server is `dynamic` to the CLI, whichever file it came from.
    expect(mcpScope("dynamic", "db", "dynamic", layers)).toBe("project");
    expect(mcpScope("user", "db", "user", layers)).toBe("project");
    // Without Orkestrator's connection, a project's server of that name is the project's.
    expect(mcpScope("dynamic", "orkestrator", "dynamic", layers)).toBe("project");
    expect(mcpScope("dynamic", "unlisted", "dynamic", layers)).toBe("user");
    expect(initMcpServerStatus({ name: "db", source: "dynamic" }, layers).scope).toBe("project");
    expect(initMcpServerStatus({ name: "db" }, layers).scope).toBe("project");
    expect(initMcpServerStatus({ name: "unlisted" }, layers).scope).toBeUndefined();
  });

  test("a same-named server from a source the files never declare keeps its own layer", () => {
    const layers = new Map([["plugin:docs:search", "user"]] as const);
    expect(mcpScope("dynamic", "plugin:docs:search", "plugin", layers)).toBe("plugin");
    expect(mcpScope("claudeai", "plugin:docs:search", "claudeai", layers)).toBe("user");
    expect(mcpScope("dynamic", "plugin:docs:search", "dynamic", layers)).toBe("user");
  });
});
