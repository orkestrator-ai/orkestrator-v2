import { describe, expect, test } from "bun:test";
import { classifyLaunchBaseTip, launchBaseForCreate } from "./launch-base";

const COMMIT = "a".repeat(40);

describe("classifyLaunchBaseTip", () => {
  test("a tip this read refreshed from the remote is fresh", () => {
    const state = classifyLaunchBaseTip({
      branch: "main",
      commit: COMMIT,
      ref: "origin/main",
      fetched: true,
      launchEligible: true,
      fetchedAt: "2026-11-19T10:00:00.000Z",
    });
    expect(state).toEqual({
      status: "ready",
      freshness: "fresh",
      branch: "main",
      ref: "origin/main",
      commit: COMMIT,
      fetchedAt: "2026-11-19T10:00:00.000Z",
    });
    expect(launchBaseForCreate(state)).toEqual({ branch: "main", commit: COMMIT });
  });

  test("a tip refreshed a moment ago, inside the cooldown, is still fresh", () => {
    expect(
      classifyLaunchBaseTip({
        branch: "main",
        commit: COMMIT,
        ref: "origin/main",
        fetched: false,
        launchEligible: true,
        fetchedAt: "2026-11-19T10:00:00.000Z",
      }),
    ).toMatchObject({ status: "ready", freshness: "fresh" });
  });

  test("a failed refresh offers the last-fetched commit, labelled as such", () => {
    const state = classifyLaunchBaseTip({
      branch: "main",
      commit: COMMIT.toUpperCase(),
      ref: "origin/main",
      fetched: false,
      launchEligible: true,
      fetchedAt: "2026-11-19T09:00:00.000Z",
      fetchError: "Could not resolve host",
    });
    expect(state).toEqual({
      status: "ready",
      freshness: "last-fetched",
      branch: "main",
      ref: "origin/main",
      commit: COMMIT,
      fetchedAt: "2026-11-19T09:00:00.000Z",
      fetchError: "Could not resolve host",
    });
    expect(launchBaseForCreate(state)).toEqual({ branch: "main", commit: COMMIT });
  });

  test("a project with no remote starts from its own branch", () => {
    const state = classifyLaunchBaseTip({
      branch: "main",
      commit: COMMIT,
      ref: "main",
      fetched: false,
      launchEligible: true,
    });
    expect(state).toMatchObject({ status: "ready", freshness: "local", ref: "main" });
    expect(launchBaseForCreate(state)).toEqual({ branch: "main", commit: COMMIT });
  });

  test("a local branch behind a remote that could not supply it is never pinned", () => {
    // Today's start refuses a base the remote does not have; pinning the local
    // branch would quietly start from commits that may never have been pushed.
    const state = classifyLaunchBaseTip({
      branch: "main",
      commit: COMMIT,
      ref: "main",
      fetched: false,
      launchEligible: false,
      fetchError: "couldn't find remote ref main",
    });
    expect(state.status).toBe("unavailable");
    expect(launchBaseForCreate(state)).toBeUndefined();
  });

  test("no commit, a short commit or no answer is unavailable", () => {
    expect(
      classifyLaunchBaseTip({
        branch: "nowhere",
        commit: null,
        ref: null,
        unavailableReason: "Base branch nowhere was not found locally or on origin",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "Base branch nowhere was not found locally or on origin",
    });
    expect(
      classifyLaunchBaseTip({
        branch: "main",
        commit: "abc123",
        ref: "origin/main",
        launchEligible: true,
      }).status,
    ).toBe("unavailable");
    expect(classifyLaunchBaseTip(null).status).toBe("unavailable");
  });

  test("local tips without eligibility from the backend cannot be pinned", () => {
    for (const launchEligible of [false, undefined]) {
      const state = classifyLaunchBaseTip({
        branch: "main",
        commit: COMMIT,
        ref: "main",
        fetched: false,
        launchEligible,
      });
      expect(state.status).toBe("unavailable");
      expect(launchBaseForCreate(state)).toBeUndefined();
    }
  });

  test("resolving submits a pending reference and unavailable falls back to ordinary start", () => {
    expect(launchBaseForCreate({ status: "idle" })).toBeUndefined();
    expect(launchBaseForCreate({ status: "resolving" })).toEqual({ pending: true });
    expect(launchBaseForCreate({ status: "unavailable", reason: "x" })).toBeUndefined();
  });
});
