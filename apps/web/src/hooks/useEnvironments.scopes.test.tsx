import { afterEach, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useEffect } from "react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import type { Environment, Project } from "@/types";
import { useEnvironments } from "./useEnvironments";
import { useProjects } from "./useProjects";

const NODE_A = "bk_environments-a" as BackendId;
const NODE_B = "bk_environments-b" as BackendId;

afterEach(cleanupNodeScopes);

function project(name: string): Project {
  return {
    id: "p-1",
    name,
    gitUrl: "",
    localPath: null,
    addedAt: "2026-11-07T00:00:00.000Z",
    order: 0,
  };
}

function environment(name: string): Environment {
  return {
    id: "env-1",
    projectId: "p-1",
    name,
    branch: name,
    containerId: null,
    status: "running",
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

/** A node with project `p-1` and environment `env-1`: ids are node-local, so both nodes use them. */
function nodeClient(nodeId: BackendId, label: string): FakeNodeClient {
  return new FakeNodeClient({
    nodeId,
    invoke: {
      get_projects: [project(`project-${label}`)],
      get_environments: [environment(`env-${label}`)],
      stop_environment: null,
    },
  });
}

let stopOnB: ((environmentId: string) => Promise<void>) | null = null;

function Lists({ label }: { label: string }) {
  const { projects } = useProjects();
  const { environments, stopEnvironment } = useEnvironments("p-1", {
    listenForRenameEvents: false,
  });
  useEffect(() => {
    if (label === "b") stopOnB = stopEnvironment;
  }, [label, stopEnvironment]);
  return (
    <div data-testid={`node-${label}`}>
      {projects.map((entry) => entry.name).join(",")}|
      {environments.map((entry) => `${entry.id}:${entry.name}:${entry.status}`).join(",")}
    </div>
  );
}

test("two node scopes with the same project and environment ids keep their own lists", async () => {
  const windowScope = new WindowScope();
  const clientA = nodeClient(NODE_A, "a");
  const clientB = nodeClient(NODE_B, "b");
  const { scope: scopeA } = renderInNodeScope(<Lists label="a" />, {
    windowScope,
    client: clientA,
  });
  const { scope: scopeB } = renderInNodeScope(<Lists label="b" />, {
    windowScope,
    client: clientB,
    role: "leaf",
  });

  await waitFor(() => {
    expect(screen.getByTestId("node-a").textContent).toBe("project-a|env-1:env-a:running");
    expect(screen.getByTestId("node-b").textContent).toBe("project-b|env-1:env-b:running");
  });
  expect(clientA.calls("get_environments")).toEqual([
    { command: "get_environments", args: { projectId: "p-1" } },
  ]);
  expect(clientB.calls("get_environments")).toEqual([
    { command: "get_environments", args: { projectId: "p-1" } },
  ]);

  // Stopping B's env-1 asks B and changes only B's record.
  await act(async () => {
    await stopOnB!("env-1");
  });
  expect(clientB.calls("stop_environment")).toEqual([
    { command: "stop_environment", args: { environmentId: "env-1" } },
  ]);
  expect(clientA.calls("stop_environment")).toEqual([]);
  expect(scopeB.store(environmentStore).getState().getEnvironmentById("env-1")?.status).toBe(
    "stopped",
  );
  expect(scopeA.store(environmentStore).getState().getEnvironmentById("env-1")?.status).toBe(
    "running",
  );
  expect(scopeA.store(projectStore).getState().projects[0]?.name).toBe("project-a");
  expect(screen.getByTestId("node-a").textContent).toBe("project-a|env-1:env-a:running");
  stopOnB = null;
});
