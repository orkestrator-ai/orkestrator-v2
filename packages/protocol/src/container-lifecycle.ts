/**
 * Shared contract for container lifecycle mutations.
 *
 * Every destructive container operation names its intent explicitly. A request
 * that omits the intent resolves to `preserve`, and a backend that cannot yet
 * preserve the requested state refuses rather than discarding it. This keeps an
 * older renderer, CLI or automation that still sends the pre-intent request
 * shape from destroying a workspace by default.
 *
 * Errors cross the command transport as message strings, so a typed failure is
 * encoded as `ContainerLifecycleError:<code>: <message>` (the same convention
 * MCP management uses) and parsed back with `parseContainerLifecycleError`.
 */

export const CONTAINER_LIFECYCLE_ERROR_PREFIX = "ContainerLifecycleError";

export const CONTAINER_LIFECYCLE_ERROR_CODES = [
  /** The runtime has local data this operation cannot yet preserve. */
  "preservation-required",
  /** The request was reviewed against a runtime that has since changed. */
  "runtime-changed",
  /** The request's expected revision does not match the stored revision. */
  "revision-conflict",
  /** The Docker resource is not owned by this backend registry. */
  "not-owned",
  /** Docker could not be reached; nothing was changed. */
  "daemon-unavailable",
  /** Docker refused to remove the runtime; its identity is retained. */
  "removal-failed",
  /** Another lifecycle operation owns this environment. */
  "operation-in-progress",
  /** A durable operation is in a state that needs the user's decision. */
  "needs-attention",
  /** The stored state was written by a newer, unsupported format. */
  "unsupported-format",
  /** The image does not declare a capability the operation needs. */
  "capability-unavailable",
  /** The Docker daemon topology cannot support the operation. */
  "unsupported-topology",
  /** A request field was malformed or out of bounds. */
  "invalid-request",
  /** A bounded resource (retained copies, followers, admission) is full. */
  "resource-exhausted",
  /** The requested operation id is unknown or its record has expired. */
  "operation-unknown",
] as const;

export type ContainerLifecycleErrorCode = (typeof CONTAINER_LIFECYCLE_ERROR_CODES)[number];

export function isContainerLifecycleErrorCode(
  value: unknown,
): value is ContainerLifecycleErrorCode {
  return (
    typeof value === "string" &&
    (CONTAINER_LIFECYCLE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function formatContainerLifecycleError(
  code: ContainerLifecycleErrorCode,
  message: string,
): string {
  return `${CONTAINER_LIFECYCLE_ERROR_PREFIX}:${code}: ${message}`;
}

export interface ParsedContainerLifecycleError {
  code: ContainerLifecycleErrorCode;
  message: string;
}

/**
 * Extracts a typed lifecycle failure from an error message. Transport layers
 * may prefix the message (for example `Error invoking remote method ...:`), so
 * the marker is located anywhere in the string.
 */
export function parseContainerLifecycleError(value: unknown): ParsedContainerLifecycleError | null {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : null;
  if (!message) return null;
  const match = /ContainerLifecycleError:([a-z-]+): (.*)$/s.exec(message);
  if (!match) return null;
  const code = match[1];
  if (!isContainerLifecycleErrorCode(code)) return null;
  return { code, message: match[2] ?? "" };
}

export type RecreateEnvironmentIntent = "preserve" | "discard";

export interface RecreateEnvironmentRequest {
  environmentId: string;
  /** Omitted means `preserve`. */
  intent: RecreateEnvironmentIntent;
  /**
   * The runtime the user reviewed before choosing `discard`. Required for
   * discard: a replacement that appeared after the review must not be removed
   * on the strength of a confirmation that described a different container.
   */
  expectedContainerId: string | null;
}

const MAX_ID_LENGTH = 256;

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(formatContainerLifecycleError("invalid-request", `Expected ${field}`));
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(formatContainerLifecycleError("invalid-request", `${field} is too long`));
  }
  return value;
}

/**
 * Validates the `recreate_environment` arguments. Unknown keys are ignored so
 * the command remains callable by adapters that forward extra transport
 * metadata, but every recognised field is strictly typed.
 */
export function parseRecreateEnvironmentRequest(
  args: Record<string, unknown>,
): RecreateEnvironmentRequest {
  const environmentId = boundedId(args.environmentId, "environmentId");
  const rawIntent = args.intent;
  if (rawIntent !== undefined && rawIntent !== "preserve" && rawIntent !== "discard") {
    throw new Error(
      formatContainerLifecycleError("invalid-request", "intent must be preserve or discard"),
    );
  }
  const intent: RecreateEnvironmentIntent = rawIntent ?? "preserve";
  const rawExpected = args.expectedContainerId;
  const expectedContainerId =
    rawExpected === undefined || rawExpected === null
      ? null
      : boundedId(rawExpected, "expectedContainerId");
  if (intent === "discard" && !expectedContainerId) {
    throw new Error(
      formatContainerLifecycleError(
        "invalid-request",
        "Discarding a container requires the container id that was reviewed",
      ),
    );
  }
  return { environmentId, intent, expectedContainerId };
}

/** Plain-language consequence of discarding a legacy container. */
export const LEGACY_CONTAINER_DISCARD_WARNING =
  "Resetting deletes this container's local files: uncommitted and untracked changes, " +
  "ignored files, unpushed commits, installed tools and container-local agent session state. " +
  "The remote Git repository does not back up any of these.";
