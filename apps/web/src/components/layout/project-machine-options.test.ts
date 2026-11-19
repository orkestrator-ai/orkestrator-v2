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
  test("lists the command node first, then the stored machine order, whichever is current", () => {
    // On a leaf, the targets put the leaf first and the command node second.
    const targets = [
      target("leaf-b", "beelink", { current: true, machine: undefined }),
      target("command", "mini", { machine: null }),
      target("leaf-a", "beelink2"),
    ];
    const options = projectMachineOptions(targets, { machineOrder: [] }, "command");
    expect(options.map((option) => option.name)).toEqual(["mini", "beelink", "beelink2"]);
    expect(options.find((option) => option.current)?.name).toBe("beelink");

    const arranged = projectMachineOptions(
      targets,
      { machineOrder: ["leaf-a", "command", "leaf-b"] },
      "command",
    );
    expect(arranged.map((option) => option.name)).toEqual(["beelink2", "mini", "beelink"]);
  });

  test("opens the command node's copy when its id is not known yet", () => {
    const [option] = projectMachineOptions(
      [target(null, "mini", { machine: null })],
      { machineOrder: [] },
      "command-scope",
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
    );
    expect(options).toEqual([
      expect.objectContaining({ name: "mini", colorToken: "teal", available: true, current: true }),
      expect.objectContaining({ name: "laptop", available: false, current: false }),
    ]);
    expect("colorToken" in options[1]!).toBe(false);
  });
});
