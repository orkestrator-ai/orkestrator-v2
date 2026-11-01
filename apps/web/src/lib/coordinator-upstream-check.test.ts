import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ClientStateCapabilities } from "@orkestrator/protocol/client-state";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import { resetClientStateCapabilitiesForTests } from "@/lib/client-state-capabilities";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  checkUpstreamMergeOffer,
  declineUpstreamMerge,
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
  noticeDismissals: false,
  environmentAttention: false,
});

function seedBrowserCopy(declines: unknown) {
  localStorage.setItem(
    LEGACY_UPSTREAM_DECLINE_KEY,
    JSON.stringify({ state: { declines }, version: 0 }),
  );
}

function callsTo(command: string) {
  return invokeMock.mock.calls.filter((call) => call[0] === command);
}

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.removeItem(LEGACY_UPSTREAM_DECLINE_KEY);
  resetUpstreamCheckForTests();
});

afterEach(() => {
  localStorage.removeItem(LEGACY_UPSTREAM_DECLINE_KEY);
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

  test("records a decline on the backend, not in the browser", async () => {
    invokeMock.mockImplementation(async () => undefined);
    await declineUpstreamMerge("p", behind);
    expect(callsTo("decline_coordinator_upstream_merge")[0]?.[1]).toEqual({
      projectId: "p",
      upstream: "origin/main",
      upstreamCommit: tip,
    });
    expect(localStorage.getItem(LEGACY_UPSTREAM_DECLINE_KEY)).toBeNull();
  });

  test("imports the browser's declines once, without replacing newer answers", async () => {
    seedBrowserCopy([
      { projectId: "p", upstream: "origin/main", upstreamCommit: "old" },
      { projectId: "removed", upstream: "origin/main", upstreamCommit: "old" },
      { projectId: 4, upstream: "x", upstreamCommit: "y" },
    ]);
    invokeMock.mockImplementation(async (command: string, args: { projectId?: string }) => {
      if (command === "check_coordinator_upstream_merge") {
        return { offer: false, reason: "declined", status: behind };
      }
      if (args?.projectId === "removed") throw new Error("Project not found");
      return undefined;
    });
    await checkUpstreamMergeOffer("p", { turnRunning: () => false });
    await checkUpstreamMergeOffer("p", { turnRunning: () => false });
    const imports = callsTo("decline_coordinator_upstream_merge");
    expect(imports.map((call) => call[1].projectId)).toEqual(["p", "removed"]);
    expect(imports[0]?.[1].onlyIfAbsent).toBe(true);
    expect(localStorage.getItem(LEGACY_UPSTREAM_DECLINE_KEY)).toBeNull();
  });

  test("keeps the browser's declines for a later session when an import fails", async () => {
    seedBrowserCopy([{ projectId: "p", upstream: "origin/main", upstreamCommit: "old" }]);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "check_coordinator_upstream_merge") {
        return { offer: true, status: behind };
      }
      throw new Error("transport closed");
    });
    await checkUpstreamMergeOffer("p", { turnRunning: () => false });
    expect(localStorage.getItem(LEGACY_UPSTREAM_DECLINE_KEY)).not.toBeNull();
  });
});

describe("against an older backend", () => {
  beforeEach(() => resetClientStateCapabilitiesForTests(capabilities(false)));

  test("applies the protocol rule here, honouring the browser's declines", async () => {
    invokeMock.mockImplementation(async () => behind);
    expect(await checkUpstreamMergeOffer("p", { turnRunning: () => false })).toEqual({
      offer: true,
      status: behind,
    });
    expect(callsTo("fetch_project_git")).toHaveLength(1);
    expect(callsTo("check_coordinator_upstream_merge")).toHaveLength(0);

    await declineUpstreamMerge("p", behind);
    expect(callsTo("decline_coordinator_upstream_merge")).toHaveLength(0);
    expect(await checkUpstreamMergeOffer("p", { turnRunning: () => false })).toMatchObject({
      offer: false,
      reason: "declined",
    });
    expect(
      await checkUpstreamMergeOffer("p", {
        turnRunning: () => false,
        onStatus: () => undefined,
      }),
    ).toMatchObject({ status: behind });
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
