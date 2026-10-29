import { useState } from "react";
import { DiffBaseDialog } from "../../apps/web/src/components/files-panel/DiffBaseDialog";
import { DiffBaseNotice } from "../../apps/web/src/components/files-panel/DiffBaseNotice";
import { FilesPanelHeader } from "../../apps/web/src/components/files-panel/FilesPanelHeader";
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { useFilesPanelStore } from "../../apps/web/src/stores/filesPanelStore";
import type { Environment } from "../../apps/web/src/types";

const TIP = "a".repeat(40);
const OLDER = "b".repeat(40);
const branches = [
  { ref: "refs/remotes/origin/main", name: "origin/main", kind: "remote" },
  { ref: "refs/heads/feature", name: "feature", kind: "local" },
];
const commits = [
  { commit: TIP, subject: "Merge main", committedAt: "2026-10-28T10:00:00Z", author: "Ada" },
  { commit: OLDER, subject: "Earlier base", committedAt: "2026-10-27T10:00:00Z", author: "Ada" },
];

export function installDiffBaseFixture() {
  let environment = {
    id: "diff-base-env",
    projectId: "project-1",
    diffBaseOverride: JSON.parse(localStorage.getItem("fixture-diff-base") ?? "null"),
  } as Environment;
  useEnvironmentStore.setState({ environments: [environment] });
  useFilesPanelStore.setState({ activeTab: "changes", changes: [] });
  window.orkestrator = {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_environment_diff_base_branches") return branches;
      if (command === "list_environment_diff_base_commits") return commits;
      if (command === "set_environment_diff_base") {
        const selected = commits.find((item) => item.commit === args?.commit);
        environment = {
          ...environment,
          diffBaseOverride: selected
            ? { ref: args!.ref as string, commit: selected.commit, subject: selected.subject }
            : null,
        };
        localStorage.setItem("fixture-diff-base", JSON.stringify(environment.diffBaseOverride));
        return environment;
      }
      if (command === "changes_get_views") return { projections: [] };
      return null;
    },
    listen: () => () => undefined,
  } as unknown as Window["orkestrator"];
}

export function DiffBaseFixture() {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <main className="h-screen bg-background text-foreground">
        <FilesPanelHeader
          onRefresh={() => undefined}
          changeEnvironmentId="diff-base-env"
          onChooseDiffBase={() => setOpen(true)}
        />
        <DiffBaseNotice environmentId="diff-base-env" onChange={() => setOpen(true)} />
        <DiffBaseDialog environmentId="diff-base-env" open={open} onOpenChange={setOpen} />
      </main>
    </TooltipProvider>
  );
}
