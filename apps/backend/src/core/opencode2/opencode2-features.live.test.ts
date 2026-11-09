import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { mirrorOpenCode2Credential } from "./credentials.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * The 2.x session features (`features.ts`) against a real pinned 2.x server
 * and a scripted local model: no credentials, no remote calls. Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary.
 *
 * The tests share one server and run in order.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;
// A placeholder; it reaches only the isolated fixture's database.
const FAKE_KEY = "sk-fake-live-mirror-key";

let fixture: OpenCode2Fixture | undefined;
let client: OpenCode2Client | undefined;
let provider: OpenCode2Provider | undefined;

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!, {
    env: { OPENCODE_FLAGS: "todo,-schedules,-background_compaction,-artifacts,-media_blob" },
  });
  // Staged revert restores files from 2.x's snapshots, which track a git worktree.
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: fixture!.directory, stdio: "ignore" });
  await writeFile(path.join(fixture.directory, "undo.txt"), "original\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "seed");
  client = new OpenCode2Client({
    baseUrl: fixture.baseUrl,
    password: fixture.password,
    directory: fixture.directory,
  });
  provider = new OpenCode2Provider(client, { allowedModelProviders: async () => [] });
}, 90_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
});

async function until(read: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

/** Send and wait for the model call it causes and the run to settle. */
async function turn(id: string, prompt: string, options: Record<string, unknown> = {}) {
  const before = fixture!.model.calls.length;
  await provider!.send(id, prompt, { requestId: crypto.randomUUID(), ...options });
  await until(
    async () => fixture!.model.calls.length > before && (await provider!.activity(id)) === "idle",
  );
  return fixture!.model.calls.slice(before);
}

let sessionId = "";

liveTest(
  "the 2.x catalogue offers variants as effort, and a switch reaches the model",
  async () => {
    const p = provider!;
    sessionId = await p.createSession("build", "live", {
      model: "fixture/fixture",
      effort: "high",
    });
    const state = await p.features.sessionState(sessionId);
    const fixtureModel = state.composer?.models.find((model) => model.id === "fixture/fixture");
    expect(fixtureModel?.reasoning?.map((option) => option.id)).toEqual([
      "default",
      "low",
      "medium",
      "high",
    ]);
    expect(state.composer?.selectedReasoningId).toBe("high");
    expect(JSON.stringify(state.composer)).not.toContain("test-key");
    let calls = await turn(sessionId, "effort high", { model: "fixture/fixture", effort: "high" });
    expect(calls[0]?.reasoningEffort).toBe("high");
    calls = await turn(sessionId, "effort low", { model: "fixture/fixture", effort: "low" });
    expect(calls[0]?.reasoningEffort).toBe("low");
    await expect(
      p.send(sessionId, "x", { requestId: "bad-variant", model: "fixture/fixture", effort: "max" }),
    ).rejects.toThrow('no "max" reasoning level');
  },
  90_000,
);

liveTest(
  "a file and an image attachment reach the model",
  async () => {
    await writeFile(path.join(fixture!.directory, "notes.txt"), "LIVE-ATTACHMENT-CONTENT-7\n");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const calls = await turn(sessionId, "read the attachments", {
      images: [{ filename: "dot.png", data: png }],
      attachments: [{ type: "file", path: "notes.txt", filename: "notes.txt" }],
    });
    const content = JSON.stringify(calls[0]?.lastUserContent);
    expect(content).toContain("LIVE-ATTACHMENT-CONTENT-7");
    expect(content).toContain(`data:image/png;base64,${png}`);
  },
  90_000,
);

liveTest(
  "a slash command from the catalogue runs as the server's command",
  async () => {
    const p = provider!;
    const catalogue = await p.commandCatalogue();
    expect(catalogue.status).toBe("ready");
    const review = catalogue.commands.find((command) => command.name === "/review")!;
    expect(review).toMatchObject({ executionKind: "provider-command" });
    const calls = await turn(sessionId, "/review HEAD", {
      allowProviderCommands: true,
      command: {
        id: review.id,
        name: review.name,
        executionKind: "provider-command",
        bindingRevision: review.bindingRevision,
        arguments: "HEAD",
      },
    });
    const text = calls[0]?.userTexts.at(-1) ?? "";
    // The server expanded its own template with the typed arguments.
    expect(text).toContain("code reviewer");
    expect(text).toContain("HEAD");
  },
  90_000,
);

liveTest(
  "Plan mode is the session's agent",
  async () => {
    const p = provider!;
    const calls = await turn(sessionId, "plan this", { executionAgent: "plan" });
    expect((await client!.getSession(sessionId)).agent).toBe("plan");
    expect(JSON.stringify(calls[0]?.userTexts)).toContain("Plan mode");
    expect((await p.features.sessionState(sessionId)).composer?.selectedExecutionProfileId).toBe(
      "plan",
    );
    await turn(sessionId, "build it", { executionAgent: "build" });
    expect((await client!.getSession(sessionId)).agent).toBe("build");
  },
  90_000,
);

liveTest(
  "compact queues a compaction the server runs",
  async () => {
    const p = provider!;
    expect(await p.performSessionAction(sessionId, { kind: "compact" })).toEqual({
      outcome: "applied",
    });
    await until(async () => {
      const rows = (await client!.listMessages(sessionId, { limit: 50 })).messages;
      return (
        rows.some((row) => row.type.includes("compaction")) &&
        (await p.activity(sessionId)) === "idle"
      );
    });
  },
  90_000,
);

liveTest(
  "undo restores the file and hides the turn; redo brings both back",
  async () => {
    const p = provider!;
    const file = path.join(fixture!.directory, "undo.txt");
    await turn(sessionId, "RUN_BASH:printf 'changed\\n' > undo.txt");
    await until(async () => (await readFile(file, "utf8")) === "changed\n");
    const visible = async () =>
      ((await p.messages(sessionId)) as Array<{ type: string; text?: string }>)
        .filter((row) => row.type === "user")
        .map((row) => row.text ?? "");
    expect((await visible()).at(-1)).toContain("RUN_BASH");
    await p.performSessionAction(sessionId, { kind: "undo" });
    expect(await readFile(file, "utf8")).toBe("original\n");
    expect((await visible()).some((text) => text.includes("RUN_BASH"))).toBe(false);
    expect((await p.features.sessionState(sessionId)).notices).toHaveLength(1);
    await p.performSessionAction(sessionId, { kind: "redo" });
    expect(await readFile(file, "utf8")).toBe("changed\n");
    expect((await visible()).at(-1)).toContain("RUN_BASH");
    expect((await p.features.sessionState(sessionId)).notices).toHaveLength(0);
  },
  90_000,
);

liveTest(
  "fork, title and the resume list",
  async () => {
    const p = provider!;
    await p.setSessionTitle(sessionId, "Live features");
    expect((await client!.getSession(sessionId)).metadata).toBeDefined();
    const fork = await p.forkSession(sessionId);
    expect(fork.sessionId).not.toBe(sessionId);
    const listed = (await p.listResumableSessions()).map((entry) => entry.sessionId);
    expect(listed).toContain(`opencode2:${sessionId}`);
    expect(listed).toContain(`opencode2:${fork.sessionId}`);
    expect(await p.resumeSession(`opencode2:${fork.sessionId}`)).toBe(fork.sessionId);
    const titled = (await p.listResumableSessions()).find(
      (entry) => entry.sessionId === `opencode2:${sessionId}`,
    );
    expect(titled?.title).toBe("Live features");
  },
  90_000,
);

liveTest(
  "a mirrored credential connects its provider on 2.x, and its removal disconnects it",
  async () => {
    const p = provider!;
    const connected = async () =>
      ((await p.authStatus()).providers ?? []).some((entry) => entry.id === "anthropic");
    expect(await connected()).toBe(false);
    expect(
      await mirrorOpenCode2Credential(client!, "anthropic", { type: "key", key: FAKE_KEY }),
    ).toBe("written");
    await until(connected, 15_000);
    expect(await mirrorOpenCode2Credential(client!, "anthropic", undefined)).toBe("removed");
    await until(async () => !(await connected()), 15_000);
  },
  60_000,
);
