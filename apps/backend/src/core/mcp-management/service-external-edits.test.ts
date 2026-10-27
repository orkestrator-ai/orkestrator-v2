/**
 * Edits made to a source file after its change was saved: a change still in
 * the file keeps applying and is flagged; a change gone from it is retired,
 * and applying it again is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  MCP_MANAGEMENT_LIMITS,
  mcpManagementErrorFromUnknown,
} from "@orkestrator/protocol/mcp-management";

import { EVIDENCE_RECHECK_MS, EVIDENCE_WINDOW_MS } from "./evidence.js";
import { EXTERNAL_EDIT_RECHECK_MS } from "./external-edit-watch.js";
import { McpOperationStore } from "./operations-store.js";
import { CHANGED_OUTSIDE_REASON, MERGED_NOTE, REPLACED_BY_SAVE_REASON } from "./external-edits.js";
import {
  createFixture,
  entry,
  mutation,
  pauseScheduler,
  revision,
  targetIdFor,
  type Fixture,
} from "./test-support.js";

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

const KEY = "env-env-1:tab-a";
const CLAUDE = "home/.claude.json";

function session(agent: AgentPlatform, key = KEY, environmentId = "env-1") {
  fixture.sessions.push({
    environmentId,
    agent,
    logicalSessionKey: key,
    pendingDispatch: false,
    coordinator: false,
  });
}

function environment(id: string) {
  const worktree = path.join(fixture.root, `worktree-${id}`);
  mkdirSync(worktree, { recursive: true });
  fixture.extraEnvironments.push({ ...fixture.environment, id, name: id, worktreePath: worktree });
}

function unlink(relative: string): void {
  rmSync(path.join(fixture.root, relative));
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
  pauseScheduler(fixture);
  return result.operation;
}

/** Edit `~/.claude.json` the way a user or another tool would. */
function editClaude(change: (document: { mcpServers: Record<string, unknown> }) => void): void {
  const document = JSON.parse(fixture.read(CLAUDE));
  change(document);
  fixture.write(CLAUDE, JSON.stringify(document, null, 2));
}

function reportClaude(): void {
  const digest = `sha256:${createHash("sha256")
    .update(readFileSync(path.join(fixture.root, CLAUDE)))
    .digest("base64url")}`;
  fixture.evidence.set(`env-1:claude:${KEY}`, {
    state: "evidence",
    evidence: {
      sources: { user: digest },
      observedAt: new Date(fixture.now.value).toISOString(),
      scope: "session",
    },
  });
}

async function operation(operationId: string) {
  return fixture.service.getOperation({ operationId });
}

describe("a change removed after it was saved", () => {
  test("outside Orkestrator: waiting runtimes are retired, and polling stops", async () => {
    session("claude");
    session("claude", "env-env-1:tab-b");
    const saved = await saveAndApply("claude", "claude:user");
    editClaude((document) => delete document.mcpServers.fixture);
    await fixture.service.tick();
    const retired = await operation(saved.operationId);
    expect(retired.apply.state).toBe("cancelled");
    for (const runtime of retired.apply.runtimes) {
      expect(runtime).toMatchObject({
        state: "cancelled",
        reason: CHANGED_OUTSIDE_REASON,
        cancelReason: "superseded-external",
      });
    }
    // Nothing is left to wait for, so the bridges are not read again.
    const reads = fixture.evidenceReads.length;
    fixture.now.value += EVIDENCE_RECHECK_MS;
    await fixture.service.tick();
    expect(fixture.evidenceReads.length).toBe(reads);
  });

  test("by a later save here: the reason names that save", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    const snapshot = await fixture.service.snapshot({ targetId: saved.targetId });
    await fixture.service.mutate(
      mutation(saved.targetId, {
        kind: "update",
        entryId: entry(snapshot, "claude:user", "fixture").entryId,
        expectedRevision: revision(snapshot, "claude:user")!,
        patch: { env: [{ key: "LATER", edit: { kind: "set", value: "v" } }] },
      }),
    );
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      reason: REPLACED_BY_SAVE_REASON,
      cancelReason: "superseded-local",
    });
  });

  test("a runtime that loaded the change before it was removed stays applied", async () => {
    session("claude");
    session("claude", "env-env-1:tab-b");
    const saved = await saveAndApply("claude", "claude:user");
    fixture.now.value += 1_000;
    reportClaude();
    editClaude((document) => delete document.mcpServers.fixture);
    await fixture.service.tick();
    const states = (await operation(saved.operationId)).apply.runtimes.map((runtime) => [
      runtime.runtimeId.endsWith("tab-a") ? "tab-a" : "tab-b",
      runtime.state,
      runtime.cancelReason,
    ]);
    expect(states).toEqual([
      ["tab-a", "applied", undefined],
      ["tab-b", "cancelled", "superseded-external"],
    ]);
  });

  test("applying it again is refused and changes nothing", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    await fixture.service.tick();
    editClaude((document) => delete document.mcpServers.fixture);
    const before = fixture.read(CLAUDE);
    const refused = await fixture.service
      .apply({ operationId: saved.operationId })
      .catch((error: unknown) => error);
    const detail = mcpManagementErrorFromUnknown(refused);
    expect(detail?.code).toBe("revision-conflict");
    expect(detail?.message).toBe(CHANGED_OUTSIDE_REASON);
    expect(fixture.read(CLAUDE)).toBe(before);
  });

  test("a queued Codex reload is cancelled instead of run", async () => {
    session("codex");
    fixture.activity.set(`env-1:codex:${KEY}`, "working");
    const saved = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.state).toBe("queued");
    fixture.write("home/.codex/config.toml", "");
    fixture.activity.set(`env-1:codex:${KEY}`, "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    expect((await operation(saved.operationId)).apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      reason: CHANGED_OUTSIDE_REASON,
      cancelReason: "superseded-external",
    });
  });

  test("a Codex app-server that already reloaded it keeps its state", async () => {
    environment("env-2");
    session("codex");
    session("codex", "env-env-2:tab-b", "env-2");
    fixture.activity.set("env-2:codex:env-env-2:tab-b", "working");
    const saved = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
    fixture.write("home/.codex/config.toml", "");
    fixture.activity.set("env-2:codex:env-env-2:tab-b", "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
    const states = (await operation(saved.operationId)).apply.runtimes.map((runtime) => [
      runtime.environmentId,
      runtime.state,
      runtime.cancelReason,
    ]);
    expect(states).toEqual([
      ["env-1", "pending-next-turn", undefined],
      ["env-2", "cancelled", "superseded-external"],
    ]);
  });

  test("restoring the change outside Orkestrator lets it apply again, without the reason", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    const original = fixture.read(CLAUDE);
    editClaude((document) => delete document.mcpServers.fixture);
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.runtimes[0]!.cancelReason).toBe(
      "superseded-external",
    );
    fixture.write(CLAUDE, original);
    const replanned = await fixture.service.apply({ operationId: saved.operationId });
    expect(replanned.apply.runtimes[0]!.state).toBe("pending-next-turn");
    expect(replanned.apply.runtimes[0]!.cancelReason).toBeUndefined();
  });
});

describe("a source file deleted after the save", () => {
  test("waiting runtimes are retired, and applying again is refused", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    unlink(CLAUDE);
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      reason: CHANGED_OUTSIDE_REASON,
      cancelReason: "superseded-external",
    });
    const refused = await fixture.service
      .apply({ operationId: saved.operationId })
      .catch((error: unknown) => error);
    expect(mcpManagementErrorFromUnknown(refused)?.code).toBe("revision-conflict");
  });

  test("a queued Codex reload is cancelled instead of run", async () => {
    session("codex");
    fixture.activity.set(`env-1:codex:${KEY}`, "working");
    const saved = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    unlink("home/.codex/config.toml");
    fixture.activity.set(`env-1:codex:${KEY}`, "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    expect((await operation(saved.operationId)).apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      cancelReason: "superseded-external",
    });
  });

  test("a removal is still in it, so it keeps applying", async () => {
    session("claude");
    const added = await saveAndApply("claude", "claude:user");
    const snapshot = await fixture.service.snapshot({ targetId: added.targetId });
    const removal = await fixture.service.mutate(
      mutation(
        added.targetId,
        {
          kind: "remove",
          entryId: entry(snapshot, "claude:user", "fixture").entryId,
          expectedRevision: revision(snapshot, "claude:user")!,
        },
        "save-and-apply",
      ),
    );
    pauseScheduler(fixture);
    unlink(CLAUDE);
    await fixture.service.tick();
    const kept = await operation(removal.operation.operationId);
    expect(kept.apply.runtimes[0]!.state).toBe("pending-next-turn");
    expect(kept.apply.runtimes[0]!.cancelReason).toBeUndefined();
    const again = await fixture.service.apply({ operationId: removal.operation.operationId });
    expect(again.apply.runtimes[0]!.state).toBe("pending-next-turn");
  });
});

describe("cancellations a retry can still apply", () => {
  test("a user cancel and a newer apply's supersession carry no cancel reason", async () => {
    session("codex");
    fixture.activity.set(`env-1:codex:${KEY}`, "working");
    const cancelled = await saveAndApply("codex", "codex:user");
    const byUser = await fixture.service.cancelApply({ operationId: cancelled.operationId });
    expect(byUser.apply.runtimes[0]!.state).toBe("cancelled");
    expect(byUser.apply.runtimes[0]!.cancelReason).toBeUndefined();

    const first = await saveAndApply("codex", "codex:user", "first");
    await saveAndApply("codex", "codex:user", "second");
    const covered = (await operation(first.operationId)).apply.runtimes[0]!;
    expect(covered.state).toBe("cancelled");
    expect(covered.reason).toContain("Superseded by a newer change");
    expect(covered.cancelReason).toBeUndefined();
  });
});

describe("a change still in a file that changed after it was saved", () => {
  test("another server added outside Orkestrator: flagged, and evidence still counts", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    editClaude((document) => {
      document.mcpServers.other = { type: "stdio", command: "y" };
    });
    await fixture.service.tick();
    const flagged = await operation(saved.operationId);
    expect(flagged.message).toBe(MERGED_NOTE);
    expect(flagged.apply.runtimes[0]!.state).toBe("pending-next-turn");

    // The session loads the file as it is now, outside edit included.
    fixture.now.value += EVIDENCE_RECHECK_MS;
    reportClaude();
    await fixture.service.tick();
    const applied = await operation(saved.operationId);
    expect(applied.apply.runtimes[0]!.state).toBe("applied");
    // Flagged once, not on every pass.
    expect(applied.message).toBe(MERGED_NOTE);
  });

  test("bookkeeping outside the server list is not an edit", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    const document = JSON.parse(fixture.read(CLAUDE));
    fixture.write(CLAUDE, JSON.stringify({ ...document, numStartups: 42 }));
    await fixture.service.tick();
    const unchanged = await operation(saved.operationId);
    expect(unchanged.message).toBeUndefined();
    expect(unchanged.apply.runtimes[0]!.state).toBe("pending-next-turn");
  });

  test("a later save here is its own operation, so it is not flagged", async () => {
    session("claude");
    const saved = await saveAndApply("claude", "claude:user");
    await saveAndApply("claude", "claude:user", "second");
    await fixture.service.tick();
    expect((await operation(saved.operationId)).message).toBeUndefined();
  });

  test("a queued Codex reload goes ahead and says the file changed", async () => {
    session("codex");
    fixture.activity.set(`env-1:codex:${KEY}`, "working");
    const saved = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    const config = fixture.read("home/.codex/config.toml");
    fixture.write("home/.codex/config.toml", `${config}\n[mcp_servers.other]\ncommand = "y"\n`);
    fixture.activity.set(`env-1:codex:${KEY}`, "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
    const reloaded = await operation(saved.operationId);
    expect(reloaded.message).toBe(MERGED_NOTE);
    expect(reloaded.apply.runtimes[0]!.state).toBe("pending-next-turn");
  });

  test("applying it again goes ahead and says the file changed", async () => {
    session("codex");
    const saved = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
    const config = fixture.read("home/.codex/config.toml");
    fixture.write("home/.codex/config.toml", `${config}\n[mcp_servers.other]\ncommand = "y"\n`);
    const again = await fixture.service.apply({ operationId: saved.operationId });
    expect(again.message).toBe(MERGED_NOTE);
    expect(again.apply.state).toBe("queued");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1", "env-1"]);
  });
});

describe("waiting runtimes no evidence pass polls", () => {
  const OPENCODE = "home/.config/opencode/opencode.json";

  function editOpencode(change: (mcp: Record<string, unknown>) => void): void {
    const document = JSON.parse(fixture.read(OPENCODE));
    change(document.mcp);
    fixture.write(OPENCODE, JSON.stringify(document, null, 2));
  }

  test.each(["count", "bytes"] as const)(
    "OpenCode watch survives %s pressure and restart, then retires an outside edit",
    async (pressure) => {
      session("opencode");
      const saved = await saveAndApply("opencode", "opencode:user-opencode.json");
      fixture.service.dispose();
      const file = path.join(fixture.dataDir, "mcp-management/operations.json");
      const history = new McpOperationStore(
        file,
        async () => Buffer.alloc(32),
        () => fixture.now.value,
      );
      await history.load();
      const original = history.get(saved.operationId)!;
      const count = pressure === "count" ? MCP_MANAGEMENT_LIMITS.retainedOperations + 5 : 25;
      const finishedIds: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const finished = structuredClone(original);
        finished.snapshot.operationId = `finished-${index}`;
        finished.snapshot.requestId = `finished-request-${index}`;
        finished.snapshot.apply = { state: "not-requested", runtimes: [], omitted: 0 };
        if (pressure === "bytes") finished.snapshot.message = "m".repeat(200 * 1024);
        finishedIds.push(finished.snapshot.operationId);
        await history.put(finished);
      }
      expect(history.get(saved.operationId)).toBeDefined();
      expect(history.get(finishedIds[0]!)).toBeUndefined();
      expect(history.list().length).toBeLessThanOrEqual(MCP_MANAGEMENT_LIMITS.retainedOperations);
      expect(readFileSync(file).byteLength).toBeLessThanOrEqual(
        MCP_MANAGEMENT_LIMITS.operationStoreMaxBytes,
      );

      fixture.service = fixture.newService();
      await fixture.service.init();
      pauseScheduler(fixture);
      expect((await operation(saved.operationId)).apply.state).toBe("restart-required");
      editOpencode((mcp) => delete mcp.fixture);
      await fixture.service.tick();
      expect((await operation(saved.operationId)).apply.runtimes[0]).toMatchObject({
        state: "cancelled",
        cancelReason: "superseded-external",
      });
    },
  );

  test("restart arms the scheduler for external edits alone, and expiry leaves it idle", async () => {
    session("opencode");
    const saved = await saveAndApply("opencode", "opencode:user-opencode.json");
    fixture.service.dispose();
    fixture.service = fixture.newService();
    await fixture.service.init();
    const scheduler = fixture.service as unknown as { timer: ReturnType<typeof setTimeout> | null };
    expect(scheduler.timer).not.toBeNull();
    pauseScheduler(fixture);
    expect((await operation(saved.operationId)).apply.state).toBe("restart-required");
    expect(fixture.evidenceReads).toEqual([]);
    expect(fixture.reloads).toEqual([]);

    fixture.service.dispose();
    fixture.now.value += EVIDENCE_WINDOW_MS + 1;
    fixture.service = fixture.newService();
    await fixture.service.init();
    expect((fixture.service as unknown as typeof scheduler).timer).toBeNull();
  });

  test("container restart-required watches the host source of its saved change", async () => {
    fixture.environment.environmentType = "containerized";
    session("codex");
    const saved = await saveAndApply("codex", "codex:user");
    expect(saved.apply.runtimes[0]!.state).toBe("restart-required");
    fixture.write("home/.codex/config.toml", "");
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      cancelReason: "superseded-external",
    });
    expect(fixture.reloads).toEqual([]);
  });

  test("mixed local queued and container restart-required: watch resumes after the local reload", async () => {
    environment("env-2");
    fixture.extraEnvironments[0]!.environmentType = "containerized";
    session("codex");
    session("codex", "env-env-2:tab-b", "env-2");
    fixture.activity.set(`env-1:codex:${KEY}`, "working");
    const saved = await saveAndApply("codex", "codex:user");
    expect(saved.apply.runtimes.map((runtime) => runtime.state)).toEqual([
      "queued",
      "restart-required",
    ]);
    await fixture.service.tick();
    expect(fixture.reloads).toEqual([]);
    fixture.activity.set(`env-1:codex:${KEY}`, "idle");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
    fixture.write("home/.codex/config.toml", "");
    fixture.now.value += EXTERNAL_EDIT_RECHECK_MS;
    await fixture.service.tick();
    const runtimes = (await operation(saved.operationId)).apply.runtimes;
    expect(runtimes[0]).toMatchObject({ state: "pending-next-turn" });
    expect(runtimes[0]!.cancelReason).toBeUndefined();
    expect(runtimes[1]).toMatchObject({ state: "cancelled", cancelReason: "superseded-external" });
    expect(fixture.reloads).toEqual(["env-1"]);
  });

  test("OpenCode restart-required: retired on the watch's slow cadence", async () => {
    session("opencode");
    const saved = await saveAndApply("opencode", "opencode:user-opencode.json");
    expect(saved.apply.runtimes[0]!.state).toBe("restart-required");
    // A first pass reads the file as the save left it.
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.runtimes[0]!.state).toBe("restart-required");

    editOpencode((mcp) => delete mcp.fixture);
    await fixture.service.tick();
    // Not read again before its recheck interval.
    expect((await operation(saved.operationId)).apply.runtimes[0]!.state).toBe("restart-required");
    fixture.now.value += EXTERNAL_EDIT_RECHECK_MS;
    await fixture.service.tick();
    const retired = await operation(saved.operationId);
    expect(retired.apply.state).toBe("cancelled");
    expect(retired.apply.runtimes[0]).toMatchObject({
      state: "cancelled",
      reason: CHANGED_OUTSIDE_REASON,
      cancelReason: "superseded-external",
    });
  });

  test("OpenCode restart-required: a change still in the file is flagged, not retired", async () => {
    session("opencode");
    const saved = await saveAndApply("opencode", "opencode:user-opencode.json");
    editOpencode((mcp) => (mcp.other = { type: "local", command: ["y"] }));
    await fixture.service.tick();
    const flagged = await operation(saved.operationId);
    expect(flagged.apply.runtimes[0]!.state).toBe("restart-required");
    expect(flagged.message).toContain(MERGED_NOTE);
  });

  test("Codex pending-next-turn after its reload is held, so the watch leaves it", async () => {
    session("codex");
    const saved = await saveAndApply("codex", "codex:user");
    await fixture.service.tick();
    expect(fixture.reloads).toEqual(["env-1"]);
    // The app-server loaded the change at its reload and keeps it until its
    // next one, so a later removal neither retires it nor flags the file.
    fixture.write("home/.codex/config.toml", "");
    fixture.now.value += EXTERNAL_EDIT_RECHECK_MS;
    await fixture.service.tick();
    const held = await operation(saved.operationId);
    expect(held.apply.runtimes[0]).toMatchObject({ state: "pending-next-turn" });
    expect(held.apply.runtimes[0]!.cancelReason).toBeUndefined();
    expect(held.message ?? "").not.toContain(MERGED_NOTE);
  });

  test("the watch stops once the apply window has passed", async () => {
    session("opencode");
    const saved = await saveAndApply("opencode", "opencode:user-opencode.json");
    fixture.now.value += EVIDENCE_WINDOW_MS + 1;
    editOpencode((mcp) => delete mcp.fixture);
    await fixture.service.tick();
    expect((await operation(saved.operationId)).apply.runtimes[0]!.state).toBe("restart-required");
  });
});
