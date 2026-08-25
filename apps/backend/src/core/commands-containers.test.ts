import { describe, expect, test } from "bun:test";

import { containerServerLogFile } from "./commands-containers.js";

describe("containerServerLogFile", () => {
  test("uses the Pi bridge log for Pi startup diagnostics", () => {
    expect(containerServerLogFile("pi")).toBe("/tmp/pi-bridge.log");
  });

  test("keeps the ACP fallback for ACP-backed servers", () => {
    expect(containerServerLogFile("cursor")).toBe("/tmp/cursor-acp-bridge.log");
    expect(containerServerLogFile("grok")).toBe("/tmp/grok-acp-bridge.log");
  });
});
