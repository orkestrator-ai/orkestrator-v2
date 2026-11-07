import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import {
  environmentResourceHandlers,
  projectResourceHandlers,
} from "@/lib/project-environment-resource-handlers";
import { requestResourceResync } from "@/lib/resource-sync";
import { startStoreResourceSync, storeResourceHandlersFor } from "@/lib/store-resource-sync";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import type { Environment, Project } from "@/types";

const NODE_A = "bk_project-sync-a" as BackendId;
const NODE_B = "bk_project-sync-b" as BackendId;
const HANDLERS = [projectResourceHandlers, environmentResourceHandlers];

function project(id: string, name: string): Project {
  return { id, name, gitUrl: "", localPath: null, addedAt: "2026-11-07T00:00:00.000Z", order: 0 };
}

function environment(id: string, projectId: string, name: string): Environment {
  return {
    id,
    projectId,
    name,
    branch: name,
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-11-07T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "ready",
  };
}

/** A node whose project `p-1` holds environment `env-1`: ids are node-local, so both nodes use them. */
function nodeClient(nodeId: BackendId, label: string): FakeNodeClient {
  return new FakeNodeClient({
    nodeId,
    invoke: {
      get_projects: [project("p-1", `project-${label}`)],
      get_environment_snapshots: ({ projectId }: Readonly<Record<string, unknown>>) =>
        projectId === "p-1" ? [environment("env-1", "p-1", `env-${label}`)] : [],
    },
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

let windowScope: WindowScope;
let clientA: FakeNodeClient;
let clientB: FakeNodeClient;
let scopeA: NodeScope;
let scopeB: NodeScope;
const stops: Array<() => void> = [];

beforeEach(() => {
  clientA = nodeClient(NODE_A, "a");
  clientB = nodeClient(NODE_B, "b");
  windowScope = new WindowScope();
  scopeA = windowScope.open({ role: "command", client: clientA });
  scopeB = windowScope.open({ role: "leaf", client: clientB });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  windowScope.dispose();
});

test("both registrations run on every scope", () => {
  expect(storeResourceHandlersFor(scopeB, HANDLERS)).toEqual(HANDLERS);
});

test("each scope's resync reads its own node into its own stores, with the same ids", async () => {
  stops.push(startStoreResourceSync({}, { scope: scopeA, handlers: HANDLERS }));
  stops.push(startStoreResourceSync({}, { scope: scopeB, handlers: HANDLERS }));

  requestResourceResync(scopeB);
  await settle();

  expect(clientB.calls("get_projects")).toHaveLength(1);
  expect(clientB.calls("get_environment_snapshots")).toHaveLength(1);
  expect(clientA.calls("get_projects")).toHaveLength(0);
  expect(
    scopeB
      .store(projectStore)
      .getState()
      .projects.map(({ name }) => name),
  ).toEqual(["project-b"]);
  expect(scopeB.store(environmentStore).getState().getEnvironmentById("env-1")?.name).toBe("env-b");
  // The other node's stores are untouched by B's resync.
  expect(scopeA.store(projectStore).getState().projects).toEqual([]);
  expect(scopeA.store(environmentStore).getState().environments).toEqual([]);

  requestResourceResync(scopeA);
  await settle();

  expect(scopeA.store(environmentStore).getState().getEnvironmentById("env-1")?.name).toBe("env-a");
  expect(scopeB.store(environmentStore).getState().getEnvironmentById("env-1")?.name).toBe("env-b");
});

test("a project mutation on one node does not make the other node's read stale", async () => {
  stops.push(startStoreResourceSync({}, { scope: scopeB, handlers: HANDLERS }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  clientB.respond("get_projects", async () => {
    await gate;
    return [project("p-1", "project-b")];
  });

  requestResourceResync(scopeB);
  await settle();
  // While B's read is in flight, A's projects change locally.
  scopeA.store(projectStore).getState().addProject(project("p-9", "local-a"));
  release();
  await settle();

  expect(clientB.calls("get_projects")).toHaveLength(1);
  expect(
    scopeB
      .store(projectStore)
      .getState()
      .projects.map(({ name }) => name),
  ).toEqual(["project-b"]);
});
