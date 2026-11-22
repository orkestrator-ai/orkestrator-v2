import { expect, test } from "bun:test";

import {
  cursorSkillNames,
  retryCursorSkillRemoval,
} from "../../e2e/agent-testing/capability-cursor-live-support";

test("a Cursor turn must answer NONE or return exact skill names", () => {
  expect(cursorSkillNames(" NONE\n", "ork-cq-")).toEqual([]);
  expect(cursorSkillNames("ork-cq-a\r\nork-cq-b", "ork-cq-")).toEqual(["ork-cq-a", "ork-cq-b"]);
  for (const reply of [
    "I can't inspect skills.",
    "Some other answer",
    "NONE\nThanks",
    "- ork-cq-a",
  ]) {
    expect(cursorSkillNames(reply, "ork-cq-")).toBeNull();
  }
});

test.each([true, false])(
  "partial removal retries according to the remaining setup assignment (%s)",
  async (assigned) => {
    let inSetup = assigned;
    let onDisk = true;
    const changes: unknown[] = [];
    const result = await retryCursorSkillRemoval(
      async <T>() =>
        ({
          packages: [{ id: "test-package", assignedSetupIds: inSetup ? ["my-setup"] : [] }],
        }) as T,
      async (change) => {
        changes.push(change);
        inSetup = false;
        onDisk = false;
        return { state: "completed" };
      },
      "test-package",
      () => onDisk,
    );
    expect(changes).toEqual([
      assigned ? { kind: "remove-from-setup", packageId: "test-package" } : { kind: "reconcile" },
    ]);
    expect(result).toEqual({ state: "completed", assigned: false, copyRemaining: false });
  },
);

test("the fallback reports an unremoved copy and setup after a failed retry", async () => {
  const result = await retryCursorSkillRemoval(
    async <T>() => ({ packages: [{ id: "test-package", assignedSetupIds: ["my-setup"] }] }) as T,
    async () => {
      throw new Error("fixture retry failed");
    },
    "test-package",
    () => true,
  );
  expect(result).toEqual({ state: "failed", assigned: true, copyRemaining: true });
});
