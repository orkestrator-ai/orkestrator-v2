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
});
