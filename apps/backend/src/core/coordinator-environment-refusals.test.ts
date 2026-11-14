import { expect, test } from "bun:test";
import { CoordinatorEnvironmentRefusals } from "./coordinator-environment-refusals.js";

test("refusals are counted by surface and node", () => {
  const counts = new CoordinatorEnvironmentRefusals();
  counts.record("mail-reply", "local");
  counts.record("mail-reply", "local");
  counts.record("node-mail", "remote");
  expect(counts.snapshot()).toEqual({
    total: 3,
    bySurface: { "mail-reply:local": 2, "node-mail:remote": 1 },
    byTool: {},
  });
});

test("a tool outside the checked set, or not a tool name, counts as other", () => {
  const counts = new CoordinatorEnvironmentRefusals();
  const known = new Set(["launch_job"]);
  counts.recordTool("launch_job", known);
  counts.recordTool("made_up_tool", known);
  counts.recordTool("env-1234 /tmp/secret", known);
  expect(counts.snapshot().byTool).toEqual({ launch_job: 1, other: 2 });
});

test("the tool table is bounded and reset clears everything", () => {
  const counts = new CoordinatorEnvironmentRefusals();
  const known = new Set(Array.from({ length: 100 }, (_, index) => `tool_${index}`));
  for (const name of known) counts.recordTool(name, known);
  expect(Object.keys(counts.snapshot().byTool)).toHaveLength(64);
  counts.record("tool", "local");
  counts.reset();
  expect(counts.snapshot()).toEqual({ total: 0, bySurface: {}, byTool: {} });
});
