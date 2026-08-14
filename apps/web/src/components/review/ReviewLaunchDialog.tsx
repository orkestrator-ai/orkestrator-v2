import { useEffect, useMemo, useRef, useState } from "react";
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
import { AgentRadioGroup } from "@/components/agents/AgentRadioGroup";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  effortLabel,
  firstModelFor,
  modelsForAgent,
  type AgentModelCatalog,
  type AgentModelOption,
  type LaunchAgent,
} from "@/lib/agent-launch";
import { LOOPED_REVIEW_DEFAULT_ALLOWANCE } from "@/stores/loopedReviewStore";
import { cn } from "@/lib/utils";

export type ReviewTabType = LaunchAgent;

export type ReviewAgent = LaunchAgent;

export type ReviewModelOption = AgentModelOption;

export type ReviewModelCatalog = AgentModelCatalog;

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
    value: "claude",
    label: "Claude Native",
    description: "Agent SDK Markdown review",
    agent: "claude",
    mode: "native",
  },
  {
    value: "codex",
    label: "Codex Native",
    description: "App-server Markdown review",
    agent: "codex",
    mode: "native",
  },
  {
    value: "cursor",
    label: "Cursor Agent",
    description: "Cursor ACP review",
    agent: "cursor",
    mode: "native",
  },
  {
    value: "grok",
    label: "Grok Build",
    description: "Grok ACP review",
    agent: "grok",
    mode: "native",
  },
  {
    value: "opencode",
    label: "OpenCode Native",
    description: "SDK v2 Markdown review",
    agent: "opencode",
    mode: "native",
  },
];

const REVIEW_AGENT_DESCRIPTIONS: Partial<Record<ReviewAgent, string>> =
  Object.fromEntries(
    REVIEW_TAB_OPTIONS.map((option) => [option.agent, option.description]),
  );

export function getReviewAgent(tabType: ReviewTabType): ReviewAgent {
  return REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.agent ?? "claude";
}

function nativeTabType(agent: ReviewAgent): ReviewTabType {
  return agent;
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

interface ReviewLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTabType: ReviewTabType;
  catalog: ReviewModelCatalog;
  preferredModels?: Partial<Record<ReviewAgent, string>>;
  preferredReasoningEfforts?: Partial<Record<ReviewAgent, string>>;
  kind?: "review" | "looped";
  busy?: boolean;
  onConfirm: (selection: ReviewLaunchSelection) => void;
}

export function ReviewLaunchDialog({
  open,
  onOpenChange,
  defaultTabType,
  catalog,
  preferredModels,
  preferredReasoningEfforts,
  kind = "review",
  busy = false,
  onConfirm,
}: ReviewLaunchDialogProps) {
  const { favorites, toggleFavorite } = useAgentModelFavorites();
  const initialModel = firstModelFor(
    getReviewAgent(defaultTabType),
    catalog,
    preferredModels,
  );
  const [tabType, setTabType] = useState(defaultTabType);
  const [model, setModel] = useState(initialModel);
  const [reasoningEffort, setReasoningEffort] = useState(() =>
    defaultEffortFor(
      getReviewAgent(defaultTabType),
      initialModel,
      catalog,
      preferredReasoningEfforts,
    ),
  );
  const [passAllowance, setPassAllowance] = useState(
    String(LOOPED_REVIEW_DEFAULT_ALLOWANCE),
  );
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    const nextModel = firstModelFor(
      getReviewAgent(defaultTabType),
      catalog,
      preferredModels,
    );
    setTabType(defaultTabType);
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(
      getReviewAgent(defaultTabType),
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
  const models = modelsForAgent(catalog, agent);
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
    const nextModel = firstModelFor(nextAgent, catalog, preferredModels);
    setTabType(nativeTabType(nextAgent));
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(
      nextAgent,
      nextModel,
      catalog,
      preferredReasoningEfforts,
    ));
  };

  const handleModelChange = (nextModel: string) => {
    setModel(nextModel);
    setReasoningEffort(defaultEffortFor(
      agent,
      nextModel,
      catalog,
      preferredReasoningEfforts,
    ));
  };

  const title = kind === "looped"
    ? "Configure looped code review"
    : "Configure code review";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="flex w-[min(calc(100%-1rem),38rem)] flex-col gap-0 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[38rem]">
        <DialogHeader className="shrink-0 border-b border-zinc-800 bg-gradient-to-br from-cyan-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="grid size-8 shrink-0 place-items-center rounded-full border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
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
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
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
            <div
              role="region"
              aria-label="Review configuration"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6"
            >
              <Step number={1} icon={<Bot className="size-4" />}>
              <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Native agent
              </Label>
              <AgentRadioGroup
                value={agent}
                onChange={handleAgentChange}
                label="Review provider"
                descriptions={REVIEW_AGENT_DESCRIPTIONS}
              />
              </Step>

              <Step number={2} icon={<Bot className="size-4" />}>
              <Label htmlFor="review-model" className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
                Model
              </Label>
              {agent === "opencode" ? (
                <AgentModelPicker
                  id="review-model"
                  ariaLabel="Model"
                  models={models.map((option) => ({
                    platform: "opencode" as const,
                    id: option.id,
                    label: option.name,
                    description: option.description,
                  }))}
                  enabledPlatforms={["opencode"]}
                  selectedPlatform="opencode"
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  selectedModelId={selectedModel?.id ?? model}
                  selectedModelLabel={selectedModel?.name ?? "Choose a model"}
                  onModelChange={handleModelChange}
                  reasoningOptions={[]}
                  title="Review model"
                  className="min-h-11 w-full border border-zinc-700/80 bg-zinc-900 py-2.5"
                />
              ) : (
                <Select value={selectedModel?.id ?? model} onValueChange={handleModelChange}>
                  <SelectTrigger
                    id="review-model"
                    className="min-h-11 w-full border-zinc-700/80 bg-zinc-900 py-2.5 data-[size=default]:h-auto"
                  >
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
              )}
            </Step>

              <Step
                number={3}
                icon={<BrainCircuit className="size-4" />}
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
                      {effortLabel(effort)}
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
                <Step number={4} icon={<Layers3 className="size-4" />} last>
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
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy
                  ? kind === "looped" ? "Starting looped review…" : "Starting review…"
                  : kind === "looped" ? "Start looped review" : "Start review"}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
