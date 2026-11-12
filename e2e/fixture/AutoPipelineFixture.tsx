import { useEffect, useState } from "react";
import { AutoPipelineTab } from "../../apps/web/src/components/review/AutoPipelineTab";
import { ToPipelineButton } from "../../apps/web/src/components/review/ToPipelineButton";
import { useNodeScope } from "../../apps/web/src/lib/node-scope/providers";
import { paneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import type { AutoPipelineTabData } from "../../apps/web/src/types/paneLayout";

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

const LONG_DESCRIPTION = [
  "## Summary",
  "Restore the selected workspace after a reload, so the picker opens where the user left it.",
  "## Problem",
  ...Array.from(
    { length: 8 },
    (_, index) =>
      `Paragraph ${index + 1}: reloading the window drops the selected workspace and falls back to the first one in the list, so anyone who works in a later workspace has to pick it again after every reload, every restart and every update of the application.`,
  ),
  "## Context",
  "- The workspace picker already saves this preference.",
  "- Nothing reads it back when the window loads.",
  "The last line of the description.",
].join("\n\n");

type FixtureState =
  | { phase: "idle" }
  | { phase: "drafting" }
  | { phase: "failed"; error: string }
  | {
      phase: "ready";
      draft: ReturnType<typeof fixtureDraft>;
      edits?: unknown;
      reviewed?: unknown;
      confirmError?: string;
    }
  | { phase: "promoting"; draft: ReturnType<typeof fixtureDraft>; edits?: unknown }
  | { phase: "promoted"; pipelineId: string };

function fixtureDraft(params: URLSearchParams, id: string) {
  return {
    id,
    title: "Remember the selected workspace",
    description: params.has("longDescription")
      ? LONG_DESCRIPTION
      : "Summary: Restore the selected workspace after reload.\n\nProblem: Reloading loses the selection.\n\nContext: The workspace picker already saves this preference.",
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
  };
}

/**
 * A stand-in backend that keeps drafting and promotion state the way the real
 * one does, so the tab can be left and returned to. `?draftMs=` sets how long
 * drafting takes (default 400 ms), and `?longDescription` drafts a description
 * taller than the page. `?draftRefused` refuses every drafting
 * request without recording a failure (a lost connection), `?saveOffline`
 * refuses every edit save, and `?locked` keeps a refused confirmation's ticket
 * as the locked `reviewed` ticket, as a part-way failed promotion does.
 */
export function installAutoPipelineFixture() {
  const params = new URLSearchParams(window.location.search);
  const draftMs = Number(params.get("draftMs") ?? 400);
  let state: FixtureState = { phase: "idle" };
  let generation = 0;
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
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
      if (command === "get_auto_pipeline_state") return state as T;
      if (command === "draft_auto_pipeline") {
        if (params.has("draftRefused")) throw new Error("The backend did not answer.");
        const current = ++generation;
        state = { phase: "drafting" };
        await new Promise((resolve) => setTimeout(resolve, draftMs));
        if (current !== generation) throw new Error("Auto-pipeline drafting cancelled");
        if (params.has("failure")) {
          state = {
            phase: "failed",
            error: "The agent finished without submitting a draft. No ticket was created.",
          };
          throw new Error(state.error);
        }
        const draft = fixtureDraft(params, `draft-${current}`);
        state = { phase: "ready", draft };
        return draft as T;
      }
      if (command === "cancel_auto_pipeline_draft") {
        generation++;
        state = { phase: "idle" };
        return undefined as T;
      }
      if (command === "save_auto_pipeline_edits") {
        if (params.has("saveOffline")) throw new Error("The backend did not answer");
        if (state.phase === "ready") state = { ...state, edits: args?.edits };
        return undefined as T;
      }
      if (command === "confirm_auto_pipeline") {
        if (state.phase !== "ready") throw new Error("Auto-pipeline draft expired");
        const ready = state;
        state = { phase: "promoting", draft: ready.draft, edits: ready.edits };
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (params.has("refused")) {
          const error =
            "A terminal in this environment did not close. Stop the command running in it and confirm again.";
          state = {
            ...ready,
            ...(params.has("locked") ? { reviewed: args?.ticket } : {}),
            confirmError: error,
          };
          throw new Error(error);
        }
        state = { phase: "promoted", pipelineId: "pipeline-1" };
        return null as T;
      }
      return null as T;
    },
  } as Window["orkestrator"];
}

/**
 * The toolbar's "To pipeline" button, and the environment's tab strip it opens
 * the Auto-pipeline tab in. The Agent tab stands for "somewhere else": choosing
 * it unmounts the Auto-pipeline tab, as switching environments does. The pane
 * layout holds one interactive tab, `original`, as the active tab, which is the
 * source the stand-in backend offers.
 */
export function AutoPipelineFixture() {
  const scope = useNodeScope();
  useEffect(() => {
    scope.store(paneLayoutStore).setState({
      environments: new Map([
        [
          "fixture",
          {
            root: {
              kind: "leaf",
              id: "default",
              tabs: [{ id: "original", type: "agent-native" }],
              activeTabId: "original",
            },
            activePaneId: "default",
            containerId: null,
            backendRevision: 0,
          },
        ],
      ]) as never,
    });
  }, [scope]);
  const [tab, setTab] = useState<AutoPipelineTabData | null>(null);
  const [active, setActive] = useState<"agent" | "auto-pipeline">("agent");
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <div
        role="tablist"
        aria-label="Environment tabs"
        className="flex gap-1 border-b border-divider px-2 py-1"
      >
        {(tab ? (["agent", "auto-pipeline"] as const) : (["agent"] as const)).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active === id}
            onClick={() => setActive(id)}
            className={`rounded px-3 py-1 text-xs ${active === id ? "bg-muted text-foreground" : "text-muted-foreground"}`}
          >
            {id === "agent" ? "Codex 1" : "Auto-pipeline 2"}
          </button>
        ))}
        <div className="ml-auto">
          <ToPipelineButton
            environmentId="fixture"
            createTab={(_type, options) => {
              if (!options?.autoPipeline) return false;
              setTab(options.autoPipeline);
              setActive("auto-pipeline");
              return true;
            }}
          />
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {active === "agent" && (
          <p className="p-4 text-sm text-muted-foreground">
            The source agent tab&apos;s transcript.
          </p>
        )}
        {tab && active === "auto-pipeline" && (
          <AutoPipelineTab environmentId="fixture" data={tab} isActive />
        )}
      </div>
    </main>
  );
}
