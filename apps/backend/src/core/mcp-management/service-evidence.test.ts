/**
 * Runtime evidence: a planned `pending-next-turn` / `restart-required` runtime
 * becomes `applied` only when its bridge proves it loaded the saved bytes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import {
  EVIDENCE_READS_PER_TICK,
  EVIDENCE_RECHECK_MS,
  EVIDENCE_WINDOW_MS,
  type RuntimeEvidenceRead,
} from "./evidence.js";
import {
  createFixture,
  entry,
  mutation,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.cleanup();
});

const KEY = "env-env-1:tab-a";

function session(
  agent: AgentPlatform,
  key = KEY,
  extra: Partial<Fixture["sessions"][number]> = {},
) {
  fixture.sessions.push({
    environmentId: "env-1",
    agent,
    logicalSessionKey: key,
    pendingDispatch: false,
    coordinator: false,
    ...extra,
  });
}

function digestOf(relative: string): string {
  return `sha256:${createHash("sha256")
    .update(readFileSync(path.join(fixture.root, relative)))
    .digest("base64url")}`;
}

function report(
  agent: AgentPlatform,
  sources: { user?: string; project?: string; local?: string },
  observedAt: number,
  options: { key?: string; scope?: "session" | "process" } = {},
): void {
  const answer: RuntimeEvidenceRead = {
    state: "evidence",
    evidence: {
      sources,
      observedAt: new Date(observedAt).toISOString(),
      scope: options.scope ?? (agent === "grok" ? "process" : "session"),
    },
  };
  fixture.evidence.set(`env-1:${agent}:${options.key ?? KEY}`, answer);
}

async function saveAndApply(provider: AgentPlatform, sourceId: string, name = "fixture") {
  const targetId = await targetIdFor(fixture, provider, "backend");
  const snapshot = await fixture.service.snapshot({ targetId });
  const result = await fixture.service.mutate(
    mutation(
      targetId,
      {
        kind: "add",
        sourceId,
        expectedRevision: revision(snapshot, sourceId),
        definition: { name, transport: "stdio", command: "x" },
      },
      "save-and-apply",
    ),
  );
  return result.operation;
}

async function stateOf(operationId: string): Promise<string[]> {
  return (await fixture.service.getOperation({ operationId })).apply.runtimes.map(
    (runtime) => runtime.state,
  );
}

const USER_FILE: Record<"claude" | "cursor" | "pi" | "grok", string> = {
  claude: "home/.claude.json",
  cursor: "home/.cursor/mcp.json",
  pi: "home/.pi/agent/mcp.json",
  grok: "home/.grok/config.toml",
};

describe("Claude evidence", () => {
  test("a query that started after the save and read its bytes marks the session applied", async () => {
    session("claude");
    const operation = await saveAndApply("claude", "claude:user");
    expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);

    fixture.now.value += 5_000;
    report("claude", { user: digestOf(USER_FILE.claude), project: "absent" }, fixture.now.value);
    await fixture.service.tick();

    const done = await fixture.service.getOperation({ operationId: operation.operationId });
    expect(done.apply.state).toBe("applied");
    expect(done.apply.runtimes[0]).toMatchObject({
      state: "applied",
      reason: expect.stringContaining("latest message"),
    });
    expect(fixture.events.at(-1)?.[1]).toMatchObject({ operationIds: [operation.operationId] });
  });

  test("a query that started before the save stays pending even with matching bytes", async () => {
    session("claude");
    const started = fixture.now.value - 60_000;
    const operation = await saveAndApply("claude", "claude:user");
    report("claude", { user: digestOf(USER_FILE.claude) }, started);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);
  });

  test("a query that read different bytes stays pending", async () => {
    session("claude");
    const operation = await saveAndApply("claude", "claude:user");
    fixture.now.value += 1_000;
    report(
      "claude",
      { user: `sha256:${createHash("sha256").update("older").digest("base64url")}` },
      fixture.now.value,
    );
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);
  });

  test("an older bridge without the field, or a failed read, leaves the plan untouched", async () => {
    session("claude");
    session("claude", "env-env-1:tab-b");
    const operation = await saveAndApply("claude", "claude:user");
    // tab-a: no report at all (the fixture answers `none`); tab-b: the read rejects.
    fixture.evidence.set("env-1:claude:env-env-1:tab-b", new Error("bridge down"));
    await fixture.service.tick();
    expect(fixture.evidenceReads).toEqual([
      "env-1:claude:env-env-1:tab-a",
      "env-1:claude:env-env-1:tab-b",
    ]);
    const after = await fixture.service.getOperation({ operationId: operation.operationId });
    expect(after.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "pending-next-turn",
      "pending-next-turn",
    ]);
    expect(after.apply.state).toBe("pending-next-turn");
    expect(JSON.stringify(after)).not.toContain("bridge down");
  });

  test("absent and excluded reports are not evidence", async () => {
    session("claude");
    const operation = await saveAndApply("claude", "claude:user");
    fixture.now.value += 1_000;
    report("claude", { user: "excluded", project: "excluded" }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);
  });

  test("a later revision still carrying the change counts; one without it does not", async () => {
    session("claude");
    const operation = await saveAndApply("claude", "claude:user");
    // Claude rewrites ~/.claude.json for its own bookkeeping after the save.
    const saved = JSON.parse(fixture.read(USER_FILE.claude));
    fixture.write(USER_FILE.claude, JSON.stringify({ ...saved, numStartups: 42 }, null, 2));
    fixture.now.value += 1_000;
    report("claude", { user: digestOf(USER_FILE.claude) }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["applied"]);

    // A second save whose entry was edited away again before the query read it.
    session("claude", "env-env-1:tab-b");
    const second = await saveAndApply("claude", "claude:user", "second");
    const current = JSON.parse(fixture.read(USER_FILE.claude));
    delete current.mcpServers.second;
    fixture.write(USER_FILE.claude, JSON.stringify(current));
    fixture.now.value += 1_000;
    report("claude", { user: digestOf(USER_FILE.claude) }, fixture.now.value, {
      key: "env-env-1:tab-b",
    });
    await fixture.service.tick();
    const secondStates = await fixture.service.getOperation({ operationId: second.operationId });
    expect(
      secondStates.apply.runtimes.find((runtime) => runtime.runtimeId.endsWith("tab-b"))?.state,
    ).toBe("pending-next-turn");
  });

  test("a project save is proven by the project digest, not the user one", async () => {
    session("claude");
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const result = await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "add",
          sourceId: "claude:project",
          expectedRevision: revision(snapshot, "claude:project"),
          definition: { name: "proj", transport: "http", url: "https://p.example/mcp" },
        },
        "save-and-apply",
      ),
    );
    fixture.now.value += 1_000;
    const projectDigest = digestOf("worktree/.mcp.json");
    report("claude", { user: projectDigest, project: "absent" }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(result.operation.operationId)).toEqual(["pending-next-turn"]);

    fixture.now.value += EVIDENCE_RECHECK_MS;
    report("claude", { user: "absent", project: projectDigest }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(result.operation.operationId)).toEqual(["applied"]);
  });

  test("a private-local save needs a query that also loaded the local map", async () => {
    session("claude");
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const result = await fixture.service.mutate(
      mutation(
        targetId,
        {
          kind: "add",
          sourceId: "claude:local",
          expectedRevision: revision(snapshot, "claude:local"),
          definition: { name: "mine", transport: "stdio", command: "x" },
        },
        "save-and-apply",
      ),
    );
    fixture.now.value += 1_000;
    // The same file, but read under a `user` scope: the local map was skipped.
    report("claude", { user: digestOf(USER_FILE.claude), project: "excluded" }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(result.operation.operationId)).toEqual(["pending-next-turn"]);

    fixture.now.value += EVIDENCE_RECHECK_MS;
    const file = digestOf(USER_FILE.claude);
    report("claude", { user: file, project: "absent", local: file }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(result.operation.operationId)).toEqual(["applied"]);
  });

  test("a removal is proven the same way", async () => {
    session("claude");
    const add = await saveAndApply("claude", "claude:user");
    const snapshot = await fixture.service.snapshot({ targetId: add.targetId });
    const removal = await fixture.service.mutate(
      mutation(
        add.targetId,
        {
          kind: "remove",
          entryId: entry(snapshot, "claude:user", "fixture").entryId,
          expectedRevision: revision(snapshot, "claude:user")!,
        },
        "save-and-apply",
      ),
    );
    fixture.now.value += 1_000;
    report("claude", { user: digestOf(USER_FILE.claude) }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(removal.operation.operationId)).toEqual(["applied"]);
  });
});

describe("Cursor and Pi evidence", () => {
  for (const provider of ["cursor", "pi"] as const) {
    test(`${provider}: a generation built after the save from its bytes is applied`, async () => {
      session(provider);
      const operation = await saveAndApply(provider, `${provider}:user`);
      expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);

      // Still the generation built before the save.
      report(provider, { user: "absent", project: "excluded" }, fixture.now.value - 1_000);
      await fixture.service.tick();
      expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);

      fixture.now.value += EVIDENCE_RECHECK_MS;
      report(
        provider,
        { user: digestOf(USER_FILE[provider]), project: "excluded" },
        fixture.now.value,
      );
      await fixture.service.tick();
      const done = await fixture.service.getOperation({ operationId: operation.operationId });
      expect(done.apply.runtimes[0]).toMatchObject({
        state: "applied",
        reason: expect.stringContaining("rebuilt"),
      });
    });
  }
});

describe("Grok evidence", () => {
  test("process-level evidence counts only from a bridge started after planning", async () => {
    fixture.environment.grokBridgePid = 100;
    session("grok");
    const operation = await saveAndApply("grok", "grok:user");
    expect(await stateOf(operation.operationId)).toEqual(["restart-required"]);

    // The same bridge process: another session's child may still hold the old file.
    fixture.now.value += 1_000;
    report("grok", { user: digestOf(USER_FILE.grok), project: "absent" }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["restart-required"]);
    expect(fixture.evidenceReads).toEqual([]);

    // Restarted: every child of the new bridge spawned after the save.
    fixture.environment.grokBridgePid = 200;
    fixture.now.value += EVIDENCE_RECHECK_MS;
    report("grok", { user: digestOf(USER_FILE.grok), project: "absent" }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["applied"]);
  });

  test("session-scoped or stale evidence from Grok is not accepted", async () => {
    fixture.environment.grokBridgePid = 100;
    session("grok");
    const operation = await saveAndApply("grok", "grok:user");
    fixture.environment.grokBridgePid = 200;
    fixture.now.value += 1_000;
    report("grok", { user: digestOf(USER_FILE.grok) }, fixture.now.value, { scope: "session" });
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["restart-required"]);

    fixture.now.value += EVIDENCE_RECHECK_MS;
    report("grok", { user: digestOf(USER_FILE.grok) }, fixture.now.value - 60_000);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["restart-required"]);
  });
});

describe("bounds and scope", () => {
  test("reads are capped per tick, paced per runtime and stop after the window", async () => {
    const keys = Array.from({ length: EVIDENCE_READS_PER_TICK + 3 }, (_, index) => `tab-${index}`);
    for (const key of keys) session("claude", key);
    const operation = await saveAndApply("claude", "claude:user");
    await fixture.service.tick();
    expect(fixture.evidenceReads.length).toBe(EVIDENCE_READS_PER_TICK);

    // The rest are covered next, before anything is re-read.
    await fixture.service.tick();
    expect(fixture.evidenceReads.length).toBe(keys.length);
    expect(new Set(fixture.evidenceReads).size).toBe(keys.length);

    // Nothing is due again until the recheck interval passes.
    await fixture.service.tick();
    expect(fixture.evidenceReads.length).toBe(keys.length);
    fixture.now.value += EVIDENCE_RECHECK_MS;
    await fixture.service.tick();
    expect(fixture.evidenceReads.length).toBe(keys.length + EVIDENCE_READS_PER_TICK);

    // After the window the runtimes keep their plan and are never read again.
    fixture.now.value += EVIDENCE_WINDOW_MS;
    const before = fixture.evidenceReads.length;
    await fixture.service.tick();
    expect(fixture.evidenceReads.length).toBe(before);
    expect(new Set(await stateOf(operation.operationId))).toEqual(new Set(["pending-next-turn"]));
    // With no queued or evidence work left the scheduler does not rearm.
    const service = fixture.service as unknown as {
      scheduleTick(delay?: number): void;
      timer: ReturnType<typeof setTimeout> | null;
    };
    if (service.timer) clearTimeout(service.timer);
    service.timer = null;
    service.scheduleTick(0);
    expect(service.timer).toBeNull();
  });

  test("the scheduler stays armed while evidence is awaited", async () => {
    session("claude");
    await saveAndApply("claude", "claude:user");
    const service = fixture.service as unknown as { timer: unknown };
    expect(service.timer).not.toBeNull();
  });

  test("containers, coordinators, Codex and OpenCode are never polled", async () => {
    session("claude", "env-env-1:coord", { coordinator: true });
    session("codex", "env-env-1:tab-x");
    session("opencode", "env-env-1:tab-o");
    await saveAndApply("claude", "claude:user");
    await saveAndApply("codex", "codex:user");
    await saveAndApply("opencode", "opencode:user-opencode.json");
    await fixture.service.tick();
    expect(fixture.evidenceReads).toEqual([]);

    fixture.environment.environmentType = "containerized";
    fixture.environment.containerId = "container-1";
    session("claude", "env-env-1:tab-c");
    session("grok", "env-env-1:tab-g");
    fixture.sessions.splice(0, 3);
    await saveAndApply("claude", "claude:user", "container");
    await saveAndApply("grok", "grok:user", "container");
    await fixture.service.tick();
    expect(fixture.evidenceReads).toEqual([]);
  });

  test("the saved digest stays private to the operation record", async () => {
    session("claude");
    const operation = await saveAndApply("claude", "claude:user");
    const digest = digestOf(USER_FILE.claude);
    const stored = JSON.parse(
      readFileSync(path.join(fixture.dataDir, "mcp-management", "operations.json"), "utf8"),
    );
    const record = stored.operations.find(
      (candidate: { snapshot: { operationId: string } }) =>
        candidate.snapshot.operationId === operation.operationId,
    );
    expect(record.recovery).toMatchObject({
      savedDigest: digest,
      evidenceRole: "user",
      writeStartedAt: expect.any(String),
    });
    expect(record.recovery.runtimes[0]).toMatchObject({ awaitsEvidence: true });
    const digestBody = digest.slice("sha256:".length);
    for (const visible of [
      operation,
      await fixture.service.getOperation({ operationId: operation.operationId }),
      await fixture.service.snapshot({ targetId: operation.targetId }),
      fixture.events,
    ]) {
      expect(JSON.stringify(visible)).not.toContain(digestBody);
    }
  });

  test("evidence survives a backend restart and is re-read", async () => {
    session("pi");
    const operation = await saveAndApply("pi", "pi:user");
    fixture.service.dispose();
    fixture.service = fixture.newService();
    // Rehydrated from the record; pacing is in memory, so it is due at once.
    expect(await stateOf(operation.operationId)).toEqual(["pending-next-turn"]);
    fixture.now.value += 1_000;
    report("pi", { user: digestOf(USER_FILE.pi), project: "excluded" }, fixture.now.value);
    await fixture.service.tick();
    expect(await stateOf(operation.operationId)).toEqual(["applied"]);
  });
});
