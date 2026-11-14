import { describe, expect, test } from "bun:test";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import { linearKeyFingerprint, linearMachineTargets } from "./linear-machines";

function node(
  nodeId: string,
  displayName: string,
  projects: Array<{ id: string; hint?: string; pathName?: string }>,
  available = true,
): NodeSummary {
  return {
    nodeId,
    available,
    view: { displayName },
    projects: projects.map((project) => ({
      ref: { backendId: nodeId, projectId: project.id },
      key: `${nodeId}:${project.id}`,
      name: project.id,
      order: 0,
      ...(project.hint ? { repositoryHint: project.hint } : {}),
      ...(project.pathName ? { pathName: project.pathName } : {}),
    })),
    environments: [],
  } as unknown as NodeSummary;
}

const nodes = [
  node("node-laptop", "Laptop", [{ id: "laptop-web", hint: "github.com/acme/web" }]),
  node("node-ci", "CI box", [{ id: "ci-web", hint: "github.com/acme/web" }], false),
  node("node-other", "Other", [{ id: "other-api", hint: "github.com/acme/api" }]),
];

describe("linearMachineTargets", () => {
  test("offers only this machine for a project without a Git remote", () => {
    const targets = linearMachineTargets({
      currentNodeId: "node-home",
      currentRole: "command",
      projectId: "project-1",
      gitUrl: undefined,
      commandNodeId: "node-home",
      commandName: "Home server",
      commandProjects: [],
      nodes,
    });
    expect(targets.map((target) => target.name)).toEqual(["Home server"]);
    expect(targets[0]).toMatchObject({ current: true, machine: undefined });
  });

  test("on the command node, adds every machine with the same repository", () => {
    const targets = linearMachineTargets({
      currentNodeId: "node-home",
      currentRole: "command",
      projectId: "project-1",
      gitUrl: "git@github.com:Acme/web.git",
      commandNodeId: "node-home",
      commandName: "Home server",
      commandProjects: [],
      nodes,
    });
    expect(
      targets.map(({ name, machine, projectId, available }) => ({
        name,
        machine,
        projectId,
        available,
      })),
    ).toEqual([
      { name: "Home server", machine: undefined, projectId: "project-1", available: true },
      { name: "Laptop", machine: "node-laptop", projectId: "laptop-web", available: true },
      { name: "CI box", machine: "node-ci", projectId: "ci-web", available: false },
    ]);
  });

  test("in a leaf's workspace, the command node is reached through the command scope", () => {
    const targets = linearMachineTargets({
      currentNodeId: "node-laptop",
      currentRole: "leaf",
      projectId: "laptop-web",
      gitUrl: "https://github.com/acme/web",
      commandNodeId: "node-home",
      commandName: "Home server",
      commandProjects: [
        { id: "home-api", gitUrl: "https://github.com/acme/api" },
        { id: "home-web", gitUrl: "https://github.com/acme/web.git" },
      ],
      nodes,
    });
    expect(
      targets.map(({ name, machine, projectId, current }) => ({
        name,
        machine,
        projectId,
        current,
      })),
    ).toEqual([
      { name: "Laptop", machine: undefined, projectId: "laptop-web", current: true },
      { name: "Home server", machine: null, projectId: "home-web", current: false },
      { name: "CI box", machine: "node-ci", projectId: "ci-web", current: false },
    ]);
  });
});

describe("linearMachineTargets checkouts", () => {
  test("a peer's project has a checkout only when its summary names one", () => {
    const targets = linearMachineTargets({
      currentNodeId: "node-home",
      currentRole: "command",
      projectId: "project-1",
      gitUrl: "https://github.com/acme/web",
      commandNodeId: "node-home",
      commandName: "Home server",
      commandProjects: [],
      nodes: [
        node("node-a", "With checkout", [
          { id: "a-web", hint: "github.com/acme/web", pathName: "web" },
        ]),
        // Remote-only, or a summary read before `pathName` existed.
        node("node-b", "Remote only", [{ id: "b-web", hint: "github.com/acme/web" }]),
      ],
      currentHasCheckout: false,
    });
    expect(targets.map(({ name, hasCheckout }) => ({ name, hasCheckout }))).toEqual([
      { name: "Home server", hasCheckout: false },
      { name: "With checkout", hasCheckout: true },
      { name: "Remote only", hasCheckout: false },
    ]);
  });

  test("the command node's project has a checkout when it has a local path", () => {
    const build = (localPath: string | null) =>
      linearMachineTargets({
        currentNodeId: "node-laptop",
        currentRole: "leaf",
        projectId: "laptop-web",
        gitUrl: "https://github.com/acme/web",
        commandNodeId: "node-home",
        commandName: "Home server",
        commandProjects: [{ id: "home-web", gitUrl: "https://github.com/acme/web", localPath }],
        nodes: [],
      });
    expect(build("/work/web").map((target) => target.hasCheckout)).toEqual([true, true]);
    expect(build(null).map((target) => target.hasCheckout)).toEqual([true, false]);
  });
});

describe("linearKeyFingerprint", () => {
  test("is the first 16 hex characters of the trimmed key's SHA-256, as the backend's", () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(linearKeyFingerprint("  abc \n")).toBe("ba7816bf8f01cfea");
  });
});
