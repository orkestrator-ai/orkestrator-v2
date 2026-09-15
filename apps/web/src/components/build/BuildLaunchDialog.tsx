import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildStepConfig, BuildStepKey } from "@orkestrator/protocol/build-pipeline";
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
  defaultFastModeFor,
  defaultEffortFor,
  effortLabel,
  firstModelFor,
  modelsForAgent,
  platformOwnsSpeed,
  toPickerModel,
  type AgentModelCatalog,
  type AgentModelOption,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { cn } from "@/lib/utils";
import type { EnvironmentType } from "@/types";
import type { BuildPipelineConfiguredDefaults } from "@/lib/build-launch-options";

export interface BuildLaunchStepSelection {
  agent: LaunchAgent;
  model: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface BuildLaunchSelection {
  /** Environment type is a property of the workspace, so it is chosen once. */
  environmentType: EnvironmentType;
  steps: Record<BuildStepKey, BuildLaunchStepSelection>;
  /** Multi-review fan-out chosen for this launch. */
  reviewers?: BuildLaunchStepSelection[];
  /** Shared review preparation and consolidation model. */
  reviewPreparation?: BuildLaunchStepSelection;
  /** Present when the launcher offers source comments as optional context. */
  includeComments?: boolean;
}

export interface BuildLaunchCommentContextOption {
  count: number;
  defaultIncluded?: boolean;
}

const REVIEW_PREPARATION_CARD = {
  title: "Review preparation & consolidation",
  description: "Prepares the shared review package, then consolidates reviewer findings.",
  icon: <ScanSearch className="size-4" />,
};

type VisibleBuildCard =
  | {
      kind: "step";
      key: Exclude<BuildStepKey, "review">;
      title: string;
      description: string;
      icon: React.ReactNode;
    }
  | {
      kind: "reviewer";
      index: number;
      title: string;
      description: string;
      icon: React.ReactNode;
    }
  | {
      kind: "reviewPreparation";
      title: string;
      description: string;
      icon: React.ReactNode;
    };

function visibleBuildCards(reviewerCount: number, hasPreparation: boolean): VisibleBuildCard[] {
  const count = Math.max(1, reviewerCount);
  const cards: VisibleBuildCard[] = [
    {
      kind: "step",
      key: "build",
      title: "Build",
      description: "Implements the ticket and runs the fix stage.",
      icon: <Hammer className="size-4" />,
    },
  ];
  if (hasPreparation && count > 1) {
    cards.push({ kind: "reviewPreparation", ...REVIEW_PREPARATION_CARD });
  }
  for (let index = 0; index < count; index += 1) {
    cards.push({
      kind: "reviewer",
      index,
      title: count > 1 ? `Reviewer ${index + 1}` : "Review",
      description:
        count > 1
          ? "Reads the shared package independently."
          : "Reviews the diff for issues and coverage gaps.",
      icon: <ScanSearch className="size-4" />,
    });
  }
  for (const step of BUILD_STEPS) {
    if (step.key === "build" || step.key === "review") continue;
    cards.push({
      kind: "step",
      key: step.key,
      title: step.title,
      description: step.description,
      icon: step.icon,
    });
  }
  return cards;
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
  preferredFastModes?: Partial<Record<LaunchAgent, boolean>>;
  /** Action and Multi Review defaults shared by every ticket build path. */
  pipelineDefaults?: BuildPipelineConfiguredDefaults;
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

type StepState = {
  agent: LaunchAgent;
  model: string;
  reasoningEffort: string;
  fastMode?: boolean;
};

interface ResolvedStep {
  model: AgentModelOption | undefined;
  efforts: string[];
  effort: string;
  fastMode?: boolean;
}

function catalogHasModel(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  modelId: string | undefined,
): boolean {
  if (!modelId) return false;
  return modelsForAgent(catalog, agent).some(
    (option) => option.id === modelId || option.resolvedModel === modelId,
  );
}

function initialStepState(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
  preferredFastModes: BuildLaunchDialogProps["preferredFastModes"],
  configured?: BuildStepConfig,
): StepState {
  const selectedAgent = configured?.agent ?? agent;
  const configuredModel = configured?.model;
  const catalogKnowsModel = catalogHasModel(selectedAgent, catalog, configuredModel);
  // Keep the raw configured id until the catalogue can resolve it. Falling
  // through `firstModelFor` while OpenCode is still the placeholder would
  // silently replace a real preference with "default" or the first entry.
  const model =
    configuredModel && !catalogKnowsModel
      ? configuredModel
      : firstModelFor(
          selectedAgent,
          catalog,
          configuredModel
            ? { ...preferredModels, [selectedAgent]: configuredModel }
            : preferredModels,
        );
  const configuredEffort =
    configured?.reasoningEffort && configured.reasoningEffort !== "default"
      ? configured.reasoningEffort
      : undefined;
  return {
    agent: selectedAgent,
    model,
    reasoningEffort:
      configuredModel && !catalogKnowsModel && configuredEffort
        ? configuredEffort
        : defaultEffortFor(
            selectedAgent,
            model,
            catalog,
            configuredEffort
              ? {
                  ...preferredReasoningEfforts,
                  [selectedAgent]: configuredEffort,
                }
              : preferredReasoningEfforts,
          ),
    fastMode: defaultFastModeFor(selectedAgent, model, catalog, {
      ...preferredFastModes,
      ...(configured?.fastMode !== undefined ? { [selectedAgent]: configured.fastMode } : {}),
    }),
  };
}

function initialSteps(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
  preferredFastModes: BuildLaunchDialogProps["preferredFastModes"],
  pipelineDefaults?: BuildPipelineConfiguredDefaults,
): Record<BuildStepKey, StepState> {
  return Object.fromEntries(
    BUILD_STEPS.map(({ key }) => [
      key,
      initialStepState(
        agent,
        catalog,
        preferredModels,
        preferredReasoningEfforts,
        preferredFastModes,
        pipelineDefaults?.steps[key],
      ),
    ]),
  ) as Record<BuildStepKey, StepState>;
}

function initialReviewers(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
  preferredFastModes: BuildLaunchDialogProps["preferredFastModes"],
  pipelineDefaults?: BuildPipelineConfiguredDefaults,
): StepState[] {
  const configured = pipelineDefaults?.reviewers;
  if (!configured || configured.length === 0) {
    return [
      initialStepState(
        agent,
        catalog,
        preferredModels,
        preferredReasoningEfforts,
        preferredFastModes,
        pipelineDefaults?.steps.review,
      ),
    ];
  }
  return configured.map((reviewer) =>
    initialStepState(
      agent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      reviewer,
    ),
  );
}

function initialReviewPreparation(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
  preferredFastModes: BuildLaunchDialogProps["preferredFastModes"],
  pipelineDefaults?: BuildPipelineConfiguredDefaults,
): StepState | undefined {
  if (!pipelineDefaults?.reviewPreparation) return undefined;
  if ((pipelineDefaults.reviewers?.length ?? 0) <= 1) return undefined;
  return initialStepState(
    agent,
    catalog,
    preferredModels,
    preferredReasoningEfforts,
    preferredFastModes,
    pipelineDefaults.reviewPreparation,
  );
}

function matchCatalogModel(
  catalog: AgentModelCatalog,
  agent: LaunchAgent,
  modelId: string,
): AgentModelOption | undefined {
  const options = modelsForAgent(catalog, agent);
  return (
    options.find((option) => option.id === modelId) ??
    options.find((option) => option.resolvedModel === modelId)
  );
}

function cleanStep(state: StepState, catalog: AgentModelCatalog): BuildLaunchStepSelection {
  const model = matchCatalogModel(catalog, state.agent, state.model);
  const efforts = model?.reasoningEfforts ?? [];
  const reasoningEffort =
    state.reasoningEffort !== "default" &&
    (model ? efforts.includes(state.reasoningEffort) : Boolean(state.reasoningEffort))
      ? state.reasoningEffort
      : undefined;
  return {
    agent: state.agent,
    model: model?.id ?? state.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(model?.supportsSpeed === true && state.fastMode !== undefined
      ? { fastMode: state.fastMode }
      : {}),
  };
}

function resolveStepState(state: StepState, catalog: AgentModelCatalog): ResolvedStep {
  const matched = matchCatalogModel(catalog, state.agent, state.model);
  // An explicit configured id that the catalogue has not listed yet must not
  // collapse onto the first (often placeholder) entry.
  const model =
    matched ??
    (state.model && state.model !== "default"
      ? undefined
      : modelsForAgent(catalog, state.agent)[0]);
  const efforts = model?.reasoningEfforts ?? [];
  const effort =
    !model && state.reasoningEffort && state.reasoningEffort !== "default"
      ? state.reasoningEffort
      : efforts.length > 0 &&
          (state.reasoningEffort === "default" || efforts.includes(state.reasoningEffort))
        ? state.reasoningEffort
        : "default";
  return {
    model,
    efforts,
    effort,
    fastMode: model?.supportsSpeed === true ? state.fastMode : undefined,
  };
}

function flatCatalog(catalog: AgentModelCatalog, enabledPlatforms: LaunchAgent[]): AgentModel[] {
  return enabledPlatforms.flatMap((agent) =>
    (catalog[agent] ?? []).map((model) => toPickerModel(agent, model)),
  );
}

function BuildStepCard({
  number,
  stepKey,
  pickerId,
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
  preferredFastModes,
  favorites,
  onToggleFavorite,
  onReorderFavorites,
  onChange,
}: {
  number: number;
  stepKey: BuildStepKey;
  pickerId?: string;
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
  preferredFastModes: BuildLaunchDialogProps["preferredFastModes"];
  favorites: ReturnType<typeof useAgentModelFavorites>["favorites"];
  onToggleFavorite: ReturnType<typeof useAgentModelFavorites>["toggleFavorite"];
  onReorderFavorites: ReturnType<typeof useAgentModelFavorites>["reorderFavorites"];
  onChange: (next: StepState) => void;
}) {
  const selectModel = (agent: LaunchAgent, model: string) => {
    const previousFastMode = agent === state.agent ? state.fastMode : undefined;
    onChange({
      agent,
      model,
      reasoningEffort: defaultEffortFor(agent, model, catalog, preferredReasoningEfforts),
      fastMode: defaultFastModeFor(agent, model, catalog, {
        ...preferredFastModes,
        ...(typeof previousFastMode === "boolean" ? { [agent]: previousFastMode } : {}),
      }),
    });
  };
  const reasoningOptions =
    resolved.efforts.length === 0
      ? []
      : [
          { id: "default", label: "Default" },
          ...resolved.efforts.map((effort) => ({
            id: effort,
            label: effortLabel(effort),
          })),
        ];
  const modelLabel =
    resolved.model?.name ?? (state.model === "default" ? "Choose a model" : state.model);
  const pickerLabel = `${title} step model`;
  const controlId = pickerId ?? `build-${stepKey}-model`;
  const speedCapable = platformOwnsSpeed(state.agent);
  const speedAvailable = speedCapable && resolved.model?.supportsSpeed === true;

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
          <Label htmlFor={controlId} className="block text-sm font-semibold text-zinc-200">
            {pickerLabel}
          </Label>
          <p className="mt-0.5 text-xs leading-snug text-zinc-500">{description}</p>
        </div>
      </div>

      <AgentModelPicker
        id={controlId}
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
        speedCapable={speedCapable}
        fastModeAvailable={speedAvailable}
        fastModeEnabled={speedAvailable ? (state.fastMode ?? false) : false}
        onFastModeChange={
          speedAvailable ? (fastMode) => onChange({ ...state, fastMode }) : undefined
        }
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
  preferredFastModes,
  pipelineDefaults,
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
    initialSteps(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      pipelineDefaults,
    ),
  );
  const [reviewers, setReviewers] = useState(() =>
    initialReviewers(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      pipelineDefaults,
    ),
  );
  const [reviewPreparation, setReviewPreparation] = useState(() =>
    initialReviewPreparation(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      pipelineDefaults,
    ),
  );
  const [includeComments, setIncludeComments] = useState(commentContext?.defaultIncluded ?? true);
  const wasOpenRef = useRef(false);
  const touchedRef = useRef(new Set<string>());
  const environmentGroupId = useId();
  const commentContextId = useId();

  const resetLaunchState = useCallback(() => {
    setSteps(
      initialSteps(
        defaultAgent,
        catalog,
        preferredModels,
        preferredReasoningEfforts,
        preferredFastModes,
        pipelineDefaults,
      ),
    );
    setReviewers(
      initialReviewers(
        defaultAgent,
        catalog,
        preferredModels,
        preferredReasoningEfforts,
        preferredFastModes,
        pipelineDefaults,
      ),
    );
    setReviewPreparation(
      initialReviewPreparation(
        defaultAgent,
        catalog,
        preferredModels,
        preferredReasoningEfforts,
        preferredFastModes,
        pipelineDefaults,
      ),
    );
  }, [
    catalog,
    defaultAgent,
    pipelineDefaults,
    preferredFastModes,
    preferredModels,
    preferredReasoningEfforts,
  ]);

  // Reset on the closed→open transition. A catalogue that arrives while the
  // dialog is already open may only restore selections the user has not edited.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (justOpened) {
      touchedRef.current.clear();
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
      resetLaunchState();
      return;
    }
    if (!open) return;
    const nextSteps = initialSteps(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      pipelineDefaults,
    );
    const nextReviewers = initialReviewers(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      pipelineDefaults,
    );
    const nextPreparation = initialReviewPreparation(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
      preferredFastModes,
      pipelineDefaults,
    );
    setSteps((current) => {
      const merged = { ...current };
      for (const { key } of BUILD_STEPS) {
        if (!touchedRef.current.has(key)) merged[key] = nextSteps[key];
      }
      return merged;
    });
    setReviewers((current) => {
      const reviewerTouched = [...touchedRef.current].some((key) => key.startsWith("reviewer:"));
      if (!reviewerTouched) return nextReviewers;
      return current.map((row, index) =>
        touchedRef.current.has(`reviewer:${index}`) ? row : (nextReviewers[index] ?? row),
      );
    });
    setReviewPreparation((current) =>
      touchedRef.current.has("reviewPreparation") ? current : nextPreparation,
    );
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
    preferredFastModes,
    pipelineDefaults,
    resetLaunchState,
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
      const step = key === "review" ? (reviewers[0] ?? steps[key]) : steps[key];
      return [key, resolveStepState(step, catalog)] as const;
    });
    return Object.fromEntries(entries) as Record<BuildStepKey, ResolvedStep>;
  }, [catalog, reviewers, steps]);
  const resolvedReviewers = useMemo(
    () => reviewers.map((reviewer) => resolveStepState(reviewer, catalog)),
    [catalog, reviewers],
  );
  const resolvedReviewPreparation = useMemo(
    () => (reviewPreparation ? resolveStepState(reviewPreparation, catalog) : undefined),
    [catalog, reviewPreparation],
  );

  const updateStep = (key: BuildStepKey, next: StepState) => {
    touchedRef.current.add(key);
    if (key === "review") {
      touchedRef.current.add("reviewer:0");
      setReviewers((current) => current.map((row, index) => (index === 0 ? next : row)));
    }
    setSteps((current) => ({ ...current, [key]: next }));
  };

  const updateReviewer = (index: number, next: StepState) => {
    touchedRef.current.add(`reviewer:${index}`);
    if (index === 0) {
      touchedRef.current.add("review");
      setSteps((current) => ({ ...current, review: next }));
    }
    setReviewers((current) => current.map((row, i) => (i === index ? next : row)));
  };

  const commentContextLabel = commentContext
    ? `Include ${commentContext.count} comment${commentContext.count === 1 ? "" : "s"} in build context`
    : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="flex max-h-[min(46rem,calc(100vh-2rem))] w-[min(calc(100%-1rem),42rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[42rem] sm:p-0"
        onCloseAutoFocus={(event) => {
          const focusTarget = returnFocusRef?.current;
          if (!focusTarget?.isConnected) return;
          event.preventDefault();
          focusTarget.focus();
        }}
      >
        <DialogHeader className="m-0 shrink-0 border-b border-divider bg-background px-5 pb-4 pt-5 sm:m-0 sm:px-6">
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
            const selectedSteps = Object.fromEntries(
              BUILD_STEPS.map(({ key }) => {
                const state = key === "review" ? (reviewers[0] ?? steps[key]) : steps[key];
                const resolvedStep = resolved[key];
                return [
                  key,
                  {
                    agent: state.agent,
                    model: resolvedStep.model?.id ?? state.model,
                    reasoningEffort:
                      resolvedStep.effort === "default" ? undefined : resolvedStep.effort,
                    fastMode: resolvedStep.fastMode,
                  },
                ];
              }),
            ) as Record<BuildStepKey, BuildLaunchStepSelection>;
            const submittedReviewers =
              reviewers.length > 1
                ? reviewers.map((reviewer, index) =>
                    index === 0 ? selectedSteps.review : cleanStep(reviewer, catalog),
                  )
                : undefined;
            const submittedPreparation =
              reviewers.length > 1 && reviewPreparation
                ? cleanStep(reviewPreparation, catalog)
                : undefined;
            onConfirm({
              environmentType,
              ...(commentContext ? { includeComments } : {}),
              steps: selectedSteps,
              ...(submittedReviewers ? { reviewers: submittedReviewers } : {}),
              ...(submittedPreparation ? { reviewPreparation: submittedPreparation } : {}),
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
                {visibleBuildCards(reviewers.length, Boolean(reviewPreparation)).map(
                  (card, index) => {
                    if (card.kind === "reviewPreparation") {
                      if (!reviewPreparation || !resolvedReviewPreparation) return null;
                      return (
                        <BuildStepCard
                          key="reviewPreparation"
                          number={index + 1}
                          stepKey="review"
                          pickerId="build-reviewPreparation-model"
                          title={card.title}
                          description={card.description}
                          icon={card.icon}
                          state={reviewPreparation}
                          resolved={resolvedReviewPreparation}
                          models={models}
                          enabledPlatforms={enabledPlatforms}
                          catalog={catalog}
                          preferredModels={preferredModels}
                          preferredReasoningEfforts={preferredReasoningEfforts}
                          preferredFastModes={preferredFastModes}
                          favorites={pickerFavorites}
                          onToggleFavorite={toggleFavorite}
                          onReorderFavorites={reorderPickerFavorites}
                          onChange={(next) => {
                            touchedRef.current.add("reviewPreparation");
                            setReviewPreparation(next);
                          }}
                        />
                      );
                    }
                    if (card.kind === "reviewer") {
                      const state = reviewers[card.index] ?? steps.review;
                      return (
                        <BuildStepCard
                          key={`reviewer-${card.index}`}
                          number={index + 1}
                          stepKey="review"
                          pickerId={`build-reviewer-${card.index}-model`}
                          title={card.title}
                          description={card.description}
                          icon={card.icon}
                          state={state}
                          resolved={resolvedReviewers[card.index] ?? resolved.review}
                          models={models}
                          enabledPlatforms={enabledPlatforms}
                          catalog={catalog}
                          preferredModels={preferredModels}
                          preferredReasoningEfforts={preferredReasoningEfforts}
                          preferredFastModes={preferredFastModes}
                          favorites={pickerFavorites}
                          onToggleFavorite={toggleFavorite}
                          onReorderFavorites={reorderPickerFavorites}
                          onChange={(next) => updateReviewer(card.index, next)}
                        />
                      );
                    }
                    return (
                      <BuildStepCard
                        key={card.key}
                        number={index + 1}
                        stepKey={card.key}
                        title={card.title}
                        description={card.description}
                        icon={card.icon}
                        state={steps[card.key]}
                        resolved={resolved[card.key]}
                        models={models}
                        enabledPlatforms={enabledPlatforms}
                        catalog={catalog}
                        preferredModels={preferredModels}
                        preferredReasoningEfforts={preferredReasoningEfforts}
                        preferredFastModes={preferredFastModes}
                        favorites={pickerFavorites}
                        onToggleFavorite={toggleFavorite}
                        onReorderFavorites={reorderPickerFavorites}
                        onChange={(next) => updateStep(card.key, next)}
                      />
                    );
                  },
                )}
              </ol>
            </fieldset>
          </div>

          <DialogFooter className="m-0 shrink-0 flex-row justify-end border-t border-divider px-5 py-4 sm:m-0 sm:px-6">
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
