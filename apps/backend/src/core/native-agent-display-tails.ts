import { createHash } from "node:crypto";

export const NATIVE_DISPLAY_TAIL_VERSION = 2 as const;
export const NATIVE_DISPLAY_TAIL_SCHEMA = "native-agent-display-tail-v2";
export const NATIVE_DISPLAY_TAIL_LEGACY_VERSION = 1 as const;
export const NATIVE_DISPLAY_TAIL_LEGACY_SCHEMA = "native-agent-display-tail-v1";
export const NATIVE_DISPLAY_TAIL_MAX_BYTES = 512 * 1024;
export const NATIVE_DISPLAY_TAIL_MAX_SESSIONS = 128;
export const NATIVE_DISPLAY_TAIL_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS = 2_000;

/** Recovery fields only — never persist tokens, credentials, or payload bodies. */
export interface NativeAgentDisplayTailWindow {
  limit: number;
  truncated: boolean;
  truncationReason?: "count" | "bytes";
  omittedMessages?: number;
  canLoadEarlier?: boolean;
}

export interface NativeAgentDisplayTail {
  version: typeof NATIVE_DISPLAY_TAIL_VERSION | typeof NATIVE_DISPLAY_TAIL_LEGACY_VERSION;
  schema: typeof NATIVE_DISPLAY_TAIL_SCHEMA | typeof NATIVE_DISPLAY_TAIL_LEGACY_SCHEMA;
  environmentId: string;
  agent: string;
  logicalSessionKey: string;
  providerSessionId: string;
  historyEpoch: string;
  title?: string;
  messages: unknown[];
  /** Absent on v1 tails; treat that as unknown rather than complete. */
  historyComplete?: boolean;
  messageWindow?: NativeAgentDisplayTailWindow;
  checksum: string;
  updatedAt: string;
}

export function stripDisplayTailPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripDisplayTailPayload);
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (
      key === "toolOutput" ||
      key === "toolError" ||
      key === "interactions" ||
      key === "approvals" ||
      key === "token" ||
      key === "knownToken" ||
      key === "credentials"
    ) {
      continue;
    }
    if (key === "fileUrl" && typeof entry === "string" && entry.startsWith("data:")) continue;
    if (key === "toolDiff" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      const diff = entry as Record<string, unknown>;
      next.toolDiff = {
        ...(typeof diff.filePath === "string" ? { filePath: diff.filePath } : {}),
        ...(typeof diff.additions === "number" ? { additions: diff.additions } : {}),
        ...(typeof diff.deletions === "number" ? { deletions: diff.deletions } : {}),
        deferred: true,
      };
      continue;
    }
    next[key] = stripDisplayTailPayload(entry);
  }
  return next;
}

export function displayTailRecoveryWindow(
  value: unknown,
): NativeAgentDisplayTailWindow | undefined {
  if (!isDisplayTailMessageWindow(value)) return undefined;
  return {
    limit: value.limit,
    truncated: value.truncated,
    ...(value.truncationReason ? { truncationReason: value.truncationReason } : {}),
    ...(value.omittedMessages === undefined ? {} : { omittedMessages: value.omittedMessages }),
    ...(value.canLoadEarlier === undefined ? {} : { canLoadEarlier: value.canLoadEarlier }),
  };
}

export function displayTailChecksum(input: Omit<NativeAgentDisplayTail, "checksum">): string {
  return input.version === NATIVE_DISPLAY_TAIL_LEGACY_VERSION
    ? displayTailChecksumV1(input)
    : displayTailChecksumV2(input);
}

function displayTailChecksumV1(input: Omit<NativeAgentDisplayTail, "checksum">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.version,
        input.schema,
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
        input.providerSessionId,
        input.historyEpoch,
        input.title ?? "",
        input.messages,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

function displayTailChecksumV2(input: Omit<NativeAgentDisplayTail, "checksum">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.version,
        input.schema,
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
        input.providerSessionId,
        input.historyEpoch,
        input.title ?? "",
        input.messages,
        input.historyComplete === true,
        input.messageWindow ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

export function createNativeAgentDisplayTail(
  input: Omit<NativeAgentDisplayTail, "version" | "schema" | "checksum" | "messages"> & {
    messages: unknown[];
  },
): NativeAgentDisplayTail | null {
  const messages = stripDisplayTailPayload(input.messages);
  if (!Array.isArray(messages)) return null;
  const messageWindow = displayTailRecoveryWindow(input.messageWindow);
  const record: Omit<NativeAgentDisplayTail, "checksum"> = {
    version: NATIVE_DISPLAY_TAIL_VERSION,
    schema: NATIVE_DISPLAY_TAIL_SCHEMA,
    environmentId: input.environmentId,
    agent: input.agent,
    logicalSessionKey: input.logicalSessionKey,
    providerSessionId: input.providerSessionId,
    historyEpoch: input.historyEpoch,
    ...(input.title ? { title: input.title } : {}),
    messages,
    historyComplete: input.historyComplete === true,
    ...(messageWindow ? { messageWindow } : {}),
    updatedAt: input.updatedAt,
  };
  const checksum = displayTailChecksum(record);
  const tail: NativeAgentDisplayTail = { ...record, checksum };
  if (Buffer.byteLength(JSON.stringify(tail)) > NATIVE_DISPLAY_TAIL_MAX_BYTES) return null;
  return tail;
}

export function isNativeAgentDisplayTail(value: unknown): value is NativeAgentDisplayTail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const legacy =
    candidate.version === NATIVE_DISPLAY_TAIL_LEGACY_VERSION &&
    candidate.schema === NATIVE_DISPLAY_TAIL_LEGACY_SCHEMA;
  const current =
    candidate.version === NATIVE_DISPLAY_TAIL_VERSION &&
    candidate.schema === NATIVE_DISPLAY_TAIL_SCHEMA;
  if (
    (!legacy && !current) ||
    typeof candidate.environmentId !== "string" ||
    candidate.environmentId.length === 0 ||
    typeof candidate.agent !== "string" ||
    candidate.agent.length === 0 ||
    typeof candidate.logicalSessionKey !== "string" ||
    candidate.logicalSessionKey.length === 0 ||
    typeof candidate.providerSessionId !== "string" ||
    candidate.providerSessionId.length === 0 ||
    typeof candidate.historyEpoch !== "string" ||
    candidate.historyEpoch.length === 0 ||
    !Array.isArray(candidate.messages) ||
    candidate.messages.length > 100 ||
    typeof candidate.checksum !== "string" ||
    candidate.checksum.length === 0 ||
    typeof candidate.updatedAt !== "string"
  ) {
    return false;
  }
  if (
    current &&
    candidate.historyComplete !== undefined &&
    typeof candidate.historyComplete !== "boolean"
  ) {
    return false;
  }
  if (
    candidate.messageWindow !== undefined &&
    !isDisplayTailMessageWindow(candidate.messageWindow)
  ) {
    return false;
  }
  const expected = displayTailChecksum({
    version: candidate.version as NativeAgentDisplayTail["version"],
    schema: candidate.schema as NativeAgentDisplayTail["schema"],
    environmentId: candidate.environmentId,
    agent: candidate.agent,
    logicalSessionKey: candidate.logicalSessionKey,
    providerSessionId: candidate.providerSessionId,
    historyEpoch: candidate.historyEpoch,
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    messages: candidate.messages,
    ...(typeof candidate.historyComplete === "boolean"
      ? { historyComplete: candidate.historyComplete }
      : {}),
    ...(isDisplayTailMessageWindow(candidate.messageWindow)
      ? { messageWindow: displayTailRecoveryWindow(candidate.messageWindow) }
      : {}),
    updatedAt: candidate.updatedAt,
  });
  return expected === candidate.checksum;
}

function isDisplayTailMessageWindow(value: unknown): value is NativeAgentDisplayTailWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  if (
    typeof window.limit !== "number" ||
    !Number.isSafeInteger(window.limit) ||
    window.limit <= 0
  ) {
    return false;
  }
  if (typeof window.truncated !== "boolean") return false;
  if (
    window.truncationReason !== undefined &&
    window.truncationReason !== "count" &&
    window.truncationReason !== "bytes"
  ) {
    return false;
  }
  if (
    window.omittedMessages !== undefined &&
    (typeof window.omittedMessages !== "number" ||
      !Number.isSafeInteger(window.omittedMessages) ||
      window.omittedMessages < 0)
  ) {
    return false;
  }
  if (window.canLoadEarlier !== undefined && typeof window.canLoadEarlier !== "boolean") {
    return false;
  }
  return true;
}
