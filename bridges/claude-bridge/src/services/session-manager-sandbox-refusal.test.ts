import { afterEach, describe, expect, test } from "bun:test";
import { setClaudeLinuxSandboxStatusForTests } from "@orkestrator/protocol/node/claude-linux-sandbox";
import {
  createSession,
  getSession,
  mockQuery,
  sendPrompt,
  track,
} from "./session-manager-test-harness.js";

const reason =
  "Claude's command sandbox cannot run commands on this host: bubblewrap starts, but AppArmor's bwrap-userns-restrict profile strips capabilities from the user namespace the Claude CLI nests inside it.";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  setClaudeLinuxSandboxStatusForTests({ available: true });
});

describe("a turn that requires a sandbox the host cannot run commands in", () => {
  test("fails with the probe's reason without starting the CLI", async () => {
    // The prompt route refuses this first; a turn that reaches `sendPrompt`
    // another way, or after the host changed, still never starts a CLI whose
    // every Bash call would fail.
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    setClaudeLinuxSandboxStatusForTests({
      available: false,
      failure: "nested-user-namespace",
      reason,
    });
    const session = createSession("sandbox refused");
    track(session.id);
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    };
    const queriesBefore = mockQuery.mock.calls.length;
    await expect(sendPrompt(session.id, "List the files")).rejects.toThrow(reason);
    expect(mockQuery.mock.calls.length).toBe(queriesBefore);
    expect(getSession(session.id)?.status).toBe("error");
    expect(getSession(session.id)?.error).toContain("bwrap-userns-restrict");
  });
});
