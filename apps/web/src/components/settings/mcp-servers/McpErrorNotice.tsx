import type { ReactNode } from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { toast } from "sonner";

import { mcpManagementErrorFromUnknown } from "@orkestrator/protocol/mcp-management";

import { writeText } from "@/lib/native/clipboard";
import { cn } from "@/lib/utils";

/** A failure as shown to the user: safe text plus an optional support reference. */
export interface McpProblem {
  message: string;
  /** Backend correlation id, when the error carried one. Never a value. */
  reference?: string;
  conflict?: boolean;
}

const HIDDEN = "[hidden]";
/** Short values match too much ordinary text to be worth redacting. */
const MIN_REDACTED_LENGTH = 4;

/**
 * Replace every occurrence of a value the user typed into a secret-bearing
 * field. The backend never echoes submitted values, but a transport or proxy
 * error is outside its control; this keeps them off screen regardless.
 */
export function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  const candidates = values
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .sort((left, right) => right.length - left.length);
  for (const value of candidates) out = out.split(value).join(HIDDEN);
  return out;
}

export function mcpErrorReference(error: unknown): string | undefined {
  const reference = mcpManagementErrorFromUnknown(error)?.correlationId?.trim();
  return reference ? reference : undefined;
}

export function mcpProblemFrom(
  error: unknown,
  options: { redact?: readonly string[] } = {},
): McpProblem {
  const detail = mcpManagementErrorFromUnknown(error);
  const raw = detail
    ? detail.message
    : error instanceof Error
      ? error.message
      : "The request failed.";
  const reference = mcpErrorReference(error);
  return {
    message: redactValues(raw, options.redact ?? []),
    ...(reference ? { reference } : {}),
    conflict: detail?.code === "revision-conflict",
  };
}

/** Text for a toast: the message, then the reference when there is one. */
export function mcpProblemText(problem: McpProblem): string {
  return problem.reference
    ? `${problem.message} (Reference: ${problem.reference})`
    : problem.message;
}

export function McpErrorReference({ reference }: { reference: string }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      Reference: <code className="break-all font-mono text-foreground/80">{reference}</code>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1 text-blue-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label="Copy error reference"
        onClick={() => {
          void writeText(reference).then(
            () => toast.success("Reference copied"),
            () => toast.error("Could not copy the reference"),
          );
        }}
      >
        <Copy className="h-3 w-3" aria-hidden="true" /> Copy
      </button>
    </p>
  );
}

/** Error box used across MCP settings. Children carry recovery actions. */
export function McpErrorNotice({
  problem,
  children,
  className,
}: {
  problem: McpProblem;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm",
        className,
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <p className="break-words">{problem.message}</p>
        {problem.reference ? <McpErrorReference reference={problem.reference} /> : null}
        {children}
      </div>
    </div>
  );
}
