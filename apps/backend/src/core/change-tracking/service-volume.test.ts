import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";
import { operationVolumeResourceKey } from "./identities.js";
import { turnIdFor } from "./turn-boundaries.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("recorded edit activity (operation volume)", () => {
  test("§5.6: A→B then B→A records +2/−2 of activity while thread net is 0/0", async () => {
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
    const source = spoolSource(spool);
    const logical = "env-env-1:tab";
    const turn = async (requestId: string, callId: string, before: string, after: string) => {
      await h.service.prepareTurnStart({
        environmentId: "env-1",
        logicalSessionKey: logical,
        requestId,
        provider: "claude",
        providerSessionId: "s1",
      });
      h.service.markTurnDispatched("env-1", logical, requestId, "accepted");
      writeFileSync(join(h.repo, "a.txt"), `one\n${after}\n`);
      recorder.tool(
        { conversationId: "s1", callId },
        {
          toolKind: "file-edit",
          phase: "succeeded",
          executionOccurrence: "started",
          evidence: [
            {
              kind: "replacement",
              path: "a.txt",
              before: `${before}\n`,
              after: `${after}\n`,
              extent: "fragment",
              origin: "input",
              claim: "proposal",
            },
          ],
        },
      );
      await h.service.pullEvidence(source);
      await h.service.finalizeTurn({
        environmentId: "env-1",
        logicalSessionKey: logical,
        requestId,
      });
    };
    writeFileSync(join(h.repo, "a.txt"), "one\nA\n");
    await turn("r1", "c1", "A", "B");
    await turn("r2", "c2", "B", "A");

    const firstTurn = turnIdFor("env-1", logical, "r1");
    const turnVolume = h.service.projections.selectedMeasurement(
      operationVolumeResourceKey(firstTurn),
    )!;
    expect(turnVolume.totals.additions.value).toBe(1);
    const segment = h.service.threadResource("env-1", logical)!;
    const threadVolume = h.service.projections.selectedMeasurement(
      operationVolumeResourceKey(segment.segmentId, "segment"),
    )!;
    expect(threadVolume.scope).toBe("operation-volume");
    expect(threadVolume.totals.additions).toEqual({
      value: 2,
      quality: "complete",
      bound: "exact",
    });
    expect(threadVolume.totals.deletions).toEqual({
      value: 2,
      quality: "complete",
      bound: "exact",
    });
    expect(threadVolume.totals.changedFiles).toBeNull();
    expect(threadVolume.totals.touchedFiles).toBe(1);
    const threadNet = h.service.projections.selectedMeasurement(segment.resourceKey)!;
    expect(threadNet.totals.changedFiles).toBe(0);
    // The history lists the volume as its own secondary role.
    const history = h.service.getHistory({ environmentId: "env-1", logicalSessionKey: logical });
    expect(
      history.kind === "page" && history.entries[0]!.presentation.changes.map((c) => c.role),
    ).toEqual(["turn-net", "operation-volume"]);
  });
});
