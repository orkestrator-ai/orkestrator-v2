import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// Snapshot the real session-manager BEFORE installing the route's stub mock.
// Otherwise this stub leaks process-wide and breaks any later test that imports
// the real session-manager (notably services/session-manager.test.ts).
import * as realSessionManager from "../services/session-manager.js";
const realSessionManagerSnapshot = { ...realSessionManager };

const mockGetAvailableModels = mock(async () => [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description: "Latest model",
    supportsFastMode: true,
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
]);

mock.module("../services/session-manager.js", () => ({
  getAvailableModels: mockGetAvailableModels,
}));

const { default: config } = await import("./config.js");

const app = new Hono();
app.route("/", config);

afterAll(() => {
  mock.module("../services/session-manager.js", () => realSessionManagerSnapshot);
});

describe("GET /models", () => {
  beforeEach(() => {
    mockGetAvailableModels.mockClear();
  });

  test("returns the model list from session-manager", async () => {
    const res = await app.request("/models");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(mockGetAvailableModels).toHaveBeenCalledTimes(1);
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      supportsFastMode: true,
    });
  });

  test("returns an empty list when no models are available", async () => {
    mockGetAvailableModels.mockImplementationOnce(async () => []);
    const res = await app.request("/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [] });
  });
});
