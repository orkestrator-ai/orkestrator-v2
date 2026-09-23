import {
  isPreviewServiceRef,
  normalizePreviewPath,
  parsePreviewUrlIntent,
  previewFailure,
  type PreviewScheme,
  type PreviewServiceSnapshot,
  type PreviewTargetKind,
  type PreviewUrlSource,
} from "@orkestrator/protocol/preview-services";

import type { Environment } from "./models.js";
import type { PreviewServiceRegistry } from "./preview-service-registry.js";

export type PreviewTargetResolutionResult =
  | { kind: "service"; service: PreviewServiceSnapshot; path: string }
  | { kind: "choose"; candidates: PreviewServiceSnapshot[]; path: string }
  | {
      kind: "unregistered";
      path: string;
      suggestion: { targetKind: PreviewTargetKind; applicationPort: number; scheme: PreviewScheme };
      /** The URL was a bind-address hint (`0.0.0.0`) rather than a reachable host. */
      bindHint: boolean;
    }
  | { kind: "manual"; path: string; scheme: PreviewScheme; hostPort: number };

const SOURCES: readonly PreviewUrlSource[] = [
  "container-terminal",
  "worktree-terminal",
  "address-bar",
  "agent-link",
];

/**
 * Resolve a service reference or a bounded URL intent. The interpretation is
 * owned by the *source*: `localhost:3000` in a container terminal means the
 * application port inside that container, never backend host port 3000. An
 * unregistered or ambiguous service produces a choice, not a guess.
 */
export async function resolvePreviewTargetIntent(
  registry: PreviewServiceRegistry,
  args: Record<string, unknown>,
  loadEnvironment: (environmentId: string) => Promise<Environment | null>,
): Promise<PreviewTargetResolutionResult> {
  if (args.serviceRef !== undefined) {
    if (!isPreviewServiceRef(args.serviceRef))
      throw previewFailure("invalid-request", { message: "Invalid service reference." });
    const ref = args.serviceRef;
    if (ref.backendInstanceId !== registry.backendInstanceId) {
      throw previewFailure("not-found", { message: "This tab belongs to a different backend." });
    }
    const service = await registry.refresh(ref.serviceId).catch(() => null);
    if (!service || service.definition.environmentId !== ref.environmentId) {
      throw previewFailure("not-found");
    }
    return { kind: "service", service, path: ref.path };
  }

  const intent = args.intent;
  if (!intent || typeof intent !== "object")
    throw previewFailure("invalid-request", {
      message: "A service reference or URL intent is required.",
    });
  const { url, source, environmentId, mode } = intent as Record<string, unknown>;
  if (typeof source !== "string" || !SOURCES.includes(source as PreviewUrlSource)) {
    throw previewFailure("invalid-request", { message: "Invalid intent source." });
  }
  if (typeof environmentId !== "string" || !environmentId)
    throw previewFailure("invalid-request", { message: "Invalid environment." });
  if (typeof url !== "string")
    throw previewFailure("invalid-request", { message: "Invalid address." });
  const environment = await loadEnvironment(environmentId);
  if (!environment) throw previewFailure("not-found", { message: "Environment not found." });

  // An agent link or address-bar entry in a container environment follows the
  // container's semantics; in a local environment, the worktree's.
  const effective: PreviewUrlSource =
    source === "agent-link"
      ? environment.environmentType === "containerized"
        ? "container-terminal"
        : "worktree-terminal"
      : (source as PreviewUrlSource);
  const parsed = parsePreviewUrlIntent(url, effective, environmentId);
  const path = normalizePreviewPath(parsed.path);

  if (effective === "address-bar" && mode === "manual") {
    return { kind: "manual", path, scheme: parsed.scheme, hostPort: parsed.port };
  }

  const kinds: PreviewTargetKind[] =
    effective === "container-terminal"
      ? ["container"]
      : effective === "worktree-terminal"
        ? ["worktree", "backend-host"]
        : ["container", "worktree", "backend-host"];
  if (effective === "container-terminal" && environment.environmentType !== "containerized") {
    throw previewFailure("invalid-request", { message: "This environment has no container." });
  }
  let candidates = registry
    .listDefinitions(environmentId)
    .filter(
      (definition) =>
        kinds.includes(definition.targetKind) && definition.applicationPort === parsed.port,
    );
  const sameScheme = candidates.filter((definition) => definition.scheme === parsed.scheme);
  if (sameScheme.length) candidates = sameScheme;
  const snapshots = candidates
    .map((definition) => registry.serviceSnapshot(definition.serviceId))
    .filter((snapshot): snapshot is PreviewServiceSnapshot => snapshot !== null);
  if (snapshots.length === 1) return { kind: "service", service: snapshots[0]!, path };
  if (snapshots.length > 1) return { kind: "choose", candidates: snapshots, path };
  return {
    kind: "unregistered",
    path,
    bindHint: parsed.host === "0.0.0.0",
    suggestion: {
      targetKind: environment.environmentType === "containerized" ? "container" : "worktree",
      applicationPort: parsed.port,
      scheme: parsed.scheme,
    },
  };
}
