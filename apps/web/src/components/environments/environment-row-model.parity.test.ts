/**
 * One environment, two ways in: this window's own record (`EnvironmentItem`)
 * and the node summary a command node shows for another machine
 * (`RemoteEnvironmentItem`). The row must look the same either way. Each case
 * builds the summary the way the real path does: the record the machine's
 * `get_environment_snapshots` returns, with its summary markers, through
 * `toNodeEnvironmentSummary`.
 *
 * When this fails after adding something to a row, supply it on the other
 * path too (usually a field in `NodeEnvironmentSummary` and the machine's
 * snapshot), rather than changing the expectation.
 */
import { describe, expect, test } from "bun:test";
import { environmentRef } from "@orkestrator/protocol/federation";
import type { BackendId } from "@orkestrator/protocol/federation";
import { isPrReadingConfirmedByMonitor } from "@orkestrator/protocol/pr-merge-readiness";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import {
  environmentHasDeletionTombstone,
  toNodeEnvironmentSummary,
} from "@orkestrator/protocol/node-summaries";
import type { MachineView } from "@/lib/federation/aggregate";
import { machineViewWithScopeRows } from "@/lib/federation/scope-overlay";
import { isLocalDeletionRetryable } from "@/lib/federation/selected-environments";
import { localEnvironmentPrMergeState } from "@/lib/pr-merge-readiness";
import type { Environment } from "@/types";
import { localEnvironmentRowFacts, nodeEnvironmentRowFacts } from "./environment-row-facts";
import {
  environmentRowModel,
  type EnvironmentRowFacts,
  type EnvironmentRowModel,
} from "./environment-row-model";

/** A row's facts and the model drawn from them: everything the row shows. */
interface Row {
  facts: EnvironmentRowFacts;
  model: EnvironmentRowModel;
}

function row(facts: EnvironmentRowFacts): Row {
  return { facts, model: environmentRowModel(facts) };
}

const NODE = "bk_leaf" as BackendId;

const base = {
  id: "env-1",
  projectId: "project-1",
  name: "feature",
  branch: "feature",
  containerId: null,
  environmentType: "local",
  status: "running",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2026-10-01T00:00:00Z",
  networkAccessMode: "restricted",
  order: 0,
  agentActivityState: "idle",
  agentActivityUpdatedAt: "2026-10-21T09:00:00Z",
  lastActivityAt: "2026-10-21T09:00:00Z",
} as unknown as Environment;

/** What the machine's summary read adds to a record, beside the record itself. */
interface Markers {
  buildPipeline?: boolean;
  buildActive?: boolean;
  unreadMail?: number;
  failedMail?: boolean;
  /** The machine's Docker availability; absent as from a leaf that predates it. */
  dockerAvailable?: boolean;
  monitor?: PrMonitorEnvironmentState;
}

function monitorFor(environment: Environment): PrMonitorEnvironmentState {
  return {
    environmentId: environment.id,
    mode: "normal",
    checkInProgress: false,
    consecutiveErrors: 0,
    lastCheckAt: "2026-10-21T09:00:00Z",
    lastSuccessfulCheckAt: "2026-10-21T09:00:00Z",
    prUrl: environment.prUrl ?? null,
    prState: environment.prState ?? null,
    hasMergeConflicts: environment.hasMergeConflicts ?? null,
    checkSummary: null,
  } as PrMonitorEnvironmentState;
}

const machine: MachineView = {
  connectionId: NODE,
  backendId: NODE,
  name: "RKMBP",
  colorToken: "teal",
  bound: false,
  freshness: "current",
  transport: "connected",
  projects: [
    {
      ref: projectRef(NODE, "project-1"),
      key: projectKey(projectRef(NODE, "project-1")),
      name: "app",
      order: 0,
      pathName: "app",
    },
  ],
  environmentsByProject: new Map(),
  truncated: false,
  loadedAt: 1,
};

function localRow(environment: Environment, markers: Markers): Row {
  const deleting = environmentHasDeletionTombstone(environment);
  const dockerAvailable = markers.dockerAvailable ?? true;
  return row(
    localEnvironmentRowFacts(environment, {
      deleting,
      deletionRetryable: isLocalDeletionRetryable(environment, new Set()),
      activity: markers.buildActive ? "working" : (environment.agentActivityState ?? "idle"),
      // As `useEnvironmentDisplayActivity` decides it.
      running:
        environment.environmentType === "local" ||
        (dockerAvailable && environment.status === "running"),
      buildPipeline: markers.buildPipeline === true,
      unreadMail: markers.unreadMail ?? 0,
      failedMail: markers.failedMail === true,
      prMergeState: localEnvironmentPrMergeState(
        environment,
        markers.monitor ?? null,
        "current",
        true,
      ),
      machine: { name: machine.name, colorToken: machine.colorToken },
      dockerAvailable,
      localCheckoutAvailable: true,
    }),
  );
}

/** The node summary of `environment`, as the command node keeps it. */
function nodeSummary(environment: Environment, markers: Markers) {
  // The record `get_environment_snapshots` answers a node summary read with.
  const raw = {
    ...environment,
    ...(markers.buildPipeline ? { buildPipeline: true } : {}),
    ...(markers.buildActive ? { buildActive: true } : {}),
    ...(markers.unreadMail ? { agentMailUnread: markers.unreadMail } : {}),
    ...(markers.failedMail ? { agentMailFailed: true } : {}),
    ...(markers.dockerAvailable === undefined ? {} : { dockerAvailable: markers.dockerAvailable }),
    ...(isPrReadingConfirmedByMonitor(environment, markers.monitor)
      ? { prMonitorConfirmed: true }
      : {}),
  };
  const summary = toNodeEnvironmentSummary(NODE, raw as Record<string, unknown>)!;
  expect(summary.ref).toEqual(environmentRef(NODE, environment.id));
  return summary;
}

function nodeRow(environment: Environment, markers: Markers): Row {
  const summary = nodeSummary(environment, markers);
  return row(nodeEnvironmentRowFacts(machine, summary, { busy: false, writable: true }, true));
}

/**
 * The same machine's row while the window holds its scope warm or live (plan
 * item 5007): the scope's own record, overlaid on the summary, which keeps
 * only what a summary read adds.
 */
function scopeRow(environment: Environment, markers: Markers): Row {
  const summary = nodeSummary(environment, markers);
  const project = {
    id: "project-1",
    name: "app",
    gitUrl: "",
    localPath: "/work/app",
    addedAt: "2026-10-01T00:00:00Z",
    order: 0,
  };
  const view = machineViewWithScopeRows(
    machine,
    { projects: [...machine.projects], environments: [summary] },
    { projects: [project], environments: [environment] },
  );
  expect(view.projects).toEqual(machine.projects);
  const overlaid = view.environmentsByProject.get("project-1")?.[0];
  expect(overlaid).toEqual(summary);
  return row(nodeEnvironmentRowFacts(view, overlaid!, { busy: false, writable: true }, true));
}

/** Machine lines and failure detail differ by design: remote errors are content-free. */
function comparable({ facts, model }: Row) {
  const { machine, ...otherFacts } = facts;
  const { markerMachine, cardMachine, ...otherModel } = model;
  return {
    facts: {
      ...otherFacts,
      deleteFailure: Boolean(facts.deleteFailure),
      machine: machine && { name: machine.name },
    },
    model: {
      ...otherModel,
      deleteFailureText: Boolean(model.deleteFailureText),
      markerMachine: markerMachine && { name: markerMachine.name },
      cardMachine: cardMachine && { name: cardMachine.name },
    },
  };
}

const cases: Array<[string, Partial<Environment>, Markers]> = [
  ["an idle local worktree", {}, {}],
  ["a working container", { environmentType: "containerized", agentActivityState: "working" }, {}],
  ["a local agent waiting for an answer", { agentActivityState: "waiting" }, {}],
  [
    "a stopped container whose agent last waited",
    { environmentType: "containerized", status: "stopped", agentActivityState: "waiting" },
    {},
  ],
  ["a container being created", { environmentType: "containerized", status: "creating" }, {}],
  ["a container stopping", { environmentType: "containerized", status: "stopping" }, {}],
  ["an environment being deleted", { lifecycleOperation: "deleting" }, {}],
  [
    "a failed deletion kept for retry",
    { deletionRequestedAt: "2026-10-21T09:00:00Z", cleanupAfterMergeError: "failed" },
    {},
  ],
  [
    "a failed deletion with its own reason",
    {
      lifecycleOperation: "deleting",
      deletionRequestedAt: "2026-10-21T09:00:00Z",
      deletionError: "Terminal process trees are still running",
    },
    {},
  ],
  [
    "a merged pull request with auto-merge on",
    { prUrl: "https://github.com/o/r/pull/1", prState: "merged", autoMerge: true },
    {},
  ],
  [
    "an open pull request with auto-merge on",
    { prUrl: "https://github.com/o/r/pull/1", prState: "open", autoMerge: true },
    {},
  ],
  [
    "a working build pipeline",
    { name: "Build: feature" },
    { buildPipeline: true, buildActive: true },
  ],
  ["a paused build pipeline", { name: "Build: feature" }, { buildPipeline: true }],
  ["a project home", { name: "project-home", projectHome: true }, {}],
  [
    "unread work, unread mail and a failed delivery",
    { hasUnreadWork: true },
    { unreadMail: 3, failedMail: true },
  ],
  [
    "a running container on a machine whose Docker is down",
    { environmentType: "containerized", status: "running", agentActivityState: "working" },
    { dockerAvailable: false },
  ],
  ["a local worktree on a machine whose Docker is down", {}, { dockerAvailable: false }],
  [
    "a stopped container on a machine with Docker",
    { environmentType: "containerized", status: "stopped" },
    { dockerAvailable: true },
  ],
];

describe("an environment row looks the same on its own machine and through a command node", () => {
  for (const [label, overrides, markers] of cases) {
    test(label, () => {
      const environment = { ...base, ...overrides } as Environment;
      expect(comparable(nodeRow(environment, markers))).toEqual(
        comparable(localRow(environment, markers)),
      );
    });
  }

  test.each([
    ["container", null, "container"],
    ["worktree", null, "worktree"],
    ["future-step", null, null],
    ["container", "stopped", null],
  ] as const)(
    "deletion stage %s with failure %s has the same local and relayed facts",
    (step, failure, expected) => {
      const environment = {
        ...base,
        lifecycleOperation: "deleting",
        deletionRequestedAt: "2026-10-21T09:00:00Z",
        lifecycleOperationStartedAt: "2026-10-21T09:00:00Z",
        deletionStep: step,
        deletionError: failure,
      } as Environment;
      const local = localRow(environment, {});
      const remote = nodeRow(environment, {});
      expect(local.facts.deletingStep).toBe(expected);
      expect(remote.facts.deletingStep).toBe(expected);
      expect(comparable(remote)).toEqual(comparable(local));
    },
  );

  for (const [label, hasMergeConflicts, expected] of [
    ["a pull request ready to merge", false, "merge-ready"],
    ["a pull request with conflicts", true, "merge-conflicts"],
  ] as const) {
    test(`${label}, vouched for by the machine's monitor`, () => {
      const environment = {
        ...base,
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
        hasMergeConflicts,
        prMergeability: hasMergeConflicts ? "conflicting" : "clean",
      } as Environment;
      const markers = { monitor: monitorFor(environment) };
      const local = localRow(environment, markers);
      expect(local.model.nameSignal).toBe(expected);
      expect(comparable(nodeRow(environment, markers))).toEqual(comparable(local));
    });
  }
});

describe("another machine's row is the same from its summary and from its warm scope", () => {
  for (const [label, overrides, markers] of cases) {
    test(label, () => {
      const environment = { ...base, ...overrides } as Environment;
      expect(scopeRow(environment, markers)).toEqual(nodeRow(environment, markers));
    });
  }

  test("a PR reading vouched for by the machine's monitor", () => {
    const environment = {
      ...base,
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
      hasMergeConflicts: false,
      prMergeability: "clean",
    } as Environment;
    const markers = { monitor: monitorFor(environment) };
    const fromScope = scopeRow(environment, markers);
    expect(fromScope.model.nameSignal).toBe("merge-ready");
    expect(fromScope).toEqual(nodeRow(environment, markers));
  });
});

test("multi-select takes a failed cleanup but not a delete in flight, on either path", () => {
  const failed = {
    ...base,
    deletionRequestedAt: "2026-10-21T09:00:00Z",
    cleanupAfterMergeError: "failed",
  } as Environment;
  const failedInRecovery = { ...failed, lifecycleOperation: "deleting" } as Environment;
  const inFlight = { ...base, lifecycleOperation: "deleting" } as Environment;
  const failedDelete = {
    ...inFlight,
    deletionRequestedAt: "2026-10-21T09:00:00Z",
    deletionError: "failed",
  } as Environment;
  for (const environment of [failed, failedInRecovery]) {
    expect(localRow(environment, {}).model.selectable).toBe(true);
    expect(nodeRow(environment, {}).model.selectable).toBe(true);
  }
  expect(localRow(inFlight, {}).model.selectable).toBe(false);
  expect(nodeRow(inFlight, {}).model.selectable).toBe(false);
  // A stopped progress spinner does not lift the selection fence. Only the
  // explicit merge-cleanup retry flag permits bulk selection of a tombstone.
  expect(localRow(failedDelete, {}).model.selectable).toBe(false);
  expect(nodeRow(failedDelete, {}).model.selectable).toBe(false);
  expect(localRow(base, {}).model.selectable).toBe(true);
  expect(nodeRow(base, {}).model.selectable).toBe(true);
});

test("offline, busy and unwritable node facts disable mutations and retain last-known activity", () => {
  const summary = toNodeEnvironmentSummary(NODE, { ...base, agentActivityState: "working" })!;
  for (const [transport, busy, writable] of [
    ["unreachable", false, false],
    ["connected", true, true],
    ["connected", false, false],
  ] as const) {
    const facts = nodeEnvironmentRowFacts(
      { ...machine, transport },
      summary,
      { busy, writable },
      true,
    );
    const model = environmentRowModel(facts);
    expect(model.menu.deleteDisabled).toBe(true);
    expect(model.menu.forkContainerDisabled).toBe(true);
    expect(model.menu.powerDisabled).toBe(true);
    expect(model.markerState).toBe(transport === "connected" ? "working" : "inactive");
    expect(model.spinner).toBe(busy ? "transition" : null);
  }
});

test("Docker unavailable blocks container actions while local worktree actions remain usable", () => {
  const facts = localEnvironmentRowFacts(base, {
    deleting: false,
    deletionRetryable: false,
    activity: "idle",
    running: true,
    buildPipeline: false,
    unreadMail: 0,
    failedMail: false,
    prMergeState: null,
    machine: null,
    dockerAvailable: false,
    localCheckoutAvailable: true,
  });
  const model = environmentRowModel(facts);
  expect(model.menu.forkContainerDisabled).toBe(true);
  expect(model.menu.powerDisabled).toBe(true);
  expect(model.menu.restartDisabled).toBe(true);
  expect(model.menu.forkLocalDisabled).toBe(false);
  expect(model.menu.deleteDisabled).toBe(false);
});

test("a machine's Docker availability gates another machine's container actions; an older leaf's rows do not", () => {
  const container = { ...base, environmentType: "containerized", status: "running" };
  const read = (extra: Record<string, unknown>) =>
    environmentRowModel(
      nodeEnvironmentRowFacts(
        machine,
        toNodeEnvironmentSummary(NODE, { ...container, ...extra })!,
        {
          busy: false,
          writable: true,
        },
        true,
      ),
    );
  const down = read({ dockerAvailable: false });
  expect(down.menu.forkContainerDisabled).toBe(true);
  expect(down.menu.powerDisabled).toBe(true);
  expect(down.menu.restartDisabled).toBe(true);
  expect(down.isRunning).toBe(false);
  expect(down.menu.forkLocalDisabled).toBe(false);
  // A leaf that predates the field sends none: the row stays as it was.
  for (const model of [read({}), read({ dockerAvailable: true })]) {
    expect(model.menu.forkContainerDisabled).toBe(false);
    expect(model.menu.powerDisabled).toBe(false);
    expect(model.menu.restartDisabled).toBe(false);
    expect(model.isRunning).toBe(true);
  }
});

test.each(["deletionError", "cleanupAfterMergeError"] as const)(
  "failed %s tombstones retain Retry without enabling either Fork action",
  (field) => {
    const environment = { ...base, deletionRequestedAt: "2026-11-05T12:00:00Z", [field]: "failed" };
    for (const value of [localRow(environment, {}), nodeRow(environment, {})]) {
      expect(value.facts.deletionPending).toBe(true);
      expect(value.model.deleteFailureText).toBe(
        value.facts.machine?.isThisWindow === false
          ? "Deletion failed. Retry on the owning machine."
          : "Delete failed: failed",
      );
      expect(value.model.spinner).toBeNull();
      expect(value.model.menu.deleteDisabled).toBe(false);
      expect(value.model.menu.forkLocalDisabled).toBe(true);
      expect(value.model.menu.forkContainerDisabled).toBe(true);
    }
  },
);
