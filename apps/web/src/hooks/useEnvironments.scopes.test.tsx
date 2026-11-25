import { afterEach, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useEffect } from "react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { startEnvironmentCleanupSelectionSync } from "@/lib/environment-cleanup-selection";
import { ensureProjectHomeInStore } from "@/lib/project-home-ensures";
import {
  armWindowStartupAgentActivation,
  hasWindowStartupAgentActivation,
} from "@/lib/pane-selection-storage";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { uiStore } from "@/stores/uiStore";
import type { Environment, Project } from "@/types";
import { refreshEnvironmentSnapshot, useEnvironments } from "./useEnvironments";
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
let reload: ((projectId: string) => Promise<void>) | null = null;

function Lists({ label }: { label: string }) {
  const { projects } = useProjects();
  const { environments, stopEnvironment, loadEnvironments } = useEnvironments("p-1", {
    listenForRenameEvents: false,
  });
  useEffect(() => {
    if (label === "b") stopOnB = stopEnvironment;
    else reload = loadEnvironments;
  }, [label, loadEnvironments, stopEnvironment]);
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

test("a list read that began before the project home was ensured keeps the home and its selection", async () => {
  const home: Environment = {
    ...environment("home"),
    id: "home-1",
    projectHome: true,
    worktreePath: "/checkout",
  };
  let answerList!: (environments: Environment[]) => void;
  const client = new FakeNodeClient({
    nodeId: NODE_A,
    invoke: {
      get_projects: [project("project-a")],
      get_environments: () =>
        new Promise<Environment[]>((resolve) => {
          answerList = resolve;
        }),
      ensure_project_home_environment: home,
    },
  });
  // A leaf scope asks its own client, so the list read goes to this fake node.
  const { scope } = renderInNodeScope(<Lists label="a" />, {
    windowScope: new WindowScope(),
    client,
    role: "leaf",
  });
  await waitFor(() => expect(client.calls("get_environments")).toHaveLength(1));
  const stopSync = startEnvironmentCleanupSelectionSync(scope);
  try {
    // The user opens the project while the startup read is still running.
    act(() => scope.store(uiStore).getState().selectProject("p-1"));
    await act(async () => {
      await ensureProjectHomeInStore("p-1", scope);
    });
    act(() => scope.store(uiStore).getState().selectEnvironment("home-1"));

    // The answer was computed before the home existed.
    await act(async () => answerList([environment("env-a")]));

    await waitFor(() =>
      expect(
        scope
          .store(environmentStore)
          .getState()
          .environments.map((entry) => entry.id)
          .sort(),
      ).toEqual(["env-1", "home-1"]),
    );
    expect(scope.store(uiStore).getState()).toMatchObject({
      selectedProjectId: "p-1",
      selectedEnvironmentId: "home-1",
    });
  } finally {
    stopSync();
  }
});

test("a list read that began after an environment was listed still removes it", async () => {
  const client = new FakeNodeClient({
    nodeId: NODE_A,
    invoke: {
      get_projects: [project("project-a")],
      get_environments: [environment("env-a"), { ...environment("gone"), id: "env-gone" }],
    },
  });
  const { scope } = renderInNodeScope(<Lists label="a" />, {
    windowScope: new WindowScope(),
    client,
    role: "leaf",
  });
  const listed = () =>
    scope
      .store(environmentStore)
      .getState()
      .environments.map((entry) => entry.id);
  await waitFor(() => expect(listed().sort()).toEqual(["env-1", "env-gone"]));
  client.respond("get_environments", [environment("env-a")]);
  await act(async () => {
    await reload!("p-1");
  });
  expect(listed()).toEqual(["env-1"]);
  reload = null;
});

test.each(["older first", "newer first", "deletion announced"] as const)(
  "overlapping project lists keep a deleted environment out (%s)",
  async (order) => {
    const answers: ((environments: Environment[]) => void)[] = [];
    const client = new FakeNodeClient({
      nodeId: NODE_A,
      invoke: {
        get_projects: [project("project-a")],
        get_environments: () => new Promise<Environment[]>((resolve) => answers.push(resolve)),
        get_environment_snapshot: null,
      },
    });
    const { scope } = renderInNodeScope(<Lists label="a" />, {
      windowScope: new WindowScope(),
      client,
      role: "leaf",
    });
    const listed = () => scope.store(environmentStore).getState().environments;
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    const stopSync = startEnvironmentCleanupSelectionSync(scope);
    try {
      await waitFor(() => expect(answers).toHaveLength(1));
      let newer!: Promise<void>;
      act(() => {
        newer = reload!("p-1");
      });
      await waitFor(() => expect(answers).toHaveLength(2));
      expect(listed()).toEqual([]);
      const settleNewer = () =>
        act(async () => {
          answers[1]!([]);
          await newer;
        });
      if (order === "newer first") await settleNewer();
      if (order === "deletion announced") {
        await act(() => refreshEnvironmentSnapshot("p-1", "env-1", scope));
      }

      await act(async () => answers[0]!([environment("gone")]));
      if (order === "older first") {
        expect(listed().map(({ id }) => id)).toEqual(["env-1"]);
        act(() => {
          scope.store(uiStore).getState().selectProject("p-1");
          scope.store(uiStore).getState().selectEnvironment("env-1");
          armWindowStartupAgentActivation("env-1", scope);
        });
        expect(hasWindowStartupAgentActivation("env-1", scope)).toBe(true);
      } else {
        expect(listed()).toEqual([]);
      }
      if (order !== "newer first") await settleNewer();

      expect(listed()).toEqual([]);
      expect(scope.store(uiStore).getState().selectedEnvironmentId).toBeNull();
      expect(hasWindowStartupAgentActivation("env-1", scope)).toBe(false);
    } finally {
      stopSync();
      reload = null;
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  },
);
