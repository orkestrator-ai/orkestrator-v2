import type { ReactNode } from "react";
import {
  Copy,
  Database,
  LockKeyhole,
  RotateCcw,
  Settings2,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import type {
  CoordinatorProviderTier,
  CoordinatorWorkflowStoreState,
  ProjectGitStatus,
} from "@orkestrator/protocol/coordinator";
import { Button } from "@/components/ui/button";
import {
  FLOATING_NOTICE_ACTION,
  FloatingNotice,
  type FloatingNoticeTone,
} from "@/components/ui/floating-notice";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { writeText } from "@/lib/native/clipboard";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";

/**
 * Offered on an empty main conversation. Choosing one fills the message box
 * for the user to finish; nothing is sent until they send it.
 */
export const COORDINATOR_STARTER_PROMPTS: readonly string[] = [
  "Build this feature and check it against these criteria: …",
  "Investigate this bug, reproduce it and fix it: …",
  "Review this branch and tell me what needs attention",
  "Take ticket … through build and review",
];

/**
 * What the composer's special characters do. It lives in the empty message
 * box's placeholder rather than a line under it, so it is out of the way once
 * the user starts typing. `!` commands are the user's own action, so it says
 * who runs them.
 */
export const COORDINATOR_COMPOSER_SYNTAX_HINT =
  "Type @ to mention a file, or start with ! to run a command yourself.";

export const COORDINATOR_COMPOSER_PLACEHOLDER = `What would you like to get done? ${COORDINATOR_COMPOSER_SYNTAX_HINT}`;

/**
 * A side agent's own placeholder. The main's asks what to get done, which a
 * conversation that cannot launch anything should not promise.
 */
export const COORDINATOR_SIDE_COMPOSER_PLACEHOLDER = `Ask a question about this project. ${COORDINATOR_COMPOSER_SYNTAX_HINT}`;

/** What a side agent is for: the New side agent tooltip and a side composer's hint. */
export const COORDINATOR_SIDE_AGENT_EXPLANATION =
  "Side agents can read the project and talk to the main coordinator, but can't launch workers. Good for a second opinion or a parallel investigation.";

/** The tiers a qualified platform can hold (`coordinator.md`, Provider qualification). */
export type CoordinatorReadOnlyTier = Exclude<CoordinatorProviderTier, "unavailable">;

export const COORDINATOR_TIER_LABELS: Record<CoordinatorReadOnlyTier, string> = {
  enforced: "Enforced",
  "provider-configured": "Provider-configured",
  advisory: "Advisory",
};

/** The one-sentence meaning of each tier, from the tier table in `coordinator.md`. */
export const COORDINATOR_TIER_MEANINGS: Record<CoordinatorReadOnlyTier, string> = {
  enforced: "The provider or the operating system blocks changes, whatever the agent attempts.",
  "provider-configured":
    "The provider is told to refuse changes, but offers no way for Orkestrator to verify that it does.",
  advisory:
    "The agent is asked to request permission before changing anything; a tool that does not ask is not stopped.",
};

export function coordinatorReadOnlyTier(
  tier: CoordinatorProviderTier | undefined,
): CoordinatorReadOnlyTier | null {
  return tier && tier !== "unavailable" ? tier : null;
}

/**
 * The header's one statement about where work happens, and the read-only tier
 * of the conversation in front. It reads as coloured text in the toolbar
 * rather than a boxed panel; only the tier pill keeps an outline.
 *
 * `platform` and `tier` name the selected conversation's agent and how strongly
 * its read-only boundary holds; an unassigned conversation has neither. The
 * pill names the tier, so a provider-configured platform is never called
 * advisory. The explanation, the checkout path and the context revision open
 * from the badge as a menu rather than a tooltip: it carries a link to the
 * safety-level setting, and a menu opens by touch and keyboard as well as by
 * pointer.
 */
export function CoordinatorIsolationBadge({
  projectPath,
  contextRevision,
  platform,
  tier,
}: {
  projectPath: string;
  contextRevision: number;
  platform: string | null;
  tier: CoordinatorReadOnlyTier | null;
}) {
  const caution = tier !== null && tier !== "enforced";
  const Icon = caution ? ShieldAlert : LockKeyhole;
  const tierLabel = tier ? COORDINATOR_TIER_LABELS[tier] : null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-coordinator-isolation-badge={tier ?? "unassigned"}
          data-context-revision={contextRevision}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-xs focus-hairline",
            caution
              ? "text-amber-200 hover:text-amber-100"
              : "text-emerald-200 hover:text-emerald-100",
          )}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate max-sm:sr-only">Changes run in isolated environments</span>
          {tierLabel ? (
            <span
              data-coordinator-tier-pill={tier}
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4 font-medium",
                caution
                  ? "border-amber-400/40 text-amber-200"
                  : "border-emerald-400/35 text-emerald-200",
              )}
            >
              <span className="max-sm:sr-only">Read-only · </span>
              {tierLabel}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        className="max-w-sm space-y-1.5 p-3 text-xs text-balance"
        data-coordinator-isolation-details
      >
        <p>
          The coordinator reads this checkout but never changes it. Builds, fixes and other changes
          run in build pipelines or prompt environments.
        </p>
        {tier && platform ? (
          <p className={caution ? "text-amber-200" : "text-emerald-200"}>
            {platform}&apos;s read-only protection is {tierLabel?.toLowerCase()}.{" "}
            {COORDINATOR_TIER_MEANINGS[tier]}
          </p>
        ) : null}
        <DropdownMenuItem className="text-xs" onSelect={() => requestGlobalSettings("coordinator")}>
          <Settings2 className="size-3.5" aria-hidden="true" />
          Coordinator safety level in Settings
        </DropdownMenuItem>
        <p className="break-all text-muted-foreground">
          Checkout: <code>{projectPath}</code>
        </p>
        <p className="text-muted-foreground">
          Context revision r{contextRevision}. It increases when the branch or HEAD changes, so
          earlier analysis may describe an older revision.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A notice over the conversation, floating at the top right of the
 * coordinator area. Paused, startup and provider states are notices rather
 * than replacements, so the transcript stays readable.
 */
export function CoordinatorBanner({
  tone,
  label,
  summary,
  icon,
  children,
  action,
  onDismiss,
  dismissLabel,
}: {
  tone: FloatingNoticeTone;
  /** A few words naming the notice: its heading, and what its pill says. */
  label: string;
  /** Plain-text gist for the pill's accessible name; the label when absent. */
  summary?: string;
  icon?: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <FloatingNotice
      tone={tone}
      label={label}
      summary={summary ?? label}
      role={tone === "error" ? "alert" : "status"}
      actions={action}
      {...(icon ? { icon } : {})}
      {...(onDismiss ? { onDismiss } : {})}
      {...(dismissLabel ? { dismissLabel } : {})}
    >
      {children}
    </FloatingNotice>
  );
}

/**
 * Says when the workflow store every project's coordinator shares is close to
 * refusing new work, or refusing it, and what frees room. Nothing from a
 * backend that predates `workflowStore`, which says nothing about the store.
 */
export function CoordinatorWorkflowStoreBanner({
  state,
}: {
  state: CoordinatorWorkflowStoreState | undefined;
}) {
  if (state !== "near-limit" && state !== "full") return null;
  const full = state === "full";
  return (
    <CoordinatorBanner
      tone={full ? "error" : "warning"}
      label={full ? "Work records full" : "Work records nearly full"}
      icon={Database}
    >
      <span data-coordinator-workflow-store={state}>
        <span className="font-medium">
          {full
            ? "Coordinator work records are full."
            : "Coordinator work records are nearly full."}
        </span>{" "}
        <span className="text-muted-foreground">
          {full
            ? "New launches are refused, and messages to workers will not wake the coordinator, until room frees up."
            : "The records every project's coordinator shares will soon refuse new launches."}{" "}
          Delete finished worker environments, or let running work finish; finished work older than
          a day is then cleared automatically.
        </span>
      </span>
    </CoordinatorBanner>
  );
}

/** The repository's own retained error, as the toolbar's disclosure shows it. */
export function coordinatorGitErrorText(git: ProjectGitStatus | null): string | null {
  return git?.lastError ? git.lastError.stderr || git.lastError.message : null;
}

/**
 * A failed action, visible and announced. A retained repository error stays a
 * disclosure instead, because it describes a state rather than something the
 * user just did.
 */
export function CoordinatorActionAlert({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <CoordinatorBanner
      tone="error"
      label="Action failed"
      summary={message}
      onDismiss={onDismiss}
      dismissLabel="Dismiss error"
    >
      <span className="block max-h-28 overflow-auto break-words whitespace-pre-wrap">
        {message}
      </span>
    </CoordinatorBanner>
  );
}

/** A conversation's bridge failed to start: this pane's notice and the ways out of it. */
export function CoordinatorStartupFailure({
  title,
  error,
  busy,
  onRetry,
  onClose,
}: {
  title: string;
  error: string;
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <CoordinatorBanner
      tone="error"
      label="Could not start"
      summary={`${title} could not start.`}
      action={
        <>
          <Button
            size="sm"
            variant="secondary"
            className={FLOATING_NOTICE_ACTION}
            disabled={busy}
            onClick={onRetry}
          >
            <RotateCcw className="size-3" />
            Retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={FLOATING_NOTICE_ACTION}
            disabled={busy}
            onClick={onClose}
          >
            Close conversation
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={FLOATING_NOTICE_ACTION}
            onClick={() => {
              void writeText(error).then(
                () => toast.success("Error copied"),
                () => toast.error("Could not copy the error"),
              );
            }}
          >
            <Copy className="size-3" />
            Copy error
          </Button>
        </>
      }
    >
      <span className="font-medium">{title} could not start.</span>{" "}
      <span className="break-words text-muted-foreground">{error}</span>
    </CoordinatorBanner>
  );
}

/** One expandable error line for the repository's retained error. */
export function CoordinatorErrorDetails({ label, message }: { label: string; message: string }) {
  return (
    <details className="mt-1 text-xs text-red-300">
      <summary className="cursor-pointer">{label}</summary>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap">{message}</pre>
    </details>
  );
}
