import {
  PREVIEW_SESSION_CODE_TTL_MS,
  PREVIEW_SESSION_PATH,
} from "@orkestrator/protocol/preview-access";
import { previewFailure } from "@orkestrator/protocol/preview-services";

import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { resolvePreviewTargetIntent } from "./preview-intent.js";
import type { PreviewRuntime } from "./preview-runtime.js";

async function previews(context: CommandContext): Promise<PreviewRuntime> {
  const runtime = context.previews;
  if (!runtime)
    throw previewFailure("unsupported", {
      message: "Preview services are unavailable on this backend.",
    });
  await runtime.init();
  return runtime;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 256) {
    throw previewFailure("invalid-request", { message: `Invalid ${field}.` });
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value, field);
  if (!text) throw previewFailure("invalid-request", { message: `${field} is required.` });
  return text;
}

function revision(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw previewFailure("invalid-request", { message: `Invalid ${field}.` });
  }
  return value;
}

/**
 * Preview service commands. Every command runs behind the existing
 * authenticated control API; none of them mints connect authority except the
 * explicit attachment commands registered with the access service.
 */
export function registerPreviewCommands(register: CommandRegistrar): void {
  register("get_preview_capabilities", async (_args, context) =>
    (await previews(context)).capabilities(),
  );

  register("get_preview_services", async (args, context) => {
    const runtime = await previews(context);
    const knownRevision = args.knownRevision;
    return runtime.registry.snapshot({
      environmentId: optionalString(args.environmentId, "environment id") ?? null,
      knownEpoch: optionalString(args.knownEpoch, "epoch"),
      knownRevision: typeof knownRevision === "number" ? knownRevision : undefined,
    });
  });

  register("register_preview_service", async (args, context) => {
    const runtime = await previews(context);
    return runtime.registry.register(args.service, {
      operationId: optionalString(args.operationId, "operation id"),
    });
  });

  register("update_preview_service", async (args, context) => {
    const runtime = await previews(context);
    return runtime.registry.update(
      requiredString(args.serviceId, "serviceId"),
      revision(args.expectedRevision, "expected revision"),
      args.patch,
      { operationId: optionalString(args.operationId, "operation id") },
    );
  });

  register("remove_preview_service", async (args, context) => {
    const runtime = await previews(context);
    return runtime.registry.remove(
      requiredString(args.serviceId, "serviceId"),
      args.expectedRevision === undefined
        ? undefined
        : revision(args.expectedRevision, "expected revision"),
      { operationId: optionalString(args.operationId, "operation id") },
    );
  });

  register("resolve_preview_target", async (args, context) => {
    const runtime = await previews(context);
    return resolvePreviewTargetIntent(runtime.registry, args, (environmentId) =>
      context.storage.getEnvironment(environmentId),
    );
  });

  register("probe_preview_service", async (args, context) => {
    const runtime = await previews(context);
    return runtime.registry.refresh(requiredString(args.serviceId, "serviceId"), { probe: true });
  });

  register("create_preview_attachment", async (args, context) => {
    const runtime = await previews(context);
    return runtime.access.createAttachment(args);
  });

  register("renew_preview_attachment", async (args, context) => {
    const runtime = await previews(context);
    return runtime.access.renewAttachment(args.attachmentId);
  });

  register("release_preview_attachment", async (args, context) => {
    const runtime = await previews(context);
    return runtime.access.releaseAttachment(args.attachmentId);
  });

  /**
   * Handoff for clients that cannot POST a grant to the bootstrap authority
   * (the iOS app hands navigations to Safari as URLs). The grant is consumed
   * here, server-side; the returned URL carries only the one-use, 30-second
   * session code bound to the service's own host.
   */
  register("create_preview_handoff_url", async (args, context) => {
    const runtime = await previews(context);
    const attachment = await runtime.access.createAttachment({
      ...args,
      surface: "browser-top-level",
    });
    if (!attachment.bootstrap) throw previewFailure("unsupported");
    const { code, origin } = runtime.access.consumeBootstrapGrant(
      attachment.attachmentId,
      attachment.bootstrap.grant,
    );
    return {
      url: `${origin}${PREVIEW_SESSION_PATH}?code=${encodeURIComponent(code)}`,
      expiresAt: new Date(Date.now() + PREVIEW_SESSION_CODE_TTL_MS).toISOString(),
    };
  });

  /** The clean, shareable private origin of a published service (no credential). */
  register("get_preview_public_origin", async (args, context) => {
    const runtime = await previews(context);
    return {
      origin: runtime.publication?.originFor(requiredString(args.serviceId, "serviceId")) ?? null,
    };
  });

  /** Operator action: close active preview transport. Separate from the issuance kill switch. */
  register("revoke_preview_access", async (args, context) => {
    const runtime = await previews(context);
    const serviceId = optionalString(args.serviceId, "serviceId");
    return {
      revoked: serviceId
        ? runtime.access.revokeServices([serviceId], "operator-revoked")
        : runtime.access.revokeAll("operator-revoked"),
    };
  });

  register("get_preview_settings", async (_args, context) => {
    const runtime = await previews(context);
    return { stored: runtime.storedSettings(), effective: runtime.effectiveSettings() };
  });

  register("update_preview_settings", async (args, context) => {
    const runtime = await previews(context);
    const patch = args.settings;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw previewFailure("invalid-request", { message: "Settings must be an object." });
    }
    const input = patch as Record<string, unknown>;
    await runtime.updateSettings((current) => ({
      ...current,
      ...(typeof input.transport === "boolean" ? { transport: input.transport } : {}),
      ...(typeof input.relay === "boolean" ? { relay: input.relay } : {}),
      ...(input.publication && typeof input.publication === "object"
        ? { publication: { ...current.publication, ...(input.publication as object) } }
        : {}),
    }));
    return { stored: runtime.storedSettings(), effective: runtime.effectiveSettings() };
  });
}
