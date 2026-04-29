import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Snapshot the real modules BEFORE installing stub mocks below, so other
// test files in the same `bun test` run see the real implementations.
import * as realPluginConfig from "../services/plugin-config.js";
import * as realSlashCommands from "../services/slash-commands.js";
const pluginConfigSnapshot = { ...realPluginConfig };
const slashCommandsSnapshot = { ...realSlashCommands };

import type { PluginInfo } from "../types/plugins.js";

const mockGetPluginInfo = mock(async (_cwd: string): Promise<PluginInfo[]> => []);
const mockDiscoverSlashCommands = mock(async (_cwd: string): Promise<string[]> => []);

mock.module("../services/plugin-config.js", () => ({
  getPluginInfo: mockGetPluginInfo,
}));

mock.module("../services/slash-commands.js", () => ({
  discoverSlashCommands: mockDiscoverSlashCommands,
}));

const { default: plugins } = await import("./plugins.js");

const app = new Hono();
app.route("/", plugins);

const originalCwdEnv = process.env.CWD;

afterAll(() => {
  mock.module("../services/plugin-config.js", () => pluginConfigSnapshot);
  mock.module("../services/slash-commands.js", () => slashCommandsSnapshot);
  if (originalCwdEnv === undefined) delete process.env.CWD;
  else process.env.CWD = originalCwdEnv;
});

beforeEach(() => {
  mockGetPluginInfo.mockClear();
  mockDiscoverSlashCommands.mockClear();
});

afterEach(() => {
  delete process.env.CWD;
});

describe("GET /", () => {
  test("returns plugin list and the cwd that was used", async () => {
    process.env.CWD = "/fake/project";
    mockGetPluginInfo.mockImplementationOnce(async (cwd) => [
      { name: "p1", path: `${cwd}/plugins/p1`, source: "project", enabled: true },
      { name: "p2", path: `${cwd}/plugins/p2`, source: "global", enabled: false },
    ]);

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cwd).toBe("/fake/project");
    expect(body.plugins).toHaveLength(2);
    expect(body.plugins[0]).toMatchObject({ name: "p1", enabled: true });
    expect(mockGetPluginInfo).toHaveBeenCalledWith("/fake/project");
  });

  test("falls back to process.cwd() when CWD env is unset", async () => {
    delete process.env.CWD;
    mockGetPluginInfo.mockImplementationOnce(async () => []);

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cwd).toBe(process.cwd());
    expect(mockGetPluginInfo).toHaveBeenCalledWith(process.cwd());
  });

  test("returns 500 when getPluginInfo throws", async () => {
    mockGetPluginInfo.mockImplementationOnce(async () => {
      throw new Error("plugin load failed");
    });

    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("plugin load failed");
  });

  test("returns a generic 500 error when a non-Error is thrown", async () => {
    mockGetPluginInfo.mockImplementationOnce(async () => {
      throw "boom";
    });

    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to get plugins");
  });
});

describe("GET /commands", () => {
  test("returns the discovered slash command list", async () => {
    process.env.CWD = "/fake/project";
    mockDiscoverSlashCommands.mockImplementationOnce(async () => [
      "/help - Show available commands",
      "/myplugin:foo - Custom plugin command",
    ]);

    const res = await app.request("/commands");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.commands).toEqual([
      "/help - Show available commands",
      "/myplugin:foo - Custom plugin command",
    ]);
    expect(mockDiscoverSlashCommands).toHaveBeenCalledWith("/fake/project");
  });

  test("falls back to process.cwd() when CWD env is unset", async () => {
    delete process.env.CWD;
    mockDiscoverSlashCommands.mockImplementationOnce(async () => []);

    const res = await app.request("/commands");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.commands).toEqual([]);
    expect(mockDiscoverSlashCommands).toHaveBeenCalledWith(process.cwd());
  });

  test("returns 500 when discoverSlashCommands throws", async () => {
    mockDiscoverSlashCommands.mockImplementationOnce(async () => {
      throw new Error("scan failed");
    });

    const res = await app.request("/commands");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("scan failed");
  });

  test("returns a generic 500 error when a non-Error is thrown", async () => {
    mockDiscoverSlashCommands.mockImplementationOnce(async () => {
      throw 42;
    });

    const res = await app.request("/commands");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to discover slash commands");
  });
});
