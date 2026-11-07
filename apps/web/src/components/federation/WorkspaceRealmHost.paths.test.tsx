/**
 * The realm side runs on both paths (plan item 4001): a realm document reads
 * its request from its URL and talks over the page's transport; a node in
 * the window's tree has a loopback in context, and reads the window's
 * request from the window's own store (plan item 4005). Each scenario below
 * runs on both, with the same expectations.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import {
  createRealmLoopback,
  RealmChannelContext,
  type RealmLoopback,
} from "@/lib/federation/realm-channel";
import {
  parseRealmMessage,
  realmSearchParams,
  type RealmSelectRequest,
  type RealmToShellMessage,
  type ShellToRealmMessage,
} from "@/lib/federation/workspace-realm";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { getReadCoordinator, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useConfigStore } from "@/stores/configStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useRealmShellStore } from "@/stores/realmShellStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import type { Environment, Project } from "@/types";
import { WorkspaceRealmHost } from "./WorkspaceRealmHost";

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const originalNative = window.orkestrator;
const originalPortal = portalStore.getState();
const originalUI = useUIStore.getState();
const originalConfig = useConfigStore.getState();
const originalProjects = useProjectStore.getState();
const originalEnvironments = useEnvironmentStore.getState();
const nativeInvoke = invoke as ReturnType<typeof mock>;
const project = { id: "project", name: "Checkout", localPath: null, order: 0 } as Project;
const environment = {
  id: "env",
  projectId: project.id,
  name: "Feature",
  environmentType: "local",
  status: "stopped",
} as Environment;

/** One path's realm side: how it is opened, how the window talks to it, what it said. */
interface RealmPath {
  open(request: Omit<RealmSelectRequest, "type">): void;
  send(message: ShellToRealmMessage): void;
  posted(): RealmToShellMessage[];
}

function pagePath(): RealmPath {
  let deliver: (message: unknown) => void = () => undefined;
  const posted: unknown[] = [];
  return {
    open(request) {
      happyDOM.setURL(`http://localhost/?${realmSearchParams(request)}`);
      window.orkestrator = {
        ...originalNative,
        workspaceRealm: {
          post: (message: unknown) => posted.push(message),
          onMessage: (callback: (message: unknown) => void) => {
            deliver = callback;
            return () => {
              deliver = () => undefined;
            };
          },
        },
      } as typeof window.orkestrator;
      render(<WorkspaceRealmHost />);
    },
    send: (message) => act(() => deliver(message)),
    posted: () => posted.map(parseRealmMessage).filter((m): m is RealmToShellMessage => !!m),
  };
}

const loopbacks: RealmLoopback[] = [];
const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
function loopbackPath(): RealmPath {
  let pair: RealmLoopback | null = null;
  const posted: unknown[] = [];
  // The window asks through its own store, keyed by the node the host shows.
  const ask = (request: Omit<RealmSelectRequest, "type">) =>
    act(() =>
      useRemoteWorkspaceStore.getState().open(getWindowScope().commandScope().nodeId, request),
    );
  return {
    open(request) {
      pair = createRealmLoopback(null);
      loopbacks.push(pair);
      ask(request);
      pair.onRealmMessage((message) => posted.push(message));
      const tree: ReactElement = (
        <RealmChannelContext.Provider value={pair.realm}>
          <WorkspaceRealmHost />
        </RealmChannelContext.Provider>
      );
      render(tree);
    },
    send: (message) => {
      if (message.type === "select") {
        const { type: _type, ...request } = message;
        ask(request);
        return;
      }
      act(() => pair!.send(message));
    },
    posted: () => posted.map(parseRealmMessage).filter((m): m is RealmToShellMessage => !!m),
  };
}

/** Lets the loopback's microtask deliveries land. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let resolveProjects: (projects: Project[]) => void;

beforeEach(() => {
  nativeInvoke.mockReset();
  const projects = new Promise<Project[]>((resolve) => {
    resolveProjects = resolve;
  });
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return projects;
    if (command === "get_environments" || command === "get_environment_snapshots")
      return [environment];
    return undefined;
  });
  portalStore.store.setState({
    loaded: true,
    status: { mode: "command" } as never,
    selfId: "bk_command" as BackendId,
  });
  useProjectStore.setState({ projects: [], hasLoaded: false, isLoading: false });
  useEnvironmentStore.setState({ environments: [] });
  useUIStore.setState({ selectedProjectId: null, selectedEnvironmentId: null });
  useUIChromeStore.setState({ sidebarOpen: true });
  useAppDialogStore.setState({ request: null });
  resetReadCoordinatorForTests();
});

afterEach(() => {
  cleanup();
  for (const pair of loopbacks.splice(0)) pair.close();
  happyDOM.setURL(originalHref);
  window.orkestrator = originalNative;
  useAppDialogStore.setState({ request: null });
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useRealmShellStore.setState({ grouping: null });
  useConfigStore.setState(originalConfig, true);
  useUIStore.setState(originalUI, true);
  useProjectStore.setState(originalProjects, true);
  useEnvironmentStore.setState(originalEnvironments, true);
  portalStore.store.setState(originalPortal, true);
  resetReadCoordinatorForTests();
  resetWindowScopeForTests();
});

for (const [name, makePath] of [
  ["realm document", pagePath],
  ["in-tree loopback", loopbackPath],
] as const) {
  describe(`on the ${name} path`, () => {
    test("the realm says ready once it listens, and opens on its request", async () => {
      const path = makePath();
      path.open({ projectId: project.id, environmentId: environment.id });
      await settle();
      expect(path.posted()).toContainEqual({ type: "ready" });
      await act(async () => resolveProjects([project]));
      await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(environment.id));
      expect(useUIStore.getState().selectedProjectId).toBe(project.id);
      await settle();
      if (name === "realm document") {
        // The selection is reported back to the window.
        expect(path.posted()).toContainEqual({
          type: "selection",
          projectId: project.id,
          environmentId: environment.id,
        });
      } else {
        // In the window's tree it is the window's selection itself.
        expect(getWindowScope().selection.get()).toMatchObject({
          projectId: project.id,
          environmentId: environment.id,
        });
      }
    });

    test("a project dialog waits for the node's projects, then opens for this node once", async () => {
      const path = makePath();
      path.open({ projectId: project.id, dialog: "delete-project" });
      await settle();
      expect(useAppDialogStore.getState().request).toBeNull();
      await act(async () => resolveProjects([project]));
      await waitFor(() =>
        expect(useAppDialogStore.getState().request).toEqual({
          nodeId: getWindowScope().commandScope().nodeId,
          kind: "delete-project",
          projectId: project.id,
        }),
      );
      const first = useAppDialogStore.getState().requestSequence;
      // A later unrelated message does not reopen it.
      path.send({ type: "sidebar", open: false });
      await settle();
      expect(useAppDialogStore.getState().requestSequence).toBe(first);
    });

    test("a later select from the window is applied as a sidebar click would", async () => {
      const path = makePath();
      path.open({});
      await act(async () => resolveProjects([project]));
      await settle();
      path.send({ type: "select", projectId: project.id, boardTab: "kanban" });
      await settle();
      await waitFor(() => expect(useUIStore.getState().selectedProjectId).toBe(project.id));
      expect(useUIStore.getState().projectBoardTab).toBe("kanban");
    });

    test("sidebar, files panel and grouping follow the window", async () => {
      const path = makePath();
      path.open({});
      await settle();
      path.send({ type: "sidebar", open: false });
      path.send({ type: "grouping", grouping: "repository" });
      await settle();
      expect(useUIChromeStore.getState().sidebarOpen).toBe(false);
      expect(useRealmShellStore.getState().grouping).toBe("repository");
    });
  });
}

test("visibility defers a realm document's reads; in the window's tree the window's own visibility stands", async () => {
  const page = pagePath();
  page.open({});
  await settle();
  page.send({ type: "visibility", hidden: true });
  expect(getReadCoordinator().getDiagnostics().hostHidden).toBe(true);
  cleanup();
  resetReadCoordinatorForTests();

  const inTree = loopbackPath();
  inTree.open({});
  await settle();
  inTree.send({ type: "visibility", hidden: true });
  await settle();
  expect(getReadCoordinator().getDiagnostics().hostHidden).toBe(false);
});

test("in the window's tree, a host remounted on the same scope resumes without reopening a one-shot dialog", async () => {
  const inTree = loopbackPath();
  inTree.open({ projectId: project.id, dialog: "delete-project" });
  await act(async () => resolveProjects([project]));
  await waitFor(() => expect(useAppDialogStore.getState().request?.kind).toBe("delete-project"));
  const first = useAppDialogStore.getState().requestSequence;
  // Try again after a crash: a new host, on the same node scope and request.
  cleanup();
  const again = createRealmLoopback(null);
  loopbacks.push(again);
  render(
    <RealmChannelContext.Provider value={again.realm}>
      <WorkspaceRealmHost />
    </RealmChannelContext.Provider>,
  );
  await settle();
  expect(useAppDialogStore.getState().requestSequence).toBe(first);
});
