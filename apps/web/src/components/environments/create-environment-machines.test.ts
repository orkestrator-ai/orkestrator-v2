import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as openWorkspace from "@/lib/federation/open-workspace";
import type { BuildLaunchMachine } from "@/components/build/build-machines";
import {
  createEnvironmentMachines,
  openCreateEnvironmentOnMachine,
} from "./create-environment-machines";

afterEach(() => {
  mock.restore();
});

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
    expect(createEnvironmentMachines([own, studio, asleep]).map((machine) => machine.key)).toEqual([
      "node:own",
      "node:studio",
    ]);
  });

  test("a machine without a checkout is still offered: a container needs none", () => {
    expect(createEnvironmentMachines([own, studio])).toContain(studio);
  });

  test("the dialog's own machine stays even when the summary calls it unavailable", () => {
    const ownUnknown = { ...own, available: false };
    expect(createEnvironmentMachines([ownUnknown])).toEqual([ownUnknown]);
  });
});

describe("openCreateEnvironmentOnMachine", () => {
  test("opens that machine's own New Environment dialog for its copy of the project", () => {
    const open = spyOn(openWorkspace, "openMachineWorkspace").mockImplementation(() => undefined);
    openCreateEnvironmentOnMachine(studio, "repo");
    expect(open).toHaveBeenCalledWith({
      connectionId: "studio",
      projectId: "project-studio",
      createEnvironment: true,
      title: "repo",
    });
  });
});
