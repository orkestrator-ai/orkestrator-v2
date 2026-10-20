import { describe, expect, test } from "bun:test";
import type { EvidenceBodyRef, ProviderEvidence } from "../../change-evidence";
import {
  addLineCounts,
  exactCount,
  measurementIssues,
  unknownCount,
} from "../../change-measurements";
import { combineEvidenceMeasurements, measureEvidence } from "./evidence-measure";
import {
  findCountDiscrepancies,
  selectToolEvidence,
  type EvidenceCandidate,
} from "./evidence-selection";

const bodies = new Map<string, Uint8Array>();
function body(text: string, complete = true): EvidenceBodyRef {
  const id = `b${bodies.size}`;
  bodies.set(id, new TextEncoder().encode(text));
  return { id, state: "available", retainedBytes: text.length, complete };
}
const read = (id: string) => bodies.get(id) ?? null;

function lines(count: number, changeAt = -1): string {
  return Array.from({ length: count }, (_, i) => (i === changeAt ? `x${i}\n` : `l${i}\n`)).join("");
}

describe("measureEvidence", () => {
  test("C01: paired replacement uses the minimal edit script", () => {
    const result = measureEvidence(
      {
        kind: "replacement",
        path: "a",
        before: { state: "present", body: body(lines(100)) },
        after: { state: "present", body: body(lines(100, 7)) },
        extent: "fragment",
        origin: "input",
        effectClaim: "proposal",
      },
      read,
    );
    expect(result.additions).toEqual(exactCount(1));
    expect(result.deletions).toEqual(exactCount(1));
    expect(result.origin).toBe("input-fragments");
    expect(result.reasons).toContain("fragment-extent");
  });

  test("C02: a write with unknown prior content exposes only its length", () => {
    const result = measureEvidence(
      {
        kind: "replacement",
        path: "w",
        before: { state: "unknown", reason: "before-not-supplied" },
        after: { state: "present", body: body(lines(100)) },
        extent: "whole-file",
        origin: "input",
        effectClaim: "proposal",
      },
      read,
    );
    expect(result.origin).toBe("content-only");
    expect(result.contentLines).toBe(100);
    expect(result.additions).toEqual(unknownCount());
    expect(result.deletions).toEqual(unknownCount());
  });

  test("C02: established absence makes a verified creation", () => {
    const result = measureEvidence(
      {
        kind: "replacement",
        path: "n",
        before: { state: "absent" },
        after: { state: "present", body: body("a\nb\n") },
        extent: "whole-file",
        origin: "result",
        effectClaim: "provider-reported",
      },
      read,
    );
    expect(result.additions).toEqual(exactCount(2));
    expect(result.deletions).toEqual(exactCount(0));
    expect(result.files[0]!.status).toBe("added");
  });

  test("C03: counts and hunks of a patch come from the same parse", () => {
    const patch = ["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n");
    const result = measureEvidence(
      { kind: "patch", body: body(patch), format: "git_unified", effectClaim: "provider-reported" },
      read,
      { withHunks: true },
    );
    expect(result.additions).toEqual(exactCount(1));
    expect(result.deletions).toEqual(exactCount(1));
    const rendered = result.files[0]!.hunks!.flatMap((h) => h.lines);
    expect(rendered.filter((l) => l.type === "add")).toHaveLength(1);
  });

  test("C10: binary changes keep file identity with not-applicable text counts", () => {
    const patch = ["diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ"].join(
      "\n",
    );
    const result = measureEvidence(
      { kind: "patch", body: body(patch), format: "git_unified", effectClaim: "provider-reported" },
      read,
    );
    expect(result.changedFiles).toBe(1);
    expect(result.files[0]!.additions.quality).toBe("not-applicable");
  });

  test("C11: a truncated patch body is partial, not exact", () => {
    const patch = ["--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const result = measureEvidence(
      { kind: "patch", body: body(patch, false), format: "git_unified", effectClaim: "proposal" },
      read,
    );
    expect(result.additions.quality).toBe("partial");
    expect(result.reasons).toContain("patch-body-truncated");
  });

  test("an unavailable body is unknown, never zero", () => {
    const result = measureEvidence(
      {
        kind: "patch",
        body: {
          id: "gone",
          state: "unavailable",
          retainedBytes: 0,
          complete: false,
          unavailableReason: "expired",
        },
        format: "git_unified",
        effectClaim: "proposal",
      },
      read,
    );
    expect(result.additions.value).toBeNull();
    expect(result.reasons).toEqual(["expired"]);
  });

  test("known additions with unknown deletions stay independent", () => {
    const result = measureEvidence(
      {
        kind: "reported-counts",
        path: "c",
        additions: 10,
        deletions: null,
        scope: "file",
        effectClaim: "provider-reported",
      },
      read,
    );
    expect(result.additions).toEqual(exactCount(10));
    expect(result.deletions).toEqual(unknownCount());
  });

  test("combining an unknown member makes the total partial", () => {
    expect(addLineCounts(exactCount(3), unknownCount())).toEqual({
      value: 3,
      quality: "partial",
      bound: "none",
    });
    const combined = combineEvidenceMeasurements([
      measureEvidence(
        {
          kind: "reported-counts",
          path: "x",
          additions: 1,
          deletions: 1,
          scope: "file",
          effectClaim: "proposal",
        },
        read,
      ),
      measureEvidence(
        { kind: "path-operation", path: "y", operation: "delete", effectClaim: "proposal" },
        read,
      ),
    ]);
    expect(combined.additions.quality).toBe("partial");
    expect(combined.changedFiles).toBe(2);
  });
});

function candidate(evidence: ProviderEvidence, key: string, revision = 1): EvidenceCandidate {
  return { evidenceId: `e-${key}`, evidenceRevision: revision, evidenceKey: key, evidence };
}

describe("selectToolEvidence", () => {
  const patch: ProviderEvidence = {
    kind: "patch",
    body: body(["--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b"].join("\n")),
    format: "git_unified",
    effectClaim: "provider-reported",
  };
  const counts: ProviderEvidence = {
    kind: "reported-counts",
    additions: 9,
    deletions: 9,
    scope: "tool",
    effectClaim: "provider-reported",
  };
  const proposal: ProviderEvidence = {
    kind: "replacement",
    path: "f",
    before: { state: "present", body: body("a\n") },
    after: { state: "present", body: body("b\n") },
    extent: "fragment",
    origin: "input",
    effectClaim: "proposal",
  };

  test("proposal and reported result never compete; a patch outranks counts", () => {
    const selection = selectToolEvidence(
      [candidate(patch, "p"), candidate(counts, "c"), candidate(proposal, "r")],
      { phase: "succeeded", executionOccurrence: "started" },
    );
    expect(selection.effect?.kind).toBe("patch");
    expect(selection.payload?.kind).toBe("replacement");
  });

  test("C08: a denied operation has a payload and no applied effect", () => {
    const selection = selectToolEvidence([candidate(proposal, "r"), candidate(patch, "p")], {
      phase: "denied",
      executionOccurrence: "did-not-run",
    });
    expect(selection.effect).toBeNull();
    expect(selection.payload).not.toBeNull();
  });

  test("C09: disagreeing native counts are retained as a discrepancy", () => {
    const candidates = [candidate(patch, "p"), candidate(counts, "c")];
    const selection = selectToolEvidence(candidates, {
      phase: "succeeded",
      executionOccurrence: "started",
    });
    const measured = measureEvidence(patch, read);
    const discrepancies = findCountDiscrepancies(selection.effect!, measured, candidates);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]!.reported).toEqual({ additions: 9, deletions: 9 });
  });
});

describe("measurement validation", () => {
  const base = {
    schemaVersion: 1,
    measurementId: "m",
    worktreeId: "w",
    worktreeIncarnation: "i",
    scope: "tool-payload",
    logicalOwner: { operationId: "o" },
    baselineVersion: null,
    beforeSnapshotId: null,
    afterSnapshotId: null,
    evidenceRefs: [{ evidenceId: "e", evidenceRevision: 1 }],
    capabilityRevision: null,
    origin: "input-fragments",
    algorithmPolicyId: "raw-lines-v1",
    representationPolicyId: "provider-payload-v1",
    execution: "succeeded",
    executionOccurrence: "started",
    effectClaim: "proposal",
    finality: "final",
    consistency: "unknown",
    boundary: { before: "not-applicable", after: "not-applicable" },
    attribution: { basis: "proposal", writerIsolation: "unknown", overlap: "unknown" },
    completeness: { files: "complete", reasons: [], omittedFileCount: 0 },
    totals: { additions: exactCount(1), deletions: unknownCount(), changedFiles: 1 },
    diffIdentityId: null,
    createdAt: new Date(0).toISOString(),
    supersedesMeasurementId: null,
  };

  test("a valid payload measurement passes", () => {
    expect(measurementIssues(base)).toEqual([]);
  });

  test("null cannot masquerade as an exact count", () => {
    const issues = measurementIssues({
      ...base,
      totals: { ...base.totals, deletions: { value: null, quality: "complete", bound: "exact" } },
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  test("payload evidence cannot invent a baseline or claim observation", () => {
    expect(measurementIssues({ ...base, baselineVersion: "b1" }).map((i) => i.path)).toContain(
      "baselineVersion",
    );
    expect(
      measurementIssues({ ...base, effectClaim: "workspace-observed" }).length,
    ).toBeGreaterThan(0);
  });

  test("verified isolation cannot coexist with known overlap", () => {
    expect(
      measurementIssues({
        ...base,
        attribution: {
          basis: "proposal",
          writerIsolation: "verified-isolated",
          overlap: "known-overlap",
        },
      }).length,
    ).toBeGreaterThan(0);
  });
});

test("mixed evidence ranks per independent file and deduplicates multifile patches", () => {
  const patch: ProviderEvidence = {
    kind: "patch",
    format: "git_unified",
    effectClaim: "provider-reported",
    body: body("--- a/updated\n+++ b/updated\n@@ -1 +1 @@\n-old\n+new\n"),
  };
  const added: ProviderEvidence = {
    kind: "replacement",
    path: "added",
    before: { state: "absent" },
    after: { state: "present", body: body("new\n") },
    extent: "whole-file",
    origin: "result",
    effectClaim: "provider-reported",
  };
  const deleted: ProviderEvidence = {
    kind: "replacement",
    path: "deleted",
    before: { state: "present", body: body("old\n") },
    after: { state: "absent" },
    extent: "whole-file",
    origin: "result",
    effectClaim: "provider-reported",
  };
  const chosen = selectToolEvidence(
    [
      candidate(patch, "p"),
      candidate(patch, "duplicate"),
      candidate(added, "a"),
      candidate(deleted, "d"),
    ],
    { phase: "succeeded", executionOccurrence: "started" },
    read,
  ).effect!;
  const measured = combineEvidenceMeasurements(
    chosen.candidates.map((c) =>
      measureEvidence(c.evidence, read, { selectedPaths: c.selectedPaths }),
    ),
  );
  expect(measured.files.map((f) => f.path).sort()).toEqual(["added", "deleted", "updated"]);
  expect(measured.additions.value).toBe(2);
  expect(measured.deletions.value).toBe(2);
});

for (const text of ["--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n-old\n+new\n", "malformed patch"])
  test(`complete replacements outrank unusable patches: ${text.startsWith("---") ? "truncated" : "malformed"}`, () => {
    const patch: ProviderEvidence = {
      kind: "patch",
      path: "f",
      format: "git_unified",
      body: body(text, !text.startsWith("---")),
      effectClaim: "provider-reported",
    };
    const replacement: ProviderEvidence = {
      kind: "replacement",
      path: "f",
      before: { state: "present", body: body("old\n") },
      after: { state: "present", body: body("new\n") },
      extent: "whole-file",
      origin: "result",
      effectClaim: "provider-reported",
    };
    const chosen = selectToolEvidence(
      [candidate(patch, "p"), candidate(replacement, "r")],
      { phase: "succeeded", executionOccurrence: "started" },
      read,
    ).effect!;
    expect(chosen.candidates.map((c) => c.evidenceId)).toEqual(["e-r"]);
  });

test("partial multifile patch fills independent paths without duplicating a complete replacement", () => {
  const patch: ProviderEvidence = {
    kind: "patch",
    format: "git_unified",
    body: body(
      "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-c\n+d\n",
      false,
    ),
    effectClaim: "provider-reported",
  };
  const replacement: ProviderEvidence = {
    kind: "replacement",
    path: "f",
    before: { state: "present", body: body("a\n") },
    after: { state: "present", body: body("b\n") },
    extent: "whole-file",
    origin: "result",
    effectClaim: "provider-reported",
  };
  const chosen = selectToolEvidence(
    [candidate(patch, "p"), candidate(replacement, "r")],
    { phase: "succeeded", executionOccurrence: "started" },
    read,
  ).effect!;
  const measured = combineEvidenceMeasurements(
    chosen.candidates.map((c) =>
      measureEvidence(c.evidence, read, { selectedPaths: c.selectedPaths }),
    ),
  );
  expect(measured.files.map((f) => f.path).sort()).toEqual(["f", "g"]);
  expect(measured.additions.value).toBe(2);
});
