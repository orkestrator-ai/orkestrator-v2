import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHumanPromptReads } from "../../scripts/human-prompt-reads-live";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const mode of [
  "success",
  "startup",
  "turn-failure",
  "abort",
  "restore-failure",
  "stop-failure",
]) {
  test(`human prompt lifecycle: ${mode}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bg9-lifecycle-"));
    dirs.push(dir);
    const profile = "bg9-lifecycle";
    const out = path.join(dir, "result.json");
    const dataDir = path.join(dir, "profiles", profile, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "..", "profile.json"),
      JSON.stringify({
        id: profile,
        flavor: "agent-test",
        dataDir,
        credentialSources: [],
      }),
    );
    const calls: string[] = [];
    let configDir = "";
    let held = "";
    let working = false;
    const controller = new AbortController();
    const code = await runHumanPromptReads(
      { profile, idleMs: 1, workingMs: 1, out },
      controller.signal,
      {
        spawnSync: (() => ({
          stdout: JSON.stringify({
            status: "ready",
            dataDir,
            testProject: "/fixture",
          }),
        })) as never,
        gatewayFor: (() => ({
          invoke: async (command: string) =>
            command === "get_projects"
              ? [{ id: "project", localPath: "/fixture" }]
              : [
                  {
                    id: "env",
                    environmentType: "local",
                    worktreePath: "/fixture",
                    agentActivityState: working ? "working" : "idle",
                  },
                ],
        })) as never,
        gatewayMetrics: async () => ({
          recurringWork: {
            metrics: {
              kinds: {},
              unattributed: { workUnits: {} },
            },
          },
        }),
        delay: (async () => new Promise<void>((resolve) => setTimeout(resolve, 1))) as never,
        cliRunner: (_profile, config) => {
          configDir = config;
          return async (args) => {
            if (mode === "turn-failure") throw new Error("turn failed");
            if (mode === "abort") {
              controller.abort();
              throw new Error("aborted");
            }
            const prompt = args.at(-1) ?? "";
            const marker = /\[hold:([^\]]+)\]/.exec(prompt);
            if (marker) {
              held = marker[1]!;
              working = true;
            }
            return { status: 0, stdout: JSON.stringify({ result: { sessionId: "session" } }) };
          };
        },
        startFakeAnthropicModel: (async () => {
          calls.push("start");
          if (mode === "startup") throw new Error("startup");
          return {
            origin: "http://127.0.0.1:1",
            calls: () => [{}],
            held: () => [held],
            release: () => {
              calls.push("release");
              working = false;
            },
            stop: async () => {
              calls.push("stop");
              if (mode === "stop-failure") throw new Error("stop");
            },
          };
        }) as never,
        claudeFixture: () => {
          calls.push("fixture");
          return () => {
            calls.push("restore");
            if (mode === "restore-failure") throw new Error("restore");
          };
        },
      },
    );
    expect(code).toBe(mode === "success" ? 0 : 1);
    expect(configDir).not.toBe("");
    expect(existsSync(configDir)).toBe(false);
    const result = JSON.parse(readFileSync(out, "utf8"));
    if (mode === "startup") expect(calls).toEqual(["start"]);
    else {
      expect(calls).toContain("restore");
      expect(calls).toContain("stop");
      expect(calls.indexOf("release")).toBeLessThan(calls.indexOf("stop"));
    }
    if (mode.endsWith("-failure") && mode !== "turn-failure") {
      expect(result.cleanupFailed).toBe(true);
    }
    if (mode === "success") expect(result.windows).toHaveLength(2);
  });
}
