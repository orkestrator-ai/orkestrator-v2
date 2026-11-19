import { describe, expect, test } from "bun:test";
import type { LinearMachineTarget } from "@/components/linear/linear-machines";
import { projectMachineOptions } from "./project-machine-options";

function target(
  nodeId: string | null,
  name: string,
  extra: Partial<LinearMachineTarget> = {},
): LinearMachineTarget {
  return {
    key: `node:${nodeId ?? "command"}`,
    machine: nodeId,
    nodeId,
    name,
    projectId: `${name}-project`,
    current: false,
    available: true,
    hasCheckout: true,
    ...extra,
  };
}

describe("projectMachineOptions", () => {
  for (const { saved, expected } of [
    { saved: [], expected: ["command", "leaf-a", "leaf-b"] },
    { saved: ["leaf-b", "command"], expected: ["leaf-b", "command", "leaf-a"] },
    { saved: ["unmatched", "command"], expected: ["leaf-b", "command", "leaf-a"] },
    {
      saved: ["leaf-b", "unmatched", "leaf-a", "command"],
      expected: ["leaf-b", "leaf-a", "command"],
    },
  ]) {
    test(`keeps the sidebar order from every machine with saved order [${saved}]`, () => {
      const matching = ["command", "leaf-a", "leaf-b"];
      const nodes = ["leaf-a", "unmatched", "leaf-b"];
      for (const current of matching) {
        // Matching puts the current machine first, then the rest in registry order.
        const targets = [current, ...matching.filter((id) => id !== current)].map((id) =>
          target(id, id, { current: id === current }),
        );
        const options = projectMachineOptions(targets, { machineOrder: saved }, "command", nodes);
        expect(options.map((option) => option.connectionId)).toEqual(expected);
        expect(options.find((option) => option.current)?.connectionId).toBe(current);
      }
    });
  }

  test("opens the command node's copy when its id is not known yet", () => {
    const [option] = projectMachineOptions(
      [target(null, "mini", { machine: null })],
      { machineOrder: [] },
      "command-scope",
      [],
    );
    expect(option).toMatchObject({ connectionId: "command-scope", projectId: "mini-project" });
  });

  test("keeps the colour and availability of each machine", () => {
    const options = projectMachineOptions(
      [
        target("command", "mini", { current: true, colorToken: "teal" }),
        target("leaf", "laptop", { available: false }),
      ],
      { machineOrder: [] },
      "command",
      ["leaf"],
    );
    expect(options).toEqual([
      expect.objectContaining({ name: "mini", colorToken: "teal", available: true, current: true }),
      expect.objectContaining({ name: "laptop", available: false, current: false }),
    ]);
    expect("colorToken" in options[1]!).toBe(false);
  });
});
