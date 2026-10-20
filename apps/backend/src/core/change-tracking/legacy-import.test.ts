import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { CommandChangeJournal } from "@orkestrator/protocol/node/command-change-journal";
import { lineChangeStatsFromSides } from "@orkestrator/protocol/tool-diff";
import { OPENCODE_COMMAND_CHANGES_DIRECTORY } from "../opencode-command-changes.js";
import { importOpenCodeCommandJournals } from "./legacy-import.js";
import { measureLegacyPayload } from "./legacy-payload.js";
import { createHarness, type Harness } from "./service-test-support.js";
import { toolResourceKeys, operationIdFor } from "./identities.js";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("legacy journal import", () => {
  test("journals become legacy-summary-only records, once", async () => {
    const h = createHarness();
    harnesses.push(h);
    const journal = new CommandChangeJournal(
      path.join(h.dataDir, OPENCODE_COMMAND_CHANGES_DIRECTORY, "env-1", "ses_abc.jsonl"),
    );
    await journal.append("call_1", {
      additions: 4,
      deletions: 1,
      files: [{ path: "a.ts", status: "M", additions: 4, deletions: 1 }],
      approximate: true,
    });
    const first = await importOpenCodeCommandJournals(h.service, h.dataDir);
    expect(first).toMatchObject({ files: 1, records: 1 });
    const operationId = operationIdFor({
      environmentId: "env-1",
      provider: "opencode",
      conversationId: "ses_abc",
      callId: "call_1",
    });
    const view = h.service.getView({ resourceKey: toolResourceKeys(operationId).observation });
    if (view.kind !== "projection") throw new Error("projection expected");
    expect(view.projection.provenanceLabelKey).toBe("changes.provenance.legacy");
    // `approximate` survives as partial quality, never as an exact count.
    expect(view.projection.counters.additions).toEqual({
      value: 4,
      quality: "partial",
      bound: "none",
    });
    expect(view.projection.detail).toBeNull();
    const second = await importOpenCodeCommandJournals(h.service, h.dataDir);
    expect(second.records).toBe(0);
  });
});

describe("shadow comparison: expected corrections versus the legacy client counter", () => {
  // The old renderer counted whole replacement sides. CountPolicyV1 counts the
  // minimal edit script. These fixtures document the intended differences;
  // the old implementation is not an oracle.
  const lines = (count: number, change = -1) =>
    Array.from({ length: count }, (_, i) => (i === change ? `x${i}\n` : `l${i}\n`)).join("");

  test("one changed line in a 100-line replacement", () => {
    const legacy = lineChangeStatsFromSides(lines(100), lines(100, 10));
    const canonical = measureLegacyPayload({
      toolName: "Edit",
      filePath: "f",
      before: lines(100),
      after: lines(100, 10),
    })!;
    expect(legacy).toEqual({ additions: 100, deletions: 100 });
    expect(canonical.additions.value).toBe(1);
    expect(canonical.deletions.value).toBe(1);
  });

  test("a write with no recorded prior state", () => {
    const legacy = lineChangeStatsFromSides("", lines(5));
    const canonical = measureLegacyPayload({
      toolName: "Write",
      filePath: "f",
      before: "",
      after: lines(5),
    })!;
    expect(legacy).toEqual({ additions: 5, deletions: 0 });
    expect(canonical.additions.value).toBeNull();
    expect(canonical.deletions.value).toBeNull();
    expect(canonical.contentLines).toBe(5);
  });

  test("a patch whose source line begins with +++", () => {
    const patch = ["--- a/c", "+++ b/c", "@@ -1 +1 @@", "---x;", "+++x;"].join("\n");
    const canonical = measureLegacyPayload({ toolName: "patch", filePath: "c", diff: patch })!;
    expect(canonical.additions.value).toBe(1);
    expect(canonical.deletions.value).toBe(1);
  });
});

test("a capped import resumes remaining journals on the next run", async () => {
  const h = createHarness();
  harnesses.push(h);
  for (const id of ["s1", "s2"])
    await new CommandChangeJournal(
      path.join(h.dataDir, OPENCODE_COMMAND_CHANGES_DIRECTORY, "env-1", `${id}.jsonl`),
    ).append("call", {
      additions: 1,
      deletions: 0,
      files: [{ path: `${id}.ts`, additions: 1, deletions: 0, status: "A" }],
    });
  expect((await importOpenCodeCommandJournals(h.service, h.dataDir, { maxFiles: 1 })).records).toBe(
    1,
  );
  expect(h.service.ledger.meta("legacy-import:opencode:v1")).toBeNull();
  expect((await importOpenCodeCommandJournals(h.service, h.dataDir, { maxFiles: 1 })).records).toBe(
    1,
  );
  expect(h.service.ledger.meta("legacy-import:opencode:v1")).not.toBeNull();
});
