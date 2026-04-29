import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Snapshot the real mcp-config BEFORE installing the stub mock, so other test
// files in the same `bun test` run see the real implementation.
import * as realMcpConfig from "../services/mcp-config.js";
const mcpConfigSnapshot = { ...realMcpConfig };

import type { McpServerInfo } from "../types/mcp.js";

const mockGetMcpServerInfo = mock(async (_cwd: string): Promise<McpServerInfo[]> => []);

mock.module("../services/mcp-config.js", () => ({
  getMcpServerInfo: mockGetMcpServerInfo,
}));

const { default: mcp } = await import("./mcp.js");

const app = new Hono();
app.route("/", mcp);

const originalCwdEnv = process.env.CWD;

afterAll(() => {
  mock.module("../services/mcp-config.js", () => mcpConfigSnapshot);
  if (originalCwdEnv === undefined) delete process.env.CWD;
  else process.env.CWD = originalCwdEnv;
});

describe("GET /servers", () => {
  beforeEach(() => {
    mockGetMcpServerInfo.mockClear();
  });

  afterEach(() => {
    delete process.env.CWD;
  });

  test("returns server list and the cwd that was used", async () => {
    process.env.CWD = "/fake/project";
    mockGetMcpServerInfo.mockImplementationOnce(async (cwd) => [
      { name: "github", type: "stdio", command: "node", source: "global" },
      { name: "remote", type: "http", url: "https://example.com", source: "project" },
    ]);

    const res = await app.request("/servers");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cwd).toBe("/fake/project");
    expect(body.servers).toHaveLength(2);
    expect(body.servers[0]).toMatchObject({ name: "github", source: "global" });
    expect(mockGetMcpServerInfo).toHaveBeenCalledWith("/fake/project");
  });

  test("falls back to process.cwd() when CWD env is unset", async () => {
    delete process.env.CWD;
    mockGetMcpServerInfo.mockImplementationOnce(async () => []);

    const res = await app.request("/servers");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cwd).toBe(process.cwd());
    expect(mockGetMcpServerInfo).toHaveBeenCalledWith(process.cwd());
  });

  test("returns 500 when getMcpServerInfo throws", async () => {
    mockGetMcpServerInfo.mockImplementationOnce(async () => {
      throw new Error("fs error");
    });

    const res = await app.request("/servers");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe("fs error");
  });

  test("returns a generic 500 error message when a non-Error is thrown", async () => {
    mockGetMcpServerInfo.mockImplementationOnce(async () => {
      throw "string error";
    });

    const res = await app.request("/servers");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe("Failed to get MCP servers");
  });
});
