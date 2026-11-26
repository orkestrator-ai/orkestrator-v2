import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
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

function callsTo(command: string) {
  return invokeMock.mock.calls.filter((call) => call[0] === command);
}

beforeEach(() => {
  invokeMock.mockReset();
  resetUpstreamCheckForTests();
});

afterEach(() => {
  invokeMock.mockImplementation(() => Promise.resolve());
});

test("asks the backend, hands on the refreshed status and never fetches itself", async () => {
  invokeMock.mockImplementation(async () => ({ offer: true, status: behind }));
  const statuses: ProjectGitStatus[] = [];
  const check = await checkUpstreamMergeOffer("p", {
    onStatus: (status) => statuses.push(status),
  });
  expect(check).toEqual({ offer: true, status: behind });
  expect(statuses).toEqual([behind]);
  expect(callsTo("check_coordinator_upstream_merge")).toHaveLength(1);
  expect(callsTo("fetch_project_git")).toHaveLength(0);
});

test("passes an automatic offer through", async () => {
  invokeMock.mockImplementation(async () => ({ offer: true, status: behind, automatic: true }));
  expect(await checkUpstreamMergeOffer("p", {})).toEqual({
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
  await checkUpstreamMergeOffer("p", {});
  expect(readLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY)).toBeNull();
  expect(callsTo("decline_coordinator_upstream_merge")).toHaveLength(0);
});

test("a transport failure decides nothing", async () => {
  invokeMock.mockImplementation(async () => {
    throw new Error("transport closed");
  });
  await expect(checkUpstreamMergeOffer("p", {})).rejects.toThrow("transport closed");
  expect(callsTo("fetch_project_git")).toHaveLength(0);
});
