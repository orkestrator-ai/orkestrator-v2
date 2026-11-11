import { describe, expect, test } from "bun:test";
import type { CoordinatorDelegation, CoordinatorWorkflowAssociation } from "./coordinator.js";
import {
  coordinatorLaunchOverrideKey,
  coordinatorLaunchOverrides,
  coordinatorLaunchOverridesSnapshot,
  coordinatorTabLaunchRequest,
  parseCoordinatorLaunchOverrides,
} from "./coordinator-launch-overrides.js";

const delegation = (extra: Partial<CoordinatorDelegation> = {}): CoordinatorDelegation => ({
  requestedAt: "2026-11-05T10:00:00.000Z",
  workerTabId: "startup-agent",
  state: "running",
  ...extra,
});

const association = (
  extra: Partial<CoordinatorWorkflowAssociation> = {},
): CoordinatorWorkflowAssociation => ({
  id: "association",
  coordinatorId: "coordinator",
  projectId: "project",
  kind: "environment",
  resourceId: "worker",
  requestId: "request",
  createdAt: "2026-11-05T10:00:00.000Z",
  ...extra,
});

const launched = (source: "requested" | "default") =>
  association({
    delegation: delegation({
      request: { agent: "claude", model: "opus", reasoning: "max", source },
    }),
  });

describe("coordinatorLaunchOverrides", () => {
  test("lists a launch that overrode the default, and not one that used it", () => {
    expect(coordinatorLaunchOverrides([launched("requested")])).toEqual([
      { environmentId: "worker", tabId: "startup-agent", model: "opus", reasoning: "max" },
    ]);
    expect(coordinatorLaunchOverrides([launched("default")])).toEqual([]);
  });

  test("a follow-up to the worker keeps the launch's answer", () => {
    const followUp = association({
      id: "follow-up",
      delegation: delegation({
        requestedAt: "2026-11-05T11:00:00.000Z",
        request: { summary: "Now add tests", agent: "claude" },
      }),
    });
    // A reasoning-only override names no model, which is what a follow-up matches on.
    const reasoningOnly = association({
      delegation: delegation({
        request: { agent: "claude", reasoning: "max", source: "requested" },
      }),
    });
    expect(coordinatorLaunchOverrides([reasoningOnly, followUp])).toEqual([
      { environmentId: "worker", tabId: "startup-agent", reasoning: "max" },
    ]);
  });

  test("a tab the coordinator only messaged is not an override", () => {
    expect(
      coordinatorLaunchOverrides([
        association({ delegation: delegation({ request: { summary: "Look at this" } }) }),
        association({ delegation: delegation() }),
      ]),
    ).toEqual([]);
  });

  test("each tab answers for itself", () => {
    const overrides = coordinatorLaunchOverrides([
      launched("default"),
      association({
        id: "job",
        delegation: delegation({
          workerTabId: "job-tab",
          request: { agent: "codex", model: "gpt-5", source: "requested" },
        }),
      }),
    ]);
    expect(overrides).toEqual([{ environmentId: "worker", tabId: "job-tab", model: "gpt-5" }]);
  });

  test("a reservation and other kinds are not listed", () => {
    const requested = launched("requested");
    expect(
      coordinatorLaunchOverrides([
        { ...requested, pending: true },
        { ...requested, kind: "build-pipeline" },
        association(),
      ]),
    ).toEqual([]);
  });

  test("a worker on another node is listed with that node, apart from a local one", () => {
    const requested = launched("requested");
    // The same environment and tab ids on another node are another tab.
    const remoteDefault = { ...launched("default"), id: "remote-default", nodeId: "bk_other" };
    expect(
      coordinatorLaunchOverrides([
        { ...requested, nodeId: "bk_leaf" },
        requested,
        remoteDefault,
        { ...requested, nodeId: "bk_leaf", pending: true },
      ]),
    ).toEqual([
      {
        nodeId: "bk_leaf",
        environmentId: "worker",
        tabId: "startup-agent",
        model: "opus",
        reasoning: "max",
      },
      { environmentId: "worker", tabId: "startup-agent", model: "opus", reasoning: "max" },
    ]);
  });

  test("a remote tab's newest launch decides, as a local one's does", () => {
    const first = association({
      nodeId: "bk_leaf",
      delegation: delegation({ request: { model: "opus", source: "requested" } }),
    });
    const relaunch = association({
      id: "relaunch",
      nodeId: "bk_leaf",
      delegation: delegation({
        requestedAt: "2026-11-05T12:00:00.000Z",
        request: { source: "default" },
      }),
    });
    expect(coordinatorLaunchOverrides([first, relaunch])).toEqual([]);
  });
});

describe("coordinatorTabLaunchRequest", () => {
  test("the newest request stating a source wins, whatever order it arrives in", () => {
    const first = delegation({ request: { source: "default" } });
    const second = delegation({
      requestedAt: "2026-11-05T11:00:00.000Z",
      request: { source: "requested" },
    });
    expect(coordinatorTabLaunchRequest([first, second])?.source).toBe("requested");
    expect(coordinatorTabLaunchRequest([second, first])?.source).toBe("requested");
    expect(coordinatorTabLaunchRequest([delegation()])).toBeUndefined();
  });
});

describe("parseCoordinatorLaunchOverrides", () => {
  test("keeps the well-formed rows of any answer", () => {
    expect(parseCoordinatorLaunchOverrides(undefined)).toEqual({ overrides: [] });
    expect(parseCoordinatorLaunchOverrides({ overrides: "nope" })).toEqual({ overrides: [] });
    expect(
      parseCoordinatorLaunchOverrides({
        overrides: [
          null,
          { environmentId: "worker" },
          { environmentId: "", tabId: "tab" },
          { environmentId: "worker", tabId: "tab", model: 3, reasoning: "max" },
        ],
      }),
    ).toEqual({ overrides: [{ environmentId: "worker", tabId: "tab", reasoning: "max" }] });
  });

  test("reads other nodes' rows apart, and drops a row whose node is wrong for its list", () => {
    expect(
      parseCoordinatorLaunchOverrides({
        overrides: [
          { environmentId: "worker", tabId: "tab" },
          { nodeId: "bk_leaf", environmentId: "worker", tabId: "stray" },
        ],
        remoteOverrides: [
          { nodeId: "bk_leaf", environmentId: "worker", tabId: "tab", model: "opus" },
          { nodeId: "", environmentId: "worker", tabId: "tab" },
          { nodeId: 7, environmentId: "worker", tabId: "tab" },
          { environmentId: "worker", tabId: "tab" },
        ],
      }),
    ).toEqual({
      overrides: [{ environmentId: "worker", tabId: "tab" }],
      remoteOverrides: [
        { nodeId: "bk_leaf", environmentId: "worker", tabId: "tab", model: "opus" },
      ],
    });
    expect(parseCoordinatorLaunchOverrides({ overrides: [], remoteOverrides: "nope" })).toEqual({
      overrides: [],
    });
  });
});

describe("coordinatorLaunchOverridesSnapshot", () => {
  test("keeps every row naming another node out of the list an older renderer reads", () => {
    const requested = launched("requested");
    expect(
      coordinatorLaunchOverridesSnapshot([requested, { ...requested, id: "r", nodeId: "bk_leaf" }]),
    ).toEqual({
      overrides: [
        { environmentId: "worker", tabId: "startup-agent", model: "opus", reasoning: "max" },
      ],
      remoteOverrides: [
        {
          nodeId: "bk_leaf",
          environmentId: "worker",
          tabId: "startup-agent",
          model: "opus",
          reasoning: "max",
        },
      ],
    });
    expect(coordinatorLaunchOverridesSnapshot([requested])).toEqual({
      overrides: [
        { environmentId: "worker", tabId: "startup-agent", model: "opus", reasoning: "max" },
      ],
    });
  });
});

describe("coordinatorLaunchOverrideKey", () => {
  test("a node-qualified key never equals a local one", () => {
    expect(coordinatorLaunchOverrideKey("bk_leaf", "worker", "tab")).not.toBe(
      coordinatorLaunchOverrideKey(undefined, "worker", "tab"),
    );
    expect(coordinatorLaunchOverrideKey(undefined, "worker", "tab")).toBe(
      coordinatorLaunchOverrideKey(undefined, "worker", "tab"),
    );
  });
});
