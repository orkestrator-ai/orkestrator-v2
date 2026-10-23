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

  test("stays a legacy display list, never an executable enhanced catalogue", async () => {
    mockDiscoverSlashCommands.mockImplementationOnce(async () => ["/review - Review changes"]);

    const res = await app.request("/commands");
    expect(res.status).toBe(200);

    // Old clients read `commands: string[]`. No catalogue version, status or
    // row identity: nothing here may be executed as a selected command.
    expect(await res.json()).toEqual({ commands: ["/review - Review changes"] });
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

  /*
   * A backend from before the version-1 catalogue (ff4026b4e^, #827) reads this
   * route only when `GET /session/:id/commands` answers 404, which this bridge
   * no longer does for a known or unknown session; the remaining caller is an
   * old backend asking with no session id. Its reader took `payload.commands`
   * and turned each string row into `{ name: row }`, prefixing a missing `/`.
   */
  describe("mixed-version: old backend, current bridge", () => {
    test("the legacy list still answers 200 as plain strings the old reader keeps", async () => {
      mockDiscoverSlashCommands.mockImplementationOnce(async () => [
        "/help - Show available commands",
        "/myplugin:foo - Custom plugin command",
      ]);

      const res = await app.request("/commands");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { commands: unknown[] };
      // Exactly the pre-#827 shape: one key, an array of non-empty strings that
      // already carry their slash, so the old reader re-spells nothing.
      expect(Object.keys(body)).toEqual(["commands"]);
      expect(Array.isArray(body.commands)).toBe(true);
      for (const row of body.commands) {
        expect(typeof row).toBe("string");
        expect(String(row).length).toBeGreaterThan(0);
        expect(String(row).startsWith("/")).toBe(true);
      }
    });
  });
});
