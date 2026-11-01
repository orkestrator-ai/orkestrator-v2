import { describe, expect, test } from "bun:test";

import { containerServerLogFile, fetchClaudeBridgeModelCatalog } from "./commands-containers.js";

describe("containerServerLogFile", () => {
  test("uses the Pi bridge log for Pi startup diagnostics", () => {
    expect(containerServerLogFile("pi")).toBe("/tmp/pi-bridge.log");
  });

  test("uses provider-specific bridge logs", () => {
    expect(containerServerLogFile("cursor")).toBe("/tmp/cursor-bridge.log");
    expect(containerServerLogFile("grok")).toBe("/tmp/grok-acp-bridge.log");
  });
});

test("forced model discovery reaches the bridge with its bypass flag", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return Response.json({
      models: [{ id: "haiku", name: "Haiku" }],
      source: "sdk",
      fetchedAt: new Date().toISOString(),
    });
  }) as typeof fetch;
  try {
    await fetchClaudeBridgeModelCatalog(43123, "token", true);
    expect(requested).toBe("http://127.0.0.1:43123/config/models?forceRefresh=true");
  } finally {
    globalThis.fetch = original;
  }
});
