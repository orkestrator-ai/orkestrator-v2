import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { readLegacyPersistedState, writeLegacyPersistedState } from "@/lib/legacy-local-state";
import {
  checkUpstreamMergeOffer,
  LEGACY_UPSTREAM_DECLINE_KEY,
  resetUpstreamCheckForTests,
} from "./coordinator-upstream-check";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const tip = "b".repeat(40);
const behind = {
  projectId: "p",
  upstream: "origin/main",
  upstreamCommit: tip,
  ahead: 0,
  behind: 2,
  trackedChanges: 0,
  untrackedChanges: 0,
  repositoryOperationBlockedReason: null,
} as unknown as ProjectGitStatus;

const capabilities = (coordinatorUpstreamMerge: boolean): ClientStateCapabilities => ({
  coordinatorPaneLayouts: false,
  coordinatorUpstreamMerge,
  coordinatorUpstreamAutoMerge: false,
  noticeDismissals: false,
  environmentAttention: false,
});

function callsTo(command: string) {
  return invokeMock.mock.calls.filter((call) => call[0] === command);
}

beforeEach(() => {
  invokeMock.mockReset();
  resetUpstreamCheckForTests();
});

afterEach(() => {
  resetClientStateCapabilitiesForTests();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("against a backend that decides", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(true)));

  test("asks the backend, hands on the refreshed status and never fetches itself", async () => {
    invokeMock.mockImplementation(async () => ({ offer: true, status: behind }));
    const statuses: ProjectGitStatus[] = [];
    const turnRunning = mock(() => true);
    const check = await checkUpstreamMergeOffer("p", {
      turnRunning,
      onStatus: (status) => statuses.push(status),
    });
    expect(check).toEqual({ offer: true, status: behind });
    expect(statuses).toEqual([behind]);
    expect(turnRunning).not.toHaveBeenCalled();
    expect(callsTo("fetch_project_git")).toHaveLength(0);
  });

  test("passes an automatic offer through", async () => {
    invokeMock.mockImplementation(async () => ({ offer: true, status: behind, automatic: true }));
    expect(await checkUpstreamMergeOffer("p", { turnRunning: () => false })).toEqual({
      offer: true,
      status: behind,
      automatic: true,
    });
  });

  test("deletes the browser's copy of earlier declines without importing it", async () => {
    writeLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY, {
      declines: [{ projectId: "p", upstream: "origin/main", upstreamCommit: "old" }],
    });
    invokeMock.mockImplementation(async () => ({ offer: true, status: behind, automatic: true }));
    await checkUpstreamMergeOffer("p", { turnRunning: () => false });
    expect(readLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY)).toBeNull();
    expect(callsTo("decline_coordinator_upstream_merge")).toHaveLength(0);
  });
});

describe("against an older backend", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(false)));

  test("applies the protocol rule here: a mergeable checkout is always merged", async () => {
    writeLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY, {
      declines: [{ projectId: "p", upstream: "origin/main", upstreamCommit: tip }],
    });
    invokeMock.mockImplementation(async () => behind);
    const statuses: ProjectGitStatus[] = [];
    expect(
      await checkUpstreamMergeOffer("p", {
        turnRunning: () => false,
        onStatus: (status) => statuses.push(status),
      }),
    ).toEqual({ offer: true, status: behind, automatic: true });
    expect(statuses).toEqual([behind]);
    expect(callsTo("fetch_project_git")).toHaveLength(1);
    expect(callsTo("check_coordinator_upstream_merge")).toHaveLength(0);
  });

  test("a running turn is not asked about and starts no fetch", async () => {
    expect(await checkUpstreamMergeOffer("p", { turnRunning: () => true })).toEqual({
      offer: false,
      reason: "turn-running",
      status: null,
    });
    expect(callsTo("fetch_project_git")).toHaveLength(0);
  });
});

test("a backend that does not know the command gets the browser-local rule", async () => {
  resetClientStateCapabilitiesForTests();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_client_state_capabilities") {
      throw new Error("Unknown backend command: get_client_state_capabilities");
    }
    return behind;
  });
  expect(await checkUpstreamMergeOffer("p", { turnRunning: () => false })).toEqual({
    offer: true,
    status: behind,
    automatic: true,
  });
  expect(callsTo("check_coordinator_upstream_merge")).toHaveLength(0);
});

test("a transient capability failure decides nothing", async () => {
  resetClientStateCapabilitiesForTests();
  invokeMock.mockImplementation(async () => {
    throw new Error("transport closed");
  });
  await expect(checkUpstreamMergeOffer("p", { turnRunning: () => false })).rejects.toThrow(
    "transport closed",
  );
  expect(callsTo("fetch_project_git")).toHaveLength(0);
});
