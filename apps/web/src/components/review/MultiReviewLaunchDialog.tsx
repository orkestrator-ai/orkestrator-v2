import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Plus, Trash2, Wrench } from "lucide-react";
import type { MultiReviewModelSelection } from "@orkestrator/protocol/multi-review";
import { MULTI_REVIEW_MAX_REVIEWERS } from "@orkestrator/protocol/multi-review";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
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
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  firstModelFor,
  modelsForAgent,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { createUuid } from "@/lib/uuid";

interface PickerRow extends MultiReviewModelSelection {
  key: string;
}

export interface MultiReviewLaunchSelection {
  reviewers: MultiReviewModelSelection[];
  fixModel: MultiReviewModelSelection;
}

interface MultiReviewLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultAgent: LaunchAgent;
  catalog: AgentModelCatalog;
  preferredModels?: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<LaunchAgent, string>>;
  busy?: boolean;
  onConfirm: (selection: MultiReviewLaunchSelection) => void;
}

export function StackedEyes({ className = "size-5" }: { className?: string }) {
  return (
    <span className={`relative inline-block ${className}`} aria-hidden="true">
      <Eye className="absolute left-0 top-0 size-[72%] opacity-45" />
      <Eye className="absolute bottom-0 right-0 size-[72%]" />
    </span>
  );
}

function initialRow(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels?: Partial<Record<LaunchAgent, string>>,
  preferredEfforts?: Partial<Record<LaunchAgent, string>>,
): PickerRow {
  const model = firstModelFor(agent, catalog, preferredModels);
  const effort = defaultEffortFor(agent, model, catalog, preferredEfforts);
  return {
    key: createUuid(),
    agent,
    model,
    ...(effort === "default" ? {} : { reasoningEffort: effort }),
  };
}

function flatCatalog(catalog: AgentModelCatalog): AgentModel[] {
  return (["claude", "codex", "cursor", "grok", "opencode"] as LaunchAgent[]).flatMap((agent) =>
    modelsForAgent(catalog, agent).map((model) => ({
      platform: agent,
      id: model.id,
      label: model.name,
      description: model.description,
      reasoning: model.reasoningEfforts.map((effort) => ({ id: effort, label: effort })),
    })),
  );
}

function ModelRow({
  row,
  label,
  models,
  catalog,
  preferredReasoningEfforts,
  favorites,
  onToggleFavorite,
  onReorderFavorites,
  onChange,
  onRemove,
}: {
  row: PickerRow;
  label: string;
  models: AgentModel[];
  catalog: AgentModelCatalog;
  preferredReasoningEfforts?: Partial<Record<LaunchAgent, string>>;
  favorites: ReturnType<typeof useAgentModelFavorites>["favorites"];
  onToggleFavorite: ReturnType<typeof useAgentModelFavorites>["toggleFavorite"];
  onReorderFavorites: ReturnType<typeof useAgentModelFavorites>["reorderFavorites"];
  onChange: (row: PickerRow) => void;
  onRemove?: () => void;
}) {
  const selected = modelsForAgent(catalog, row.agent).find((model) => model.id === row.model);
  const reasoning =
    selected?.reasoningEfforts.map((effort) => ({
      id: effort,
      label: effort === "xhigh" ? "Extra high" : effort[0]?.toUpperCase() + effort.slice(1),
    })) ?? [];
  /**
   * Applies the chosen model *and* the platform it came from in one update.
   *
   * The picker lists every platform's models — and its favourites view mixes
   * them — so a chosen row routinely belongs to a platform other than this
   * row's. Handling it as `onPlatformChange` then `onModelChange` would run
   * both against the same stale `row`, so the second call restored the old
   * agent and the reviewer launched a Codex or Cursor model against Claude.
   */
  const selectModel = (agent: LaunchAgent, modelId: string) => {
    const effort = defaultEffortFor(agent, modelId, catalog, preferredReasoningEfforts);
    onChange({
      ...row,
      agent,
      model: modelId,
      reasoningEffort: effort === "default" ? undefined : effort,
    });
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          {label}
        </Label>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onRemove}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      <AgentModelPicker
        ariaLabel={`${label} model`}
        models={models}
        selectedPlatform={row.agent}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        onReorderFavorites={onReorderFavorites}
        selectedModelId={row.model}
        selectedModelLabel={selected?.name ?? row.model}
        onPlatformChange={(agent) => {
          selectModel(agent, firstModelFor(agent, catalog));
        }}
        onModelChange={(model) => selectModel(row.agent, model)}
        onModelSelect={(model) => selectModel(model.platform, model.id)}
        reasoningOptions={reasoning}
        selectedReasoningId={row.reasoningEffort ?? ""}
        selectedReasoningLabel={row.reasoningEffort ?? "Default effort"}
        onReasoningChange={(reasoningEffort) =>
          onChange({
            ...row,
            reasoningEffort: reasoningEffort || undefined,
          })
        }
        title={label}
        className="min-h-11 w-full border border-zinc-700/80 bg-zinc-900 py-2.5"
      />
    </div>
  );
}

export function MultiReviewLaunchDialog({
  open,
  onOpenChange,
  defaultAgent,
  catalog,
  preferredModels,
  preferredReasoningEfforts,
  busy = false,
  onConfirm,
}: MultiReviewLaunchDialogProps) {
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const models = useMemo(() => flatCatalog(catalog), [catalog]);
  const makeRow = () =>
    initialRow(defaultAgent, catalog, preferredModels, preferredReasoningEfforts);
  const [reviewers, setReviewers] = useState<PickerRow[]>(() => [makeRow(), makeRow()]);
  const [fixModel, setFixModel] = useState<PickerRow>(() => makeRow());
  const wasOpen = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    const first = initialRow(defaultAgent, catalog, preferredModels, preferredReasoningEfforts);
    const second = initialRow(defaultAgent, catalog, preferredModels, preferredReasoningEfforts);
    setReviewers([first, second]);
    setFixModel(initialRow(defaultAgent, catalog, preferredModels, preferredReasoningEfforts));
  }, [catalog, defaultAgent, open, preferredModels, preferredReasoningEfforts]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[min(46rem,calc(100vh-2rem))] w-[min(calc(100%-1rem),42rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[42rem]">
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-[radial-gradient(circle_at_15%_0%,rgba(34,211,238,0.12),transparent_48%)] px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-3 text-base">
            <span className="grid size-9 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
              <StackedEyes className="size-5" />
            </span>
            Configure Multi Review
          </DialogTitle>
          <DialogDescription>
            Run independent structured reviews, then use one fix model to reconcile them into a
            single report.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            const clean = ({ key: _key, ...selection }: PickerRow) => selection;
            onConfirm({ reviewers: reviewers.map(clean), fixModel: clean(fixModel) });
          }}
        >
          <fieldset
            disabled={busy}
            className="min-h-0 flex-1 overflow-y-auto border-0 px-5 py-5 sm:px-6"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Review models</h3>
                <p className="text-xs text-zinc-500">
                  Each model receives its own isolated review session.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={reviewers.length >= MULTI_REVIEW_MAX_REVIEWERS}
                onClick={() =>
                  setReviewers((rows) =>
                    rows.length < MULTI_REVIEW_MAX_REVIEWERS ? [...rows, makeRow()] : rows,
                  )
                }
              >
                <Plus className="size-3.5" /> Add model
              </Button>
            </div>
            <div className="space-y-2.5">
              {reviewers.map((row, index) => (
                <ModelRow
                  key={row.key}
                  row={row}
                  label={`Reviewer ${index + 1}`}
                  models={models}
                  catalog={catalog}
                  preferredReasoningEfforts={preferredReasoningEfforts}
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  onReorderFavorites={reorderFavorites}
                  onChange={(next) =>
                    setReviewers((rows) => rows.map((item) => (item.key === row.key ? next : item)))
                  }
                  onRemove={
                    reviewers.length > 1
                      ? () => setReviewers((rows) => rows.filter((item) => item.key !== row.key))
                      : undefined
                  }
                />
              ))}
            </div>

            <div className="my-5 flex items-center gap-3 text-zinc-500" aria-hidden="true">
              <span className="h-px flex-1 bg-zinc-800" />
              <Wrench className="size-3.5" />
              <span className="h-px flex-1 bg-zinc-800" />
            </div>
            <ModelRow
              row={fixModel}
              label="Consolidation & fix model"
              models={models}
              catalog={catalog}
              preferredReasoningEfforts={preferredReasoningEfforts}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onReorderFavorites={reorderFavorites}
              onChange={setFixModel}
            />
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              This model deduplicates every report and remains attached to address the final issues
              and coverage gaps.
            </p>
          </fieldset>

          <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || reviewers.length === 0}>
              {busy ? "Starting Multi Review…" : `Start ${reviewers.length}-model review`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
