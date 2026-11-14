import { DELIVERY_STEP_DESCRIPTIONS } from "@/lib/delivery-policy";
import {
  effectiveDeliveryPolicy,
  type DeliveryPolicy,
} from "@orkestrator/protocol/ticket-sections";
import { DeliveryPolicySelect } from "@/components/tickets/DeliveryPolicySelect";
import { type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildStepConfig, BuildStepKey } from "@orkestrator/protocol/build-pipeline";
import type { AgentModel, AgentModelRef } from "@orkestrator/protocol/native-agent";
import {
  Container,
  FolderGit2,
  GitMerge,
  Globe,
  GitPullRequest,
  Hammer,
  ListChecks,
  MessageSquare,
  Monitor,
  Package,
  ScanSearch,
  Shield,
  ShieldCheck,
  TriangleAlert,
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
  resolveCatalogModelId,
  sessionDefaultModel,
  toPickerModel,
  type AgentModelCatalog,
  type AgentModelOption,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { cn } from "@/lib/utils";
import { aptPackagesNotice } from "@/lib/apt-packages-notice";
import type { DeclaredAptPackages } from "@orkestrator/protocol/apt-packages";
import type { EnvironmentType, NetworkAccessMode } from "@/types";
import type { BuildPipelineConfiguredDefaults } from "@/lib/build-launch-options";
import {
  BuildStepInstructionsField,
  buildStepInstructionsTooLong,
} from "./BuildStepInstructionsField";
import type { ReviewLens, ReviewLensPreset } from "@orkestrator/protocol/review-lens";
import {
  machineChoiceFor,
  pickedLaunchMachine,
  type BuildLaunchMachine,
  type BuildLaunchMachineChoice,
} from "./build-machines";
import { useMachineDockerAvailability } from "./useMachineDockerAvailability";
import {
  ReviewLensField,
  launchedReviewLens,
  reviewLensDraftError,
  useReviewLensPresets,
} from "@/components/review/ReviewLensField";

export interface BuildLaunchStepSelection {
  agent: LaunchAgent;
  model: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  /** The user's own instructions for this step, trimmed; absent when blank. */
  instructions?: string;
  /** Review step and reviewer rows only: the reviewer's focus, copied from a preset or typed. */
  lens?: ReviewLens;
}

export interface BuildLaunchSelection {
  /**
   * The machine the pipeline environment is created on. Absent for the tab's
   * own machine, which is also what every launch without a choice means.
   */
  machine?: BuildLaunchMachineChoice;
  /** Environment type is a property of the workspace, so it is chosen once. */
  environmentType: EnvironmentType;
  /**
   * The container's network access. Present only for a container: a local
   * worktree has no firewall to apply one to.
   */
  networkAccessMode?: NetworkAccessMode;
  steps: Record<BuildStepKey, BuildLaunchStepSelection>;
  /** Multi-review fan-out chosen for this launch. */
  reviewers?: BuildLaunchStepSelection[];
  /** Shared review preparation and consolidation model. */
  reviewPreparation?: BuildLaunchStepSelection;
  /** Present when the launcher offers source comments as optional context. */
  includeComments?: boolean;
  /** "When verified": saved to a Kanban ticket, or kept on the pipeline for any other ticket. */
  deliveryPolicy: DeliveryPolicy;
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
      description: "Implements the ticket and does any Rework.",
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
    description: "Implements the ticket and does any Rework.",
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
    title: "Address Findings",
    description: "Continues from the review and addresses its findings.",
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
    description: "Isolated Docker workspace",
    icon: <Container className="size-4" />,
  },
  {
    value: "local",
    label: "Local",
    description: "Git worktree on this machine, full network",
    icon: <FolderGit2 className="size-4" />,
  },
];

const NETWORK_OPTIONS: Array<{
  value: NetworkAccessMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "restricted",
    label: "Restricted",
    description:
      "Only GitHub, npm, agent APIs and your allowlist. Root setup steps in orkestrator-ai.json can't run.",
    icon: <Shield className="size-4" />,
  },
  {
    value: "full",
    label: "Full access",
    description: "Unrestricted internet access. Needed when setup has root steps.",
    icon: <Globe className="size-4" />,
  },
];

/**
 * Shown under the network choice when Restricted is picked for a project whose
 * setup has root steps: `workspace-setup.sh` refuses those without full
 * network access, so the container would stop at setup.
 */
function RootStepsNetworkWarning({ steps }: { steps: number }) {
  return (
    <p
      role="status"
      className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-200"
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>
        This project's orkestrator-ai.json has{" "}
        {steps === 1 ? "a root setup step" : `${steps} root setup steps`}. Root steps run only with
        Full access, because a command running as root could get round the restriction whatever it
        connects to. With Restricted, setup will stop there. Choose Full access, or remove the
        &quot;root&quot; field from orkestrator-ai.json.
      </span>
    </p>
  );
}

/**
 * Shown under the network choice for a project whose default branch declares
 * Debian packages (`aptPackages`): which ones setup installs and, under
 * Restricted, that Debian's archive becomes reachable; or that setup will stop
 * on a list the installer refuses.
 */
function AptPackagesNote({
  aptPackages,
  networkAccessMode,
}: {
  aptPackages: DeclaredAptPackages | null;
  networkAccessMode: "restricted" | "full";
}) {
  const notice = aptPackagesNotice(aptPackages, networkAccessMode);
  if (!notice) return null;
  const warning = notice.tone === "warning";
  const Icon = warning ? TriangleAlert : Package;
  return (
    <p
      role="status"
      className={cn(
        "mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] leading-snug",
        warning
          ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
          : "border-zinc-700 bg-zinc-900/60 text-zinc-400",
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{notice.text}</span>
    </p>
  );
}

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
  /** The ticket's own delivery policy, which "When verified" opens on. */
  deliveryPolicy?: DeliveryPolicy;
  /** Disables the submit button while a start request is in flight. */
  busy?: boolean;
  /**
   * The machines this build can run on: this tab's own (marked `current`) and
   * every other one holding a project for the same repository. The choice is
   * shown only when there is more than one.
   */
  machines?: BuildLaunchMachine[];
  /** Whether this project has a host checkout that can own local worktrees. */
  localEnvironmentAvailable?: boolean;
  /**
   * Root setup steps on the project's default branch (`useBuildLaunchOptions`);
   * they run only with full network access, so Restricted shows a warning.
   * `null` or absent when unknown: no warning.
   */
  rootSetupSteps?: number | null;
  /**
   * Debian packages the project's default branch declares
   * (`useBuildLaunchOptions`); `null` or absent when unknown: no note.
   */
  aptPackages?: DeclaredAptPackages | null;
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
  return Boolean(resolveCatalogModelId(agent, modelsForAgent(catalog, agent), modelId));
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
  const resolvedId = resolveCatalogModelId(agent, options, modelId);
  return options.find((option) => option.id === resolvedId);
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

export function resolveStepState(state: StepState, catalog: AgentModelCatalog): ResolvedStep {
  const matched = matchCatalogModel(catalog, state.agent, state.model);
  // An explicit configured id that the catalogue has not listed yet must not
  // collapse onto the first (often placeholder) entry.
  const model =
    matched ??
    (state.model && state.model !== "default"
      ? undefined
      : sessionDefaultModel(modelsForAgent(catalog, state.agent)));
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

/**
 * Each reviewer's starting focus: the saved lens of its Multi Review position
 * (`pipelineDefaults.reviewers`), or the review step's for a single reviewer.
 */
function initialLenses(
  pipelineDefaults: BuildPipelineConfiguredDefaults | undefined,
): Array<ReviewLens | undefined> {
  const configured = pipelineDefaults?.reviewers?.length
    ? pipelineDefaults.reviewers
    : [pipelineDefaults?.steps.review];
  return configured.map((reviewer) => (reviewer?.lens ? { ...reviewer.lens } : undefined));
}

/** Instructions are keyed by card: a step key, `reviewer:N` or `reviewPreparation`. */
type InstructionsKey = Exclude<BuildStepKey, "review"> | `reviewer:${number}` | "reviewPreparation";

/** Trimmed instructions for a submitted selection, or nothing when blank. */
function instructionsField(value: string | undefined): { instructions?: string } {
  const instructions = value?.trim();
  return instructions ? { instructions } : {};
}

function BuildStepCard({
  number,
  stepKey,
  pickerId,
  title,
  description,
  icon,
  instructions,
  instructionsHint,
  onInstructionsChange,
  lens,
  children,
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
  instructions: string;
  instructionsHint?: string;
  onInstructionsChange: (value: string) => void;
  /** A reviewer card's Focus field. */
  lens?: {
    value: ReviewLens | undefined;
    presets: readonly ReviewLensPreset[];
    onChange: (value: ReviewLens | undefined) => void;
  };
  /** A card's own extra field, above its instructions. */
  children?: React.ReactNode;
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

      {lens && (
        <ReviewLensField
          id={`${controlId.replace(/-model$/, "")}-focus`}
          reviewerLabel={title}
          value={lens.value}
          presets={lens.presets}
          onChange={lens.onChange}
        />
      )}

      {stepKey === "review" && (
        <p className="mt-2 text-[11px] leading-snug text-zinc-500" role="note">
          Reviewers run read-only where the provider enforces it. If HEAD moves or a Git-visible
          path appears during the review, the review is marked stale and carries on. Ignored files,
          .git contents, paths outside the worktree and edits to files that were already uncommitted
          are not checked.
        </p>
      )}
      {stepKey === "verify" && (
        <p className="mt-2 text-[11px] leading-snug text-zinc-500" role="note">
          Full workspace write access. The backend rejects a result if HEAD moved or a Git-visible
          path appeared or disappeared during the step. Ignored files, .git contents, paths outside
          the worktree and edits to files that were already uncommitted are not checked.
        </p>
      )}

      {children}

      <BuildStepInstructionsField
        id={`${controlId.replace(/-model$/, "")}-instructions`}
        stepTitle={title}
        value={instructions}
        hint={instructionsHint}
        onChange={onInstructionsChange}
      />
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
  deliveryPolicy,
  busy = false,
  machines,
  localEnvironmentAvailable: ownLocalEnvironmentAvailable = true,
  rootSetupSteps = null,
  aptPackages = null,
  returnFocusRef,
  onConfirm,
}: BuildLaunchDialogProps) {
  const { favorites, enabledPlatforms, toggleFavorite, reorderFavorites } =
    useAgentModelFavorites();
  const ownDockerAvailable = useDockerAvailability();
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
  const [pickedMachineKey, setPickedMachineKey] = useState<string | null>(null);
  // A pick that left the offered machines or went offline falls back to this
  // tab's own machine (`pickedLaunchMachine`).
  const pickedMachine = pickedLaunchMachine(machines, pickedMachineKey);
  const machineKey = pickedMachine?.key ?? null;
  const machineChoice = machineChoiceFor(machines, machineKey);
  // Docker and the local checkout belong to the machine the build runs on.
  const remoteDocker = useMachineDockerAvailability(machineChoice?.machine, Boolean(machineChoice));
  // Until the other machine answers, Container is neither offered nor
  // switched away from: the answer is unknown, not "no".
  const dockerChecking = Boolean(machineChoice) && remoteDocker === null;
  const dockerAvailable = machineChoice ? remoteDocker === true : ownDockerAvailable;
  // A matching repository does not imply a checkout: the other machine's
  // project may be remote-only.
  const localEnvironmentAvailable = machineChoice
    ? pickedMachine?.hasCheckout === true
    : ownLocalEnvironmentAvailable;
  const [environmentType, setEnvironmentType] = useState(defaultEnvironmentType);
  // Pipelines have always created restricted containers; the launcher now
  // shows that choice instead of making it silently.
  const [networkAccessMode, setNetworkAccessMode] = useState<NetworkAccessMode>("restricted");
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
  const [deliveryChoice, setDeliveryChoice] = useState(() =>
    effectiveDeliveryPolicy(deliveryPolicy),
  );
  // Per launch: instructions are never saved as defaults, so every open starts empty.
  const [instructions, setInstructions] = useState<Partial<Record<InstructionsKey, string>>>({});
  // Each reviewer opens on its position's saved focus; edits are per launch.
  const lensPresets = useReviewLensPresets();
  const [lenses, setLenses] = useState(() => initialLenses(pipelineDefaults));
  const wasOpenRef = useRef(false);
  const touchedRef = useRef(new Set<string>());
  const environmentGroupId = useId();
  const networkGroupId = useId();
  const commentContextId = useId();
  const machineGroupId = useId();

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
      setPickedMachineKey(null);
      setEnvironmentType(() => {
        if (defaultEnvironmentType === "containerized" && !dockerAvailable) {
          return localEnvironmentAvailable ? "local" : "containerized";
        }
        if (defaultEnvironmentType === "local" && !localEnvironmentAvailable) {
          return dockerAvailable ? "containerized" : "local";
        }
        return defaultEnvironmentType;
      });
      setNetworkAccessMode("restricted");
      setIncludeComments(commentContext?.defaultIncluded ?? true);
      setDeliveryChoice(effectiveDeliveryPolicy(deliveryPolicy));
      setInstructions({});
      setLenses(initialLenses(pipelineDefaults));
      resetLaunchState();
      return;
    }
    if (!open) return;
    if (!touchedRef.current.has("deliveryPolicy")) {
      setDeliveryChoice(effectiveDeliveryPolicy(deliveryPolicy));
    }
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
    deliveryPolicy,
    dockerAvailable,
    localEnvironmentAvailable,
    open,
    preferredModels,
    preferredReasoningEfforts,
    preferredFastModes,
    pipelineDefaults,
    resetLaunchState,
  ]);

  // Switch to the only available environment type. Converges in one pass.
  // A pending Docker check on another machine is not a reason to switch.
  if (
    !dockerAvailable &&
    !dockerChecking &&
    localEnvironmentAvailable &&
    environmentType === "containerized"
  ) {
    setEnvironmentType("local");
  } else if (!localEnvironmentAvailable && dockerAvailable && environmentType === "local") {
    setEnvironmentType("containerized");
  }

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

  const updateInstructions = (key: InstructionsKey, value: string) =>
    setInstructions((current) => ({ ...current, [key]: value }));
  const instructionsKeyFor = (key: BuildStepKey): InstructionsKey =>
    key === "review" ? "reviewer:0" : key;
  const instructionsTooLong = Object.values(instructions).some(
    (value) => value !== undefined && buildStepInstructionsTooLong(value),
  );
  const visibleLenses = lenses.slice(0, Math.max(1, reviewers.length));
  const lensError = visibleLenses.some((lens) => reviewLensDraftError(lens) !== null);
  const updateLens = (index: number, value: ReviewLens | undefined) =>
    setLenses((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });

  const commentContextLabel = commentContext
    ? `Include ${commentContext.count} comment${commentContext.count === 1 ? "" : "s"} in build context`
    : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        size="2xl"
        className="flex max-h-[min(46rem,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:p-0"
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
            Choose the workspace, then assign a model to every stage of the pipeline. Any stage can
            also take your own instructions, and each reviewer a focus.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || instructionsTooLong || lensError) return;
            // Covers a pending check too: `dockerAvailable` is false until the
            // picked machine says Docker runs there.
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
                    ...instructionsField(instructions[instructionsKeyFor(key)]),
                    ...(key === "review" ? launchedReviewLens(lenses[0]) : {}),
                  },
                ];
              }),
            ) as Record<BuildStepKey, BuildLaunchStepSelection>;
            const submittedReviewers =
              reviewers.length > 1
                ? reviewers.map((reviewer, index) =>
                    index === 0
                      ? selectedSteps.review
                      : {
                          ...cleanStep(reviewer, catalog),
                          ...instructionsField(instructions[`reviewer:${index}`]),
                          ...launchedReviewLens(lenses[index]),
                        },
                  )
                : undefined;
            const submittedPreparation =
              reviewers.length > 1 && reviewPreparation
                ? {
                    ...cleanStep(reviewPreparation, catalog),
                    ...instructionsField(instructions.reviewPreparation),
                  }
                : undefined;
            onConfirm({
              environmentType,
              ...(machineChoice ? { machine: machineChoice } : {}),
              ...(environmentType === "containerized" ? { networkAccessMode } : {}),
              ...(commentContext ? { includeComments } : {}),
              deliveryPolicy: deliveryChoice,
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
              {machines && machines.length > 1 && (
                <div className="mb-5" data-build-machines>
                  <div className="mb-3">
                    <h3 className="text-sm font-semibold text-zinc-200">Machine</h3>
                    <p className="text-xs text-zinc-500">
                      The pipeline environment is created and runs on this machine, in its own copy
                      of the project.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Machine">
                    {machines.map((option) => {
                      const selected = machineKey === option.key;
                      const disabled = !option.available;
                      const id = `${machineGroupId}-${option.key}`;
                      return (
                        <div key={option.key} className="relative min-w-0">
                          <input
                            id={id}
                            type="radio"
                            name={`${machineGroupId}-machine`}
                            checked={selected}
                            disabled={disabled}
                            onChange={() => setPickedMachineKey(option.key)}
                            className="peer sr-only"
                          />
                          <label
                            htmlFor={id}
                            className={cn(
                              "flex min-h-16 cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors focus-hairline-peer",
                              disabled && "cursor-not-allowed opacity-50",
                              selected
                                ? "border-cyan-400/55 bg-cyan-500/10 text-zinc-100"
                                : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700",
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                              <Monitor className="size-4 shrink-0" />
                              <span className="truncate">{option.name}</span>
                            </span>
                            <span className="mt-1 text-[11px] leading-snug text-zinc-500">
                              {disabled
                                ? "Not connected"
                                : option.current
                                  ? "This machine"
                                  : "Runs there; follow it from that machine"}
                            </span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="mb-3">
                <h3 className="text-sm font-semibold text-zinc-200">Where it runs</h3>
                <p className="text-xs text-zinc-500">
                  Every stage runs in one pipeline environment, in a container or locally.
                </p>
              </div>
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="radiogroup"
                aria-label="Where it runs"
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
                          "flex min-h-16 cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors focus-hairline-peer",
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
                              ? dockerChecking
                                ? `Checking Docker on ${machineChoice?.name ?? "that machine"}…`
                                : "Containers unavailable while Docker stopped"
                              : machineChoice
                                ? `No project checkout on ${machineChoice.name}`
                                : "Unavailable without a local project checkout"
                            : option.value === "local" && machineChoice
                              ? `Git worktree on ${machineChoice.name}, full network`
                              : option.description}
                        </span>
                      </label>
                    </div>
                  );
                })}
              </div>

              {environmentType === "containerized" && (
                <div className="mt-4">
                  <h4 id={`${networkGroupId}-label`} className="text-xs font-medium text-zinc-300">
                    Network access
                  </h4>
                  <div
                    className="mt-2 grid gap-2 sm:grid-cols-2"
                    role="radiogroup"
                    aria-labelledby={`${networkGroupId}-label`}
                  >
                    {NETWORK_OPTIONS.map((option) => {
                      const selected = networkAccessMode === option.value;
                      const id = `${networkGroupId}-${option.value}`;
                      return (
                        <div key={option.value} className="relative min-w-0">
                          <input
                            id={id}
                            type="radio"
                            name={`${networkGroupId}-network`}
                            checked={selected}
                            onChange={() => setNetworkAccessMode(option.value)}
                            className="peer sr-only"
                          />
                          <label
                            htmlFor={id}
                            className={cn(
                              "flex min-h-16 cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors focus-hairline-peer",
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
                              {option.description}
                            </span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  {networkAccessMode === "restricted" && (rootSetupSteps ?? 0) > 0 && (
                    <RootStepsNetworkWarning steps={rootSetupSteps ?? 0} />
                  )}
                  <AptPackagesNote
                    aptPackages={aptPackages}
                    networkAccessMode={networkAccessMode}
                  />
                </div>
              )}

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
                          instructions={instructions.reviewPreparation ?? ""}
                          onInstructionsChange={(value) =>
                            updateInstructions("reviewPreparation", value)
                          }
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
                          instructions={instructions[`reviewer:${card.index}`] ?? ""}
                          onInstructionsChange={(value) =>
                            updateInstructions(`reviewer:${card.index}`, value)
                          }
                          lens={{
                            value: lenses[card.index],
                            presets: lensPresets,
                            onChange: (value) => updateLens(card.index, value),
                          }}
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
                        description={
                          card.key === "pr"
                            ? DELIVERY_STEP_DESCRIPTIONS[deliveryChoice]
                            : card.description
                        }
                        icon={card.icon}
                        instructions={instructions[card.key] ?? ""}
                        instructionsHint={
                          card.key === "build" ? "Rework uses them too." : undefined
                        }
                        onInstructionsChange={(value) => updateInstructions(card.key, value)}
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
                      >
                        {card.key === "pr" ? (
                          <DeliveryPolicySelect
                            className="mt-2"
                            value={deliveryChoice}
                            offeredFor={deliveryPolicy}
                            onChange={(next) => {
                              touchedRef.current.add("deliveryPolicy");
                              setDeliveryChoice(next);
                            }}
                          />
                        ) : null}
                      </BuildStepCard>
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
                instructionsTooLong ||
                lensError ||
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
