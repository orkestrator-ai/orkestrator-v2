import type { ReactNode } from "react";
import { AlertCircle, LockKeyhole, ShieldAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

export const COORDINATOR_COMPOSER_PLACEHOLDER = "What would you like to get done?";

/**
 * The header's one statement about where work happens.
 *
 * The checkout path and context revision live in its hover text rather than
 * the header. The trigger is a button so the same text opens on keyboard
 * focus, not only on hover. `advisoryPlatform` names the selected
 * conversation's agent when its read-only boundary is not enforced; the badge
 * then says so in amber instead of claiming a protection it cannot guarantee.
 */
export function CoordinatorIsolationBadge({
  projectPath,
  contextRevision,
  advisoryPlatform,
}: {
  projectPath: string;
  contextRevision: number;
  advisoryPlatform: string | null;
}) {
  const advisory = advisoryPlatform !== null;
  const Icon = advisory ? ShieldAlert : LockKeyhole;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-coordinator-isolation-badge={advisory ? "advisory" : "enforced"}
          data-context-revision={contextRevision}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs focus-hairline",
            advisory
              ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
              : "border-emerald-500/25 bg-emerald-500/10 text-emerald-200",
          )}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Changes run in isolated environments</span>
          {advisory ? (
            <span className="shrink-0 text-amber-300">· Read-only protection is advisory</span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-sm text-left text-balance">
        <div className="space-y-1.5">
          <p>
            The coordinator reads this checkout but never changes it. Builds, fixes and other
            changes run in build pipelines or prompt environments.
          </p>
          {advisory ? (
            <p className="text-amber-200">
              {advisoryPlatform} is told not to change the checkout, but Orkestrator cannot enforce
              that, so this protection is advisory.
            </p>
          ) : null}
          <p className="break-all text-muted-foreground">
            Checkout: <code>{projectPath}</code>
          </p>
          <p className="text-muted-foreground">
            Context revision r{contextRevision}. It increases when the branch or HEAD changes, so
            earlier analysis may describe an older revision.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A notice above the conversation. Paused, startup and provider states are
 * banners rather than replacements, so the transcript stays readable.
 */
export function CoordinatorBanner({
  tone,
  icon,
  children,
  action,
}: {
  tone: "info" | "warning" | "error";
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-sm",
        tone === "error" && "border-destructive/40 bg-destructive/10 text-red-200",
        tone === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-200",
        tone === "info" && "border-border/70 bg-elevated text-foreground",
      )}
    >
      {icon ?? <AlertCircle className="size-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** One expandable error line; repository and coordinator errors each get one. */
export function CoordinatorErrorDetails({ label, message }: { label: string; message: string }) {
  return (
    <details className="mt-1 text-xs text-red-300">
      <summary className="cursor-pointer">{label}</summary>
      <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap">{message}</pre>
    </details>
  );
}
