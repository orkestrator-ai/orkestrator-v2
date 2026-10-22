import { createContext, useContext, useMemo } from "react";
import type { ToolChangeScope } from "@/hooks/useChangeProjection";

/**
 * Which environment and provider conversation a transcript belongs to, so
 * tool rows can ask the backend for their change presentations.
 *
 * `provider` is the native agent id (claude, codex, cursor, grok, pi,
 * opencode) and `conversationId` the provider session id the bridge reports
 * evidence under. Absent (null) outside a native agent tab — pipeline and
 * review transcripts — where rows fall back to their legacy presentation.
 */
export interface NativeChangeScope {
  environmentId: string;
  provider?: string;
  conversationId?: string;
}

export const NativeChangeScopeContext = createContext<NativeChangeScope | null>(null);

export function useNativeChangeScope(): NativeChangeScope | null {
  return useContext(NativeChangeScopeContext);
}

/** The full tool scope, or null when the conversation is not yet known. */
export function useToolChangeScope(): ToolChangeScope | null {
  const scope = useNativeChangeScope();
  const environmentId = scope?.environmentId;
  const provider = scope?.provider;
  const conversationId = scope?.conversationId;
  return useMemo(
    () =>
      environmentId && provider && conversationId
        ? { environmentId, provider, conversationId }
        : null,
    [environmentId, provider, conversationId],
  );
}
