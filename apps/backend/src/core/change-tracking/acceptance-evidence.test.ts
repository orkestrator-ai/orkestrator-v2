/**
 * Acceptance matrix (§16) cases for evidence, attribution and delivery that
 * cross the adapter → ledger → projection → body/handoff path end to end.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeMeasurement } from "@orkestrator/protocol/change-measurements";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  type ChangeProjection,
  type ChangeProjectionEvent,
} from "@orkestrator/protocol/change-resources";
import {
  ChangeEvidenceRecorder,
  type EvidenceInput,
} from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { OpenCodeChangeEvidence } from "../opencode-change-evidence.js";
import { formatCount } from "./handoff.js";
import {
  operationIdFor,
  operationVolumeResourceKey,
  toolResourceKeys,
  turnResourceKeys,
} from "./identities.js";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function harness(): Harness {
  const created = createHarness();
  harnesses.push(created);
  return created;
}

const CAPABILITIES = {
  resolution: "resolved",
  beforeTurn: "controlled-dispatch",
  afterTurn: "terminal-observed",
  beforeTool: "awaited",
  afterTool: "awaited",
  historicalCallIdentity: "stable",
  fileEvidence: { resolution: "confirmed", kinds: ["replacement", "patch"] },
  turnDiff: "absent",
  captureExecutor: "host-worker",
  captureAvailability: "ready",
  backgroundCompletion: "launch-only",
} as const;

function recorderFor(spool: ChangeEvidenceSpool): ChangeEvidenceRecorder {
  return new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: {
      ...CAPABILITIES,
      fileEvidence: { ...CAPABILITIES.fileEvidence, kinds: [...CAPABILITIES.fileEvidence.kinds] },
    },
  });
}

function replacement(before: string, after: string, path = "a.txt"): EvidenceInput {
  return {
    kind: "replacement",
    path,
    before,
    after,
    extent: "fragment",
    origin: "input",
    claim: "proposal",
  };
}

function view(h: Harness, resourceKey: string): ChangeProjection {
  const result = h.service.getView({ resourceKey });
  if (result.kind !== "projection") throw new Error(`projection expected, got ${result.kind}`);
  return result.projection;
}

function selected(h: Harness, resourceKey: string): ChangeMeasurement {
  const measurement = h.service.projections.selectedMeasurement(resourceKey);
  if (!measurement) throw new Error(`no measurement for ${resourceKey}`);
  return measurement;
}

async function startTurn(
  h: Harness,
  logical: string,
  requestId: string,
  providerSessionId: string,
): Promise<void> {
  await h.service.prepareTurnStart({
    environmentId: "env-1",
    logicalSessionKey: logical,
    requestId,
    provider: "claude",
    providerSessionId,
  });
  h.service.markTurnDispatched("env-1", logical, requestId, "accepted");
}

function finishTurn(h: Harness, logical: string, requestId: string) {
  return h.service.finalizeTurn({ environmentId: "env-1", logicalSessionKey: logical, requestId });
}

// OpenCode 1.19 edit metadata shape, but with the patch only on `metadata.diff`
// (no `filediff` at all). The second hunk adds a source line that begins with
// `++`, which a header-prefix parser would mistake for a `+++` file header.
const OPENCODE_DIFF_ONLY_PATCH = [
  "Index: /repo/src/a.ts",
  "===================================================================",
  "--- /repo/src/a.ts",
  "+++ /repo/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old",
  "+new",
  "+added",
  " tail",
  "@@ -10,2 +11,2 @@",
  " ctx",
  "-gone",
  "+++counter;",
  "",
].join("\n");

describe("C03: a patch delivered only in OpenCode metadata.diff", () => {
  test("C03: badge counters and the diff body come from the same parsed patch", async () => {
    const h = harness();
    const adapter = new OpenCodeChangeEvidence({ location: "host" });
    adapter.observeScoped(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            id: "part-call-1",
            sessionID: "session-1",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "edit",
            state: {
              status: "completed",
              // The proposal differs from the applied patch so a body built
              // from the input (+2/−1) cannot accidentally agree.
              input: { filePath: "/repo/src/a.ts", oldString: "old", newString: "new\nadded" },
              title: "src/a.ts",
              metadata: { diff: OPENCODE_DIFF_ONLY_PATCH },
            },
          },
        },
      },
      new Set(["session-1"]),
    );
    await h.service.pullEvidence(adapter.evidenceSource("env-1", "opencode:c03"));

    const tools = h.service.getToolPresentations({
      environmentId: "env-1",
      provider: "opencode",
      conversationId: "session-1",
      callIds: ["call-1"],
    });
    const presentation = tools.presentations["call-1"]!;
    expect(presentation.changes.map((c) => [c.role, c.prominence])).toEqual([
      ["effect", "primary"],
      ["payload", "secondary"],
    ]);
    const effectKey = presentation.changes[0]!.resourceKey;
    // The summary delivered with the presentation and the full view agree.
    const badge = tools.projections[effectKey]!;
    const projection = view(h, effectKey);
    expect(badge.measurementId).toBe(projection.measurementId);
    expect(projection.counters).toEqual({
      additions: { value: 3, quality: "complete", bound: "exact" },
      deletions: { value: 2, quality: "complete", bound: "exact" },
      changedFiles: 1,
    });
    expect(projection.provenanceLabelKey).toBe("changes.provenance.provider-reported");
    expect(projection.badge).toEqual({ visible: true, mode: "counts" });

    // The body is rendered from the very evidence revision the badge counted.
    const measurement = selected(h, effectKey);
    expect(measurement.evidenceRefs).toHaveLength(1);
    const evidenceRow = h.service.ledger.evidenceRevision(
      measurement.evidenceRefs[0]!.evidenceId,
      measurement.evidenceRefs[0]!.evidenceRevision,
    )!;
    expect(evidenceRow.kind).toBe("patch");
    expect(evidenceRow.evidence_key).toBe("result:patch");

    const body = await h.service.diffBodies.getDiff({
      diffIdentityId: projection.detail!.diffIdentityId,
    });
    if (body.kind !== "body") throw new Error("body expected");
    expect(body.measurement?.measurementId).toBe(projection.measurementId!);
    expect(body.files).toHaveLength(1);
    const lines = body.files[0]!.hunks.flatMap((hunk) => hunk.lines);
    expect(body.files[0]!.hunks).toHaveLength(2);
    expect(lines.filter((line) => line.type === "add").length).toBe(
      projection.counters.additions.value!,
    );
    expect(lines.filter((line) => line.type === "remove").length).toBe(
      projection.counters.deletions.value!,
    );
    expect(lines.filter((line) => line.type === "add").map((line) => line.text)).toContain(
      "++counter;",
    );
    // The file row of the projection names the same file with the same counts.
    const row = projection.filePage!.rows[0]!;
    expect(row.newPathDisplay).toBe(body.files[0]!.newPathDisplay);
    expect([row.additions.value, row.deletions.value]).toEqual([3, 2]);

    // The proposal stays a separate, secondary resource with its own counts.
    const payload = view(h, presentation.changes[1]!.resourceKey);
    expect(payload.provenanceLabelKey).toBe("changes.provenance.proposal");
    expect(payload.measurementId).not.toBe(projection.measurementId);
  });
});

describe("C06: two actual attempts with identical input", () => {
  async function volumeOf(
    h: Harness,
    record: (recorder: ChangeEvidenceRecorder) => void,
  ): Promise<ChangeMeasurement> {
    const spool = new ChangeEvidenceSpool();
    const recorder = recorderFor(spool);
    const logical = "env-env-1:tab";
    await startTurn(h, logical, "r1", "s1");
    record(recorder);
    await h.service.pullEvidence(spoolSource(spool));
    await finishTurn(h, logical, "r1");
    return selected(h, operationVolumeResourceKey(turnIdFor("env-1", logical, "r1")));
  }

  test("C06: two calls with identical input are two operations and two volume contributions", async () => {
    const h = harness();
    const volume = await volumeOf(h, (recorder) => {
      for (const callId of ["e1", "e2"]) {
        recorder.tool(
          { conversationId: "s1", callId },
          {
            toolKind: "file-edit",
            phase: "succeeded",
            executionOccurrence: "started",
            evidence: [replacement("x\n", "y\n")],
          },
        );
      }
    });
    const ids = ["e1", "e2"].map((callId) =>
      operationIdFor({ environmentId: "env-1", provider: "claude", conversationId: "s1", callId }),
    );
    expect(new Set(ids).size).toBe(2);
    const payloads = ids.map((id) => selected(h, toolResourceKeys(id).payload));
    expect(payloads[0]!.measurementId).not.toBe(payloads[1]!.measurementId);
    expect(payloads.map((m) => m.logicalOwner.operationId)).toEqual(ids);
    expect(volume.algorithmPolicyId).toBe("structured-edit-volume-v1");
    expect(volume.totals.additions).toEqual({ value: 2, quality: "complete", bound: "exact" });
    expect(volume.totals.deletions).toEqual({ value: 2, quality: "complete", bound: "exact" });
    expect(volume.totals.touchedFiles).toBe(1);
    expect(volume.evidenceRefs.map((ref) => ref.evidenceId)).toHaveLength(2);
  });

  test("C06: a genuine retry of one call id gets its own attempt and contribution", async () => {
    const h = harness();
    const volume = await volumeOf(h, (recorder) => {
      for (const attemptId of ["try-1", "try-2"]) {
        recorder.tool(
          { conversationId: "s1", callId: "e1", attemptId },
          {
            toolKind: "file-edit",
            phase: "succeeded",
            executionOccurrence: "started",
            evidence: [replacement("x\n", "y\n")],
          },
        );
      }
    });
    const operations = ["try-1", "try-2"].map((attemptId) =>
      h.service.ledger.operation(
        operationIdFor({
          environmentId: "env-1",
          provider: "claude",
          conversationId: "s1",
          callId: "e1",
          attemptId,
        }),
      ),
    );
    expect(operations.map((op) => op?.attempt_id)).toEqual(["try-1", "try-2"]);
    expect(operations[0]!.operation_id).not.toBe(operations[1]!.operation_id);
    expect(volume.totals.additions.value).toBe(2);
    expect(volume.totals.deletions.value).toBe(2);
  });

  test("C06: a redelivered frame of one attempt is not a second contribution", async () => {
    const h = harness();
    const volume = await volumeOf(h, (recorder) => {
      const event = {
        toolKind: "file-edit" as const,
        phase: "succeeded" as const,
        executionOccurrence: "started" as const,
        evidence: [replacement("x\n", "y\n")],
      };
      recorder.tool({ conversationId: "s1", callId: "e1" }, event);
      recorder.tool({ conversationId: "s1", callId: "e1" }, event);
    });
    expect(volume.totals.additions.value).toBe(1);
    expect(volume.totals.deletions.value).toBe(1);
  });
});

describe("C09: native counts disagree with a retained patch", () => {
  const PATCH = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,2 +1,2 @@", " keep", "-x", "+y", ""].join("\n");
  const PATCH_EVIDENCE: EvidenceInput = { kind: "patch", text: PATCH, claim: "provider-reported" };
  const COUNTS_EVIDENCE: EvidenceInput = {
    kind: "reported-counts",
    path: "f.ts",
    additions: 7,
    deletions: 0,
    scope: "file",
    claim: "provider-reported",
  };

  async function ingest(evidence: EvidenceInput[]) {
    const h = harness();
    const spool = new ChangeEvidenceSpool();
    recorderFor(spool).tool(
      { conversationId: "s1", callId: "p1" },
      { toolKind: "file-edit", phase: "succeeded", executionOccurrence: "started", evidence },
    );
    await h.service.pullEvidence(spoolSource(spool));
    const operationId = operationIdFor({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "s1",
      callId: "p1",
    });
    const key = toolResourceKeys(operationId).effect;
    return { h, operationId, key, projection: view(h, key), measurement: selected(h, key) };
  }

  test("C09: the patch is selected, both sources are retained and the reason reaches the projection", async () => {
    const { h, operationId, projection, measurement } = await ingest([
      PATCH_EVIDENCE,
      COUNTS_EVIDENCE,
    ]);
    // Patch outranks the provider's numeric report.
    expect(projection.counters.additions).toEqual({
      value: 1,
      quality: "complete",
      bound: "exact",
    });
    expect(projection.counters.deletions.value).toBe(1);
    expect(measurement.evidenceRefs).toHaveLength(1);
    // The disagreement is stored on the measurement and projected.
    expect(measurement.completeness.reasons).toContain("provider-counts-disagree");
    expect(projection.reasonKeys).toContain("changes.reason.provider-counts-disagree");
    // Both sources stay retained in the ledger.
    const retained = h.service.ledger
      .selectedEvidence("operation", operationId)
      .map((row) => row.kind)
      .sort();
    expect(retained).toEqual(["patch", "reported-counts"]);
    // The handoff carries the same backend-selected counts and the reason.
    const { text } = h.service.handoff.serialize([projection.measurementId!]);
    expect(text).toContain("+1 -1");
    expect(text).toContain("provider-counts-disagree");
    expect(text).not.toContain("+7");
  });

  test("C09: the selection is deterministic regardless of delivery order", async () => {
    const forward = await ingest([PATCH_EVIDENCE, COUNTS_EVIDENCE]);
    const reverse = await ingest([COUNTS_EVIDENCE, PATCH_EVIDENCE]);
    expect(reverse.projection.counters).toEqual(forward.projection.counters);
    expect(reverse.projection.reasonKeys).toEqual(forward.projection.reasonKeys);
    expect(reverse.measurement.evidenceRefs).toEqual(forward.measurement.evidenceRefs);
  });

  test("C09: agreeing counts record no discrepancy", async () => {
    const { projection } = await ingest([
      PATCH_EVIDENCE,
      { ...COUNTS_EVIDENCE, additions: 1, deletions: 1 },
    ]);
    expect(projection.reasonKeys).not.toContain("changes.reason.provider-counts-disagree");
  });
});

describe("H14: reconnect replays inherited fork history", () => {
  test("H14: replaying a forked child's transcript adds no activity and leaves net untouched", async () => {
    const h = harness();
    const parent = "env-env-1:tab";
    const child = "env-env-1:fork";
    const firstSpool = new ChangeEvidenceSpool();
    const firstRecorder = recorderFor(firstSpool);

    // Parent turn: one live edit A → B.
    writeFileSync(join(h.repo, "a.txt"), "one\nA\n");
    await startTurn(h, parent, "p1", "parent");
    writeFileSync(join(h.repo, "a.txt"), "one\nB\n");
    const parentEdit = {
      toolKind: "file-edit" as const,
      phase: "succeeded" as const,
      executionOccurrence: "started" as const,
      evidence: [replacement("A\n", "B\n")],
    };
    firstRecorder.tool({ conversationId: "parent", callId: "e1" }, parentEdit);
    await h.service.pullEvidence(spoolSource(firstSpool));
    await finishTurn(h, parent, "p1");

    h.service.noteFork({
      environmentId: "env-1",
      provider: "claude",
      parentLogicalSessionKey: parent,
      childProviderSessionId: "child",
    });

    // Child turn: the provider first replays the inherited call as history,
    // then the child makes its own live edit B → C.
    await startTurn(h, child, "c1", "child");
    firstRecorder.tool({ conversationId: "child", callId: "e1", mode: "history" }, parentEdit);
    writeFileSync(join(h.repo, "a.txt"), "one\nC\n");
    const childEdit = {
      toolKind: "file-edit" as const,
      phase: "succeeded" as const,
      executionOccurrence: "started" as const,
      evidence: [replacement("B\n", "C\n")],
    };
    firstRecorder.tool({ conversationId: "child", callId: "e2" }, childEdit);
    await h.service.pullEvidence(spoolSource(firstSpool));
    await finishTurn(h, child, "c1");

    const childSegment = h.service.threadResource("env-1", child)!;
    const parentSegment = h.service.threadResource("env-1", parent)!;
    expect(h.service.ledger.segment(childSegment.segmentId)!.inherited_prefix_id).toBe(
      parentSegment.segmentId,
    );
    const childVolumeKey = operationVolumeResourceKey(childSegment.segmentId, "segment");
    const parentVolumeKey = operationVolumeResourceKey(parentSegment.segmentId, "segment");
    const childTurnNet = turnResourceKeys(turnIdFor("env-1", child, "c1"), null).turnNet;
    const before = {
      childVolume: selected(h, childVolumeKey).totals,
      parentVolume: selected(h, parentVolumeKey).totals,
      childThread: selected(h, childSegment.resourceKey).measurementId,
      parentThread: selected(h, parentSegment.resourceKey).measurementId,
      childTurn: selected(h, childTurnNet).measurementId,
    };
    // The inherited call was not counted as the child's own activity.
    expect(before.childVolume.additions.value).toBe(1);
    expect(before.childVolume.deletions.value).toBe(1);
    expect(before.parentVolume.additions.value).toBe(1);
    const inherited = operationIdFor({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "child",
      callId: "e1",
    });
    expect(h.service.ledger.operation(inherited)!.history_mode).toBe("history");
    expect(view(h, toolResourceKeys(inherited).payload).reasonKeys).toContain(
      "changes.reason.history-replay",
    );

    // Reconnect: a new producer epoch replays both transcripts from the start.
    const replaySpool = new ChangeEvidenceSpool();
    const replay = recorderFor(replaySpool);
    replay.tool({ conversationId: "parent", callId: "e1", mode: "history" }, parentEdit);
    replay.tool({ conversationId: "child", callId: "e1", mode: "history" }, parentEdit);
    replay.tool({ conversationId: "child", callId: "e2", mode: "history" }, childEdit);
    // A replayed completion repeated within the same reconnect.
    replay.tool({ conversationId: "child", callId: "e2", mode: "history" }, childEdit);
    await h.service.pullEvidence(spoolSource(replaySpool));
    await h.service.pullEvidence(spoolSource(replaySpool));

    expect(selected(h, childVolumeKey).totals).toEqual(before.childVolume);
    expect(selected(h, parentVolumeKey).totals).toEqual(before.parentVolume);
    expect(selected(h, childSegment.resourceKey).measurementId).toBe(before.childThread);
    expect(selected(h, parentSegment.resourceKey).measurementId).toBe(before.parentThread);
    expect(selected(h, childTurnNet).measurementId).toBe(before.childTurn);
    // The child's own call stays the live operation it was.
    const own = operationIdFor({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "child",
      callId: "e2",
    });
    expect(h.service.ledger.operation(own)!.history_mode).toBe("live");
  });
});

describe("V02/V08: tracking does not depend on a connected client", () => {
  test("V02: a turn completes, measures and projects with no client receiving events", async () => {
    const h = harness();
    // No transport: every delivery attempt fails.
    let attempts = 0;
    (h.service.publisher as unknown as { emit: (event: string, payload: unknown) => void }).emit =
      () => {
        attempts++;
        throw new Error("no client connected");
      };
    const spool = new ChangeEvidenceSpool();
    const recorder = recorderFor(spool);
    const logical = "env-env-1:tab";
    await startTurn(h, logical, "r1", "s1");
    const turnKey = turnResourceKeys(turnIdFor("env-1", logical, "r1"), null).turnNet;
    // What a client would have read had it been mounted before the agent ran.
    const early = h.service.getView({ resourceKey: turnKey });
    if (early.kind !== "projection") throw new Error("projection expected");
    expect(early.projection.measurementId).toBeNull();

    writeFileSync(join(h.repo, "a.txt"), "one\nTWO\n");
    recorder.tool(
      { conversationId: "s1", callId: "e1" },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [replacement("two\n", "TWO\n")],
      },
    );
    await h.service.pullEvidence(spoolSource(spool));
    await finishTurn(h, logical, "r1");
    await Promise.resolve();
    expect(attempts).toBeGreaterThan(0);
    expect(h.events).toHaveLength(0);

    // A client attaching afterwards reads the authoritative result.
    const late = h.service.getView({
      resourceKey: turnKey,
      knownGeneration: early.projection.ownerGeneration,
      knownRevision: early.projection.revision,
    });
    if (late.kind !== "projection") throw new Error(`projection expected, got ${late.kind}`);
    expect(late.projection.revision).toBeGreaterThan(early.projection.revision);
    expect(late.projection.state).toBe("ready");
    expect(late.projection.counters.additions.value).toBe(1);
    expect(late.projection.counters.deletions.value).toBe(1);
    expect(h.service.ledger.turn(turnIdFor("env-1", logical, "r1"))!.lifecycle).toBe("finalized");
    const thread = h.service.threadResource("env-1", logical)!;
    expect(view(h, thread.resourceKey).counters.additions.value).toBe(1);
    const tools = h.service.getToolPresentations({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "s1",
      callIds: ["e1"],
    });
    expect(tools.presentations.e1?.lifecycle.phase).toBe("succeeded");
    // Re-reading at the revision it now holds is cheap and stable.
    expect(
      h.service.getView({
        resourceKey: turnKey,
        knownGeneration: late.projection.ownerGeneration,
        knownRevision: late.projection.revision,
      }).kind,
    ).toBe("unchanged");
  });

  test("V08: pending announcements coalesce to the latest projection per resource", async () => {
    const h = harness();
    const spool = new ChangeEvidenceSpool();
    const recorder = recorderFor(spool);
    recorder.tool(
      { conversationId: "s1", callId: "e1" },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [replacement("x\n", "y\n")],
      },
    );
    await h.service.pullEvidence(spoolSource(spool));
    await Promise.resolve();
    const key = toolResourceKeys(
      operationIdFor({
        environmentId: "env-1",
        provider: "claude",
        conversationId: "s1",
        callId: "e1",
      }),
    ).payload;
    h.events.length = 0;
    for (let index = 0; index < 5; index++) {
      h.service.projections.bump(key);
      h.service.publisher.announce(key);
    }
    await Promise.resolve();
    const events = h.events
      .filter((event) => event.event === CHANGE_PROJECTION_CHANGED_EVENT)
      .map((event) => event.payload as ChangeProjectionEvent)
      .filter((event) => event.kind === "projection" && event.projection.resourceKey === key);
    expect(events).toHaveLength(1);
    const latest = events[0]!;
    if (latest.kind !== "projection") throw new Error("projection expected");
    expect(latest.projection.revision).toBe(h.service.projections.revision(key));
    expect(h.service.publisher.stats().coalesced).toBeGreaterThanOrEqual(4);
  });

  test("V08: a client holding an older owner generation is told to reset", async () => {
    const h = harness();
    const spool = new ChangeEvidenceSpool();
    recorderFor(spool).tool(
      { conversationId: "s1", callId: "e1" },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [replacement("x\n", "y\n")],
      },
    );
    await h.service.pullEvidence(spoolSource(spool));
    const key = toolResourceKeys(
      operationIdFor({
        environmentId: "env-1",
        provider: "claude",
        conversationId: "s1",
        callId: "e1",
      }),
    ).payload;
    const current = view(h, key);
    const result = h.service.getView({
      resourceKey: key,
      knownGeneration: "generation-before-restart",
      knownRevision: current.revision,
    });
    expect(result.kind).toBe("reset");
    if (result.kind !== "reset") return;
    expect(result.projection.measurementId).toBe(current.measurementId);
    expect(result.projection.ownerGeneration).toBe(h.service.generation);
  });
});

describe("V11: handoff from partial and unknown measurements", () => {
  async function observed(observation: Parameters<ChangeEvidenceRecorder["observation"]>[1]) {
    const h = harness();
    const spool = new ChangeEvidenceSpool();
    const recorder = recorderFor(spool);
    recorder.tool(
      { conversationId: "s1", callId: "sh" },
      { toolKind: "shell", phase: "succeeded", executionOccurrence: "started" },
    );
    recorder.observation({ conversationId: "s1", callId: "sh" }, observation);
    await h.service.pullEvidence(spoolSource(spool));
    const tools = h.service.getToolPresentations({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "s1",
      callIds: ["sh"],
    });
    const change = tools.presentations.sh!.changes[0]!;
    return { h, projection: view(h, change.resourceKey) };
  }

  test("V11: partial counts keep their quality in the handoff, matching the UI projection", async () => {
    const { h, projection } = await observed({
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      change: {
        additions: 3,
        deletions: 1,
        files: [{ path: "a.txt", status: "M", additions: 3, deletions: 1 }],
      },
      omittedReasons: ["count-omitted"],
    });
    expect(projection.state).toBe("partial");
    expect(projection.counters.additions).toMatchObject({ value: 3, quality: "partial" });
    const { text, measurementIds } = h.service.handoff.serialize([projection.measurementId!]);
    expect(measurementIds).toEqual([projection.measurementId!]);
    // The same nullable counts and scope the UI shows, with their quality.
    expect(text).toContain(
      `${formatCount("+", projection.counters.additions)} ${formatCount("-", projection.counters.deletions)}`,
    );
    expect(text).toContain("+3 (partial)");
    expect(text).toContain("tool change");
    expect(text).toContain("limits: count-omitted");
    expect(text).not.toMatch(/[+-]0\b/);
  });

  test("V11: an unavailable observation is unknown in the handoff, never zero", async () => {
    const { h, projection } = await observed({
      boundary: { before: "fresh-before", after: "after-terminal" },
      overlap: "none-observed",
      unavailableReason: "capture-timeout",
    });
    expect(projection.counters.additions.value).toBeNull();
    expect(projection.counters.changedFiles).toBeNull();
    const { text } = h.service.handoff.serialize([projection.measurementId!]);
    expect(text).toContain("+unknown -unknown");
    expect(text).toContain("files unknown");
    expect(text).toContain("capture-timeout");
    expect(text).not.toMatch(/[+-]0\b/);
    expect(text).not.toContain("0 files");
  });

  test("V11: a measurement that is no longer retained is reported unavailable", () => {
    const h = harness();
    const { text, measurementIds } = h.service.handoff.serialize(["msr_missing"]);
    expect(measurementIds).toEqual([]);
    expect(text).toContain("unavailable");
    expect(text).not.toMatch(/[+-]0\b/);
  });
});
