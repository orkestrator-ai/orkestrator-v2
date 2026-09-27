import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MultiReviewModelSelection,
  MultiReviewStepKind,
} from "@orkestrator/protocol/multi-review";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  defaultFastModeFor,
  firstModelFor,
  modelsForAgent,
  platformOwnsSpeed,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { flatCatalog } from "./MultiReviewLaunchDialog";

const STEP_LABELS: Record<MultiReviewStepKind, string> = {
  prepare: "Preparation",
  consolidate: "Consolidation",
  fix: "Fix",
};

interface MultiReviewRestartDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: MultiReviewStepKind;
  catalog: AgentModelCatalog;
  defaultSelection: MultiReviewModelSelection;
  error?: string | null;
  busy?: boolean;
  onSubmit: (selection: MultiReviewModelSelection) => void | Promise<void>;
}

function catalogSelection(
  selection: MultiReviewModelSelection,
  catalog: AgentModelCatalog,
): MultiReviewModelSelection {
  const model = firstModelFor(selection.agent, catalog, {
    [selection.agent]: selection.model,
  });
  const effort = defaultEffortFor(selection.agent, model, catalog, {
    [selection.agent]: selection.reasoningEffort,
  });
  const fastMode = defaultFastModeFor(
    selection.agent,
    model,
    catalog,
    typeof selection.fastMode === "boolean" ? { [selection.agent]: selection.fastMode } : undefined,
  );
  return {
    agent: selection.agent,
    model,
    ...(effort === "default" ? {} : { reasoningEffort: effort }),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

export function MultiReviewRestartDialog({
  open,
  onOpenChange,
  kind,
  catalog,
  defaultSelection,
  error,
  busy = false,
  onSubmit,
}: MultiReviewRestartDialogProps) {
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const models = useMemo(() => flatCatalog(catalog), [catalog]);
  const [selection, setSelection] = useState(() => catalogSelection(defaultSelection, catalog));
  const wasOpen = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open) return;
    if (justOpened) {
      setSelection(catalogSelection(defaultSelection, catalog));
      return;
    }
    setSelection((current) => {
      const next = catalogSelection(current, catalog);
      return current.agent === next.agent &&
        current.model === next.model &&
        current.reasoningEffort === next.reasoningEffort &&
        current.fastMode === next.fastMode
        ? current
        : next;
    });
  }, [catalog, defaultSelection, open]);

  const selectedModel = modelsForAgent(catalog, selection.agent).find(
    (model) => model.id === selection.model,
  );
  const reasoningOptions =
    selectedModel?.reasoningEfforts.map((effort) => ({
      id: effort,
      label: effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1),
    })) ?? [];
  const speedCapable = platformOwnsSpeed(selection.agent);
  const speedAvailable = speedCapable && selectedModel?.supportsSpeed === true;

  const selectModel = (agent: LaunchAgent, model: string) => {
    const effort = defaultEffortFor(agent, model, catalog);
    const fastMode = defaultFastModeFor(
      agent,
      model,
      catalog,
      agent === selection.agent && typeof selection.fastMode === "boolean"
        ? { [agent]: selection.fastMode }
        : undefined,
    );
    setSelection({
      agent,
      model,
      ...(effort === "default" ? {} : { reasoningEffort: effort }),
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    });
  };

  const stepLabel = STEP_LABELS[kind];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100%-1rem),42rem)] sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle>Restart {stepLabel}</DialogTitle>
          <DialogDescription>
            Choose the model for the new {stepLabel.toLowerCase()} run. Dependent steps will be
            reset as usual.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(selection);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="multi-review-restart-model">Model</Label>
            <AgentModelPicker
              id="multi-review-restart-model"
              ariaLabel={`Restart ${stepLabel.toLowerCase()} model`}
              models={models}
              selectedPlatform={selection.agent}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onReorderFavorites={reorderFavorites}
              selectedModelId={selection.model}
              selectedModelLabel={selectedModel?.name ?? selection.model}
              onPlatformChange={(agent) => {
                const nextModel = modelsForAgent(catalog, agent)[0];
                if (nextModel) selectModel(agent, nextModel.id);
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
              speedCapable={speedCapable}
              fastModeAvailable={speedAvailable}
              fastModeEnabled={speedAvailable ? (selection.fastMode ?? false) : false}
              onFastModeChange={
                speedAvailable
                  ? (fastMode) => setSelection((current) => ({ ...current, fastMode }))
                  : undefined
              }
              title={`Restart ${stepLabel.toLowerCase()} model`}
              className="min-h-11 w-full border border-zinc-700/80 bg-zinc-900 py-2.5"
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
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
            <Button type="submit" disabled={busy}>
              {busy ? "Restarting…" : `Restart ${stepLabel}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
