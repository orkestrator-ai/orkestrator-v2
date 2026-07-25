import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bot, BrainCircuit, TerminalSquare } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import { cn } from "@/lib/utils";

export type ReviewTabType =
  | "claude-cli"
  | "claude-native"
  | "claude-tmux"
  | "codex-cli"
  | "codex-native"
  | "opencode-cli"
  | "opencode-native";

export type ReviewAgent = "claude" | "codex" | "opencode";
type ReviewMode = "cli" | "native" | "tmux";

export interface ReviewModelOption {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts: string[];
}

export type ReviewModelCatalog = Record<ReviewAgent, ReviewModelOption[]>;

export interface ReviewLaunchSelection {
  tabType: ReviewTabType;
  model: string;
  reasoningEffort?: string;
}

interface ReviewTabOption {
  value: ReviewTabType;
  label: string;
  description: string;
  agent: ReviewAgent;
  mode: ReviewMode;
}

export const REVIEW_TAB_OPTIONS: ReviewTabOption[] = [
  { value: "claude-cli", label: "Claude CLI", description: "Terminal interface", agent: "claude", mode: "cli" },
  { value: "claude-native", label: "Claude Native", description: "SDK chat interface", agent: "claude", mode: "native" },
  { value: "claude-tmux", label: "Claude Tmux", description: "Native UI over Claude CLI", agent: "claude", mode: "tmux" },
  { value: "codex-cli", label: "Codex CLI", description: "Terminal interface", agent: "codex", mode: "cli" },
  { value: "codex-native", label: "Codex Native", description: "Bridge chat interface", agent: "codex", mode: "native" },
  { value: "opencode-cli", label: "OpenCode CLI", description: "Terminal interface", agent: "opencode", mode: "cli" },
  { value: "opencode-native", label: "OpenCode Native", description: "SDK chat interface", agent: "opencode", mode: "native" },
];

const REVIEW_AGENT_OPTIONS: Array<{ value: ReviewAgent; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];

const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  cli: "CLI",
  native: "Native",
  tmux: "Tmux",
};

export function getReviewAgent(tabType: ReviewTabType): ReviewAgent {
  return REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.agent ?? "claude";
}

function AgentIcon({ agent, className }: { agent: ReviewAgent; className?: string }) {
  if (agent === "claude") return <ClaudeIcon className={className} />;
  if (agent === "codex") return <CodexIcon className={className} />;
  return <OpenCodeIcon className={className} />;
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
        <div className="relative grid size-8 place-items-center rounded-full border border-blue-400/35 bg-blue-500/10 text-blue-300">
          {icon}
          <span className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-zinc-800 text-[9px] font-semibold text-zinc-300 ring-1 ring-zinc-600">
            {number}
          </span>
        </div>
        {!last && <div className="my-1 h-full min-h-5 w-px bg-gradient-to-b from-blue-400/35 to-zinc-700/20" />}
      </div>
      <div className={cn("min-w-0", !last && "pb-4")}>{children}</div>
    </div>
  );
}

interface ReviewLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTabType: ReviewTabType;
  catalog: ReviewModelCatalog;
  preferredModels?: Partial<Record<ReviewAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<ReviewAgent, string>>;
  onConfirm: (selection: ReviewLaunchSelection) => void;
}

function firstModelFor(
  tabType: ReviewTabType,
  catalog: ReviewModelCatalog,
  preferredModels: ReviewLaunchDialogProps["preferredModels"],
): string {
  const agent = getReviewAgent(tabType);
  const models = catalog[agent];
  const preferred = preferredModels?.[agent];
  return models.some((model) => model.id === preferred) ? preferred! : (models[0]?.id ?? "default");
}

function defaultEffortFor(
  tabType: ReviewTabType,
  modelId: string,
  catalog: ReviewModelCatalog,
  preferredEfforts: ReviewLaunchDialogProps["preferredReasoningEfforts"],
): string {
  const agent = getReviewAgent(tabType);
  const options = catalog[agent].find((model) => model.id === modelId)?.reasoningEfforts ?? [];
  const preferred = preferredEfforts?.[agent];
  return preferred && options.includes(preferred) ? preferred : "default";
}

function handleRadioNavigation<T extends string>(
  event: React.KeyboardEvent<HTMLInputElement>,
  values: readonly T[],
  currentValue: T,
  onValueChange: (value: T) => void,
  radioRefs: Map<T, HTMLInputElement>,
) {
  const currentIndex = Math.max(values.indexOf(currentValue), 0);
  let nextIndex: number;

  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      nextIndex = (currentIndex + 1) % values.length;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      nextIndex = (currentIndex - 1 + values.length) % values.length;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = values.length - 1;
      break;
    default:
      return;
  }

  const nextValue = values[nextIndex];
  if (!nextValue) return;

  event.preventDefault();
  onValueChange(nextValue);
  radioRefs.get(nextValue)?.focus();
}

export function ReviewLaunchDialog({
  open,
  onOpenChange,
  defaultTabType,
  catalog,
  preferredModels,
  preferredReasoningEfforts,
  onConfirm,
}: ReviewLaunchDialogProps) {
  const initialModel = firstModelFor(defaultTabType, catalog, preferredModels);
  const [tabType, setTabType] = useState<ReviewTabType>(defaultTabType);
  const [model, setModel] = useState(initialModel);
  const [reasoningEffort, setReasoningEffort] = useState(() =>
    defaultEffortFor(defaultTabType, initialModel, catalog, preferredReasoningEfforts),
  );
  const wasOpenRef = useRef(false);
  const radioGroupId = useId();
  const providerRadioRefs = useRef(new Map<ReviewAgent, HTMLInputElement>());
  const modeRadioRefs = useRef(new Map<ReviewTabType, HTMLInputElement>());

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;

    if (justOpened) {
      const nextModel = firstModelFor(defaultTabType, catalog, preferredModels);
      setTabType(defaultTabType);
      setModel(nextModel);
      setReasoningEffort(
        defaultEffortFor(defaultTabType, nextModel, catalog, preferredReasoningEfforts),
      );
      return;
    }

    const currentModels = catalog[getReviewAgent(tabType)];
    const currentModelExists = currentModels.some((option) => option.id === model);
    const nextModel = currentModelExists
      ? model
      : firstModelFor(tabType, catalog, preferredModels);
    const nextEffortOptions =
      currentModels.find((option) => option.id === nextModel)?.reasoningEfforts ?? [];
    const currentEffortIsValid =
      currentModelExists
      && (reasoningEffort === "default" || nextEffortOptions.includes(reasoningEffort));
    const nextEffort = currentEffortIsValid
      ? reasoningEffort
      : defaultEffortFor(tabType, nextModel, catalog, preferredReasoningEfforts);

    if (nextModel !== model) setModel(nextModel);
    if (nextEffort !== reasoningEffort) setReasoningEffort(nextEffort);
  }, [
    catalog,
    defaultTabType,
    model,
    open,
    preferredModels,
    preferredReasoningEfforts,
    reasoningEffort,
    tabType,
  ]);

  const agent = getReviewAgent(tabType);
  const agentLabel = REVIEW_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent;
  const availableModes = REVIEW_TAB_OPTIONS.filter((option) => option.agent === agent);
  const models = catalog[agent];
  const selectedModel = models.find((option) => option.id === model) ?? models[0];
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const effortAvailable = reasoningEfforts.length > 0 && tabType !== "opencode-cli";
  const effectiveReasoningEffort =
    effortAvailable
    && (reasoningEffort === "default" || reasoningEfforts.includes(reasoningEffort))
      ? reasoningEffort
      : "default";

  const summary = useMemo(() => {
    const tabLabel = REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.label ?? tabType;
    const effortLabel = effectiveReasoningEffort === "default"
      ? "default effort"
      : `${effectiveReasoningEffort} effort`;
    return `${tabLabel} · ${selectedModel?.name ?? model} · ${effortAvailable ? effortLabel : "default effort"}`;
  }, [effectiveReasoningEffort, effortAvailable, model, selectedModel?.name, tabType]);

  const handleAgentChange = (nextAgent: ReviewAgent) => {
    const currentMode = REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.mode;
    const nextTabType = (
      REVIEW_TAB_OPTIONS.find(
        (option) => option.agent === nextAgent && option.mode === currentMode,
      )
      ?? REVIEW_TAB_OPTIONS.find((option) => option.agent === nextAgent)
    )?.value;
    if (!nextTabType) return;

    const nextModel = firstModelFor(nextTabType, catalog, preferredModels);
    setTabType(nextTabType);
    setModel(nextModel);
    setReasoningEffort(
      defaultEffortFor(nextTabType, nextModel, catalog, preferredReasoningEfforts),
    );
  };

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    setReasoningEffort(
      defaultEffortFor(tabType, nextModel, catalog, preferredReasoningEfforts),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(calc(100%-1rem),38rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[38rem]">
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-blue-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 place-items-center rounded-lg border border-blue-400/25 bg-blue-500/10 text-blue-300">
              <BrainCircuit className="size-4" />
            </span>
            Configure code review
          </DialogTitle>
          <DialogDescription>
            Choose how this one review runs. Your normal agent defaults will not be changed.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm({
              tabType,
              model: selectedModel?.id ?? model,
              reasoningEffort:
                effectiveReasoningEffort !== "default"
                  ? effectiveReasoningEffort
                  : undefined,
            });
          }}
        >
          <div
            role="region"
            aria-label="Review configuration"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
          >
            <Step number={1} icon={<TerminalSquare className="size-3.5" />}>
              <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Provider and mode
              </Label>
              <div
                role="group"
                aria-label="Provider and mode"
                className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-2"
              >
                <div className="min-w-0">
                  <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                    Provider
                  </p>
                  <div className="grid gap-1.5" role="radiogroup" aria-label="Review provider">
                    {REVIEW_AGENT_OPTIONS.map((option) => {
                      const selected = agent === option.value;
                      const inputId = `${radioGroupId}-provider-${option.value}`;
                      return (
                        <div key={option.value} className="relative min-w-0">
                          <input
                            ref={(node) => {
                              if (node) providerRadioRefs.current.set(option.value, node);
                              else providerRadioRefs.current.delete(option.value);
                            }}
                            id={inputId}
                            type="radio"
                            name={`${radioGroupId}-provider`}
                            value={option.value}
                            checked={selected}
                            tabIndex={selected ? 0 : -1}
                            onChange={() => handleAgentChange(option.value)}
                            onKeyDown={(event) =>
                              handleRadioNavigation(
                                event,
                                REVIEW_AGENT_OPTIONS.map(({ value }) => value),
                                agent,
                                handleAgentChange,
                                providerRadioRefs.current,
                              )}
                            className="peer sr-only"
                          />
                          <label
                            htmlFor={inputId}
                            className={cn(
                              "flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2.5 text-left transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/70",
                              selected
                                ? "border-blue-400/55 bg-blue-500/10 text-zinc-100"
                                : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900",
                            )}
                          >
                            <AgentIcon agent={option.value} className="size-4 shrink-0" />
                            <span className="min-w-0 truncate text-sm font-medium">{option.label}</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="min-w-0 border-l border-zinc-800 pl-2">
                  <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                    Mode
                  </p>
                  <div className="grid gap-1.5" role="radiogroup" aria-label={`${agentLabel} mode`}>
                    {availableModes.map((option) => {
                      const selected = tabType === option.value;
                      const inputId = `${radioGroupId}-mode-${option.value}`;
                      return (
                        <div key={option.value} className="relative min-w-0">
                          <input
                            ref={(node) => {
                              if (node) modeRadioRefs.current.set(option.value, node);
                              else modeRadioRefs.current.delete(option.value);
                            }}
                            id={inputId}
                            type="radio"
                            name={`${radioGroupId}-mode`}
                            value={option.value}
                            checked={selected}
                            tabIndex={selected ? 0 : -1}
                            onChange={() => setTabType(option.value)}
                            onKeyDown={(event) =>
                              handleRadioNavigation(
                                event,
                                availableModes.map(({ value }) => value),
                                tabType,
                                setTabType,
                                modeRadioRefs.current,
                              )}
                            className="peer sr-only"
                          />
                          <label
                            htmlFor={inputId}
                            className={cn(
                              "block min-w-0 cursor-pointer rounded-lg border px-2.5 py-2 text-left transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400/70",
                              selected
                                ? "border-blue-400/55 bg-blue-500/10 text-zinc-100"
                                : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900",
                            )}
                          >
                            <span className="block truncate text-sm font-medium">
                              {REVIEW_MODE_LABELS[option.mode]}
                            </span>
                            <span className="hidden truncate text-[11px] text-zinc-500 min-[390px]:block">
                              {option.description}
                            </span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </Step>

            <Step number={2} icon={<Bot className="size-3.5" />}>
              <Label htmlFor="review-model" className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Model
              </Label>
              <Select value={selectedModel?.id ?? model} onValueChange={handleModelChange}>
                <SelectTrigger id="review-model" className="h-11 w-full border-zinc-700/80 bg-zinc-900">
                  <span className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="truncate text-sm">{selectedModel?.name ?? "Choose a model"}</span>
                    {selectedModel?.description && (
                      <span className="truncate text-[11px] font-normal text-zinc-500">
                        {selectedModel.description}
                      </span>
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent position="popper" className="max-h-72">
                  {models.map((option) => (
                    <SelectItem key={option.id} value={option.id} className="py-2">
                      <span className="min-w-0">
                        <span className="block truncate">{option.name}</span>
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
            </Step>

            <Step number={3} icon={<BrainCircuit className="size-3.5" />} last>
              <Label htmlFor="review-effort" className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Reasoning effort
              </Label>
              <Select
                value={effectiveReasoningEffort}
                onValueChange={setReasoningEffort}
                disabled={!effortAvailable}
              >
                <SelectTrigger id="review-effort" className="h-11 w-full border-zinc-700/80 bg-zinc-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="default">Default</SelectItem>
                  {reasoningEfforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!effortAvailable && (
                <p className="mt-1.5 text-xs text-zinc-500">
                  {tabType === "opencode-cli"
                    ? "OpenCode CLI does not expose a launch-time reasoning option."
                    : "This model uses its default reasoning setting."}
                </p>
              )}
            </Step>

            <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <span className="text-zinc-500">Launch:</span> {summary}
            </div>
          </div>

          <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">OK</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
