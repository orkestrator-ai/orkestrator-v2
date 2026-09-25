import { z } from "zod";
import { DESIGN_MAX_DOCUMENT_BYTES } from "@orkestrator/protocol/design-canvas";
import type { DesignCommandResult } from "@orkestrator/protocol/design-operations";
import { DesignError, toDesignFailure } from "./design-errors.js";
import {
  exportPreview,
  exportSave,
  reconcileExport,
  resolveDesignDestination,
} from "./design-exports.js";
import { designId, revision } from "./design-schemas.js";
import { purge } from "./design-service-lifecycle.js";
import type { DesignService } from "./design-service.js";
import { runDesignAction } from "./design-tools.js";
import { validate as validateFrame } from "./design-validation.js";

const environmentIdSchema = z.string().min(1).max(256);
const tokenSchema = z.string().min(1).max(100);

/** Typed envelope: new clients branch on `failure.code`, never on message text. */
async function typed<T>(work: () => Promise<T>): Promise<DesignCommandResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, failure: toDesignFailure(error) };
  }
}

/**
 * The design command surface depends only on this narrow context, so it can be
 * driven directly (e.g. by the component browser harness) without the full
 * backend command context.
 */
export interface DesignCommandContext {
  design?: DesignService;
  storage: { getEnvironment(environmentId: string): Promise<unknown> };
}

export type DesignCommandRegistrar = (
  name: string,
  handler: (args: Record<string, unknown>, context: DesignCommandContext) => Promise<unknown>,
) => void;

async function authorized(args: Record<string, unknown>, context: DesignCommandContext) {
  if (!context.design)
    throw new DesignError("unsupported", "Design service unavailable", { retry: "after-delay" });
  const environmentId = environmentIdSchema.parse(args.environmentId);
  // Typed so v2 envelopes report not-found rather than a generic storage failure.
  if (!(await context.storage.getEnvironment(environmentId)))
    throw new DesignError("not-found", "Environment not found");
  return { design: context.design as DesignService, environmentId };
}

export function registerDesignCommandHandlers(register: DesignCommandRegistrar) {
  // Legacy v1 surface: untyped errors, legacy shapes. The UI acts as the user.
  register("design_action", async (args, context) => {
    const { design, environmentId } = await authorized(args, context);
    return runDesignAction(design, environmentId, z.string().parse(args.action), args.input, {
      actor: "user",
      resolveDestination: () => resolveDesignDestination(context.storage, environmentId),
    });
  });
  register("design_status", async (_args, context) => {
    if (!context.design) return { ready: false, error: "Design service unavailable" };
    return context.design.renderer.status();
  });
  register("design_changes", async (args, context) => {
    if (!context.design) throw new Error("Design service unavailable");
    return context.design.changes(
      designId.parse(args.canvasId),
      environmentIdSchema.parse(args.environmentId),
      z.string().max(100).optional().parse(args.generation),
      revision.parse(args.after),
    );
  });
  register("design_import", async (args, context) => {
    const { design, environmentId } = await authorized(args, context);
    const document = z
      .string()
      .refine((value) => Buffer.byteLength(value) <= DESIGN_MAX_DOCUMENT_BYTES)
      .parse(args.document);
    return design.create(environmentId, "Imported design", document, "user");
  });
  register("design_save", async (args, context) => {
    const { design, environmentId } = await authorized(args, context);
    const canvasId = designId.parse(args.canvasId);
    const destination = await resolveDesignDestination(context.storage, environmentId);
    const filePath = z.string().max(120).parse(args.filePath);
    // Legacy save never overwrites: a collision is reported, not resolved.
    const receipt = await exportSave(
      design,
      environmentId,
      canvasId,
      { destination },
      {
        relativePath: filePath,
        revision: revision.parse(args.expectedRevision),
        expected: { state: "absent" },
      },
    ).catch(async (error) => {
      const failure = toDesignFailure(error);
      if (failure.code !== "export-collision") throw error;
      const preview = await exportPreview(
        design,
        environmentId,
        canvasId,
        { destination },
        filePath,
      );
      if (!preview.target.needsReplaceConfirmation && preview.target.fingerprint)
        return exportSave(
          design,
          environmentId,
          canvasId,
          { destination },
          {
            relativePath: filePath,
            revision: revision.parse(args.expectedRevision),
            expected: { state: "present", digest: preview.target.fingerprint },
          },
        );
      throw error;
    });
    return { filePath: receipt.relativePath, revision: receipt.revision };
  });

  // Protocol v2 surface: typed envelopes, capability negotiated.
  register("design_capabilities", async (_args, context) =>
    typed(async () => {
      if (!context.design) throw new Error("Design service unavailable");
      return context.design.capabilities();
    }),
  );
  register("design_readiness", async (args, context) =>
    typed(async () => {
      if (!context.design) throw new Error("Design service unavailable");
      return context.design.readiness(z.boolean().optional().parse(args.probe) ?? false);
    }),
  );
  register("design_snapshot", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.snapshot(environmentId, designId.parse(args.canvasId));
    }),
  );
  register("design_sync", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.sync(
        environmentId,
        designId.parse(args.canvasId),
        z.string().max(100).optional().parse(args.generation),
        revision.parse(args.after),
        z.number().int().nonnegative().optional().parse(args.statusVersion),
      );
    }),
  );
  register("design_prepare", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.prepare(environmentId, "user", args.descriptor);
    }),
  );
  register("design_execute", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.execute(
        environmentId,
        designId.parse(args.canvasId),
        tokenSchema.parse(args.token),
        {
          waitMs: z.number().int().min(0).max(60_000).optional().parse(args.waitMs),
        },
      );
    }),
  );
  register("design_operation_status", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.status(
        environmentId,
        designId.parse(args.canvasId),
        tokenSchema.parse(args.token),
      );
    }),
  );
  register("design_cancel", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.cancel(
        environmentId,
        designId.parse(args.canvasId),
        tokenSchema.parse(args.token),
      );
    }),
  );
  register("design_library", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.libraryPage(
        environmentId,
        z
          .object({
            search: z.string().max(120).optional(),
            filter: z.enum(["live", "deleted", "all"]).optional(),
            sort: z.enum(["modified", "name"]).optional(),
            offset: z.number().int().nonnegative().optional(),
            limit: z.number().int().min(1).max(50).optional(),
          })
          .strict()
          .parse(args.query ?? {}),
      );
    }),
  );
  register("design_purge", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      await purge(design, environmentId, designId.parse(args.canvasId));
      return { purged: true };
    }),
  );
  register("design_history", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.historyPage(
        environmentId,
        designId.parse(args.canvasId),
        z.number().int().nonnegative().optional().parse(args.offset),
        z.number().int().min(1).max(100).optional().parse(args.limit),
      );
    }),
  );
  register("design_checkpoint", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.checkpoint(
        environmentId,
        designId.parse(args.canvasId),
        z.string().min(1).max(64).parse(args.entryId),
        z.enum(["before", "after"]).parse(args.side),
      );
    }),
  );
  register("design_export_preview", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      const destination = await resolveDesignDestination(context.storage, environmentId);
      return exportPreview(
        design,
        environmentId,
        designId.parse(args.canvasId),
        { destination },
        z.string().max(120).optional().parse(args.relativePath),
      );
    }),
  );
  register("design_export_save", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      const destination = await resolveDesignDestination(context.storage, environmentId);
      const replace = z.string().max(80).optional().parse(args.replaceFingerprint);
      return exportSave(
        design,
        environmentId,
        designId.parse(args.canvasId),
        { destination },
        {
          relativePath: z.string().max(120).parse(args.relativePath),
          revision: revision.parse(args.revision),
          expected: replace ? { state: "present", digest: replace } : { state: "absent" },
        },
      );
    }),
  );
  register("design_export_reconcile", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      const destination = await resolveDesignDestination(context.storage, environmentId);
      return reconcileExport(design, environmentId, designId.parse(args.canvasId), { destination });
    }),
  );
  register("design_validate", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return (
        (await validateFrame(
          design,
          environmentId,
          designId.parse(args.canvasId),
          designId.parse(args.frameId),
        )) ?? null
      );
    }),
  );
  register("design_hierarchy", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.hierarchy(
        environmentId,
        designId.parse(args.canvasId),
        designId.parse(args.frameId),
        {
          ...(args.rootSelector
            ? { rootSelector: z.string().max(2048).parse(args.rootSelector) }
            : {}),
          ...(args.cursor ? { cursor: z.string().max(200).parse(args.cursor) } : {}),
          maxNodes: z.number().int().min(1).max(200).optional().parse(args.maxNodes) ?? 200,
          maxDepth: z.number().int().min(1).max(32).optional().parse(args.maxDepth) ?? 1,
        },
      );
    }),
  );
  register("design_capture", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      return design.capture(
        environmentId,
        designId.parse(args.canvasId),
        designId.parse(args.frameId),
        z.enum(["interactive", "background"]).optional().parse(args.priority) ?? "interactive",
      );
    }),
  );
  register("design_session_link", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      const link = z
        .object({
          tabId: z.string().min(1).max(200),
          sessionId: z.string().min(1).max(200).optional(),
          platform: z.string().min(1).max(40),
          role: z.enum(["design", "implementation"]),
          checkpointId: z.string().max(64).optional(),
          label: z.string().max(120).optional(),
        })
        .strict()
        .parse(args.link);
      return design.linkSession(
        environmentId,
        designId.parse(args.canvasId),
        link,
        z.string().max(40).optional().parse(args.replaceId),
      );
    }),
  );
  register("design_session_unlink", async (args, context) =>
    typed(async () => {
      const { design, environmentId } = await authorized(args, context);
      await design.unlinkSession(
        environmentId,
        designId.parse(args.canvasId),
        z.string().max(40).parse(args.linkId),
      );
      return { unlinked: true };
    }),
  );
}
