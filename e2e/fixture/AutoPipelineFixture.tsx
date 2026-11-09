import { useState } from "react";
import { MultiReviewLaunchDialog } from "../../apps/web/src/components/review/MultiReviewLaunchDialog";

export function installAutoPipelineFixture() {
  const params = new URLSearchParams(window.location.search);
  window.orkestrator = {
    invoke: async <T,>(command: string) => {
      if (command === "auto_pipeline_sources")
        return {
          available: !params.has("pipeline"),
          sources: [
            {
              tabId: "original",
              label: "Original feature work",
              ...(params.has("running")
                ? { disabledReason: "Wait for this tab's turn to finish" }
                : {}),
            },
          ],
        } as T;
      if (command === "draft_auto_pipeline") {
        if (params.has("failure"))
          throw new Error("The drafting session failed. No ticket was created.");
        return {
          id: "draft",
          title: "Remember the selected workspace",
          description:
            "Summary: Restore the selected workspace after reload.\n\nProblem: Reloading loses the selection.\n\nContext: The workspace picker already saves this preference.",
          acceptanceCriteria: [
            "Reload restores the selected workspace",
            "Deleted workspaces fall back to the first available workspace",
          ],
          notes: {
            summary: "Persisted and restored workspace selection.",
            workDone: ["Updated workspace selection and reload handling."],
            decisions: [],
            tests: [{ name: "Workspace selection tests", result: "passed" }],
            notDone: ["Independent review and verification remain."],
          },
          uncommittedFiles: [" M workspace-selection.ts"],
        } as T;
      }
      if (command === "confirm_auto_pipeline") return null as T;
      return null as T;
    },
  } as Window["orkestrator"];
}
export function AutoPipelineFixture() {
  const [open, setOpen] = useState(true);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <MultiReviewLaunchDialog
        open={open}
        onOpenChange={setOpen}
        defaultAgent="codex"
        catalog={{ claude: [], codex: [], opencode: [] }}
        autoPipelineEnvironmentId="fixture"
        onConfirm={() => setOpen(false)}
      />
    </main>
  );
}
