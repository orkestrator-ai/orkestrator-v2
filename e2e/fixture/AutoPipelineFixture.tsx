import { useState } from "react";
import { MultiReviewLaunchDialog } from "../../apps/web/src/components/review/MultiReviewLaunchDialog";

const LONG_CRITERIA = [
  "Reloading the window restores the workspace that was selected before the reload, including when the selection was made in another window that has since closed",
  "A workspace deleted while it was selected falls back to the first available workspace, and the picker never shows a workspace that no longer exists",
  "A workspace renamed while it was selected stays selected under its new name after a reload, and the old name is not shown anywhere in the picker",
  "Switching workspaces quickly several times in a row persists only the last selection, with no earlier selection restored after a reload",
  "The saved selection is per project: selecting a workspace in one project never changes the restored workspace of another project",
  "Clearing the application data resets the selection to the first available workspace without an error notice",
  "The documentation describes how the selection is saved and restored, and lists the fallback order when the saved workspace is unavailable",
  "Focused tests cover reload, deletion, rename, rapid switching and per-project isolation, and all pass",
];
const LONG_WORK = Array.from(
  { length: 12 },
  (_, index) =>
    `Step ${index + 1}: updated the workspace selection store, its reload handling and the matching tests so the restored selection follows the saved preference.`,
);

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
          acceptanceCriteria: params.has("long")
            ? LONG_CRITERIA
            : [
                "Reload restores the selected workspace",
                "Deleted workspaces fall back to the first available workspace",
              ],
          notes: {
            summary: "Persisted and restored workspace selection.",
            workDone: params.has("long")
              ? LONG_WORK
              : ["Updated workspace selection and reload handling."],
            decisions: [],
            tests: [{ name: "Workspace selection tests", result: "passed" }],
            notDone: ["Independent review and verification remain."],
          },
          uncommittedFiles: [" M workspace-selection.ts"],
        } as T;
      }
      if (command === "confirm_auto_pipeline") {
        if (params.has("refused")) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          throw new Error(
            "Close this environment's terminals before promotion; a shell may still write.",
          );
        }
        return null as T;
      }
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
