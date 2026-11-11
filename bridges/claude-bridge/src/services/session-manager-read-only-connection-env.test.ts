import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertClaudeRuntimeAccepts,
  claudeLaunchResourceProfile,
} from "./session-manager-runtime.js";
import {
  nextQueryCall,
  releaseWithBackgroundWork,
  sendPrompt,
  createSession,
  track,
  withTemporaryClaudeHome,
} from "./session-manager-test-harness.js";

/**
 * A read-only turn loads no settings file, so the bridge hands it the user
 * settings' model connection itself (to-do 7565). Driven through the real
 * query plan against a private Claude home; the values are fixtures.
 */
describe("a read-only turn reaches the model the user settings name (to-do 7565)", () => {
  test("gets the settings' connection entries and nothing else from the file", async () => {
    await withTemporaryClaudeHome("claude-read-only-connection-", async (home) => {
      await mkdir(join(home, ".claude"), { recursive: true });
      await writeFile(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          apiKeyHelper: "/bin/echo helper-key",
          hooks: { Stop: [{ hooks: [{ type: "command", command: "touch /tmp/never" }] }] },
          env: {
            ANTHROPIC_BASE_URL: "http://127.0.0.1:47123",
            ANTHROPIC_AUTH_TOKEN: "fixture-settings-token",
            NODE_OPTIONS: "--require /tmp/never.js",
          },
        }),
      );
      const session = createSession("read-only review on a settings-file login");
      track(session.id);
      const review = sendPrompt(session.id, "Review this", { readOnly: true });
      const call = await nextQueryCall();
      expect(call.options.settingSources).toEqual([]);
      expect(call.options.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47123");
      expect(call.options.env?.ANTHROPIC_AUTH_TOKEN).toBe("fixture-settings-token");
      expect(call.options.env?.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS);
      expect(JSON.stringify(call.options)).not.toContain("helper-key");
      expect(JSON.stringify(call.options)).not.toContain("/tmp/never");
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await review;

      // An ordinary turn loads the file itself; the bridge adds nothing.
      const build = sendPrompt(session.id, "Fix it");
      const buildCall = await nextQueryCall();
      expect(buildCall.options.settingSources).toContain("user");
      expect(buildCall.options.env?.ANTHROPIC_AUTH_TOKEN).toBe(process.env.ANTHROPIC_AUTH_TOKEN);
      buildCall.push({ type: "result", subtype: "success" });
      buildCall.finish();
      await build;
    });
  });

  test("a changed connection is a different launch, so a warm CLI on the old one is not joined", () => {
    const before = claudeLaunchResourceProfile([], { ANTHROPIC_BASE_URL: "http://a" });
    const after = claudeLaunchResourceProfile([], { ANTHROPIC_BASE_URL: "http://b" });
    expect(after.credentials).not.toBe(before.credentials);
    expect(JSON.stringify(after)).not.toContain("http://b");
    expect(claudeLaunchResourceProfile([], { PATH: "/a" }).credentials).toBe(
      claudeLaunchResourceProfile([], { PATH: "/b" }).credentials,
    );
  });

  test("a changed settings connection is refused while the warm read-only CLI owes background work", async () => {
    await withTemporaryClaudeHome("claude-read-only-connection-change-", async (home) => {
      await mkdir(join(home, ".claude"), { recursive: true });
      const settingsPath = join(home, ".claude", "settings.json");
      const writeConnection = (url: string) =>
        writeFile(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: url } }));
      await writeConnection("http://127.0.0.1:1");
      const { session, call, firstPrompt } = await releaseWithBackgroundWork(
        "read-only connection change",
        "agent-bg",
        { readOnly: true },
      );
      expect(call.options.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1");
      // The same connection joins the running CLI.
      await assertClaudeRuntimeAccepts(session, { readOnly: true });
      // A longer value, so the stat-validated cache sees a new file.
      await writeConnection("http://127.0.0.1:47123");
      await expect(assertClaudeRuntimeAccepts(session, { readOnly: true })).rejects.toMatchObject({
        code: "conflict",
      });
      expect(JSON.stringify(session.claudeRuntime!.launch)).not.toContain("127.0.0.1:47123");
      call.finish();
      await firstPrompt;
    });
  });
});
