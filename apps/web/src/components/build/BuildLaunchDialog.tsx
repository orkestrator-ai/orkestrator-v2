import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildStepKey } from "@orkestrator/protocol/build-pipeline";
import type { AgentModel, AgentModelRef } from "@orkestrator/protocol/native-agent";
import {
  Container,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  Hammer,
  ListChecks,
  MessageSquare,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
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
import { useDockerAvailability } from "@/contexts/DockerAvailabilityContext";
import {
  mergeReorderedFavoriteModels,
  useAgentModelFavorites,
} from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  effortLabel,
  firstModelFor,
  modelsForAgent,
  type AgentModelCatalog,
  type AgentModelOption,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { cn } from "@/lib/utils";
import type { EnvironmentType } from "@/types";

export interface BuildLaunchStepSelection {
  agent: LaunchAgent;
  model: string;
  reasoningEffort?: string;
}

export interface BuildLaunchSelection {
  /** Environment type is a property of the workspace, so it is chosen once. */
  environmentType: EnvironmentType;
  steps: Record<BuildStepKey, BuildLaunchStepSelection>;
  /** Present when the launcher offers source comments as optional context. */
  includeComments?: boolean;
}

export interface BuildLaunchCommentContextOption {
  count: number;
  defaultIncluded?: boolean;
}

const BUILD_STEPS: Array<{
  key: BuildStepKey;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    key: "build",
    title: "Build",
    description: "Implements the ticket and runs the fix stage.",
    icon: <Hammer className="size-4" />,
  },
  {
    key: "review",
    title: "Review",
    description: "Reviews the diff for issues and coverage gaps.",
    icon: <ScanSearch className="size-4" />,
  },
  {
    key: "address",
    title: "Address issues",
    description: "Continues from the review and fixes its findings.",
    icon: <ListChecks className="size-4" />,
  },
  {
    key: "verify",
    title: "Verify",
    description: "Checks the committed branch against the ticket.",
    icon: <ShieldCheck className="size-4" />,
  },
  {
    key: "pr",
    title: "Pull request",
    description: "Pushes the branch and opens the pull request.",
    icon: <GitPullRequest className="size-4" />,
  },
  {
    key: "resolve-conflicts",
    title: "Resolve conflicts",
    description: "Resolves merge conflicts on an open pull request.",
    icon: <GitMerge className="size-4" />,
  },
];

const ENVIRONMENT_OPTIONS: Array<{
  value: EnvironmentType;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "containerized",
    label: "Container",
    description: "Docker workspace with a restricted network",
    icon: <Container className="size-4" />,
  },
  {
    value: "local",
    label: "Local",
    description: "Git worktree on this machine, full network",
    icon: <FolderGit2 className="size-4" />,
  },
];

/**
 * States both halves of the trade: the access these stages get, and the exact
 * reach of the check that constrains it. The backend compares HEAD and the
 * Git-visible uncommitted paths, so ignored files and `.git` internals are not
 * covered — claiming the workspace is protected outright would overstate it.
 */
const VALIDATION_WORKSPACE_NOTICE =
  "This step runs with full workspace access so validation can write generated outputs and caches. Source edits and commits are forbidden: the backend rejects the result if the commit or any Git-tracked or untracked path changed. Ignored files are not checked.";

interface BuildLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: AgentModelCatalog;
  defaultAgent: LaunchAgent;
  defaultEnvironmentType: EnvironmentType;
  preferredModels?: Partial<Record<LaunchAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<LaunchAgent, string>>;
  /** Offers source-ticket comments as optional build context. */
  commentContext?: BuildLaunchCommentContextOption;
  /** Disables the submit button while a start request is in flight. */
  busy?: boolean;
  /** Whether this project has a host checkout that can own local worktrees. */
  localEnvironmentAvailable?: boolean;
  /** Trigger that receives focus again after the dialog closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: (selection: BuildLaunchSelection) => void;
}

type StepState = { agent: LaunchAgent; model: string; reasoningEffort: string };

interface ResolvedStep {
  model: AgentModelOption | undefined;
  efforts: string[];
  effort: string;
}

function initialStepState(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
): StepState {
  const model = firstModelFor(agent, catalog, preferredModels);
  return {
    agent,
    model,
    reasoningEffort: defaultEffortFor(agent, model, catalog, preferredReasoningEfforts),
  };
}

function initialSteps(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
): Record<BuildStepKey, StepState> {
  const initial = initialStepState(agent, catalog, preferredModels, preferredReasoningEfforts);
  return Object.fromEntries(BUILD_STEPS.map(({ key }) => [key, { ...initial }])) as Record<
    BuildStepKey,
    StepState
  >;
}

function flatCatalog(catalog: AgentModelCatalog, enabledPlatforms: LaunchAgent[]): AgentModel[] {
  return enabledPlatforms.flatMap((agent) =>
    (catalog[agent] ?? []).map((model) => ({
      platform: agent,
      id: model.id,
      label: model.name,
      ...(model.description ? { providerLabel: model.description } : {}),
      description: model.description,
      reasoning: model.reasoningEfforts.map((effort) => ({
        id: effort,
        label: effortLabel(effort),
      })),
    })),
  );
}

function BuildStepCard({
  number,
  stepKey,
  title,
  description,
  icon,
  state,
  resolved,
  models,
  enabledPlatforms,
  catalog,
  preferredModels,
  preferredReasoningEfforts,
  favorites,
  onToggleFavorite,
  onReorderFavorites,
  onChange,
}: {
  number: number;
  stepKey: BuildStepKey;
  title: string;
  description: string;
  icon: React.ReactNode;
  state: StepState;
  resolved: ResolvedStep;
  models: AgentModel[];
  enabledPlatforms: LaunchAgent[];
  catalog: AgentModelCatalog;
  preferredModels: BuildLaunchDialogProps["preferredModels"];
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"];
  favorites: ReturnType<typeof useAgentModelFavorites>["favorites"];
  onToggleFavorite: ReturnType<typeof useAgentModelFavorites>["toggleFavorite"];
  onReorderFavorites: ReturnType<typeof useAgentModelFavorites>["reorderFavorites"];
  onChange: (next: StepState) => void;
}) {
  const selectModel = (agent: LaunchAgent, model: string) => {
    onChange({
      agent,
      model,
      reasoningEffort: defaultEffortFor(agent, model, catalog, preferredReasoningEfforts),
    });
  };
  const reasoningOptions =
    resolved.efforts.length === 0
      ? []
      : [
          { id: "default", label: "Default" },
          ...resolved.efforts.map((effort) => ({ id: effort, label: effortLabel(effort) })),
        ];
  const modelLabel =
    resolved.model?.name ?? (state.model === "default" ? "Choose a model" : state.model);
  const pickerLabel = `${title} step model`;

  return (
    <li
      data-build-step={stepKey}
      className="relative rounded-xl border border-zinc-800 bg-zinc-950/55 p-3.5"
    >
      <div className="mb-3 flex min-w-0 items-start gap-3">
        <span className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
          {icon}
          <span
            data-build-step-number={number}
            className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-zinc-800 text-[9px] font-semibold text-zinc-300 ring-1 ring-zinc-600"
          >
            {number}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <Label
            htmlFor={`build-${stepKey}-model`}
            className="block text-sm font-semibold text-zinc-200"
          >
            {pickerLabel}
          </Label>
          <p className="mt-0.5 text-xs leading-snug text-zinc-500">{description}</p>
        </div>
      </div>

      <AgentModelPicker
        id={`build-${stepKey}-model`}
        ariaLabel={pickerLabel}
        models={models}
        enabledPlatforms={enabledPlatforms}
        selectedPlatform={state.agent}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        onReorderFavorites={onReorderFavorites}
        selectedModelId={resolved.model?.id ?? state.model}
        selectedModelLabel={modelLabel}
        onPlatformChange={(agent) => {
          if (agent === state.agent) return;
          selectModel(agent, firstModelFor(agent, catalog, preferredModels));
        }}
        onModelChange={(model) => selectModel(state.agent, model)}
        onModelSelect={(model) => selectModel(model.platform, model.id)}
        reasoningOptions={reasoningOptions}
        selectedReasoningId={resolved.effort}
        selectedReasoningLabel={
          reasoningOptions.length > 0
            ? resolved.effort === "default"
              ? "Default effort"
              : effortLabel(resolved.effort)
            : undefined
        }
        onReasoningChange={(reasoningEffort) => onChange({ ...state, reasoningEffort })}
        title={pickerLabel}
        className="min-h-11 w-full border border-zinc-700/80 bg-zinc-900 py-2.5 md:max-w-none"
      />

      {reasoningOptions.length === 0 && (
        <p className="mt-1.5 text-xs text-zinc-500">
          This model uses its default reasoning setting.
        </p>
      )}

      {(stepKey === "review" || stepKey === "verify") && (
        <p className="mt-2 text-[11px] leading-snug text-amber-400/80" role="note">
          {VALIDATION_WORKSPACE_NOTICE}
        </p>
      )}
    </li>
  );
}

/**
 * Configures a build before it starts.
 *
 * The environment belongs to the workspace and is chosen once. Every ordered
 * pipeline stage gets a complete model picker so its harness, model and
 * reasoning can be understood and changed as one selection.
 */
export function BuildLaunchDialog({
  open,
  onOpenChange,
  catalog,
  defaultAgent,
  defaultEnvironmentType,
  preferredModels,
  preferredReasoningEfforts,
  commentContext,
  busy = false,
  localEnvironmentAvailable = true,
  returnFocusRef,
  onConfirm,
}: BuildLaunchDialogProps) {
  const { favorites, enabledPlatforms, toggleFavorite, reorderFavorites } =
    useAgentModelFavorites();
  const dockerAvailable = useDockerAvailability();
  const models = useMemo(() => flatCatalog(catalog, enabledPlatforms), [catalog, enabledPlatforms]);
  const pickerFavorites = useMemo(
    () => favorites.filter((favorite) => enabledPlatforms.includes(favorite.platform)),
    [enabledPlatforms, favorites],
  );
  const reorderPickerFavorites = useCallback(
    (reorderedVisibleFavorites: AgentModelRef[]) => {
      const merged = mergeReorderedFavoriteModels(
        favorites,
        pickerFavorites,
        reorderedVisibleFavorites,
      );
      if (merged) reorderFavorites(merged);
    },
    [favorites, pickerFavorites, reorderFavorites],
  );
  const [environmentType, setEnvironmentType] = useState(defaultEnvironmentType);
  const [steps, setSteps] = useState(() =>
    initialSteps(defaultAgent, catalog, preferredModels, preferredReasoningEfforts),
  );
  const [includeComments, setIncludeComments] = useState(commentContext?.defaultIncluded ?? true);
  const wasOpenRef = useRef(false);
  const environmentGroupId = useId();
  const commentContextId = useId();

  // Reset on the closed→open transition only, so a catalog that arrives while
  // the dialog is open cannot discard a selection the user has already made.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setEnvironmentType(() => {
      if (defaultEnvironmentType === "containerized" && !dockerAvailable) {
        return localEnvironmentAvailable ? "local" : "containerized";
      }
      if (defaultEnvironmentType === "local" && !localEnvironmentAvailable) {
        return dockerAvailable ? "containerized" : "local";
      }
      return defaultEnvironmentType;
    });
    setIncludeComments(commentContext?.defaultIncluded ?? true);
    setSteps(initialSteps(defaultAgent, catalog, preferredModels, preferredReasoningEfforts));
  }, [
    catalog,
    commentContext?.defaultIncluded,
    defaultAgent,
    defaultEnvironmentType,
    dockerAvailable,
    localEnvironmentAvailable,
    open,
    preferredModels,
    preferredReasoningEfforts,
  ]);

  useEffect(() => {
    if (!dockerAvailable && localEnvironmentAvailable && environmentType === "containerized") {
      setEnvironmentType("local");
    } else if (!localEnvironmentAvailable && dockerAvailable && environmentType === "local") {
      setEnvironmentType("containerized");
    }
  }, [dockerAvailable, environmentType, localEnvironmentAvailable]);

  const resolved = useMemo(() => {
    const entries = BUILD_STEPS.map(({ key }) => {
      const step = steps[key];
      const agentModels = modelsForAgent(catalog, step.agent);
      const model = agentModels.find((option) => option.id === step.model) ?? agentModels[0];
      const efforts = model?.reasoningEfforts ?? [];
      const effort =
        efforts.length > 0 &&
        (step.reasoningEffort === "default" || efforts.includes(step.reasoningEffort))
          ? step.reasoningEffort
          : "default";
      return [key, { model, efforts, effort }] as const;
    });
    return Object.fromEntries(entries) as Record<BuildStepKey, ResolvedStep>;
  }, [catalog, steps]);

  const updateStep = (key: BuildStepKey, next: StepState) => {
    setSteps((current) => ({ ...current, [key]: next }));
  };

  const commentContextLabel = commentContext
    ? `Include ${commentContext.count} comment${commentContext.count === 1 ? "" : "s"} in build context`
    : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="flex max-h-[min(46rem,calc(100vh-2rem))] w-[min(calc(100%-1rem),42rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[42rem]"
        onCloseAutoFocus={(event) => {
          const focusTarget = returnFocusRef?.current;
          if (!focusTarget?.isConnected) return;
          event.preventDefault();
          focusTarget.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-[radial-gradient(circle_at_15%_0%,rgba(34,211,238,0.12),transparent_48%)] px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-3 text-base">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
              <Hammer className="size-5" />
            </span>
            Configure build
          </DialogTitle>
          <DialogDescription>
            Choose the workspace, then assign a model to every stage of the pipeline.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            if (environmentType === "containerized" && !dockerAvailable) return;
            if (environmentType === "local" && !localEnvironmentAvailable) return;
            onConfirm({
              environmentType,
              ...(commentContext ? { includeComments } : {}),
              steps: Object.fromEntries(
                BUILD_STEPS.map(({ key }) => [
                  key,
                  {
                    agent: steps[key].agent,
                    model: resolved[key].model?.id ?? steps[key].model,
                    reasoningEffort:
                      resolved[key].effort === "default" ? undefined : resolved[key].effort,
                  },
                ]),
              ) as Record<BuildStepKey, BuildLaunchStepSelection>,
            });
          }}
        >
          <div
            role="region"
            aria-label="Build configuration"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <fieldset disabled={busy} className="min-w-0 border-0 px-5 py-5 sm:px-6">
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-zinc-200">Environment</h3>
                <p className="text-xs text-zinc-500">Every stage runs in this workspace.</p>
              </div>
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="radiogroup"
                aria-label="Build environment"
              >
                {ENVIRONMENT_OPTIONS.map((option) => {
                  const selected = environmentType === option.value;
                  const disabled =
                    option.value === "containerized"
                      ? !dockerAvailable
                      : !localEnvironmentAvailable;
                  const id = `${environmentGroupId}-${option.value}`;
                  return (
                    <div key={option.value} className="relative min-w-0">
                      <input
                        id={id}
                        type="radio"
                        name={`${environmentGroupId}-environment`}
                        checked={selected}
                        disabled={disabled}
                        onChange={() => setEnvironmentType(option.value)}
                        className="peer sr-only"
                      />
                      <label
                        htmlFor={id}
                        className={cn(
                          "flex min-h-16 cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/70",
                          disabled && "cursor-not-allowed opacity-50",
                          selected
                            ? "border-cyan-400/55 bg-cyan-500/10 text-zinc-100"
                            : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700",
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {option.icon}
                          {option.label}
                        </span>
                        <span className="mt-1 text-[11px] leading-snug text-zinc-500">
                          {disabled
                            ? option.value === "containerized"
                              ? "Unavailable while Docker is stopped"
                              : "Unavailable without a local project checkout"
                            : option.description}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>

              {commentContext && (
                <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-500/[0.06] px-3 py-2.5">
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id={commentContextId}
                      checked={includeComments}
                      onCheckedChange={(checked) => setIncludeComments(checked === true)}
                      aria-label={commentContextLabel}
                      className="mt-0.5"
                    />
                    <Label
                      htmlFor={commentContextId}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <MessageSquare className="mt-0.5 size-4 shrink-0 text-cyan-300/80" />
                      <span>
                        <span className="block text-sm font-medium text-zinc-200">
                          {commentContextLabel}
                        </span>
                        <span className="mt-0.5 block text-[11px] font-normal leading-snug text-zinc-500">
                          Give the pipeline the discussion attached to this ticket.
                        </span>
                      </span>
                    </Label>
                  </div>
                </div>
              )}

              <div className="my-5 flex items-center gap-3 text-zinc-500" aria-hidden="true">
                <span className="h-px flex-1 bg-zinc-800" />
                <Hammer className="size-3.5" />
                <span className="h-px flex-1 bg-zinc-800" />
              </div>

              <div className="mb-3">
                <h3 className="text-sm font-semibold text-zinc-200">Build steps</h3>
                <p className="text-xs text-zinc-500">
                  The pipeline runs top to bottom. Pick the model best suited to each stage.
                </p>
              </div>
              <ol className="space-y-2.5" aria-label="Build steps">
                {BUILD_STEPS.map(({ key, title, description, icon }, index) => (
                  <BuildStepCard
                    key={key}
                    number={index + 1}
                    stepKey={key}
                    title={title}
                    description={description}
                    icon={icon}
                    state={steps[key]}
                    resolved={resolved[key]}
                    models={models}
                    enabledPlatforms={enabledPlatforms}
                    catalog={catalog}
                    preferredModels={preferredModels}
                    preferredReasoningEfforts={preferredReasoningEfforts}
                    favorites={pickerFavorites}
                    onToggleFavorite={toggleFavorite}
                    onReorderFavorites={reorderPickerFavorites}
                    onChange={(next) => updateStep(key, next)}
                  />
                ))}
              </ol>
            </fieldset>
          </div>

          <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                (environmentType === "containerized" && !dockerAvailable) ||
                (environmentType === "local" && !localEnvironmentAvailable)
              }
            >
              {busy ? "Starting build…" : "Start build"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
