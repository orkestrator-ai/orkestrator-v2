/**
 * Shared message types used by all native-mode chat UIs (OpenCode, Claude, Codex).
 *
 * Currently aliased to the OpenCode types because all three agents share the
 * same message shape.  If an agent's message model diverges in the future,
 * replace these aliases with a standalone interface and add per-agent mappers.
 */
import type {
  OpenCodeMessage,
  OpenCodeMessagePart,
} from "@/lib/opencode-client";

export type NativeMessage = OpenCodeMessage;
export type NativeMessagePart = OpenCodeMessagePart;
