import { describe, expect, test } from "bun:test";
import {
  deletableEnvironmentHeadBranch,
  deleteRemoteBranchForPullRequestHead,
  type GitHubPullRequestHead,
} from "./commands-review.js";

const ENVIRONMENT_ID = "ce98b4c6-2352-4a1b-9c3d-0123456789ab";
const OWN_BRANCH = "fix-login-ce98b4c62352-r1";

function pull(ref: string, headRepo = "acme/widget", baseRepo = "acme/widget") {
  return {
    head: { ref, repo: { full_name: headRepo } },
    base: { repo: { full_name: baseRepo } },
  } satisfies GitHubPullRequestHead;
}

function recordingGh() {
  const calls: string[][] = [];
  const runGh = async (args: string[]) => {
    calls.push(args);
    return "";
  };
  return { calls, runGh };
}

describe("environment merge branch cleanup", () => {
  test("deletes the environment's own branch in the pull request's repository", async () => {
    const { calls, runGh } = recordingGh();
    expect(
      await deleteRemoteBranchForPullRequestHead(pull(OWN_BRANCH), runGh, ENVIRONMENT_ID),
    ).toBe("deleted");
    expect(calls).toEqual([
      ["api", `repos/acme/widget/git/refs/heads/${OWN_BRANCH}`, "--method", "DELETE"],
    ]);
  });

  test("never deletes a base branch the pull request was opened from", async () => {
    for (const ref of ["dev", "main", "release/2026-11"]) {
      const { calls, runGh } = recordingGh();
      expect(await deleteRemoteBranchForPullRequestHead(pull(ref), runGh, ENVIRONMENT_ID)).toBe(
        "kept",
      );
      expect(calls).toEqual([]);
    }
  });

  test("never deletes another environment's branch", async () => {
    const { calls, runGh } = recordingGh();
    const other = pull("investigate-aa1f36a5c1e0-r1");
    expect(await deleteRemoteBranchForPullRequestHead(other, runGh, ENVIRONMENT_ID)).toBe("kept");
    expect(calls).toEqual([]);
  });

  test("never deletes a branch in a fork, even one named for the environment", async () => {
    const { calls, runGh } = recordingGh();
    const fork = pull(OWN_BRANCH, "someone/widget", "acme/widget");
    expect(await deleteRemoteBranchForPullRequestHead(fork, runGh, ENVIRONMENT_ID)).toBe("kept");
    expect(calls).toEqual([]);
  });

  test("an unreadable pull request keeps its branch", () => {
    expect(deletableEnvironmentHeadBranch(null, ENVIRONMENT_ID)).toBeNull();
    expect(
      deletableEnvironmentHeadBranch({ head: { ref: OWN_BRANCH } }, ENVIRONMENT_ID),
    ).toBeNull();
  });
});
