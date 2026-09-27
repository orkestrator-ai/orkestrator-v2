/**
 * Server side of part-level transcript patches (efficiency step 14).
 *
 * Only a client that negotiated `NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION` gets
 * patches; everyone else keeps the whole-message delta. A changed message is
 * patched only when its patch encodes smaller than the message itself, so the
 * representation can never cost more than it did before.
 */
import {
  buildNativeAgentMessagePatch,
  type NativeAgentMessagePatch,
} from "@orkestrator/protocol/native-agent-transcript-patch";
import type { NativeAgentTranscriptDelta } from "@orkestrator/protocol/native-agent";
import { encodedValue } from "./native-agent-projection-encoding.js";

const encode = (value: unknown) => encodedValue(value).json;

/** Encoded bytes of a patch list, as it will appear in the response. */
export function encodedPatchBytes(patches: readonly NativeAgentMessagePatch[]): number {
  return Buffer.byteLength(JSON.stringify(patches));
}

/**
 * Replace whole-message upserts with patches against the base view's version
 * of the same message wherever that is smaller. Mutates `delta`.
 */
export function patchTranscriptDelta(
  delta: NativeAgentTranscriptDelta,
  previousMessages: readonly unknown[],
): void {
  const previousById = new Map<string, unknown>();
  for (const message of previousMessages) {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id === "string") previousById.set(id, message);
  }
  const upserts: unknown[] = [];
  const patches: NativeAgentMessagePatch[] = [];
  for (const message of delta.messageUpserts) {
    const id = (message as { id?: unknown } | null)?.id;
    const previous = typeof id === "string" ? previousById.get(id) : undefined;
    const patch =
      previous === undefined ? undefined : buildNativeAgentMessagePatch(previous, message, encode);
    if (patch && Buffer.byteLength(JSON.stringify(patch)) < encodedValue(message).bytes) {
      patches.push(patch);
    } else {
      upserts.push(message);
    }
  }
  if (patches.length === 0) return;
  delta.messageUpserts = upserts;
  delta.messagePatches = patches;
}
