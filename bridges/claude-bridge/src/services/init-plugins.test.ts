import { describe, expect, test } from "bun:test";
import {
  MAX_INIT_PLUGIN_ERRORS,
  MAX_PLUGIN_ERROR_LENGTH,
  pluginStatusesFromInit,
} from "./init-plugins.js";

describe("pluginStatusesFromInit", () => {
  test("lists every plugins[] row as loaded, since the SDK lists only what loaded", () => {
    const { statuses, errors } = pluginStatusesFromInit({
      plugins: [
        { name: "alpha", path: "/plugins/alpha", source: "alpha@market" },
        { name: "beta", path: "/plugins/beta" },
      ],
    });
    expect(statuses).toEqual([
      { name: "alpha", path: "/plugins/alpha", status: "loaded" },
      { name: "beta", path: "/plugins/beta", status: "loaded" },
    ]);
    expect(errors).toEqual([]);
  });

  test("grades plugin-provided MCP servers by their connection", () => {
    const { statuses } = pluginStatusesFromInit({
      mcp_servers: [
        { name: "local", status: "connected" },
        { name: "plugin:up", status: "connected" },
        { name: "plugin:down", status: "failed", error: "offline" },
      ],
    });
    expect(statuses).toEqual([
      { name: "plugin:up", status: "loaded" },
      { name: "plugin:down", status: "failed", error: "offline" },
    ]);
  });

  test("adds a failed row for a plugin that did not load", () => {
    const { statuses, errors } = pluginStatusesFromInit({
      plugins: [],
      plugin_errors: [
        {
          plugin: "inline[0]",
          type: "path-not-found",
          message: "No plugin at /missing",
          path: "/missing",
        },
      ],
    });
    expect(statuses).toEqual([
      { name: "inline[0]", path: "/missing", status: "failed", error: "No plugin at /missing" },
    ]);
    expect(errors).toEqual([
      {
        plugin: "inline[0]",
        type: "path-not-found",
        message: "No plugin at /missing",
        path: "/missing",
        loaded: false,
      },
    ]);
  });

  test("keeps a partially loaded plugin loaded and attaches its first error", () => {
    const { statuses, errors } = pluginStatusesFromInit({
      plugins: [{ name: "gamma", path: "/plugins/gamma" }],
      plugin_errors: [
        { plugin: "gamma@market", type: "hook-load-failed", message: "hooks.json invalid" },
        { plugin: "gamma@market", type: "generic-error", message: "second" },
      ],
    });
    expect(statuses).toEqual([
      { name: "gamma", path: "/plugins/gamma", status: "loaded", error: "hooks.json invalid" },
    ]);
    expect(errors.map((error) => error.loaded)).toEqual([true, true]);
  });

  test("does not match a row that merely shares a name prefix", () => {
    const { statuses } = pluginStatusesFromInit({
      plugins: [{ name: "gam", path: "/plugins/gam" }],
      plugin_errors: [{ plugin: "gamma@market", type: "generic-error", message: "boom" }],
    });
    expect(statuses).toEqual([
      { name: "gam", path: "/plugins/gam", status: "loaded" },
      { name: "gamma@market", status: "failed", error: "boom" },
    ]);
  });

  test("bounds the error list and text, and tolerates malformed entries", () => {
    const { errors } = pluginStatusesFromInit({
      plugin_errors: [
        null,
        "nope",
        { type: "generic-error", message: "no plugin id" },
        ...Array.from({ length: MAX_INIT_PLUGIN_ERRORS + 10 }, (_, index) => ({
          plugin: `p${index}`,
          type: 7,
          message: "x".repeat(MAX_PLUGIN_ERROR_LENGTH * 2),
        })),
      ],
    });
    expect(errors.length).toBeLessThanOrEqual(MAX_INIT_PLUGIN_ERRORS);
    expect(errors[0]).toMatchObject({ plugin: "p0", type: "generic-error" });
    expect(errors[0]?.message).toHaveLength(MAX_PLUGIN_ERROR_LENGTH);
  });

  test("an init from an SDK predating plugin_errors reports nothing failed", () => {
    expect(pluginStatusesFromInit({})).toEqual({ statuses: [], errors: [] });
  });
});
