import { useEffect, useMemo, useRef, useState } from "react";
import { GitPullRequest } from "lucide-react";
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
  effortLabel,
  firstModelFor,
  modelsForAgent,
  LAUNCH_AGENT_OPTIONS,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";

export interface CreatePRSelection {
  agent: LaunchAgent;
  model: string;
  reasoningEffort?: string;
}

interface CreatePRDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent the toolbar would have used for a plain click. */
  defaultAgent: LaunchAgent;
  catalog: AgentModelCatalog;
  /** Providers the user has enabled; the picker offers no others. */
  enabledAgents: LaunchAgent[];
  preferredModels?: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<LaunchAgent, string>>;
  /** Base branch the pull request will target, shown so it can be verified. */
  targetBranch: string;
  onConfirm: (selection: CreatePRSelection) => void;
}

function agentLabel(agent: LaunchAgent): string {
  return LAUNCH_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent;
}

/**
 * Configures the agent, model and reasoning effort for a PR-creation run.
 *
 * The single unified picker is deliberate: provider, model and effort are one
 * decision, and splitting them across controls lets a user leave an effort
 * selected that the newly chosen model does not offer.
 */
export function CreatePRDialog({
  open,
  onOpenChange,
  defaultAgent,
  catalog,
  enabledAgents,
  preferredModels,
  preferredReasoningEfforts,
  targetBranch,
  onConfirm,
}: CreatePRDialogProps) {
  const { favorites, toggleFavorite } = useAgentModelFavorites();
  const initialModel = firstModelFor(defaultAgent, catalog, preferredModels);
  const [agent, setAgent] = useState<LaunchAgent>(defaultAgent);
  const [model, setModel] = useState(initialModel);
  const [reasoningEffort, setReasoningEffort] = useState(() =>
    defaultEffortFor(defaultAgent, initialModel, catalog, preferredReasoningEfforts),
  );
  const wasOpenRef = useRef(false);

  // Only the closed -> open edge reconfigures the dialog: a parent re-render
  // that hands down a refreshed catalog must not discard a selection the user
  // is in the middle of making.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    const nextModel = firstModelFor(defaultAgent, catalog, preferredModels);
    setAgent(defaultAgent);
    setModel(nextModel);
    setReasoningEffort(
      defaultEffortFor(defaultAgent, nextModel, catalog, preferredReasoningEfforts),
    );
  }, [catalog, defaultAgent, open, preferredModels, preferredReasoningEfforts]);

  const models = modelsForAgent(catalog, agent);
  const selectedModel = models.find((option) => option.id === model) ?? models[0];
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const effortAvailable = reasoningEfforts.length > 0;
  const effectiveEffort =
    effortAvailable
    && (reasoningEffort === "default" || reasoningEfforts.includes(reasoningEffort))
      ? reasoningEffort
      : "default";

  const pickerModels = useMemo<AgentModel[]>(
    () => enabledAgents.flatMap((platform) =>
      modelsForAgent(catalog, platform).map((option) => ({
        platform,
        id: option.id,
        label: option.name,
        description: option.description,
      })),
    ),
    [catalog, enabledAgents],
  );
  const reasoningOptions = useMemo<AgentReasoningOption[]>(
    () => (effortAvailable
      ? [
          { id: "default", label: "Default" },
          ...reasoningEfforts.map((effort) => ({ id: effort, label: effortLabel(effort) })),
        ]
      : []),
    [effortAvailable, reasoningEfforts],
  );

  // Model and provider move together: applying them separately would validate
  // the new model id against the previously selected provider's catalog.
  const selectAgentModel = (nextModel: AgentModel) => {
    setAgent(nextModel.platform);
    setModel(nextModel.id);
    setReasoningEffort(defaultEffortFor(
      nextModel.platform,
      nextModel.id,
      catalog,
      preferredReasoningEfforts,
    ));
  };

  const selectAgent = (nextAgent: LaunchAgent) => {
    if (nextAgent === agent) return;
    const nextModel = firstModelFor(nextAgent, catalog, preferredModels);
    setAgent(nextAgent);
    setModel(nextModel);
    setReasoningEffort(
      defaultEffortFor(nextAgent, nextModel, catalog, preferredReasoningEfforts),
    );
  };

  const summary = [
    agentLabel(agent),
    selectedModel?.name ?? model,
    effectiveEffort === "default" ? "default effort" : `${effectiveEffort} effort`,
    `into ${targetBranch}`,
  ].join(" · ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(calc(100%-1rem),34rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[34rem]">
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-cyan-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
              <GitPullRequest className="size-4" />
            </span>
            Configure pull request
          </DialogTitle>
          <DialogDescription>
            Launch an agent that commits the work, pushes the branch, and opens a
            pull request against <span className="text-zinc-300">{targetBranch}</span>.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm({
              agent,
              model: selectedModel?.id ?? model,
              reasoningEffort:
                effectiveEffort === "default" ? undefined : effectiveEffort,
            });
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
            <Label
              htmlFor="create-pr-model"
              className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400"
            >
              Agent, model and reasoning
            </Label>
            <AgentModelPicker
              id="create-pr-model"
              ariaLabel="Agent, model and reasoning"
              models={pickerModels}
              enabledPlatforms={enabledAgents}
              selectedPlatform={agent}
              favorites={favorites}
              onPlatformChange={selectAgent}
              onToggleFavorite={toggleFavorite}
              selectedModelId={selectedModel?.id ?? model}
              selectedModelLabel={selectedModel?.name ?? "Choose a model"}
              onModelChange={(nextModelId) =>
                selectAgentModel({ platform: agent, id: nextModelId, label: nextModelId })}
              onModelSelect={selectAgentModel}
              reasoningOptions={reasoningOptions}
              selectedReasoningId={effectiveEffort}
              selectedReasoningLabel={
                reasoningOptions.find((option) => option.id === effectiveEffort)?.label
              }
              onReasoningChange={setReasoningEffort}
              title="Choose agent, model, and reasoning"
              className="min-h-11 w-full max-w-none justify-start border border-zinc-700/80 bg-zinc-900 py-2.5 text-sm text-zinc-100 md:max-w-none md:flex-1"
            />
            {!effortAvailable && (
              <p className="mt-1.5 text-xs text-zinc-500">
                This model uses its default reasoning setting.
              </p>
            )}

            <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <span className="text-zinc-500">Launch:</span> {summary}
            </div>
          </div>

          <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create pull request</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
