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
import { toNodeEnvironmentSummary } from "@orkestrator/protocol/node-summaries";
import type { MachineView } from "@/lib/federation/aggregate";
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
  const deleting =
    environment.lifecycleOperation === "deleting" || Boolean(environment.deletionRequestedAt);
  return row(
    localEnvironmentRowFacts(environment, {
      deleting,
      activity: markers.buildActive ? "working" : (environment.agentActivityState ?? "idle"),
      running: environment.environmentType === "local" || environment.status === "running",
      buildPipeline: markers.buildPipeline === true,
      unreadMail: markers.unreadMail ?? 0,
      failedMail: markers.failedMail === true,
      prMergeState: localEnvironmentPrMergeState(environment, markers.monitor ?? null, "current"),
      machine: { name: machine.name, colorToken: machine.colorToken },
      dockerAvailable: true,
      localCheckoutAvailable: true,
    }),
  );
}

function nodeRow(environment: Environment, markers: Markers): Row {
  // The record `get_environment_snapshots` answers a node summary read with.
  const raw = {
    ...environment,
    ...(markers.buildPipeline ? { buildPipeline: true } : {}),
    ...(markers.buildActive ? { buildActive: true } : {}),
    ...(markers.unreadMail ? { agentMailUnread: markers.unreadMail } : {}),
    ...(markers.failedMail ? { agentMailFailed: true } : {}),
    ...(isPrReadingConfirmedByMonitor(environment, markers.monitor)
      ? { prMonitorConfirmed: true }
      : {}),
  };
  const summary = toNodeEnvironmentSummary(NODE, raw as Record<string, unknown>)!;
  expect(summary.ref).toEqual(environmentRef(NODE, environment.id));
  return row(nodeEnvironmentRowFacts(machine, summary, { busy: false, writable: true }));
}

/** Everything but the machine lines, which differ by design ("This window"). */
function comparable({ facts, model }: Row) {
  const { machine, ...otherFacts } = facts;
  const { markerMachine, cardMachine, ...otherModel } = model;
  return {
    facts: { ...otherFacts, machine: machine && { name: machine.name } },
    model: {
      ...otherModel,
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
