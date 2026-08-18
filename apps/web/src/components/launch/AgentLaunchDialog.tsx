import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AlertTriangle, GitPullRequest, Loader2 } from "lucide-react";
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

export interface AgentLaunchSelection {
  agent: LaunchAgent;
  model: string;
  reasoningEffort?: string;
}

/** The workflow being launched. Every entry restyles the same picker. */
export type AgentLaunchKind = "create-pr" | "resolve-conflicts";

interface AgentLaunchDialogProps {
  kind?: AgentLaunchKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent the toolbar would have used for a plain click. */
  defaultAgent: LaunchAgent;
  catalog: AgentModelCatalog;
  /** Providers the user has enabled; the picker offers no others. */
  enabledAgents: LaunchAgent[];
  preferredModels?: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<LaunchAgent, string>>;
  /** Base branch the launch targets, shown so it can be verified. */
  targetBranch: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  returnFocusFallback?: () => HTMLElement | null;
  confirmDisabled?: boolean;
  /** Blocks confirmation and shows neutral busy text rather than an error. */
  busy?: boolean;
  error?: string | null;
  onConfirm: (selection: AgentLaunchSelection) => void;
}

function agentLabel(agent: LaunchAgent): string {
  return LAUNCH_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent;
}

/**
 * Configures the agent, model and reasoning effort for a toolbar launch.
 *
 * Shared by every workflow that launches a configured agent — `kind` restyles
 * the copy and the confirm label, nothing else. The single unified picker is
 * deliberate: provider, model and effort are one decision, and splitting them
 * across controls lets a user leave an effort selected that the newly chosen
 * model does not offer.
 */
export function AgentLaunchDialog({
  kind = "create-pr",
  open,
  onOpenChange,
  defaultAgent,
  catalog,
  enabledAgents,
  preferredModels,
  preferredReasoningEfforts,
  targetBranch,
  returnFocusRef,
  returnFocusFallback,
  confirmDisabled = false,
  busy = false,
  error,
  onConfirm,
}: AgentLaunchDialogProps) {
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
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
  // Stable identity: the `?? []` fallback otherwise re-created the array every
  // render, defeating the reasoningOptions memo below.
  const reasoningEfforts = useMemo(
    () => selectedModel?.reasoningEfforts ?? [],
    [selectedModel?.reasoningEfforts],
  );
  const effortAvailable = reasoningEfforts.length > 0;
  const effectiveEffort =
    effortAvailable && (reasoningEffort === "default" || reasoningEfforts.includes(reasoningEffort))
      ? reasoningEffort
      : "default";

  const pickerModels = useMemo<AgentModel[]>(
    () =>
      enabledAgents.flatMap((platform) =>
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
    () =>
      effortAvailable
        ? [
            { id: "default", label: "Default" },
            ...reasoningEfforts.map((effort) => ({ id: effort, label: effortLabel(effort) })),
          ]
        : [],
    [effortAvailable, reasoningEfforts],
  );

  // Model and provider move together: applying them separately would validate
  // the new model id against the previously selected provider's catalog.
  const selectAgentModel = (nextModel: AgentModel) => {
    setAgent(nextModel.platform);
    setModel(nextModel.id);
    setReasoningEffort(
      defaultEffortFor(nextModel.platform, nextModel.id, catalog, preferredReasoningEfforts),
    );
  };

  const selectAgent = (nextAgent: LaunchAgent) => {
    if (nextAgent === agent) return;
    const nextModel = firstModelFor(nextAgent, catalog, preferredModels);
    setAgent(nextAgent);
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(nextAgent, nextModel, catalog, preferredReasoningEfforts));
  };

  const isResolve = kind === "resolve-conflicts";
  const summary = [
    agentLabel(agent),
    selectedModel?.name ?? model,
    effectiveEffort === "default" ? "default effort" : `${effectiveEffort} effort`,
    `${isResolve ? "against" : "into"} ${targetBranch}`,
  ].join(" · ");
  const pickerId = isResolve ? "resolve-conflicts-model" : "create-pr-model";
  const confirmLabel = isResolve ? "Resolve conflicts" : "Create pull request";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // A launch already in flight must keep this surface mounted: the
        // parent reports refusal here, and dismissing would swallow it.
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex w-[min(calc(100%-1rem),34rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[34rem]"
        onCloseAutoFocus={(event) => {
          const primaryTarget = returnFocusRef?.current;
          const focusTarget =
            returnFocusFallback?.() ?? (primaryTarget?.isConnected ? primaryTarget : null);
          if (!focusTarget) return;
          event.preventDefault();
          focusTarget.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-cyan-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
              {isResolve ? (
                <AlertTriangle className="size-4" />
              ) : (
                <GitPullRequest className="size-4" />
              )}
            </span>
            {isResolve ? "Configure conflict resolution" : "Configure pull request"}
          </DialogTitle>
          <DialogDescription>
            {isResolve ? (
              <>
                Launch an agent to resolve this pull request&apos;s merge conflicts against{" "}
                <span className="text-zinc-300">{targetBranch}</span>, then commit and push the
                result.
              </>
            ) : (
              <>
                Launch an agent that commits the work, pushes the branch, and opens a pull request
                against <span className="text-zinc-300">{targetBranch}</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || confirmDisabled) return;
            onConfirm({
              agent,
              model: selectedModel?.id ?? model,
              reasoningEffort: effectiveEffort === "default" ? undefined : effectiveEffort,
            });
          }}
        >
          {/*
            `display: contents` rather than a flex column: a rendered fieldset
            wraps its children in an anonymous content box that sizes to
            content, so a `flex-1 min-h-0` child resolves against that box
            instead of the fieldset's own constrained height and the scroll
            region grows until it pushes the footer out of the dialog. Removing
            the box makes the region and footer direct children of the form.
            `disabled` still propagates — that is a DOM rule, not a layout one.
          */}
          <fieldset disabled={busy} className="contents">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
              <Label
                htmlFor={pickerId}
                className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400"
              >
                Agent, model and reasoning
              </Label>
              <AgentModelPicker
                id={pickerId}
                ariaLabel="Agent, model and reasoning"
                models={pickerModels}
                enabledPlatforms={enabledAgents}
                selectedPlatform={agent}
                favorites={favorites}
                onPlatformChange={selectAgent}
                onToggleFavorite={toggleFavorite}
                onReorderFavorites={reorderFavorites}
                selectedModelId={selectedModel?.id ?? model}
                selectedModelLabel={selectedModel?.name ?? "Choose a model"}
                onModelChange={(nextModelId) =>
                  selectAgentModel({ platform: agent, id: nextModelId, label: nextModelId })
                }
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
              {/* A launch in flight is progress, not a fault: reporting it through
                the destructive alert would tell the user their own successful
                submission had failed for as long as the launch took. */}
              {busy ? (
                <p
                  role="status"
                  className="mt-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                  Launching…
                </p>
              ) : error ? (
                <p
                  role="alert"
                  className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {error}
                </p>
              ) : null}
            </div>

            <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={confirmDisabled || busy}>
                {confirmLabel}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
