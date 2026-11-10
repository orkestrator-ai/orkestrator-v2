import { Schema } from "effect";
import { schemaErrorIssues } from "../tool-schema.js";
import { hasErrorCode, ipcErrorText } from "@orkestrator/protocol/contract/ipc-error";
import { DESIGN_CONFLICT } from "@orkestrator/protocol/design-canvas";
import type {
  DesignFailure,
  DesignFailureCode,
  DesignRetryClass,
} from "@orkestrator/protocol/design-operations";

const DEFAULT_RETRY: Record<DesignFailureCode, DesignRetryClass> = {
  conflict: "after-refresh",
  "invalid-input": "never",
  "invalid-content": "never",
  "renderer-unavailable": "after-delay",
  capacity: "after-delay",
  deadline: "review",
  disconnected: "review",
  deleted: "never",
  "not-found": "never",
  forbidden: "never",
  "expired-operation": "never",
  "unknown-outcome": "review",
  unsupported: "never",
  storage: "after-delay",
  "export-collision": "review",
  "history-ineligible": "review",
};

/** The registered wire code of a revision conflict (`contract/ipc-error.ts`). */
export const DESIGN_REVISION_CONFLICT_CODE = "design-revision-conflict" as const;

/**
 * A typed, content-free design failure. The message is safe to show and log;
 * `details` carries only names, counts and reason codes.
 *
 * `code` is what a transport carries: the registered `design-revision-conflict`
 * for a revision conflict (a `conflict` led by `Design revision conflict:`),
 * otherwise the failure code. Code in the backend branches on `failure.code`
 * (`isDesignError`).
 */
export class DesignError extends Error {
  readonly failure: DesignFailure;
  constructor(
    code: DesignFailureCode,
    message: string,
    extra: Omit<Partial<DesignFailure>, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "DesignError";
    this.failure = { code, message, retry: extra.retry ?? DEFAULT_RETRY[code], ...extra };
  }
  get code(): DesignFailureCode | typeof DESIGN_REVISION_CONFLICT_CODE {
    return this.failure.code === "conflict" && this.message.startsWith(DESIGN_CONFLICT)
      ? DESIGN_REVISION_CONFLICT_CODE
      : this.failure.code;
  }
}

/** A correlation id reused for different input: never replayed, never retried. */
export function reusedCorrelation(token: string): DesignError {
  return new DesignError(
    "invalid-input",
    "This correlation id was already used for a different edit",
    { details: { token } },
  );
}

export function designConflict(
  expected: number,
  current: number,
  target?: DesignFailure["target"],
): DesignError {
  // Legacy clients match the message prefix; new clients branch on the code.
  return new DesignError(
    "conflict",
    `${DESIGN_CONFLICT} expected ${expected}, current ${current}. Fetch the latest snapshot before editing.`,
    { revisions: { expected, current }, ...(target ? { target } : {}) },
  );
}

const SAFE_RUNTIME_MESSAGES = [
  /^Selector must match exactly one element$/,
  /^Invalid selector$/,
  /^Select an element inside the body$/,
  /^Invalid element move$/,
  /^Frame exceeds 5000 elements$/,
  /^HTML exceeds 256 KiB$/,
  /^Too many styles$/,
  /^Invalid style: [a-z0-9_, -]{1,400}$/i,
  /^Hierarchy changed; reload this branch$/,
];

/** Maps any thrown value to a failure without leaking content or paths. */
export function toDesignFailure(error: unknown): DesignFailure {
  if (error instanceof DesignError) return error.failure;
  if (Schema.isSchemaError(error)) {
    const fields = Array.from(
      new Set(
        schemaErrorIssues(error)
          .map((issue) => issue.path.map(String).join("."))
          .filter(Boolean),
      ),
    ).slice(0, 8);
    return {
      code: "invalid-input",
      message: fields.length
        ? `Invalid design input: ${fields.join(", ")}`
        : "Invalid design input",
      retry: "never",
      details: { fields },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (hasErrorCode(error, DESIGN_REVISION_CONFLICT_CODE, DESIGN_CONFLICT))
    return { code: "conflict", message: ipcErrorText(message), retry: "after-refresh" };
  if (/has been closed|browser has disconnected|Target closed/i.test(message))
    return {
      code: "renderer-unavailable",
      message: "The design renderer stopped while working; retry shortly",
      retry: "after-delay",
    };
  if (SAFE_RUNTIME_MESSAGES.some((pattern) => pattern.test(message)))
    return {
      code: /exceeds|Too many/.test(message) ? "invalid-content" : "invalid-input",
      message,
      retry: "never",
    };
  return { code: "storage", message: "Design operation failed", retry: "after-delay" };
}

export function isDesignError(error: unknown, code?: DesignFailureCode): error is DesignError {
  return error instanceof DesignError && (code === undefined || error.failure.code === code);
}
