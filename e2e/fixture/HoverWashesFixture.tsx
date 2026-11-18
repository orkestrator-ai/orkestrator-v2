import { useState } from "react";
import type { GitHubCloneRepository } from "@orkestrator/protocol/github-clone";
import type { GitHubPullRequestListItem } from "@orkestrator/protocol/github-pull-requests";
import { FileTreeNode } from "@/components/files-panel/FileTreeNode";
import { FeaturesView } from "@/components/kanban/FeaturesView";
import { GitHubRepositoryPicker } from "@/components/projects/GitHubRepositoryPicker";
import { PullRequestList } from "@/components/pull-requests/PullRequestList";
import type { FeaturePlan, FileNode } from "@/lib/backend";
import { featurePlanStore } from "@/stores/featurePlanStore";
import { pullRequestListKey, pullRequestsStore } from "@/stores/pullRequestsStore";
import { appCommandStore } from "@/test/app-command-store";

const projectId = "hover-fixture";
const date = "2026-11-17T00:00:00Z";
const repositoryUrl = "https://github.com/fixture/existing";
const files: FileNode[] = [
  { name: "notes.md", path: "notes.md", isDirectory: false },
  { name: "readme.md", path: "readme.md", isDirectory: false },
  { name: "docs", path: "docs", isDirectory: true, children: [] },
];

function pullRequest(number: number, title: string): GitHubPullRequestListItem {
  return {
    number,
    title,
    htmlUrl: `${repositoryUrl}/pull/${number}`,
    state: "open",
    isDraft: false,
    author: null,
    headRef: `branch-${number}`,
    baseRef: "main",
    createdAt: date,
    updatedAt: date,
    commentsCount: 0,
    labels: [],
  };
}

const features: FeaturePlan[] = ["First feature", "Second feature"].map((title, order) => ({
  id: `feature-${order}`,
  projectId,
  title,
  status: "collecting",
  summary: "",
  messages: [],
  stories: [],
  createdAt: date,
  updatedAt: date,
  order,
}));

const repositories: GitHubCloneRepository[] = ["available", "existing"].map((name) => ({
  name,
  fullName: `fixture/${name}`,
  description: null,
  isPrivate: false,
  isFork: false,
  isArchived: false,
  updatedAt: date,
  cloneUrl: `https://github.com/fixture/${name}.git`,
}));

export function installHoverWashesFixture() {
  appCommandStore(featurePlanStore).setState({ features, loadFeatures: async () => true });
  appCommandStore(pullRequestsStore).setState({
    lists: new Map([
      [
        pullRequestListKey(projectId, "open", ""),
        {
          repository: {
            owner: "fixture",
            repo: "existing",
            fullName: "fixture/existing",
            htmlUrl: repositoryUrl,
          },
          viewer: { login: "fixture" },
          filter: "open",
          pullRequests: [
            pullRequest(2, "Neighbouring pull request"),
            pullRequest(1, "Pinned pull request"),
          ],
          hasMore: false,
        },
      ],
    ]),
  });
}

export function HoverWashesFixture() {
  const [selected, setSelected] = useState("notes.md");
  const [moved, setMoved] = useState("");

  switch (new URLSearchParams(location.search).get("surface")) {
    case "features":
      return (
        <main className="flex h-screen bg-background">
          <FeaturesView projectId={projectId} />
        </main>
      );
    case "files":
      return (
        <main className="min-h-screen max-w-sm bg-background p-4">
          {files.map((item) => (
            <FileTreeNode
              key={item.path}
              item={item}
              depth={0}
              selectedPaths={new Set([selected])}
              onFileClick={setSelected}
              onMove={(paths, destination) => setMoved(`${paths.join(", ")} → ${destination}`)}
            />
          ))}
          <output>{moved}</output>
        </main>
      );
    case "picker":
      return (
        <main className="min-h-screen max-w-md bg-background p-4">
          <GitHubRepositoryPicker
            loadAccounts={async () => [{ login: "fixture", kind: "user" }]}
            loadRepositories={async () => ({ repositories, truncated: false })}
            onClone={async () => undefined}
            onCancel={() => undefined}
            existingGitUrls={[repositoryUrl]}
          />
        </main>
      );
    default:
      return (
        <main className="min-h-screen max-w-md bg-background p-4">
          <PullRequestList
            projectId={projectId}
            layout="sidebar"
            highlightNumber={1}
            onOpenPullRequest={() => undefined}
            active={false}
          />
        </main>
      );
  }
}
