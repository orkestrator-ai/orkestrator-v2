import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  GRAPH_DESCRIBE_BOUNDS,
  type GraphDescribeJobView,
  type GraphDescribeProgress,
} from "@orkestrator/protocol/graphs/describe";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { flatCatalog } from "@/components/review/MultiReviewLaunchDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  defaultFastModeFor,
  firstModelFor,
  modelsForAgent,
  platformOwnsSpeed,
  sessionDefaultModel,
  type AgentModelCatalog,
} from "@/lib/agent-launch";

/**
 * "Describe a graph" (item 215): the user describes a graph, picks the model
 * that drafts it and may ask it to modify the current draft. While the
 * backend's job runs, the dialog shows its progress instead of the form;
 * closing the dialog or switching tabs leaves the job running, and the
 * designer reads it back from the backend.
 */

export interface GraphDescribeSelection {
  agent: AgentPlatform;
  model: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface GraphDescribeSubmission {
  description: string;
  selection: GraphDescribeSelection;
  /** Send the current draft for the agent to modify. */
  modify: boolean;
}

export const GRAPH_DESCRIBE_PROGRESS_LABELS: Record<GraphDescribeProgress, string> = {
  starting: "Starting the designer agent…",
  drafting: "Drafting the graph…",
  correcting: "Correcting the draft the compiler refused…",
  finishing: "Finishing the draft…",
};

interface GraphDescribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: AgentModelCatalog;
  /** Enabled platforms, in the user's order; the first one is the default. */
  providers: readonly AgentPlatform[];
  /** The draft or template shown, which "Modify the current draft" sends; null for none. */
  currentName: string | null;
  /** The environment's latest job (running: progress; failed: its error). */
  job: GraphDescribeJobView | null;
  busy: boolean;
  /** The last start or cancel the backend refused. */
  error: string | null;
  onSubmit: (submission: GraphDescribeSubmission) => void | Promise<void>;
  onCancelJob: () => void;
}

function selectionFor(
  agent: AgentPlatform,
  catalog: AgentModelCatalog,
  model?: string,
): GraphDescribeSelection {
  const chosen = firstModelFor(agent, catalog, model ? { [agent]: model } : undefined);
  const effort = defaultEffortFor(agent, chosen, catalog);
  const fastMode = defaultFastModeFor(agent, chosen, catalog);
  return {
    agent,
    model: chosen,
    ...(effort === "default" ? {} : { reasoningEffort: effort }),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

function defaultSelection(
  catalog: AgentModelCatalog,
  providers: readonly AgentPlatform[],
): GraphDescribeSelection {
  return selectionFor(providers[0] ?? "claude", catalog);
}

export function GraphDescribeDialog({
  open,
  onOpenChange,
  catalog,
  providers,
  currentName,
  job,
  busy,
  error,
  onSubmit,
  onCancelJob,
}: GraphDescribeDialogProps) {
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const models = useMemo(
    () => flatCatalog(catalog).filter((model) => providers.includes(model.platform)),
    [catalog, providers],
  );
  const [selection, setSelection] = useState(() => defaultSelection(catalog, providers));
  const [description, setDescription] = useState("");
  const [modify, setModify] = useState(false);
  const wasOpen = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    // A failed request is offered again as it was written.
    setDescription(job?.status === "failed" ? job.description : "");
    setModify(job?.status === "failed" ? job.modifying && currentName !== null : false);
    setSelection(
      job?.status === "failed" && providers.includes(job.agent)
        ? selectionFor(job.agent, catalog, job.model)
        : defaultSelection(catalog, providers),
    );
  }, [open, job, catalog, providers, currentName]);

  const running = job?.status === "running";
  const failure = job?.status === "failed" ? (job.error ?? "The request failed") : null;
  const selectedModel = modelsForAgent(catalog, selection.agent).find(
    (model) => model.id === selection.model,
  );
  const reasoningOptions =
    selectedModel?.reasoningEfforts.map((effort) => ({
      id: effort,
      label: effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1),
    })) ?? [];
  const speedAvailable =
    platformOwnsSpeed(selection.agent) && selectedModel?.supportsSpeed === true;
  const tooLong = description.length > GRAPH_DESCRIBE_BOUNDS.maxDescriptionChars;

  const selectModel = (agent: AgentPlatform, model: string) => {
    setSelection(selectionFor(agent, catalog, model));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl" data-graph-describe-dialog="">
        <DialogHeader>
          <DialogTitle>Describe a graph</DialogTitle>
          <DialogDescription>
            An agent drafts the graph from your description. The draft opens here unsaved: review
            it, then save it before it can run.
          </DialogDescription>
        </DialogHeader>
        {running ? (
          <div className="space-y-4" data-graph-describe-progress="">
            <div role="status" className="flex items-center gap-2 text-sm text-foreground">
              <Loader2 aria-hidden className="size-4 animate-spin text-indigo-400" />
              {GRAPH_DESCRIBE_PROGRESS_LABELS[job.progress ?? "drafting"]}
            </div>
            {job.repairs > 0 ? (
              <p className="text-xs text-muted-foreground">
                Repair turns so far: {job.repairs}. The compiler's diagnostics go back to the agent
                each time.
              </p>
            ) : null}
            <p className="line-clamp-4 rounded-md border border-border bg-muted/30 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
              {job.description}
            </p>
            <p className="text-xs text-muted-foreground">
              It keeps working if you close this dialog or switch tabs.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => onCancelJob()}>
                Cancel request
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const text = description.trim();
              if (!text || tooLong) return;
              void onSubmit({
                description: text,
                selection,
                modify: modify && currentName !== null,
              });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="graph-describe-text">What should the graph do?</Label>
              <Textarea
                id="graph-describe-text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={7}
                placeholder="Three reviewers look at the change through security, performance and simplicity lenses; a judge picks the best findings; a builder fixes them; then open a pull request."
              />
              {tooLong ? (
                <p className="text-xs text-destructive">
                  At most {GRAPH_DESCRIBE_BOUNDS.maxDescriptionChars} characters.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="graph-describe-model">Model</Label>
              <AgentModelPicker
                id="graph-describe-model"
                ariaLabel="Describe a graph model"
                models={models}
                selectedPlatform={selection.agent}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onReorderFavorites={reorderFavorites}
                selectedModelId={selection.model}
                selectedModelLabel={selectedModel?.name ?? selection.model}
                onPlatformChange={(agent) => {
                  const next = sessionDefaultModel(modelsForAgent(catalog, agent));
                  if (next) selectModel(agent, next.id);
                }}
                onModelChange={(model) => selectModel(selection.agent, model)}
                onModelSelect={(model: AgentModel) => selectModel(model.platform, model.id)}
                reasoningOptions={reasoningOptions}
                selectedReasoningId={selection.reasoningEffort ?? ""}
                selectedReasoningLabel={selection.reasoningEffort ?? "Default effort"}
                onReasoningChange={(reasoningEffort) =>
                  setSelection((current) => ({
                    ...current,
                    reasoningEffort: reasoningEffort || undefined,
                  }))
                }
                speedCapable={platformOwnsSpeed(selection.agent)}
                fastModeAvailable={speedAvailable}
                fastModeEnabled={speedAvailable ? (selection.fastMode ?? false) : false}
                onFastModeChange={
                  speedAvailable
                    ? (fastMode) => setSelection((current) => ({ ...current, fastMode }))
                    : undefined
                }
                title="Describe a graph model"
                className="min-h-11 w-full border border-zinc-700/80 bg-zinc-900 py-2.5"
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                aria-label="Modify the current draft"
                checked={modify && currentName !== null}
                disabled={currentName === null}
                onCheckedChange={(checked) => setModify(checked === true)}
                className="mt-0.5"
              />
              <span className={currentName === null ? "text-muted-foreground" : undefined}>
                Modify the current draft
                {currentName ? (
                  <span className="text-muted-foreground"> ({currentName})</span>
                ) : (
                  <span className="text-muted-foreground"> (open or start a graph first)</span>
                )}
              </span>
            </label>
            {error || failure ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {error ?? `The last request failed: ${failure}`}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !description.trim() || tooLong}>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {busy ? "Starting…" : "Describe"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
