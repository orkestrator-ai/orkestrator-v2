import { createHash } from "node:crypto";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  nativeAgentCapabilities,
  type NativeAgentCommandIntent,
} from "@orkestrator/protocol/native-agent";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import type { Environment } from "../models.js";
import { mimeTypeForImageData, type PromptAttachment } from "../prompt-attachments.js";
import { PublicActionError } from "./errors.js";
import { invalid, optionalBoolean } from "./input.js";
import type { ResolvedSession } from "./sessions.js";
import type { ExecuteOutcome, OperationHandle, PublicActionContext } from "./types.js";

/**
 * How a public prompt reaches the provider, beyond its text: explicit literal
 * intent, files sent with it, and the backend's durable queue for a busy
 * session. Every piece is part of the request's fingerprint (attachments by
 * digest, never by content), so a replay with different files or a different
 * intent conflicts instead of silently sending something else.
 */

// ---------------------------------------------------------------------------
// Literal intent

/**
 * `literal: true` is sent as `allowProviderCommands: false`. Absent keeps the
 * session's own default (a native tab reads a leading `/name` as a typed
 * command); `false` is accepted and means the same as absent.
 */
export function parseLiteral(input: Record<string, unknown>): true | undefined {
  return optionalBoolean(input, "literal") === true ? true : undefined;
}

// ---------------------------------------------------------------------------
// Attachments

export interface ParsedAttachment {
  name: string;
  type: "image" | "file";
  bytes: number;
  sha256: string;
  /** Base64 payload; kept in memory only, never in the operation record. */
  dataBase64: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function hasImageSignature(data: Buffer): boolean {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return true;
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true;
  const header = data.subarray(0, 6).toString("latin1");
  if (header === "GIF87a" || header === "GIF89a") return true;
  return (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

function attachmentName(raw: unknown, index: number): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw invalid(`attachments[${index}].name is required`);
  }
  if (raw.length > PUBLIC_API_LIMITS.promptAttachmentNameMaxChars) {
    throw new PublicActionError("input-too-large", `attachments[${index}].name is too long`);
  }
  // A name, never a path: the backend chooses where the file goes.
  if (/[\\/\0]/.test(raw) || raw === "." || raw === "..") {
    throw invalid(`attachments[${index}].name must be a file name without directories`);
  }
  return raw;
}

/** Strict validation; the data is decoded once here to bound and digest it. */
export function parseAttachments(input: Record<string, unknown>): ParsedAttachment[] | undefined {
  const raw = input.attachments;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw invalid("attachments must be an array");
  if (raw.length === 0) return undefined;
  if (raw.length > PUBLIC_API_LIMITS.promptAttachmentsMaxItems) {
    throw new PublicActionError(
      "input-too-large",
      `At most ${PUBLIC_API_LIMITS.promptAttachmentsMaxItems} attachments are allowed`,
    );
  }
  let total = 0;
  const names = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalid(`attachments[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "name" && key !== "type" && key !== "dataBase64") {
        throw invalid(`Unknown input field: attachments[${index}].${key.slice(0, 64)}`);
      }
    }
    const name = attachmentName(record.name, index);
    if (names.has(name)) throw invalid(`attachments[${index}].name repeats another attachment`);
    names.add(name);
    const data = record.dataBase64;
    if (typeof data !== "string" || data.length === 0) {
      throw invalid(`attachments[${index}].dataBase64 is required`);
    }
    if (data.length % 4 !== 0 || !BASE64.test(data)) {
      throw invalid(`attachments[${index}].dataBase64 is not valid base64`);
    }
    // Bound before decoding: base64 is 4 characters per 3 bytes.
    if ((data.length / 4) * 3 - 2 > PUBLIC_API_LIMITS.promptAttachmentsMaxBytes) {
      throw new PublicActionError("input-too-large", "Attachments are too large");
    }
    const decoded = Buffer.from(data, "base64");
    total += decoded.length;
    if (total > PUBLIC_API_LIMITS.promptAttachmentsMaxBytes) {
      throw new PublicActionError(
        "input-too-large",
        `Attachments exceed ${PUBLIC_API_LIMITS.promptAttachmentsMaxBytes} bytes in total`,
      );
    }
    if (decoded.length === 0) throw new PublicActionError("empty-input", `${name} is empty`);
    const declared = record.type;
    if (declared !== undefined && declared !== "image" && declared !== "file") {
      throw invalid(`attachments[${index}].type must be one of: image, file`);
    }
    const image = hasImageSignature(decoded);
    if (declared === "image" && !image) {
      throw invalid(`attachments[${index}] is not a PNG, JPEG, GIF or WebP image`);
    }
    return {
      name,
      type: declared ?? (image ? "image" : "file"),
      bytes: decoded.length,
      sha256: createHash("sha256").update(decoded).digest("hex"),
      dataBase64: data,
    };
  });
}

/** The fingerprinted form: names, types and digests, no content. */
export function attachmentIntent(
  attachments: readonly ParsedAttachment[] | undefined,
): Array<Omit<ParsedAttachment, "dataBase64">> | undefined {
  return attachments?.map(({ name, type, bytes, sha256 }) => ({ name, type, bytes, sha256 }));
}

export function assertAttachmentSupport(
  agent: AgentPlatform,
  attachments: readonly ParsedAttachment[] | undefined,
): void {
  if (!attachments?.length) return;
  const support = nativeAgentCapabilities(agent).attachments;
  if (attachments.some((attachment) => attachment.type === "image") && !support.images) {
    throw new PublicActionError("capability-unavailable", `${agent} does not accept images`);
  }
  if (attachments.some((attachment) => attachment.type === "file") && !support.files) {
    throw new PublicActionError(
      "capability-unavailable",
      `${agent} accepts image attachments only; send other files as workspace files`,
    );
  }
}

const STAGING_ROOT = ".orkestrator/prompt-attachments";

function stagedFilename(name: string, index: number): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return `${String(index + 1).padStart(2, "0")}-${safe.slice(0, 120) || "attachment"}`;
}

/**
 * Write the attachments into the environment workspace, under a directory
 * named for this operation, and describe them as the bridges expect. Runs
 * after admission and before dispatch; a replay of the same key returns the
 * recorded operation and never stages twice. The files live with the
 * workspace and are removed when the environment is deleted.
 */
export async function stageAttachments(
  context: PublicActionContext,
  environment: Environment,
  operationId: string,
  attachments: readonly ParsedAttachment[] | undefined,
): Promise<PromptAttachment[]> {
  if (!attachments?.length) return [];
  const local = environment.environmentType === "local";
  if (local && !environment.worktreePath) {
    throw new PublicActionError("not-ready", "The environment has no worktree for attachments");
  }
  if (!local && !environment.containerId) {
    throw new PublicActionError("not-ready", "The environment has no container for attachments");
  }
  const directory = `${STAGING_ROOT}/${operationId}`;
  const staged: PromptAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const filename = stagedFilename(attachment.name, index);
    const relativePath = `${directory}/${filename}`;
    const path = local
      ? await context.invoke<string>("write_local_file", {
          worktreePath: environment.worktreePath,
          filePath: relativePath,
          base64Data: attachment.dataBase64,
        })
      : await (async () => {
          await context.invoke("write_container_file", {
            containerId: environment.containerId,
            filePath: relativePath,
            base64Data: attachment.dataBase64,
          });
          return `/workspace/${relativePath}`;
        })();
    staged.push(
      attachment.type === "image"
        ? {
            type: "image",
            path,
            filename: attachment.name,
            dataUrl: `data:${mimeTypeForImageData(attachment.name, attachment.dataBase64)};base64,${attachment.dataBase64}`,
          }
        : { type: "file", path, filename: attachment.name },
    );
  }
  return staged;
}

// ---------------------------------------------------------------------------
// Durable enqueue

export function parseEnqueue(input: Record<string, unknown>): true | undefined {
  return optionalBoolean(input, "enqueue") === true ? true : undefined;
}

export function assertQueueSupport(agent: AgentPlatform): void {
  if (!nativeAgentCapabilities(agent).queue) {
    throw new PublicActionError(
      "capability-unavailable",
      `${agent} sessions have no prompt queue; wait for the turn to end instead`,
    );
  }
}

/** The backend's native prompt-queue key (`<agent>\0<logical session key>`). */
export function nativePromptQueueKey(agent: AgentPlatform, logicalSessionKey: string): string {
  return `${agent}\0${logicalSessionKey}`;
}

/**
 * Append the prompt to the session's durable queue under the operation's own
 * ID, so the queued item, the dispatch request and the public run share one
 * identity: a replay finds the same item, and the backend drainer — not this
 * request — sends it when the session is free. Order is the queue's FIFO.
 */
export async function enqueuePrompt(
  context: PublicActionContext,
  operation: OperationHandle,
  session: ResolvedSession,
  message: {
    text: string;
    mode?: "plan" | "build";
    command?: NativeAgentCommandIntent;
    attachments?: PromptAttachment[];
  },
  result: Record<string, unknown>,
): Promise<ExecuteOutcome> {
  const requestId = operation.operationId;
  const queueKey = nativePromptQueueKey(session.agent, session.logicalSessionKey);
  await operation.update({ stage: "queueing", resources: { dispatchRequestId: requestId } });
  const queued = {
    id: requestId,
    requestId,
    text: message.text,
    ...(message.mode
      ? {
          mode: message.mode,
          // Claude's queue entries carry the composer's plan flag instead.
          ...(session.agent === "claude" ? { planModeEnabled: message.mode === "plan" } : {}),
        }
      : {}),
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    ...(message.command ? { command: message.command } : {}),
  };
  const { status } = await context.command.storage.enqueuePromptQueueMessageIfAbsent(
    queueKey,
    session.environment.id,
    queued,
  );
  try {
    context.command.nativeAgents?.notifyPromptQueueChanged?.(queueKey);
  } catch {
    // The drainer's periodic sweep is the safety net for a missed wake-up.
  }
  if (status === "consumed") {
    return {
      state: "running",
      stage: "executing",
      result,
      dispatch: { state: "accepted" },
      execution: { state: "pending" },
    };
  }
  return {
    state: "running",
    stage: "queued",
    result: { ...result, queued: true },
    dispatch: { state: "pending" },
    execution: { state: "pending", reason: "Queued behind the session's current work" },
  };
}
