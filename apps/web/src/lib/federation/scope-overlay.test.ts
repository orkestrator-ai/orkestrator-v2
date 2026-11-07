import { afterEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  MAX_SUMMARY_PROJECTS,
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import { viewFromNodeSummary } from "@/components/federation/useMachineViews";
import { noteAuthoritativeRead } from "@/lib/node-scope/snapshot-sync";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import type { Environment, Project } from "@/types";
import { machineViewWithScopeRows, scopeRowsSource } from "./scope-overlay";

const NODE = "bk_leaf" as BackendId;
const ICON = "data:image/png;base64,iVBORw0KGgo=";

const projects: Project[] = [
  {
    id: "p-2",
    name: "second",
    gitUrl: "git@github.com:o/second.git",
    localPath: "/work/second",
    addedAt: "2026-10-01T00:00:00Z",
    order: 1,
    folder: "Clients",
  },
  {
    id: "p-1",
    name: "first",
    gitUrl: "https://github.com/o/first.git",
    localPath: "/work/first",
    addedAt: "2026-10-01T00:00:00Z",
    order: 0,
    icon: ICON,
  },
];

function environment(id: string, projectId: string, extra: Partial<Environment> = {}) {
  return {
    id,
    projectId,
    name: id,
    branch: id,
    containerId: null,
    environmentType: "local",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-10-01T00:00:00Z",
    worktreePath: `/work/trees/${id}`,
    networkAccessMode: "restricted",
    order: 0,
    agentActivityState: "idle",
    ...extra,
  } as unknown as Environment;
}

const environments: Environment[] = [
  environment("e-b", "p-1", { order: 1, agentActivityState: "waiting", hasUnreadWork: true }),
  environment("e-a", "p-1", { order: 0, prUrl: "https://github.com/o/first/pull/1" }),
  environment("e-c", "p-2", { projectHome: true, name: "project-home" }),
];

/** What a summary read adds to each record, by environment. */
const markers: Record<string, Record<string, unknown>> = {
  "e-a": { dockerAvailable: true, prMonitorConfirmed: true, buildPipeline: true },
  "e-b": { dockerAvailable: true, agentMailUnread: 2, agentMailFailed: true, buildActive: true },
  "e-c": { dockerAvailable: true, prViewerCanMerge: false },
};

/** The node's summary as the command node's read model builds it from the same records. */
function summaryOf(
  records: readonly Environment[] = environments,
  projectRecords: readonly Project[] = projects,
): NodeSummary {
  const summaryProjects = projectRecords
    .map((raw, index) => ({
      ...toNodeProjectSummary(NODE, raw as unknown as Record<string, unknown>, index)!,
      ...(raw.id === "p-1" ? { defaultBranch: "develop" } : {}),
    }))
    .sort((a, b) => a.order - b.order);
  const summaryEnvironments = summaryProjects.flatMap((project) =>
    records
      .filter((record) => record.projectId === project.ref.projectId)
      .map((record, index) =>
        toNodeEnvironmentSummary(
          NODE,
          { ...record, ...markers[record.id] } as Record<string, unknown>,
          index,
        )!,
      )
      .sort((a, b) => a.order - b.order),
  );
  return {
    nodeId: NODE,
    view: {
      nodeId: NODE,
      displayName: "Leaf",
      colorToken: "teal",
      connection: { state: "connected", epoch: 1 },
    } as NodeSummary["view"],
    available: true,
    freshness: "current",
    loadedAt: 1,
    truncated: false,
    lastError: null,
    projects: summaryProjects,
    environments: summaryEnvironments,
  };
}

test("a node's rows from its scope's records are the rows its summary gives", () => {
  const summary = summaryOf();
  const fromSummary = viewFromNodeSummary(summary);
  const fromScope = machineViewWithScopeRows(fromSummary, summary, { projects, environments });
  expect(fromScope).toEqual(fromSummary);
  // Same order too, which `toEqual` on arrays already pins; and the map's.
  expect(Array.from(fromScope.environmentsByProject.keys())).toEqual(
    Array.from(fromSummary.environmentsByProject.keys()),
  );
  // The fields a summary read adds came from the summary.
  const first = fromScope.environmentsByProject.get("p-1")!;
  expect(first.map((row) => row.ref.environmentId)).toEqual(["e-a", "e-b"]);
  expect(first[1]).toMatchObject({ agentMailUnread: 2, buildActive: true, activity: "waiting" });
  expect(fromScope.projects[0]).toMatchObject({ defaultBranch: "develop", icon: ICON });
});

test("the scope's fresher records win over the summary's, the summary-only fields stay", () => {
  const summary = summaryOf();
  const renamed = environments.map((record) =>
    record.id === "e-b"
      ? ({ ...record, name: "renamed", agentActivityState: "idle", order: -1 } as Environment)
      : record,
  );
  const added = [...renamed, environment("e-new", "p-2", { order: 5 })];
  const view = machineViewWithScopeRows(viewFromNodeSummary(summary), summary, {
    projects,
    environments: added,
  });
  const first = view.environmentsByProject.get("p-1")!;
  expect(first.map((row) => [row.ref.environmentId, row.name, row.activity])).toEqual([
    ["e-b", "renamed", "idle"],
    ["e-a", "e-a", "idle"],
  ]);
  expect(first[0]).toMatchObject({ agentMailUnread: 2, agentMailFailed: true });
  // A row created since the summary has no markers but the machine's Docker fact.
  const created = view.environmentsByProject.get("p-2")!.find((row) => row.name === "e-new")!;
  expect(created.dockerAvailable).toBe(true);
  expect(created.agentMailUnread === undefined).toBe(true);
});

test("the scope's rows keep the summary's bounds and skip unlisted projects' environments", () => {
  const many = Array.from(
    { length: MAX_SUMMARY_PROJECTS + 1 },
    (_, index) => ({ ...projects[0]!, id: `p-${index}`, order: index }) as Project,
  );
  const summary = summaryOf([], []);
  const view = machineViewWithScopeRows(viewFromNodeSummary(summary), summary, {
    projects: many,
    environments: [environment("orphan", "gone")],
  });
  expect(view.projects).toHaveLength(MAX_SUMMARY_PROJECTS);
  expect(view.truncated).toBe(true);
  expect(view.environmentsByProject.size).toBe(0);
});

let windowScope: WindowScope | null = null;
afterEach(() => {
  windowScope?.dispose();
  windowScope = null;
});

function leaf(tier: "warm" | "live" | "suspended" | "summary" = "warm") {
  windowScope = new WindowScope();
  const client = new FakeNodeClient({ nodeId: NODE });
  const scope = windowScope.open({ role: "leaf", client, tier });
  return { windowScope, client, scope };
}

test("a scope stands in for its summary only while warm or live, heard and authoritative", () => {
  const { windowScope, client, scope } = leaf("warm");
  const source = scopeRowsSource(windowScope);
  let notified = 0;
  const stop = source.subscribe(() => (notified += 1));
  try {
    expect(source.getSnapshot().size).toBe(0);
    scope.store(projectStore).getState().setProjects(projects);
    scope.store(environmentStore).getState().setEnvironments(environments);
    // Projects loaded, environments installed, but no authoritative read yet.
    expect(source.getSnapshot().size).toBe(0);
    const before = notified;
    noteAuthoritativeRead(scope, "environment");
    expect(notified).toBeGreaterThan(before);
    const ready = source.getSnapshot();
    expect(ready.get(NODE)?.environments).toBe(
      scope.store(environmentStore).getState().environments,
    );
    // Unchanged rows keep the snapshot's identity.
    expect(source.getSnapshot()).toBe(ready);

    scope.setTier("live");
    expect(source.getSnapshot()).toBe(ready);
    scope.setTier("suspended");
    expect(source.getSnapshot().size).toBe(0);
    scope.setTier("warm");
    expect(source.getSnapshot().get(NODE)).toBeTruthy();

    client.connection.set("lapsed");
    expect(source.getSnapshot().size).toBe(0);
    client.connection.set("live");

    const changed = notified;
    scope.store(environmentStore).getState().updateEnvironment("e-a", { name: "renamed" });
    expect(notified).toBeGreaterThan(changed);
    expect(source.getSnapshot()).not.toBe(ready);
    expect(
      source
        .getSnapshot()
        .get(NODE)
        ?.environments.find((e) => e.id === "e-a")?.name,
    ).toBe("renamed");

    scope.dispose();
    expect(source.getSnapshot().size).toBe(0);
  } finally {
    stop();
  }
});

test("a scope painted from its snapshot waits for the node's own projects", () => {
  const { windowScope, scope } = leaf("warm");
  const source = scopeRowsSource(windowScope);
  // A snapshot hydration installs projects without `hasLoaded` (plan item 4003).
  scope.store(projectStore).setState({ projects });
  scope.store(environmentStore).getState().setEnvironments(environments);
  noteAuthoritativeRead(scope, "environment");
  expect(source.getSnapshot().size).toBe(0);
  scope.store(projectStore).getState().setProjects(projects);
  expect(source.getSnapshot().get(NODE)?.projects).toHaveLength(2);
});

test("the command scope and summary-tier scopes never overlay", () => {
  const { windowScope, scope } = leaf("summary");
  const command = windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_command" as BackendId }),
  });
  for (const each of [scope, command]) {
    each.store(projectStore).getState().setProjects(projects);
    noteAuthoritativeRead(each, "environment");
  }
  expect(scopeRowsSource(windowScope).getSnapshot().size).toBe(0);
});

test("unsubscribing stops watching every scope", () => {
  const { windowScope, scope } = leaf("warm");
  const source = scopeRowsSource(windowScope);
  let notified = 0;
  const stop = source.subscribe(() => (notified += 1));
  stop();
  scope.store(projectStore).getState().setProjects(projects);
  scope.setTier("live");
  noteAuthoritativeRead(scope, "environment");
  expect(notified).toBe(0);
});
