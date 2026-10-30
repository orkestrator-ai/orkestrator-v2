import type { ReactNode } from "react";
import {
  GitMerge,
  GitMergeConflict,
  MessageCircleQuestionMark,
  type LucideIcon,
} from "lucide-react";
import { PR_READY_TO_MERGE_LABEL } from "@orkestrator/protocol/pr-merge-readiness";
import type { EnvironmentNameSignal } from "@/lib/environment-name-signal";
import { cn } from "@/lib/utils";

interface NameSignalStyle {
  /** The shared sweep plus this signal's colours (`index.css`). */
  className: string;
  /** Announced to assistive technology and shown in tooltips. */
  label: string;
  icon: LucideIcon;
  /** Colour of the icon and of tooltip copy. */
  textClassName: string;
}

export const ENVIRONMENT_NAME_SIGNALS: Record<EnvironmentNameSignal, NameSignalStyle> = {
  "needs-answer": {
    className: "text-shimmer needs-answer-name",
    label: "Waiting for your answer",
    icon: MessageCircleQuestionMark,
    textClassName: "text-yellow-400",
  },
  "merge-conflicts": {
    className: "text-shimmer merge-conflicts-name",
    label: "Merge conflicts to resolve",
    icon: GitMergeConflict,
    textClassName: "text-destructive",
  },
  "merge-ready": {
    className: "text-shimmer merge-ready-name",
    label: PR_READY_TO_MERGE_LABEL,
    icon: GitMerge,
    textClassName: "text-success",
  },
};

/**
 * An environment name that shimmers while something waits on the user: yellow
 * for an agent's question, red for a pull request with merge conflicts, green
 * for one ready to merge. The name keeps its own colour and truncation; only
 * the moving band is added. Pair it with {@link EnvironmentNameSignalMarker},
 * which carries the non-visual cues.
 */
export function EnvironmentNameShimmer({
  signal,
  id,
  className,
  children,
}: {
  signal: EnvironmentNameSignal | null;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      id={id}
      className={cn(className, signal && ENVIRONMENT_NAME_SIGNALS[signal].className)}
      data-name-signal={signal ?? undefined}
      data-merge-ready={signal === "merge-ready" ? "true" : undefined}
    >
      {children}
    </span>
  );
}

/**
 * What the shimmer alone cannot say. A small icon appears only when the user
 * asked for reduced motion (or forced colours), where the name holds a static
 * highlight instead of the sweep. The hidden text is the accessible
 * description: point the row control's `aria-describedby` at `descriptionId`
 * so the state is announced without changing the row's accessible name.
 */
export function EnvironmentNameSignalMarker({
  signal,
  descriptionId,
}: {
  signal: EnvironmentNameSignal | null;
  descriptionId: string;
}) {
  if (!signal) return null;
  const { icon: Icon, label, textClassName } = ENVIRONMENT_NAME_SIGNALS[signal];
  return (
    <>
      <Icon
        aria-hidden="true"
        data-testid={`${signal}-indicator`}
        className={cn(
          "hidden h-3 w-3 shrink-0 motion-reduce:inline-block forced-colors:inline-block",
          textClassName,
        )}
      />
      <span id={descriptionId} hidden>
        {label}
      </span>
    </>
  );
}

/** The tooltip line naming the signal, in its colour. */
export function EnvironmentNameSignalLine({
  signal,
  className,
}: {
  signal: EnvironmentNameSignal | null;
  className?: string;
}) {
  if (!signal) return null;
  const { icon: Icon, label, textClassName } = ENVIRONMENT_NAME_SIGNALS[signal];
  return (
    <p
      className={cn("flex items-center gap-1 text-xs", textClassName, className)}
      data-testid={`environment-tooltip-${signal}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </p>
  );
}
