import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeEvidenceRecorder } from "./evidence-builders";
import {
  changeEvidenceAckRouteBody,
  changeEvidenceBodyRouteBody,
  changeEvidenceReadBody,
} from "./evidence-routes";
import { collectBodyIds, ChangeEvidenceSpool } from "./evidence-spool";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function recorder(spool: ChangeEvidenceSpool) {
  return new ChangeEvidenceRecorder({
    spool,
    provider: "test",
    capabilities: {
      resolution: "resolved",
      beforeTurn: "observed-after-start",
      afterTurn: "terminal-observed",
      beforeTool: "awaited",
      afterTool: "awaited",
      historicalCallIdentity: "stable",
      fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
      turnDiff: "absent",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
      backgroundCompletion: "launch-only",
    },
  });
}

const query = (values: Record<string, string>) => (name: string) => values[name] ?? null;

describe("change evidence spool", () => {
  test("replayed events dedupe by content-derived frame id (C05 transport side)", () => {
    const spool = new ChangeEvidenceSpool();
    const rec = recorder(spool);
    const event = {
      toolKind: "file-edit" as const,
      phase: "succeeded" as const,
      executionOccurrence: "started" as const,
      evidence: [
        {
          kind: "replacement" as const,
          path: "a.ts",
          before: "x\n",
          after: "y\n",
          extent: "fragment" as const,
          origin: "input" as const,
          claim: "proposal" as const,
        },
      ],
    };
    rec.tool({ conversationId: "s1", callId: "c1" }, event);
    rec.tool({ conversationId: "s1", callId: "c1" }, event);
    const read = spool.read(0);
    expect(read.entries).toHaveLength(1);
    expect(read.capabilities).toHaveLength(1);
  });

  test("unknown, absent and empty sides stay distinct", () => {
    const spool = new ChangeEvidenceSpool();
    const updates = recorder(spool).updates([
      {
        kind: "replacement",
        path: "w.ts",
        before: undefined,
        after: "content\n",
        extent: "whole-file",
        origin: "input",
        claim: "proposal",
      },
      {
        kind: "replacement",
        path: "n.ts",
        before: null,
        after: "",
        extent: "whole-file",
        origin: "input",
        claim: "proposal",
      },
    ]);
    const first = updates[0]!.kind === "replace" ? updates[0]!.evidence : null;
    const second = updates[1]!.kind === "replace" ? updates[1]!.evidence : null;
    expect(first?.kind === "replacement" && first.before.state).toBe("unknown");
    expect(second?.kind === "replacement" && second.before.state).toBe("absent");
    expect(second?.kind === "replacement" && second.after.state).toBe("present");
  });

  test("a changed cumulative patch gets a new revision for the same key", () => {
    const spool = new ChangeEvidenceSpool();
    const rec = recorder(spool);
    const first = rec.updates([
      { kind: "patch", key: "p", text: "a", claim: "provider-reported" },
    ])[0]!;
    const second = rec.updates([
      { kind: "patch", key: "p", text: "ab", claim: "provider-reported" },
    ])[0]!;
    expect(first.evidenceKey).toBe(second.evidenceKey);
    expect(first.revisionKey).not.toBe(second.revisionKey);
  });

  test("bodies are released only after a durable retained acknowledgment", () => {
    const spool = new ChangeEvidenceSpool();
    recorder(spool).tool(
      { conversationId: "s", callId: "c" },
      {
        toolKind: "file-write",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: "f",
            before: undefined,
            after: "body",
            extent: "whole-file",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    const read = changeEvidenceReadBody(spool, query({ cursor: "0" }));
    const entry = read.entries[0]!;
    const frame = entry.type === "frame" ? entry.frame : null;
    const evidence = frame?.event.kind === "tool" ? frame.event.evidence[0] : null;
    const bodyId =
      evidence?.kind === "replace" &&
      evidence.evidence.kind === "replacement" &&
      evidence.evidence.after.state === "present"
        ? evidence.evidence.after.body.id
        : "";
    expect(changeEvidenceBodyRouteBody(spool, query({ id: bodyId })).state).toBe("available");
    // Acknowledging the entry without retaining the body keeps the body.
    expect(
      changeEvidenceAckRouteBody(spool, {
        runtimeEpoch: read.runtimeEpoch,
        upTo: read.nextCursor,
        retainedBodyIds: [],
        unavailableBodyIds: [],
      }),
    ).toEqual({ ok: true, released: 1 });
    expect(spool.readBody(bodyId)).not.toBeNull();
    changeEvidenceAckRouteBody(spool, {
      runtimeEpoch: read.runtimeEpoch,
      upTo: read.nextCursor,
      retainedBodyIds: [bodyId],
      unavailableBodyIds: [],
    });
    expect(spool.readBody(bodyId)).toBeNull();
    expect(changeEvidenceBodyRouteBody(spool, query({ id: bodyId })).state).toBe("missing");
  });

  test("capacity produces an explicit gap frame instead of a silent drop", () => {
    const spool = new ChangeEvidenceSpool({ limits: { maxEntries: 3 } });
    const rec = recorder(spool);
    for (let index = 0; index < 5; index++) {
      rec.turn({ conversationId: "s", turnId: `t${index}` }, "running");
    }
    const first = spool.read(0);
    expect(first.pendingGap).toBe(true);
    spool.acknowledge({
      runtimeEpoch: spool.runtimeEpoch,
      upTo: first.nextCursor,
      retainedBodyIds: [],
      unavailableBodyIds: [],
    });
    const second = spool.read(first.nextCursor);
    const gap = second.entries.find(
      (entry) => entry.type === "frame" && entry.frame.event.kind === "stream-gap",
    );
    expect(gap).toBeDefined();
  });

  test("unacknowledged entries survive a bridge restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ork-spool-"));
    directories.push(directory);
    const first = new ChangeEvidenceSpool({ directory });
    recorder(first).turn({ conversationId: "s", turnId: "t" }, "succeeded", "quiescent");
    await first.flush();
    const restarted = new ChangeEvidenceSpool({ directory });
    const read = restarted.read(0);
    expect(read.entries).toHaveLength(1);
    expect(read.runtimeEpoch).not.toBe(first.runtimeEpoch);
  });

  test("an acknowledgment from another epoch releases nothing", () => {
    const spool = new ChangeEvidenceSpool();
    recorder(spool).turn({ conversationId: "s", turnId: "t" }, "running");
    expect(
      spool.acknowledge({
        runtimeEpoch: "other",
        upTo: 99,
        retainedBodyIds: [],
        unavailableBodyIds: [],
      }),
    ).toEqual({ released: 0 });
    expect(spool.read(0).entries).toHaveLength(1);
  });
});

test("duplicate body frames after ack and rejected invalid/overflow frames release orphan bodies", () => {
  const spool = new ChangeEvidenceSpool({ limits: { maxEntries: 3, maxEntryBytes: 1500 } });
  const rec = recorder(spool);
  const emit = (id: string, text: string) =>
    rec.tool(
      { conversationId: "s", callId: id },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [{ kind: "patch", text, claim: "provider-reported" }],
      },
    );
  emit("c", "patch");
  const read = spool.read(0);
  spool.acknowledge({
    runtimeEpoch: spool.runtimeEpoch,
    upTo: read.nextCursor,
    retainedBodyIds: read.entries.flatMap((e) =>
      e.type === "frame" ? collectBodyIds(e.frame) : [],
    ),
    unavailableBodyIds: [],
  });
  expect(spool.stats().bodyBytes).toBe(0);
  emit("c", "patch");
  expect(spool.stats().bodyBytes).toBe(0);
  // Entry too large, despite a tiny retained body: no zero-reference leak.
  emit("oversized", "different");
  emit("overflow1", "one");
  emit("overflow2", "two");
  const pending = spool.read(0);
  spool.acknowledge({
    runtimeEpoch: spool.runtimeEpoch,
    upTo: pending.nextCursor,
    retainedBodyIds: pending.entries.flatMap((e) =>
      e.type === "frame" ? collectBodyIds(e.frame) : [],
    ),
    unavailableBodyIds: [],
  });
  expect(spool.stats().bodyBytes).toBe(0);
});

test("invalid oversized update arrays record a stream gap and release all bodies", () => {
  const spool = new ChangeEvidenceSpool();
  const rec = recorder(spool);
  const accepted = rec.tool(
    { conversationId: "s", callId: "huge" },
    {
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
      evidence: Array.from({ length: 257 }, (_, i) => ({
        kind: "patch" as const,
        text: `body-${i}`,
        claim: "provider-reported" as const,
      })),
    },
  );
  expect(accepted).toBe(false);
  expect(spool.stats().bodyBytes).toBe(0);
  const gaps = spool
    .read(0)
    .entries.filter((e) => e.type === "frame" && e.frame.event.kind === "stream-gap");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.type === "frame" && gaps[0].frame.event).toMatchObject({
    coverage: { kind: "frames", frameIds: [expect.any(String)] },
  });
});
