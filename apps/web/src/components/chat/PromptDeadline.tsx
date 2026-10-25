import { useId } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import type {
  AgentInteractionHold,
  AgentInteractionProvider,
} from "@orkestrator/protocol/agent-interactions";
import { AGENT_INTERACTION_HOLD_CEILING_MS } from "@orkestrator/protocol/agent-interactions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";
import { cn } from "@/lib/utils";

/**
 * A request's published hold, or the terminal-mode case of a tmux prompt
 * raised by a hook script (or a Claude Code process) that predates pausing:
 * it says so rather than show a countdown that looks clickable.
 */
export type PromptDeadlineHold =
  | AgentInteractionHold
  | { available: false; reason: "hook-outdated" };

const AGENT_NAMES: Record<AgentInteractionProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

export interface PromptDeadlineProps {
  expiresAt?: number;
  hold?: PromptDeadlineHold;
  /** Paused, including a pause still being applied. */
  held?: boolean;
  /** A pause or resume is on its way to the agent. */
  pending?: boolean;
  /** Present only when the user may pause or resume now. */
  onToggle?: () => void;
  provider?: AgentInteractionProvider;
  className?: string;
}

function ceilingHours(): number {
  return Math.round(AGENT_INTERACTION_HOLD_CEILING_MS / 3_600_000);
}

function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString([], {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** What the tooltip, and the screen-reader description, say. */
function explanation(
  hold: PromptDeadlineHold | undefined,
  held: boolean,
  expiresAt: number | undefined,
  agent: string,
): string | undefined {
  if (!hold) return undefined;
  if (!hold.available) {
    switch (hold.reason) {
      case "hook-outdated":
        return `This prompt came from a terminal hook that predates pausing. Prompts after ${agent} restarts can be paused.`;
      case "bridge-outdated":
        return "Pausing needs a newer agent bridge. Restart this environment to update it.";
      case "no-extension":
        return `${agent} stops waiting at this deadline itself, so it can't be paused.`;
      default:
        return undefined;
    }
  }
  if (held) {
    const until = expiresAt === undefined ? "" : ` until ${clockTime(expiresAt)}`;
    const limit =
      hold.reason === "provider-limit"
        ? ` ${agent} stops waiting then, even while paused.`
        : hold.reason === "upstream-may-expire"
          ? " The MCP server that asked may stop waiting sooner on its own."
          : "";
    return `Paused${until}.${limit} Click to restart the countdown.`;
  }
  if (hold.reason === "provider-limit") {
    return `Pause the countdown. ${agent} has its own time limit, so the pause can end early.`;
  }
  if (hold.reason === "upstream-may-expire") {
    return `Pause the countdown. The MCP server that asked may still stop waiting on its own.`;
  }
  return `Pause the countdown. ${agent} waits for your answer for up to ${ceilingHours()} hours.`;
}

/**
 * The countdown on a blocking prompt, and the control that pauses it.
 *
 * Pausable: a toggle button ("⏸ 4:32" → "▶ Paused"). Not pausable: the plain
 * countdown, focusable so keyboard users can reach the explanation of why.
 * Without a published hold (an older backend) it is exactly the countdown it
 * always was.
 */
export function PromptDeadline({
  expiresAt,
  hold,
  held = false,
  pending = false,
  onToggle,
  provider,
  className,
}: PromptDeadlineProps) {
  const descriptionId = useId();
  const { remaining, expired } = usePromptDeadline(expiresAt);
  if (expiresAt === undefined || expired) return null;
  if (!held && !remaining) return null;

  const agent = provider ? AGENT_NAMES[provider] : "The agent";
  const description = explanation(hold, held, expiresAt, agent);
  const label = held ? "Paused" : remaining;
  const base = cn(
    "inline-flex shrink-0 items-center gap-1 rounded px-1 text-[11px] tabular-nums text-muted-foreground",
    className,
  );

  const content = onToggle ? (
    <button
      type="button"
      data-testid="prompt-deadline-toggle"
      className={cn(
        base,
        "cursor-pointer hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default",
        held && "text-amber-300",
      )}
      aria-pressed={held}
      aria-label={held ? "Resume countdown" : `Pause countdown, ${remaining} left`}
      aria-describedby={description ? descriptionId : undefined}
      disabled={pending}
      onClick={onToggle}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : held ? (
        <Play className="size-3" aria-hidden />
      ) : (
        <Pause className="size-3" aria-hidden />
      )}
      {label}
    </button>
  ) : (
    <span
      data-testid="prompt-deadline"
      className={base}
      aria-live="off"
      aria-label={held ? "Countdown paused" : `Time remaining ${remaining}`}
      aria-describedby={description ? descriptionId : undefined}
      // Reachable by keyboard only when there is something to explain.
      tabIndex={description ? 0 : undefined}
    >
      {label}
    </span>
  );

  if (!description) return content;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent className="max-w-64">{description}</TooltipContent>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  );
}
