import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BuildStepKey } from "@orkestrator/protocol/build-pipeline";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentRadioGroup } from "@/components/agents/AgentRadioGroup";
import { OpenCodeModelSelect } from "@/components/opencode/OpenCodeModelSelect";
import {
  defaultEffortFor,
  effortLabel,
  firstModelFor,
  type AgentModelCatalog,
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
    description: "Implements the ticket. Also runs the fix stage.",
    icon: <Hammer className="size-4" />,
  },
  {
    key: "review",
    title: "Review",
    description: "Reviews the diff and identifies issues and coverage gaps.",
    icon: <ScanSearch className="size-4" />,
  },
  {
    key: "address",
    title: "Address issues",
    description: "Continues from the review context and fixes its findings.",
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
    title: "PR",
    description: "Pushes the branch and opens the pull request.",
    icon: <GitPullRequest className="size-4" />,
  },
  {
    key: "resolve-conflicts",
    title: "Conflicts",
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
function validationWorkspaceNotice(uniform: boolean): string {
  const stages = uniform ? "Review and verify" : "This step";
  return `${stages} will run with full workspace access so validation can write generated outputs and caches. Source edits and commits are forbidden: the backend rejects the result if the commit or any Git-tracked or untracked path changed. Ignored files are not checked.`;
}

function Step({
  number,
  icon,
  children,
  last = false,
}: {
  number: number;
  icon: React.ReactNode;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2rem_minmax(0,1fr)]">
      <div className="hidden flex-col items-center sm:flex" aria-hidden="true">
        <div className="relative grid size-8 shrink-0 place-items-center rounded-full border border-cyan-400/35 bg-cyan-500/10 text-cyan-300">
          {icon}
          <span className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-zinc-800 text-[9px] font-semibold text-zinc-300 ring-1 ring-zinc-600">
            {number}
          </span>
        </div>
        {!last && <div className="my-1 h-full min-h-5 w-px bg-gradient-to-b from-cyan-400/35 to-zinc-700/20" />}
      </div>
      <div className={cn("min-w-0", !last && "pb-4")}>{children}</div>
    </div>
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
  favoriteOpenCodeModelIds?: string[];
  /** Offers source-ticket comments as optional build context. */
  commentContext?: BuildLaunchCommentContextOption;
  /** Disables the submit button while a start request is in flight. */
  busy?: boolean;
  onConfirm: (selection: BuildLaunchSelection) => void;
}

type StepState = { agent: LaunchAgent; model: string; reasoningEffort: string };

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
    reasoningEffort: defaultEffortFor(
      agent,
      model,
      catalog,
      preferredReasoningEfforts,
    ),
  };
}

/** Every step set to the same state, which is what {@link uniform} means. */
function everyStep(state: StepState): Record<BuildStepKey, StepState> {
  return Object.fromEntries(
    BUILD_STEPS.map(({ key }) => [key, { ...state }]),
  ) as Record<BuildStepKey, StepState>;
}

function initialSteps(
  agent: LaunchAgent,
  catalog: AgentModelCatalog,
  preferredModels: BuildLaunchDialogProps["preferredModels"],
  preferredReasoningEfforts: BuildLaunchDialogProps["preferredReasoningEfforts"],
): Record<BuildStepKey, StepState> {
  return everyStep(initialStepState(
    agent,
    catalog,
    preferredModels,
    preferredReasoningEfforts,
  ));
}

/**
 * Configures a build before it starts.
 *
 * Each pipeline step picks its own harness, model and reasoning effort, because
 * a cheap model is often the right one to write code with and the wrong one to
 * review it. The environment type is asked once: it belongs to the workspace the
 * whole pipeline shares, not to any single step.
 */
export function BuildLaunchDialog({
  open,
  onOpenChange,
  catalog,
  defaultAgent,
  defaultEnvironmentType,
  preferredModels,
  preferredReasoningEfforts,
  favoriteOpenCodeModelIds = [],
  commentContext,
  busy = false,
  onConfirm,
}: BuildLaunchDialogProps) {
  const [environmentType, setEnvironmentType] = useState(defaultEnvironmentType);
  const [steps, setSteps] = useState(() =>
    initialSteps(defaultAgent, catalog, preferredModels, preferredReasoningEfforts));
  // On by default: one configuration for the whole pipeline is the common case,
  // and it keeps five extra step sections out of the way until they are wanted.
  const [uniform, setUniform] = useState(true);
  const [includeComments, setIncludeComments] = useState(
    commentContext?.defaultIncluded ?? true,
  );
  const wasOpenRef = useRef(false);
  const environmentGroupId = useId();
  const commentContextId = useId();

  // Reset on the closed→open transition only, so a catalog that arrives while
  // the dialog is open cannot discard a selection the user has already made.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setEnvironmentType(defaultEnvironmentType);
    setUniform(true);
    setIncludeComments(commentContext?.defaultIncluded ?? true);
    setSteps(initialSteps(
      defaultAgent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
    ));
  }, [
    catalog,
    commentContext?.defaultIncluded,
    defaultAgent,
    defaultEnvironmentType,
    open,
    preferredModels,
    preferredReasoningEfforts,
  ]);

  const resolved = useMemo(() => {
    const entries = BUILD_STEPS.map(({ key }) => {
      const step = steps[key];
      const models = catalog[step.agent];
      const model = models.find((option) => option.id === step.model) ?? models[0];
      const efforts = model?.reasoningEfforts ?? [];
      const effort =
        efforts.length > 0
        && (step.reasoningEffort === "default"
          || efforts.includes(step.reasoningEffort))
          ? step.reasoningEffort
          : "default";
      return [
        key,
        { models, model, efforts, effort },
      ] as const;
    });
    return Object.fromEntries(entries) as Record<
      BuildStepKey,
      {
        models: AgentModelCatalog[LaunchAgent];
        model: AgentModelCatalog[LaunchAgent][number] | undefined;
        efforts: string[];
        effort: string;
      }
    >;
  }, [catalog, steps, uniform]);

  // While uniform, every step is edited together, so the submitted payload needs
  // no special case and unticking leaves the steps where the shared value was.
  const updateStep = (key: BuildStepKey, next: Partial<StepState>) => {
    setSteps((current) => (uniform
      ? everyStep({ ...current[key], ...next })
      : { ...current, [key]: { ...current[key], ...next } }));
  };

  const handleUniformChange = (next: boolean) => {
    setUniform(next);
    if (next) setSteps((current) => everyStep(current.build));
  };

  const handleAgentChange = (key: BuildStepKey, agent: LaunchAgent) => {
    updateStep(key, initialStepState(
      agent,
      catalog,
      preferredModels,
      preferredReasoningEfforts,
    ));
  };

  const handleModelChange = (key: BuildStepKey, model: string) => {
    updateStep(key, {
      model,
      reasoningEffort: defaultEffortFor(
        steps[key].agent,
        model,
        catalog,
        preferredReasoningEfforts,
      ),
    });
  };

  const visibleSteps = uniform ? BUILD_STEPS.slice(0, 1) : BUILD_STEPS;

  const summary = visibleSteps.map(({ key, title }) => {
    const step = resolved[key];
    const effort = step.effort === "default"
      ? "default effort"
      : `${step.effort} effort`;
    const label = uniform ? "All steps" : title;
    return `${label}: ${step.model?.name ?? steps[key].model} · ${effort}`;
  });
  const commentContextLabel = commentContext
    ? `Include ${commentContext.count} comment${commentContext.count === 1 ? "" : "s"} in build context`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(calc(100%-1rem),38rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[38rem]">
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-cyan-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
              <Hammer className="size-4" />
            </span>
            Configure build
          </DialogTitle>
          <DialogDescription>
            Pick where the build runs, then the agent, model and reasoning effort
            for each pipeline step.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm({
              environmentType,
              ...(commentContext ? { includeComments } : {}),
              steps: Object.fromEntries(BUILD_STEPS.map(({ key }) => [key, {
                agent: steps[key].agent,
                model: resolved[key].model?.id ?? steps[key].model,
                reasoningEffort: resolved[key].effort === "default"
                  ? undefined
                  : resolved[key].effort,
              }])) as Record<BuildStepKey, BuildLaunchStepSelection>,
            });
          }}
        >
          <div
            role="region"
            aria-label="Build configuration"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
          >
            <Step number={1} icon={<Container className="size-4" />}>
              <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Environment
              </Label>
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="radiogroup"
                aria-label="Build environment"
              >
                {ENVIRONMENT_OPTIONS.map((option) => {
                  const selected = environmentType === option.value;
                  const id = `${environmentGroupId}-${option.value}`;
                  return (
                    <div key={option.value} className="relative min-w-0">
                      <input
                        id={id}
                        type="radio"
                        name={`${environmentGroupId}-environment`}
                        checked={selected}
                        onChange={() => setEnvironmentType(option.value)}
                        className="peer sr-only"
                      />
                      <label
                        htmlFor={id}
                        className={cn(
                          "flex min-h-16 cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/70",
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
            </Step>

            {commentContext && (
              <div className="mb-4 rounded-lg border border-cyan-400/20 bg-cyan-500/[0.06] px-3 py-2.5 sm:ml-[2.75rem]">
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id={commentContextId}
                    checked={includeComments}
                    onCheckedChange={(checked) => setIncludeComments(checked === true)}
                    aria-label={commentContextLabel}
                    className="mt-0.5"
                  />
                  <Label htmlFor={commentContextId} className="flex cursor-pointer items-start gap-2.5">
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

            <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 sm:ml-[2.75rem]">
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id="build-uniform-steps"
                  checked={uniform}
                  onCheckedChange={(checked) => handleUniformChange(checked === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="build-uniform-steps" className="block cursor-pointer">
                  <span className="block text-sm font-medium text-zinc-200">
                    Use one configuration for every step
                  </span>
                  <span className="mt-0.5 block text-[11px] font-normal leading-snug text-zinc-500">
                    Untick to give build, review, address issues, verify, PR and
                    conflict resolution their own agent, model and reasoning.
                  </span>
                </Label>
              </div>
            </div>

            {visibleSteps.map(({ key, title, description, icon }, index) => {
              const step = resolved[key];
              const effortAvailable = step.efforts.length > 0;
              const stepLabel = uniform ? "All steps" : title;
              return (
                <Step
                  key={key}
                  number={index + 2}
                  icon={icon}
                  last={index === visibleSteps.length - 1}
                >
                  <div className="mb-2">
                    <Label className="block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                      {uniform ? "All steps" : `${title} step`}
                    </Label>
                    <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
                      {uniform
                        ? "Build, review, address issues, verify, PR and conflict resolution all run this way."
                        : description}
                    </p>
                  </div>
                  <AgentRadioGroup
                    value={steps[key].agent}
                    onChange={(agent) => handleAgentChange(key, agent)}
                    label={`${stepLabel} agent`}
                  />
                  {(uniform || key === "review" || key === "verify") && (
                    <p
                      className="mt-2 text-[11px] leading-snug text-amber-400/80"
                      role="note"
                    >
                      {validationWorkspaceNotice(uniform)}
                    </p>
                  )}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="min-w-0">
                      <Label
                        htmlFor={`build-${key}-model`}
                        className="mb-1.5 block text-[11px] text-zinc-500"
                      >
                        {stepLabel} model
                      </Label>
                      {steps[key].agent === "opencode" ? (
                        <OpenCodeModelSelect
                          id={`build-${key}-model`}
                          value={step.model?.id ?? steps[key].model}
                          options={step.models}
                          favoriteModelIds={favoriteOpenCodeModelIds}
                          onValueChange={(model) => handleModelChange(key, model)}
                          className="min-h-11 border-zinc-700/80 bg-zinc-900 py-2.5"
                          showDescriptionInTrigger
                          emptyLabel="No OpenCode models cached"
                        />
                      ) : (
                        <Select
                          value={step.model?.id ?? steps[key].model}
                          onValueChange={(model) => handleModelChange(key, model)}
                        >
                          <SelectTrigger
                            id={`build-${key}-model`}
                            className="min-h-11 w-full border-zinc-700/80 bg-zinc-900 py-2.5 data-[size=default]:h-auto"
                          >
                            <span className="flex min-w-0 flex-1 flex-col text-left">
                              <span className="truncate text-sm">
                                {step.model?.name ?? "Choose a model"}
                              </span>
                              {step.model?.description && (
                                <span className="truncate text-[11px] font-normal text-zinc-500">
                                  {step.model.description}
                                </span>
                              )}
                            </span>
                          </SelectTrigger>
                          <SelectContent position="popper" className="max-h-72">
                            {step.models.map((option) => (
                              <SelectItem key={option.id} value={option.id} className="py-2">
                                <span>
                                  <span className="block">{option.name}</span>
                                  {option.description && (
                                    <span className="block max-w-[28rem] truncate text-[11px] text-zinc-500">
                                      {option.description}
                                    </span>
                                  )}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <div className="min-w-0">
                      <Label
                        htmlFor={`build-${key}-effort`}
                        className="mb-1.5 block text-[11px] text-zinc-500"
                      >
                        {stepLabel} reasoning effort
                      </Label>
                      <Select
                        value={step.effort}
                        onValueChange={(effort) =>
                          updateStep(key, { reasoningEffort: effort })}
                        disabled={!effortAvailable}
                      >
                        <SelectTrigger
                          id={`build-${key}-effort`}
                          className="h-11 w-full border-zinc-700/80 bg-zinc-900"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default</SelectItem>
                          {step.efforts.map((effort) => (
                            <SelectItem key={effort} value={effort}>
                              {effortLabel(effort)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!effortAvailable && (
                        <p className="mt-1.5 text-[11px] text-zinc-500">
                          This model uses its default reasoning setting.
                        </p>
                      )}
                    </div>
                  </div>
                </Step>
              );
            })}

            <div className="mt-5 space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <p>
                <span className="text-zinc-500">Environment:</span>{" "}
                {environmentType === "local" ? "Local worktree" : "Container"}
              </p>
              {summary.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>

          <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Start build
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
