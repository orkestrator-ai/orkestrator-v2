import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Snapshot the real session-manager BEFORE installing the route's stub mock.
// Otherwise this stub leaks process-wide and breaks any later test that imports
// the real session-manager (notably services/session-manager.test.ts).
import * as realSessionManager from "../services/session-manager.js";
const realSessionManagerSnapshot = { ...realSessionManager };

const mockGetAvailableModelCatalog = mock(async () => ({
  source: "sdk" as const,
  models: [
    {
      id: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6-20260615",
      name: "Claude Sonnet 4.6",
      description: "Latest model",
      supportsFastMode: true,
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
  ],
}));
const mockGetClaudeRuntimeVersions = mock(async () => ({
  sdkVersion: "0.2.1",
  cliVersion: "5.0.0",
}));

mock.module("../services/session-manager.js", () => ({
  getAvailableModelCatalog: mockGetAvailableModelCatalog,
  getClaudeRuntimeVersions: mockGetClaudeRuntimeVersions,
}));

const { default: config } = await import("./config.js");

const app = new Hono();
app.route("/", config);

afterAll(() => {
  mock.module("../services/session-manager.js", () => realSessionManagerSnapshot);
});

describe("GET /models", () => {
  beforeEach(() => {
    mockGetAvailableModelCatalog.mockClear();
    mockGetClaudeRuntimeVersions.mockClear();
  });

  test("returns the model list from session-manager", async () => {
    const res = await app.request("/models");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(mockGetAvailableModelCatalog).toHaveBeenCalledTimes(1);
    expect(mockGetClaudeRuntimeVersions).toHaveBeenCalledTimes(1);
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      supportsFastMode: true,
    });
    expect(body).toMatchObject({
      source: "sdk",
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
    });
    expect(Date.parse(body.fetchedAt)).not.toBeNaN();
  });

  test("returns an empty list when no models are available", async () => {
    mockGetAvailableModelCatalog.mockImplementationOnce(async () => ({
      models: [],
      source: "fallback",
    }));
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      models: [],
      source: "fallback",
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
    });
  });
});
