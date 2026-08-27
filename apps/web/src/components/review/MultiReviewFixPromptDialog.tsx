import { useEffect, useMemo, useRef, useState } from "react";
import type { MultiReviewModelSelection } from "@orkestrator/protocol/multi-review";
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
import { Textarea } from "@/components/ui/textarea";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  firstModelFor,
  modelsForAgent,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { flatCatalog } from "./MultiReviewLaunchDialog";

export const DEFAULT_MULTI_REVIEW_FIX_PROMPT = ADDRESS_ALL_REVIEW_PROMPT;

interface MultiReviewFixPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: AgentModelCatalog;
  defaultSelection: MultiReviewModelSelection;
  error?: string | null;
  onSubmit: (selection: MultiReviewModelSelection, prompt: string) => void;
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
  return {
    agent: selection.agent,
    model,
    ...(effort === "default" ? {} : { reasoningEffort: effort }),
  };
}

export function MultiReviewFixPromptDialog({
  open,
  onOpenChange,
  catalog,
  defaultSelection,
  error,
  onSubmit,
}: MultiReviewFixPromptDialogProps) {
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const models = useMemo(() => flatCatalog(catalog), [catalog]);
  const [selection, setSelection] = useState(() => catalogSelection(defaultSelection, catalog));
  const [prompt, setPrompt] = useState(DEFAULT_MULTI_REVIEW_FIX_PROMPT);
  const wasOpen = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open) return;
    if (justOpened) {
      setSelection(catalogSelection(defaultSelection, catalog));
      setPrompt(DEFAULT_MULTI_REVIEW_FIX_PROMPT);
      return;
    }
    // A live provider catalog can refresh while the dialog is open. Preserve a
    // still-valid user choice, but never leave the picker stranded on a model
    // that disappeared during that refresh.
    setSelection((current) => {
      const next = catalogSelection(current, catalog);
      return current.agent === next.agent &&
        current.model === next.model &&
        current.reasoningEffort === next.reasoningEffort
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

  const selectModel = (agent: LaunchAgent, model: string) => {
    const effort = defaultEffortFor(agent, model, catalog);
    setSelection({
      agent,
      model,
      ...(effort === "default" ? {} : { reasoningEffort: effort }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100%-1rem),42rem)] border-zinc-700/80 bg-[#111113] sm:max-w-[42rem]">
        <DialogHeader>
          <DialogTitle>Custom fix prompt</DialogTitle>
          <DialogDescription>
            Choose the model and instructions to use for a new fix session.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedPrompt = prompt.trim();
            if (!trimmedPrompt) return;
            onSubmit(selection, trimmedPrompt);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="multi-review-fix-model">Model</Label>
            <AgentModelPicker
              id="multi-review-fix-model"
              ariaLabel="Custom fix model"
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
              title="Custom fix model"
              className="min-h-11 w-full border border-zinc-700/80 bg-zinc-900 py-2.5"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="multi-review-fix-prompt">Prompt</Label>
            <Textarea
              id="multi-review-fix-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
              placeholder={DEFAULT_MULTI_REVIEW_FIX_PROMPT}
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!prompt.trim()}>
              Start fix
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
