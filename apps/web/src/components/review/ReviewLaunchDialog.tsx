import { useEffect, useMemo, useRef, useState } from "react";
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
}

export const REVIEW_TAB_OPTIONS: ReviewTabOption[] = [
  { value: "claude-cli", label: "Claude CLI", description: "Terminal interface", agent: "claude" },
  { value: "claude-native", label: "Claude Native", description: "SDK chat interface", agent: "claude" },
  { value: "claude-tmux", label: "Claude Tmux", description: "Native UI over Claude CLI", agent: "claude" },
  { value: "codex-cli", label: "Codex CLI", description: "Terminal interface", agent: "codex" },
  { value: "codex-native", label: "Codex Native", description: "Bridge chat interface", agent: "codex" },
  { value: "opencode-cli", label: "OpenCode CLI", description: "Terminal interface", agent: "opencode" },
  { value: "opencode-native", label: "OpenCode Native", description: "SDK chat interface", agent: "opencode" },
];

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
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      <div className="flex flex-col items-center" aria-hidden="true">
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

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const nextModel = firstModelFor(defaultTabType, catalog, preferredModels);
      setTabType(defaultTabType);
      setModel(nextModel);
      setReasoningEffort(
        defaultEffortFor(defaultTabType, nextModel, catalog, preferredReasoningEfforts),
      );
    }
    wasOpenRef.current = open;
  }, [catalog, defaultTabType, open, preferredModels, preferredReasoningEfforts]);

  const agent = getReviewAgent(tabType);
  const models = catalog[agent];
  const selectedModel = models.find((option) => option.id === model) ?? models[0];
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];
  const effortAvailable = reasoningEfforts.length > 0 && tabType !== "opencode-cli";

  const summary = useMemo(() => {
    const tabLabel = REVIEW_TAB_OPTIONS.find((option) => option.value === tabType)?.label ?? tabType;
    const effortLabel = reasoningEffort === "default"
      ? "default effort"
      : `${reasoningEffort} effort`;
    return `${tabLabel} · ${selectedModel?.name ?? model} · ${effortAvailable ? effortLabel : "default effort"}`;
  }, [effortAvailable, model, reasoningEffort, selectedModel?.name, tabType]);

  const handleTabTypeChange = (nextTabType: ReviewTabType) => {
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
      <DialogContent className="w-[min(calc(100%-1rem),38rem)] gap-5 overflow-hidden border-zinc-700/80 bg-[#111113] p-0 sm:max-w-[38rem]">
        <DialogHeader className="border-b border-zinc-800 bg-gradient-to-br from-blue-500/[0.08] via-transparent to-transparent px-5 pb-4 pt-5 sm:px-6">
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
          className="space-y-0 px-5 sm:px-6"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm({
              tabType,
              model: selectedModel?.id ?? model,
              reasoningEffort:
                effortAvailable && reasoningEffort !== "default" ? reasoningEffort : undefined,
            });
          }}
        >
          <Step number={1} icon={<TerminalSquare className="size-3.5" />}>
            <Label className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
              Tab type
            </Label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Review tab type">
              {REVIEW_TAB_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={tabType === option.value}
                  onClick={() => handleTabTypeChange(option.value)}
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70",
                    tabType === option.value
                      ? "border-blue-400/55 bg-blue-500/10 text-zinc-100"
                      : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:bg-zinc-900",
                  )}
                >
                  <AgentIcon agent={option.agent} className="size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{option.label}</span>
                    <span className="block truncate text-[11px] text-zinc-500">{option.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </Step>

          <Step number={2} icon={<Bot className="size-3.5" />}>
            <Label htmlFor="review-model" className="mb-2 block text-xs font-medium uppercase tracking-[0.14em] text-zinc-400">
              Model
            </Label>
            <Select value={selectedModel?.id ?? model} onValueChange={handleModelChange}>
              <SelectTrigger id="review-model" className="h-11 w-full border-zinc-700/80 bg-zinc-900">
                <SelectValue placeholder="Choose a model" />
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
              value={effortAvailable ? reasoningEffort : "default"}
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

          <DialogFooter className="-mx-5 mt-5 border-t border-zinc-800 bg-zinc-950/40 px-5 py-4 sm:-mx-6 sm:px-6">
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
