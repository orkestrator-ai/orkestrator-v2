import type { ReactNode } from "react";
import { GitMerge } from "lucide-react";
import { PR_READY_TO_MERGE_LABEL } from "@orkestrator/protocol/pr-merge-readiness";
import { cn } from "@/lib/utils";

/** The shared sweep plus its "ready to merge" colours (`index.css`). */
export const MERGE_READY_NAME_CLASS = "text-shimmer merge-ready-name";

/**
 * An environment name that shimmers while its pull request is ready to merge.
 * The name keeps its own colour and truncation; only the moving band is added.
 * Pair it with {@link MergeReadyMarker}, which carries the non-visual cues.
 */
export function MergeReadyName({
  ready,
  id,
  className,
  children,
}: {
  ready: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      id={id}
      className={cn(className, ready && MERGE_READY_NAME_CLASS)}
      data-merge-ready={ready ? "true" : undefined}
    >
      {children}
    </span>
  );
}

/**
 * What the shimmer alone cannot say. A small merge icon appears only when the
 * user asked for reduced motion (or forced colours), where the name holds a
 * static highlight instead of the sweep. The hidden text is the accessible
 * description: point the row control's `aria-describedby` at `descriptionId`
 * so the state is announced without changing the row's accessible name.
 */
export function MergeReadyMarker({
  ready,
  descriptionId,
}: {
  ready: boolean;
  descriptionId: string;
}) {
  if (!ready) return null;
  return (
    <>
      <GitMerge
        aria-hidden="true"
        data-testid="merge-ready-indicator"
        className="hidden h-3 w-3 shrink-0 text-success motion-reduce:inline-block forced-colors:inline-block"
      />
      <span id={descriptionId} hidden>
        {PR_READY_TO_MERGE_LABEL}
      </span>
    </>
  );
}
