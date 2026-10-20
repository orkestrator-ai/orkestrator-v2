import { afterEach, describe, expect, test } from "bun:test";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";
import { mergeLifecycle } from "./evidence-ingestion.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  const spool = new ChangeEvidenceSpool();
  const recorder = new ChangeEvidenceRecorder({
    spool,
    provider: "claude",
    capabilities: {
      resolution: "resolved",
      beforeTurn: "controlled-dispatch",
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
  return { h, spool, recorder, source: spoolSource(spool) };
}

function lines(count: number, changeAt = -1): string {
  return Array.from({ length: count }, (_, i) => (i === changeAt ? `x${i}\n` : `l${i}\n`)).join("");
}

function presentation(h: Harness, callId: string) {
  const result = h.service.getToolPresentations({
    environmentId: "env-1",
    provider: "claude",
    conversationId: "s1",
    callIds: [callId],
  });
  const value = result.presentations[callId];
  const projection = (role: string): ChangeProjection | undefined => {
    const change = value?.changes.find((c) => c.role === role);
    return change ? result.projections[change.resourceKey] : undefined;
  };
  return { value, projection };
}

describe("evidence ingestion to projections", () => {
  test("C01: a 100-line replacement proposal measures +1/-1 with input provenance", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "c1" },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: "a.ts",
            before: lines(100),
            after: lines(100, 40),
            extent: "fragment",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    await h.service.pullEvidence(source);
    const { value, projection } = presentation(h, "c1");
    expect(value?.toolKind).toBe("file-edit");
    const payload = projection("payload")!;
    expect(payload.counters.additions).toEqual({ value: 1, quality: "complete", bound: "exact" });
    expect(payload.provenanceLabelKey).toBe("changes.provenance.proposal");
    expect(payload.reasonKeys).toContain("changes.reason.fragment-extent");
  });

  test("C02: a Write without a captured before exposes content length, not counts", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "w1" },
      {
        toolKind: "file-write",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: "w.ts",
            before: undefined,
            after: lines(100),
            extent: "whole-file",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    await h.service.pullEvidence(source);
    const payload = presentation(h, "w1").projection("payload")!;
    expect(payload.counters.additions.value).toBeNull();
    expect(payload.counters.deletions.value).toBeNull();
    expect(payload.labelArgs.contentLines).toBe(100);
    expect(payload.provenanceLabelKey).toBe("changes.provenance.content-only");
  });

  test("C05: repeated cumulative updates and duplicate completion select one revision", async () => {
    const { h, recorder, source } = setup();
    const patch = (body: string) =>
      ["--- a/f", "+++ b/f", "@@ -0,0 +1,1 @@", `+${body}`].join("\n");
    recorder.tool(
      { conversationId: "s1", callId: "p1" },
      {
        toolKind: "file-edit",
        phase: "running",
        executionOccurrence: "started",
        evidence: [{ kind: "patch", key: "p", text: patch("a"), claim: "provider-reported" }],
      },
    );
    const completion = {
      toolKind: "file-edit" as const,
      phase: "succeeded" as const,
      executionOccurrence: "started" as const,
      evidence: [
        { kind: "patch" as const, key: "p", text: patch("b"), claim: "provider-reported" as const },
      ],
    };
    recorder.tool({ conversationId: "s1", callId: "p1" }, completion);
    recorder.tool({ conversationId: "s1", callId: "p1" }, completion);
    await h.service.pullEvidence(source);
    const effect = presentation(h, "p1").projection("effect")!;
    // One line, not one per delivered revision.
    expect(effect.counters.additions.value).toBe(1);
    const measurement = h.service.projections.selectedMeasurement(
      presentation(h, "p1").value!.changes[0]!.resourceKey,
    )!;
    expect(measurement.evidenceRefs).toHaveLength(1);
    expect(measurement.evidenceRefs[0]!.evidenceRevision).toBe(2);
  });

  test("C06: two attempts with identical input stay distinct operations", async () => {
    const { h, recorder, source } = setup();
    for (const callId of ["a1", "a2"]) {
      recorder.tool(
        { conversationId: "s1", callId },
        { toolKind: "shell", phase: "succeeded", executionOccurrence: "started", evidence: [] },
      );
    }
    await h.service.pullEvidence(source);
    const result = h.service.getToolPresentations({
      environmentId: "env-1",
      provider: "claude",
      conversationId: "s1",
      callIds: ["a1", "a2"],
    });
    expect(result.presentations.a1!.operationId).not.toBe(result.presentations.a2!.operationId);
  });

  test("C07: a failed shell that wrote files keeps both facts", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "sh" },
      { toolKind: "shell", phase: "failed", executionOccurrence: "started" },
    );
    recorder.observation(
      { conversationId: "s1", callId: "sh" },
      {
        boundary: { before: "fresh-before", after: "after-terminal" },
        overlap: "none-observed",
        change: {
          additions: 3,
          deletions: 0,
          files: [{ path: "out.txt", status: "A", additions: 3, deletions: 0 }],
        },
      },
    );
    await h.service.pullEvidence(source);
    const { value, projection } = presentation(h, "sh");
    expect(value?.lifecycle.phase).toBe("failed");
    const effect = projection("effect")!;
    expect(effect.counters.additions.value).toBe(3);
    expect(effect.provenanceLabelKey).toBe("changes.provenance.observed-fresh");
    expect(effect.reasonKeys).toContain("changes.reason.failed-with-effect");
  });

  test("H07: an after-start observation is an observation window, not a tool effect", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "ro" },
      { toolKind: "shell", phase: "succeeded", executionOccurrence: "started" },
    );
    recorder.observation(
      { conversationId: "s1", callId: "ro" },
      {
        boundary: { before: "prior-observation", after: "after-terminal" },
        overlap: "none-observed",
        change: {
          additions: 1,
          deletions: 0,
          files: [{ path: "idle-edit.txt", status: "M", additions: 1, deletions: 0 }],
        },
      },
    );
    await h.service.pullEvidence(source);
    const { value } = presentation(h, "ro");
    expect(value?.changes.map((c) => c.role)).toEqual(["observation"]);
  });

  test("C08: a denied edit keeps its proposal and has no applied effect", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "d1" },
      {
        toolKind: "file-edit",
        phase: "denied",
        executionOccurrence: "did-not-run",
        evidence: [
          {
            kind: "replacement",
            path: "a.ts",
            before: "a\n",
            after: "b\n",
            extent: "fragment",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    await h.service.pullEvidence(source);
    const { value } = presentation(h, "d1");
    expect(value?.changes.map((c) => c.role)).toEqual(["payload"]);
  });

  test("terminal phases never regress to running", () => {
    expect(
      mergeLifecycle(
        { phase: "succeeded", occurrence: "started" },
        { phase: "running", occurrence: "started" },
      ).phase,
    ).toBe("succeeded");
    expect(
      mergeLifecycle(
        { phase: "succeeded", occurrence: "started" },
        { phase: "failed", occurrence: "started" },
      ),
    ).toMatchObject({
      phase: "succeeded",
      conflict: "contradictory-terminal",
    });
  });

  test("bodies are released by the bridge only after the backend retained them", async () => {
    const { h, spool, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "b1" },
      {
        toolKind: "file-write",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: "x",
            before: null,
            after: "new\n",
            extent: "whole-file",
            origin: "result",
            claim: "provider-reported",
          },
        ],
      },
    );
    expect(spool.stats().bodies).toBe(1);
    await h.service.pullEvidence(source);
    expect(spool.stats()).toMatchObject({ entries: 0, bodies: 0 });
    const effect = presentation(h, "b1").projection("effect")!;
    expect(effect.counters.additions.value).toBe(1);
    // A second pull ingests nothing new.
    expect(await h.service.pullEvidence(source)).toBe(0);
  });

  test("a recorded stream gap is visible, never accepted evidence", async () => {
    const { h, recorder, source } = setup();
    const small = new ChangeEvidenceSpool({ limits: { maxEntries: 2 } });
    const tiny = new ChangeEvidenceRecorder({
      spool: small,
      provider: "claude",
      capabilities: recorder.capabilities,
    });
    for (let index = 0; index < 4; index++)
      tiny.turn({ conversationId: "s1", turnId: `t${index}` }, "running");
    const gapSource = spoolSource(small);
    await h.service.pullEvidence(gapSource);
    await h.service.pullEvidence(gapSource);
    const bindings = h
      .database()
      .db.query("SELECT COUNT(*) AS n FROM change_evidence_gaps")
      .get() as { n: number };
    expect(bindings.n).toBeGreaterThan(0);
    void source;
  });

  test("V01: two clients reading one resource get the same measurement and file order", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "v1" },
      {
        toolKind: "file-edit",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "patch",
            text: [
              "diff --git a/b b/b",
              "--- a/b",
              "+++ b/b",
              "@@ -1 +1 @@",
              "-x",
              "+y",
              "diff --git a/a b/a",
              "--- a/a",
              "+++ b/a",
              "@@ -1 +1 @@",
              "-x",
              "+y",
            ].join("\n"),
            claim: "provider-reported",
          },
        ],
      },
    );
    await h.service.pullEvidence(source);
    const key = presentation(h, "v1").value!.changes[0]!.resourceKey;
    const first = h.service.getView({ resourceKey: key });
    const second = h.service.getView({ resourceKey: key });
    expect(first).toEqual(second);
    if (first.kind !== "projection") throw new Error("projection expected");
    expect(first.projection.filePage!.rows.map((row) => row.newPathDisplay)).toEqual(["b", "a"]);
    const unchanged = h.service.getView({
      resourceKey: key,
      knownGeneration: first.projection.ownerGeneration,
      knownRevision: first.projection.revision,
    });
    expect(unchanged.kind).toBe("unchanged");
  });

  test("the handoff writes unknown counts as unknown, never zero", async () => {
    const { h, recorder, source } = setup();
    recorder.tool(
      { conversationId: "s1", callId: "hw" },
      {
        toolKind: "file-write",
        phase: "succeeded",
        executionOccurrence: "started",
        evidence: [
          {
            kind: "replacement",
            path: "w.ts",
            before: undefined,
            after: "a\nb\n",
            extent: "whole-file",
            origin: "input",
            claim: "proposal",
          },
        ],
      },
    );
    await h.service.pullEvidence(source);
    const id = presentation(h, "hw").projection("payload")!.measurementId!;
    const { text } = h.service.handoff.serialize([id]);
    expect(text).toContain("+unknown");
    expect(text).toContain("2 content lines");
    expect(text).not.toContain("+0");
  });
});
