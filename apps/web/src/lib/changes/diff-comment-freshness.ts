import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { liveCommentPathKey, type DiffCommentAnchor } from "@/stores/diffCommentsStore";

import type { DiffFileSide, DiffIdentity } from "@orkestrator/protocol/change-resources";

function sideKey(side: DiffFileSide): string | null {
  if (side.state === "present") return `blob:${side.blobId}`;
  if (side.state === "absent") return "absent";
  return null;
}

/** Both compared sides of a file identity; null when either side is unknown. */
export function diffContentKey(identity: DiffIdentity): string | null {
  if (identity.kind !== "file") return null;
  const before = sideKey(identity.before);
  const after = sideKey(identity.after);
  return before === null || after === null ? null : `${before}|${after}`;
}

export function liveCommentResource(environmentId: string, anchor: DiffCommentAnchor): string {
  return anchor.resourceKey ?? environmentChangeResourceKey(environmentId);
}

/** Resolve each live path once, with bounded concurrency across a review. */
export async function readLiveCommentContent(
  scope: NodeScope,
  environmentId: string,
  anchors: readonly DiffCommentAnchor[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string | null>> {
  const paths = new Map<string, DiffCommentAnchor>();
  for (const anchor of anchors) {
    if (anchor.source === "live") {
      paths.set(liveCommentPathKey(anchor.resourceKey, anchor.pathId), anchor);
    }
  }
  const backend = backendForScope(scope);
  const pending = Array.from(paths);
  const content = new Map<string, string | null>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length && !scope.disposed && !signal?.aborted) {
        const [key, anchor] = pending[next++]!;
        try {
          const resolved = await backend.resolveLiveChangeDetail({
            resourceKey: liveCommentResource(environmentId, anchor),
            pathId: anchor.pathId,
          });
          content.set(key, resolved.kind === "identity" ? diffContentKey(resolved.identity) : null);
        } catch {
          content.set(key, null);
        }
      }
    }),
  );
  return content;
}
