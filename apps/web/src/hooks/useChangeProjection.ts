import { useEffect } from "react";
import {
  environmentChangeResourceKey,
  type CanonicalToolPresentation,
  type ChangeProjection,
} from "@orkestrator/protocol/change-resources";
import {
  requestToolPresentation,
  subscribeToolPresentation,
  subscribeChangeResource,
} from "@/lib/changes/subscriptions";
import { toolPresentationKey, useChangeProjectionStore } from "@/stores/changeProjectionStore";

/**
 * The backend's projection for one change resource, kept current by the
 * shared subscription. `undefined` until the first read answers (or when the
 * backend has no change tracking); the caller then shows its loading or
 * legacy state — never a locally computed number.
 */
export function useChangeProjection(
  resourceKey: string | null | undefined,
): ChangeProjection | undefined {
  useEffect(() => {
    if (!resourceKey) return;
    return subscribeChangeResource(resourceKey);
  }, [resourceKey]);
  return useChangeProjectionStore((state) =>
    resourceKey ? state.projections.get(resourceKey) : undefined,
  );
}

export function useEnvironmentChangeProjection(environmentId: string | null | undefined) {
  return useChangeProjection(environmentId ? environmentChangeResourceKey(environmentId) : null);
}

/** Content generation of a live resource; changes even when counts do not. */
export function useChangeContentGeneration(resourceKey: string | null | undefined) {
  return useChangeProjectionStore((state) =>
    resourceKey ? state.contentGenerations.get(resourceKey) : undefined,
  );
}

export interface ToolChangeScope {
  environmentId: string;
  provider: string;
  conversationId: string;
}

/**
 * A transcript tool row's change presentation plus the projections of each
 * role it references. `revisionHint` (for example the row's tool state) makes
 * the row ask again when its transcript part moved on.
 */
export function useToolChangePresentation(
  scope: ToolChangeScope | null,
  callId: string | undefined,
  revisionHint?: string,
): {
  presentation: CanonicalToolPresentation | null | undefined;
  projections: Array<{
    role: "payload" | "effect" | "observation";
    prominence: "primary" | "secondary";
    projection: ChangeProjection | undefined;
  }>;
} {
  const key =
    scope && callId
      ? toolPresentationKey(scope.environmentId, scope.provider, scope.conversationId, callId)
      : null;
  useEffect(() => {
    if (!scope || !callId) return;
    const release = subscribeToolPresentation(scope, callId);
    if (revisionHint !== undefined) requestToolPresentation(scope, callId, true);
    return release;
  }, [scope, callId, revisionHint]);
  const presentation = useChangeProjectionStore((state) =>
    key ? state.toolPresentations.get(key) : undefined,
  );
  const changeKeys = presentation?.changes.map((change) => change.resourceKey).join("\n") ?? "";
  useEffect(() => {
    if (!changeKeys) return;
    const releases = changeKeys
      .split("\n")
      .map((resourceKey) => subscribeChangeResource(resourceKey));
    return () => {
      for (const release of releases) release();
    };
  }, [changeKeys]);
  const projections = useChangeProjectionStore((state) => state.projections);
  return {
    presentation,
    projections: (presentation?.changes ?? []).map((change) => ({
      role: change.role,
      prominence: change.prominence,
      projection: projections.get(change.resourceKey),
    })),
  };
}
