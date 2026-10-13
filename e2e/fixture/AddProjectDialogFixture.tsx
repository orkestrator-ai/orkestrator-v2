import { AddProjectDialog } from "../../apps/web/src/components/projects/AddProjectDialog";
import type { GitHubCloneRepository } from "@orkestrator/protocol/github-clone";

const repository: GitHubCloneRepository = {
  name: "a-very-long-repository-name-".repeat(4).slice(0, 100),
  fullName: `acme/${"a-very-long-repository-name-".repeat(4).slice(0, 100)}`,
  description: "A very long repository description ".repeat(10).trim(),
  isPrivate: true,
  isFork: true,
  isArchived: true,
  updatedAt: "2026-09-01T00:00:00Z",
  cloneUrl: "https://github.com/acme/fixture.git",
};

export function AddProjectDialogFixture() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <AddProjectDialog
        open
        onOpenChange={() => {}}
        onAdd={async () => {}}
        onCreate={async () => {}}
        validateGitUrl={async () => true}
        defaultCloneDirectory="/tmp/projects"
        loadGitHubAccounts={async () => [{ login: "acme", kind: "organization" }]}
        loadGitHubRepositories={async () => ({ repositories: [repository], truncated: false })}
      />
    </main>
  );
}
