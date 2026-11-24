import { describe, expect, test } from "bun:test";
import type { BuildLaunchMachine } from "@/components/build/build-machines";
import { createEnvironmentMachines } from "./create-environment-machines";

const own: BuildLaunchMachine = {
  key: "node:own",
  name: "Build Mac",
  machine: undefined,
  nodeId: "own",
  projectId: "project-own",
  current: true,
  available: true,
  hasCheckout: true,
};
const studio: BuildLaunchMachine = {
  key: "node:studio",
  name: "Studio",
  machine: "studio",
  nodeId: "studio",
  projectId: "project-studio",
  current: false,
  available: true,
  hasCheckout: false,
};
const asleep: BuildLaunchMachine = {
  key: "node:asleep",
  name: "Laptop",
  machine: "asleep",
  nodeId: "asleep",
  projectId: "project-asleep",
  current: false,
  available: false,
  hasCheckout: true,
};

describe("createEnvironmentMachines", () => {
  test("keeps the dialog's own machine and every reachable machine with the repository", () => {
    expect(
      createEnvironmentMachines([own, studio, asleep], new Map([[studio.key, true]])).map(
        (machine) => machine.key,
      ),
    ).toEqual(["node:own", "node:studio"]);
  });

  test("a remote-only machine is offered once Docker availability is known", () => {
    expect(createEnvironmentMachines([own, studio], new Map())).toEqual([own]);
    expect(createEnvironmentMachines([own, studio], new Map([[studio.key, false]]))).toEqual([own]);
    expect(createEnvironmentMachines([own, studio], new Map([[studio.key, true]]))).toContain(
      studio,
    );
  });

  test("the dialog's own machine stays even when the summary calls it unavailable", () => {
    const ownUnknown = { ...own, available: false };
    expect(createEnvironmentMachines([ownUnknown], new Map())).toEqual([ownUnknown]);
  });
});
