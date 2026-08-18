import { describe, expect, test } from "bun:test";
import {
  GITHUB_STATUS_LABELS as backendStatusLabels,
  type GitHubIssueDetail as BackendGitHubIssueDetail,
  type GitHubIssuesSnapshot as BackendGitHubIssuesSnapshot,
} from "../../../backend/src/core/github";
import {
  GITHUB_STATUS_LABELS as rendererStatusLabels,
  type GitHubIssueDetail as RendererGitHubIssueDetail,
  type GitHubIssuesSnapshot as RendererGitHubIssuesSnapshot,
} from "./github";

type Assert<T extends true> = T;
type SameShape<Left, Right> = Left extends Right ? (Right extends Left ? true : false) : false;

// These aliases intentionally fail typechecking if the independently compiled
// backend and renderer contracts drift apart.
type SnapshotContractMatches = Assert<
  SameShape<RendererGitHubIssuesSnapshot, BackendGitHubIssuesSnapshot>
>;
type DetailContractMatches = Assert<SameShape<RendererGitHubIssueDetail, BackendGitHubIssueDetail>>;

const contractChecks: [SnapshotContractMatches, DetailContractMatches] = [true, true];

describe("GitHub renderer contract", () => {
  test("keeps workflow labels and issue payloads aligned with the backend", () => {
    expect(rendererStatusLabels).toEqual(backendStatusLabels);
    expect(contractChecks).toEqual([true, true]);
  });
});
