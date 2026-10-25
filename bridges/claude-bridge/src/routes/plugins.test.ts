import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Snapshot the real modules BEFORE installing stub mocks below, so other
// test files in the same `bun test` run see the real implementations.
import * as realPluginConfig from "../services/plugin-config.js";
const pluginConfigSnapshot = { ...realPluginConfig };

import type { PluginInfo } from "../types/plugins.js";

const mockGetPluginInfo = mock(async (_cwd: string): Promise<PluginInfo[]> => []);

mock.module("../services/plugin-config.js", () => ({
  getPluginInfo: mockGetPluginInfo,
}));

const { default: plugins } = await import("./plugins.js");

const app = new Hono();
app.route("/", plugins);

const originalCwdEnv = process.env.CWD;

afterAll(() => {
  mock.module("../services/plugin-config.js", () => pluginConfigSnapshot);
  if (originalCwdEnv === undefined) delete process.env.CWD;
  else process.env.CWD = originalCwdEnv;
});

beforeEach(() => {
  mockGetPluginInfo.mockClear();
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
  /*
   * The legacy display list (a filesystem scan plus a fixed list of Claude
   * built-ins) was retired with the backend's global fallback. A current
   * backend reads only `GET /session/:id/commands`; a pre-2.21 backend that
   * asks here with no session gets a 404, which it already handled as "no
   * list".
   */
  test("is retired: the bridge serves no legacy command list", async () => {
    const res = await app.request("/commands");
    expect(res.status).toBe(404);
  });
});
