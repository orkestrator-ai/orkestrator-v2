import type {
  GitHubPullRequestFile,
  GitHubPullRequestFiles,
} from "@orkestrator/protocol/github-pull-requests";
import { PullRequestCodeTab } from "../../apps/web/src/components/pull-requests/PullRequestCodeTab";

const ref = { owner: "acme", repo: "widget", number: 42 };
const reviewTarget = "z-review/deep/target.ts";

function file(
  path: string,
  viewedState: GitHubPullRequestFile["viewedState"],
): GitHubPullRequestFile {
  return {
    path,
    previousPath: null,
    status: "added",
    additions: 1,
    deletions: 0,
    patchAvailable: true,
    viewedState,
    hunks: [
      {
        header: "@@ -0,0 +1 @@",
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: [{ type: "add", text: "export const example = 1;", oldLine: null, newLine: 1 }],
      },
    ],
  };
}

const guide: GitHubPullRequestFile = {
  ...file("docs/guide.md", "viewed"),
  status: "renamed",
  previousPath: "docs/old.md",
  additions: 0,
  hunks: [],
};
const files: GitHubPullRequestFiles = {
  ref,
  headSha: "a".repeat(40),
  comparisonBase: { ref: "main", sha: "b".repeat(40) },
  truncated: false,
  files: [
    guide,
    ...Array.from({ length: 59 }, (_, index) => file(`src/filler/file-${index}.ts`, "viewed")),
    file(reviewTarget, "unviewed"),
  ],
  threads: [
    {
      id: "rename-thread",
      path: guide.path,
      line: null,
      startLine: null,
      side: "RIGHT",
      isResolved: false,
      isOutdated: true,
      viewerCanResolve: false,
      comments: [
        {
          id: 1,
          nodeId: "review-comment",
          author: { login: "grace" },
          body: "Please keep the old link working.",
          createdAt: "2026-11-19T01:00:00Z",
          updatedAt: "2026-11-19T01:00:00Z",
          htmlUrl: "https://github.com/acme/widget/pull/42#discussion",
        },
      ],
    },
  ],
};

export function PullRequestCodeFixture() {
  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <PullRequestCodeTab pullRequest={ref} files={files} canComment />
    </main>
  );
}
