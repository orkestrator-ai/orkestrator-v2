import { expect, test } from "bun:test";

import { withTemporaryStorage } from "./storage-test-support.js";

test("2.x workflow sessions are recorded per environment and removed with its sessions", async () => {
  await withTemporaryStorage(async (storage) => {
    const sessions = storage.openCode2Sessions;
    expect(sessions.isOpenCode2Session("env-a", "ses_1")).toBe(false);
    expect(sessions.hasOpenCode2SessionCapacity("env-a")).toBe(true);
    sessions.recordOpenCode2Session("env-a", "ses_1");
    // Recording twice is one entry.
    sessions.recordOpenCode2Session("env-a", "ses_1");
    expect(sessions.isOpenCode2Session("env-a", "ses_1")).toBe(true);
    expect(sessions.isOpenCode2Session("env-b", "ses_1")).toBe(false);
    expect(() => sessions.recordOpenCode2Session("env-a", "not an id")).toThrow(
      "Invalid OpenCode session id",
    );

    await storage.deleteNativeAgentSessionsByEnvironment("env-a");
    expect(sessions.isOpenCode2Session("env-a", "ses_1")).toBe(false);
  });
});
