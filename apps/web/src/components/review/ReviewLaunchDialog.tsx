import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Bot, BrainCircuit, Layers3 } from "lucide-react";
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
import { LOOPED_REVIEW_DEFAULT_ALLOWANCE } from "@/stores/loopedReviewStore";
import { cn } from "@/lib/utils";

export type ReviewTabType =
  | "claude-native"
  | "codex-native"
  | "opencode-native";

export type ReviewAgent = "claude" | "codex" | "opencode";

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
  passAllowance?: number;
}

export const REVIEW_TAB_OPTIONS: Array<{
  value: ReviewTabType;
  label: string;
  description: string;
  agent: ReviewAgent;
  mode: "native";
}> = [
  {
    value: "claude-native",
    label: "Claude Native",
    description: "Agent SDK Markdown review",
    agent: "claude",
    mode: "native",
  },
  {
    value: "codex-native",
    label: "Codex Native",
    description: "App-server Markdown review",
    agent: "codex",
    mode: "native",
  },
  {
    value: "opencode-native",
    label: "OpenCode Native",
    description: "SDK v2 Markdown review",
    agent: "opencode",
    mode: "native",
  },
];

const REVIEW_AGENT_OPTIONS: Array<{ value: ReviewAgent; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];

export function getReviewAgent(tabType: ReviewTabType): ReviewAgent {
  return REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.agent ?? "claude";
}

function nativeTabType(agent: ReviewAgent): ReviewTabType {
  return `${agent}-native` as ReviewTabType;
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
        <div className="relative grid size-8 place-items-center rounded-full border border-cyan-400/35 bg-cyan-500/10 text-cyan-300">
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

interface ReviewLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTabType: ReviewTabType;
  catalog: ReviewModelCatalog;
  preferredModels?: Partial<Record<ReviewAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<ReviewAgent, string>>;
  kind?: "review" | "looped";
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
  return models.some((model) => model.id === preferred)
    ? preferred!
    : (models[0]?.id ?? "default");
}

function defaultEffortFor(
  tabType: ReviewTabType,
  modelId: string,
  catalog: ReviewModelCatalog,
  preferredEfforts: ReviewLaunchDialogProps["preferredReasoningEfforts"],
): string {
  const agent = getReviewAgent(tabType);
  const options =
    catalog[agent].find((model) => model.id === modelId)?.reasoningEfforts ?? [];
  const preferred = preferredEfforts?.[agent];
  return preferred && options.includes(preferred) ? preferred : "default";
}

function handleRadioNavigation(
  event: React.KeyboardEvent<HTMLInputElement>,
  current: ReviewAgent,
  onChange: (agent: ReviewAgent) => void,
  refs: Map<ReviewAgent, HTMLInputElement>,
) {
  const values = REVIEW_AGENT_OPTIONS.map(({ value }) => value);
  const index = Math.max(values.indexOf(current), 0);
  let next: number;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    next = (index + 1) % values.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    next = (index - 1 + values.length) % values.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = values.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const value = values[next]!;
  onChange(value);
  refs.get(value)?.focus();
}

export function ReviewLaunchDialog({
  open,
  onOpenChange,
  defaultTabType,
  catalog,
  preferredModels,
  preferredReasoningEfforts,
  kind = "review",
  onConfirm,
}: ReviewLaunchDialogProps) {
  const initialModel = firstModelFor(defaultTabType, catalog, preferredModels);
  const [tabType, setTabType] = useState(defaultTabType);
  const [model, setModel] = useState(initialModel);
  const [reasoningEffort, setReasoningEffort] = useState(() =>
    defaultEffortFor(
      defaultTabType,
      initialModel,
      catalog,
      preferredReasoningEfforts,
    ),
  );
  const [passAllowance, setPassAllowance] = useState(
    String(LOOPED_REVIEW_DEFAULT_ALLOWANCE),
  );
  const wasOpenRef = useRef(false);
  const radioGroupId = useId();
  const providerRadioRefs = useRef(new Map<ReviewAgent, HTMLInputElement>());

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    const nextModel = firstModelFor(defaultTabType, catalog, preferredModels);
    setTabType(defaultTabType);
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(
      defaultTabType,
      nextModel,
      catalog,
      preferredReasoningEfforts,
    ));
    setPassAllowance(String(LOOPED_REVIEW_DEFAULT_ALLOWANCE));
  }, [
    catalog,
    defaultTabType,
    open,
    preferredModels,
    preferredReasoningEfforts,
  ]);

  const agent = getReviewAgent(tabType);
  const models = catalog[agent];
  const selectedModel = models.find((option) => option.id === model) ?? models[0];
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const effortAvailable = reasoningEfforts.length > 0;
  const effectiveEffort =
    effortAvailable
    && (reasoningEffort === "default" || reasoningEfforts.includes(reasoningEffort))
      ? reasoningEffort
      : "default";

  const summary = useMemo(() => {
    const label = REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.label;
    const effort = effectiveEffort === "default"
      ? "default effort"
      : `${effectiveEffort} effort`;
    return [
      label,
      selectedModel?.name ?? model,
      effort,
      kind === "looped" ? `${passAllowance} initial passes` : "one pass",
    ].filter(Boolean).join(" · ");
  }, [
    effectiveEffort,
    kind,
    model,
    passAllowance,
    selectedModel?.name,
    tabType,
  ]);

  const handleAgentChange = (nextAgent: ReviewAgent) => {
    const nextType = nativeTabType(nextAgent);
    const nextModel = firstModelFor(nextType, catalog, preferredModels);
    setTabType(nextType);
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(
      nextType,
      nextModel,
      catalog,
      preferredReasoningEfforts,
    ));
  };

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(
      tabType,
      nextModel,
      catalog,
      preferredReasoningEfforts,
    ));
  };

  const title = kind === "looped"
    ? "Configure looped code review"
    : "Configure code review";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[min(calc(100%-1rem),38rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[38rem]">
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-cyan-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
              {kind === "looped"
                ? <Layers3 className="size-4" />
                : <BrainCircuit className="size-4" />}
            </span>
            {title}
          </DialogTitle>
          <DialogDescription>
            {kind === "looped"
              ? "Run fresh native review sessions, reconcile and fix their pooled findings, then create a PR."
              : "Run one native review and return its report directly in Markdown."}
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
                effectiveEffort === "default" ? undefined : effectiveEffort,
              ...(kind === "looped"
                ? { passAllowance: Number(passAllowance) }
                : {}),
            });
          }}
        >
          <div
            role="region"
            aria-label="Review configuration"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
          >
            <Step number={1} icon={<Bot className="size-3.5" />}>
              <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Native agent
              </Label>
              <div
                className="grid gap-2 sm:grid-cols-3"
                role="radiogroup"
                aria-label="Review provider"
              >
                {REVIEW_AGENT_OPTIONS.map((option) => {
                  const selected = agent === option.value;
                  const id = `${radioGroupId}-${option.value}`;
                  const nativeOption = REVIEW_TAB_OPTIONS.find(
                    (candidate) => candidate.agent === option.value,
                  )!;
                  return (
                    <div key={option.value} className="relative min-w-0">
                      <input
                        ref={(node) => {
                          if (node) providerRadioRefs.current.set(option.value, node);
                          else providerRadioRefs.current.delete(option.value);
                        }}
                        id={id}
                        type="radio"
                        name={`${radioGroupId}-provider`}
                        checked={selected}
                        tabIndex={selected ? 0 : -1}
                        onChange={() => handleAgentChange(option.value)}
                        onKeyDown={(event) => handleRadioNavigation(
                          event,
                          agent,
                          handleAgentChange,
                          providerRadioRefs.current,
                        )}
                        className="peer sr-only"
                      />
                      <label
                        htmlFor={id}
                        className={cn(
                          "flex min-h-20 cursor-pointer flex-col rounded-lg border px-3 py-2.5 transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/70",
                          selected
                            ? "border-cyan-400/55 bg-cyan-500/10 text-zinc-100"
                            : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700",
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <AgentIcon agent={option.value} className="size-4" />
                          {option.label}
                        </span>
                        <span className="mt-1 text-[11px] leading-snug text-zinc-500">
                          {nativeOption.description}
                        </span>
                      </label>
                    </div>
                  );
                })}
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
            </Step>

            <Step
              number={3}
              icon={<BrainCircuit className="size-3.5" />}
              last={kind !== "looped"}
            >
              <Label htmlFor="review-effort" className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Reasoning effort
              </Label>
              <Select
                value={effectiveEffort}
                onValueChange={setReasoningEffort}
                disabled={!effortAvailable}
              >
                <SelectTrigger id="review-effort" className="h-11 w-full border-zinc-700/80 bg-zinc-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  {reasoningEfforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort === "xhigh"
                        ? "Extra high"
                        : effort.charAt(0).toUpperCase() + effort.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!effortAvailable && (
                <p className="mt-1.5 text-xs text-zinc-500">
                  This model uses its default reasoning setting.
                </p>
              )}
            </Step>

            {kind === "looped" && (
              <Step number={4} icon={<Layers3 className="size-3.5" />} last>
                <Label htmlFor="review-pass-allowance" className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                  Initial review-pass allowance
                </Label>
                <Select value={passAllowance} onValueChange={setPassAllowance}>
                  <SelectTrigger id="review-pass-allowance" className="h-11 w-full border-zinc-700/80 bg-zinc-900">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value} {value === 1 ? "pass" : "passes"}
                        {value === LOOPED_REVIEW_DEFAULT_ALLOWANCE ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
                  A round stops early when reconciliation changes nothing. After fixes, the next allowance is halved and rounded up.
                </p>
              </Step>
            )}

            <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
              <span className="text-zinc-500">Launch:</span> {summary}
            </div>
          </div>

          <DialogFooter className="shrink-0 flex-row justify-end border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:px-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              {kind === "looped" ? "Start looped review" : "Start review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
