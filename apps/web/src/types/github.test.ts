import { describe, expect, test } from "bun:test";
import {
  GITHUB_STATUS_LABELS as backendStatusLabels,
  type GitHubIssueDetail as BackendGitHubIssueDetail,
  type GitHubIssuesSnapshot as BackendGitHubIssuesSnapshot,
} from "../../../backend/src/core/github";
import type {
  GitHubIssueDetail as RendererGitHubIssueDetail,
  GitHubIssueStatus as RendererGitHubIssueStatus,
  GitHubIssuesSnapshot as RendererGitHubIssuesSnapshot,
} from "./github";

type Assert<T extends true> = T;
type SameShape<Left, Right> = Left extends Right ? (Right extends Left ? true : false) : false;

// These aliases intentionally fail typechecking if the independently compiled
// backend and renderer contracts drift apart.
type SnapshotContractMatches = Assert<
  SameShape<RendererGitHubIssuesSnapshot, BackendGitHubIssuesSnapshot>
>;
type DetailContractMatches = Assert<SameShape<RendererGitHubIssueDetail, BackendGitHubIssueDetail>>;
type LabelledStatus = Exclude<RendererGitHubIssueStatus, "backlog">;
type BackendLabelledStatus = keyof typeof backendStatusLabels;
type StatusLabelsMatch = Assert<
  [LabelledStatus] extends [BackendLabelledStatus]
    ? [BackendLabelledStatus] extends [LabelledStatus]
      ? true
      : false
    : false
>;

const contractChecks: [SnapshotContractMatches, DetailContractMatches, StatusLabelsMatch] = [
  true,
  true,
  true,
];

describe("GitHub renderer contract", () => {
  test("keeps workflow labels and issue payloads aligned with the backend", () => {
    expect(Object.keys(backendStatusLabels).sort()).toEqual(["inprogress", "review", "todo"]);
    expect(contractChecks).toEqual([true, true, true]);
  });
});
