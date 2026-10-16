/**
 * Edits made to a source file after its change was saved: a change still in
 * the file keeps applying and is flagged; a change gone from it is retired,
 * and applying it again is refused.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import { EVIDENCE_RECHECK_MS } from "./evidence.js";
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

afterEach(() => {
  fixture.cleanup();
});

const KEY = "env-env-1:tab-a";
const CLAUDE = "home/.claude.json";

function session(agent: AgentPlatform, key = KEY) {
  fixture.sessions.push({
    environmentId: "env-1",
    agent,
    logicalSessionKey: key,
    pendingDispatch: false,
    coordinator: false,
  });
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
      expect(runtime).toMatchObject({ state: "cancelled", reason: CHANGED_OUTSIDE_REASON });
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
    ]);
    expect(states).toEqual([
      ["tab-a", "applied"],
      ["tab-b", "cancelled"],
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
    });
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
