import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignActor,
  DesignOperationDescriptor,
  DesignOperationStatus,
} from "@orkestrator/protocol/design-operations";
import { DesignError, toDesignFailure } from "./design-errors.js";
import { exportPreview, exportSave } from "./design-exports.js";
import type { DesignExportDestination } from "./design-export-writer.js";
import {
  descriptorSchema,
  designId,
  frameSchema,
  htmlSchema,
  revision,
  selectorSchema,
  stylesSchema,
} from "./design-schemas.js";
import { findCreate } from "./design-service-lifecycle.js";
import type { DesignService } from "./design-service.js";
import { validate as validateFrame } from "./design-validation.js";

const canvasInput = { canvasId: designId };
const frameInput = { ...canvasInput, frameId: designId };
const mutationInput = { ...frameInput, expectedRevision: revision };
const selector = selectorSchema;
const styles = stylesSchema;
/** Compact results omit HTML; request `full` only when the frame body is needed. */
const responseShape = { response: z.enum(["full", "compact"]).optional() };
const correlation = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._:-]+$/);

export interface DesignActionOptions {
  actor?: DesignActor;
  /** Resolves the environment's repository for safe export. */
  resolveDestination?: () => Promise<DesignExportDestination>;
}

type Mutation = {
  canvasId: string;
  frameId: string;
  expectedRevision: number;
  response?: "full" | "compact";
};

function compactStatus(status: DesignOperationStatus) {
  return {
    token: status.token,
    state: status.state,
    canvasId: status.canvasId,
    ...(status.result
      ? {
          canvasRevision: status.result.canvasRevision,
          frames: status.result.frames,
          ...(status.result.createdFrameId ? { createdFrameId: status.result.createdFrameId } : {}),
          ...(status.result.createdCanvasId
            ? { createdCanvasId: status.result.createdCanvasId }
            : {}),
          ...(status.result.unchangedProperties
            ? { unchangedProperties: status.result.unchangedProperties }
            : {}),
          ...(status.result.validation ? { validation: status.result.validation } : {}),
          ...(status.result.outcomes ? { outcomes: status.result.outcomes } : {}),
        }
      : {}),
    ...(status.failure ? { failure: status.failure } : {}),
  };
}

/** Also shared by authenticated UI commands: one validation/mutation boundary. */
export function designActions(
  service: DesignService,
  environmentId: string,
  options: DesignActionOptions = {},
) {
  const actor = options.actor ?? "agent";
  const frameMutation = async (
    a: Mutation,
    input: DesignOperationDescriptor["input"],
  ): Promise<unknown> => {
    const status = await service.runOnce(environmentId, actor, {
      canvasId: a.canvasId,
      input,
      preconditions: { frameRevision: a.expectedRevision },
    });
    if (a.response === "compact") return compactStatus(status);
    const frame = await service.getFrame(a.canvasId, environmentId, a.frameId);
    return { frame, canvasRevision: status.result?.canvasRevision ?? frame.revision };
  };
  const submit = async (raw: unknown) => {
    const descriptor = descriptorSchema.parse(raw) as DesignOperationDescriptor;
    if (!descriptor.correlationId)
      throw new DesignError(
        "invalid-input",
        "submit_operation requires a correlationId so a retry cannot duplicate work",
      );
    if (descriptor.canvasId) {
      const { record } = await service.loadFor(descriptor.canvasId, environmentId, {
        allowDeleted: true,
      });
      const settled = record.receipts.find(
        (receipt) => receipt.correlationId === descriptor.correlationId,
      );
      if (settled) return compactStatus(settled);
    } else if (descriptor.input.kind === "create_canvas") {
      const settled = (await findCreate(service, environmentId, descriptor.correlationId))?.receipt;
      if (settled) return compactStatus(settled);
    }
    const prepared = await service.prepare(environmentId, actor, descriptor);
    return compactStatus(await service.execute(environmentId, prepared.canvasId, prepared.token));
  };
  return {
    capabilities: {
      schema: z.object({}),
      description: "Report the design protocol version and supported features for this backend.",
      run: async () => service.capabilities(),
    },
    list_canvases: {
      schema: z.object({}),
      description: "List live canvases in this environment (id, name, revision). Metadata only.",
      run: () => service.list(environmentId),
    },
    create_canvas: {
      schema: z.object({ name: z.string().min(1).max(120) }),
      description:
        "Create a backend-owned design canvas. Designs use self-contained HTML/CSS; scripts and external resources are disabled.",
      run: (a: { name: string }) => service.create(environmentId, a.name, undefined, actor),
    },
    delete_canvas: {
      schema: z.object({ ...canvasInput, expectedRevision: revision.optional() }),
      description:
        "Move a canvas in this environment to the recycle bin (recoverable for 7 days). Pass the canvas revision you reviewed.",
      run: async (a: { canvasId: string; expectedRevision?: number }) => {
        const { record } = await service.loadFor(a.canvasId, environmentId);
        await service.runOnce(environmentId, actor, {
          canvasId: a.canvasId,
          input: { kind: "delete_canvas" },
          preconditions: { canvasRevision: a.expectedRevision ?? record.document.revision },
        });
        return { deleted: true, recoverable: true };
      },
    },
    get_canvas: {
      schema: z.object(canvasInput),
      description:
        "Read the authoritative canvas including every frame's HTML. Prefer get_canvas_summary and get_frame for large canvases. Re-read on revision conflict; never blindly retry edits.",
      run: (a: { canvasId: string }) => service.get(a.canvasId, environmentId),
    },
    get_canvas_summary: {
      schema: z.object(canvasInput),
      description:
        "Read canvas and frame revisions, geometry, structure identities and validation without any HTML.",
      run: async (a: { canvasId: string }) => {
        const { record } = await service.loadFor(a.canvasId, environmentId);
        return {
          id: record.canvasId,
          name: record.document.name,
          revision: record.document.revision,
          frames: record.document.frames.map((frame) => {
            const meta = record.frames[frame.id];
            return {
              id: frame.id,
              name: frame.name,
              x: frame.x,
              y: frame.y,
              width: frame.width,
              height: frame.height,
              revision: frame.revision,
              htmlBytes: Buffer.byteLength(frame.html),
              structureId: meta?.structureId,
              validation: meta?.validation.state,
            };
          }),
        };
      },
    },
    get_canvas_state: {
      schema: z.object(canvasInput),
      description:
        "Read one atomic snapshot of the authoritative canvas and your undo/redo availability.",
      run: (a: { canvasId: string }) => service.getCanvasState(a.canvasId, environmentId, actor),
    },
    history_status: {
      schema: z.object(canvasInput),
      description: "Read your undo and redo availability for a canvas.",
      run: (a: { canvasId: string }) => service.historyStatus(a.canvasId, environmentId, actor),
    },
    list_history: {
      schema: z.object({
        ...canvasInput,
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      description:
        "List recent history entries (actor, time, affected frames). Use restore_checkpoint to restore one explicitly.",
      run: (a: { canvasId: string; offset?: number; limit?: number }) =>
        service.historyPage(environmentId, a.canvasId, a.offset, a.limit),
    },
    undo: {
      schema: z.object({ ...canvasInput, expectedRevision: revision }),
      description:
        "Undo your latest edit using the expected CANVAS revision. Refused if someone changed the same frames since.",
      run: (a: { canvasId: string; expectedRevision: number }) =>
        service.undo(a.canvasId, environmentId, a.expectedRevision, actor),
    },
    redo: {
      schema: z.object({ ...canvasInput, expectedRevision: revision }),
      description: "Redo your latest undone edit using the expected CANVAS revision.",
      run: (a: { canvasId: string; expectedRevision: number }) =>
        service.redo(a.canvasId, environmentId, a.expectedRevision, actor),
    },
    create_frame: {
      schema: z.object({
        ...canvasInput,
        expectedRevision: revision,
        ...frameSchema.omit({ id: true, revision: true }).shape,
        ...responseShape,
      }),
      description:
        "Create an HTML frame using the expected CANVAS revision. HTML is validated first (5000 element limit). Returns frame and canvas revisions.",
      run: async (
        a: Omit<DesignFrame, "id" | "revision"> & {
          canvasId: string;
          expectedRevision: number;
          response?: "full" | "compact";
        },
      ) => {
        const status = await service.runOnce(environmentId, actor, {
          canvasId: a.canvasId,
          input: {
            kind: "create_frame",
            frame: { name: a.name, x: a.x, y: a.y, width: a.width, height: a.height, html: a.html },
          },
          preconditions: { canvasRevision: a.expectedRevision },
        });
        if (a.response === "compact") return compactStatus(status);
        const frame = await service.getFrame(
          a.canvasId,
          environmentId,
          status.result!.createdFrameId!,
        );
        return { frame, canvasRevision: status.result!.canvasRevision };
      },
    },
    get_frame: {
      schema: z.object(frameInput),
      description: "Read frame HTML, geometry and revision.",
      run: (a: { canvasId: string; frameId: string }) =>
        service.getFrame(a.canvasId, environmentId, a.frameId),
    },
    replace_frame_html: {
      schema: z.object({ ...mutationInput, html: htmlSchema, ...responseShape }),
      description:
        'Replace HTML using the expected FRAME revision. Byte-identical HTML is an acknowledged no-op. Use response:"compact" to avoid echoing HTML.',
      run: (a: Mutation & { html: string }) =>
        frameMutation(a, { kind: "replace_frame_html", frameId: a.frameId, html: a.html }),
    },
    append_frame_html: {
      schema: z.object({ ...mutationInput, html: htmlSchema, ...responseShape }),
      description:
        "Stream a complete HTML fragment into a frame body (styles go in head). Each append commits a frame revision. Do not send incomplete tags.",
      run: (a: Mutation & { html: string }) =>
        frameMutation(a, { kind: "append_frame_html", frameId: a.frameId, html: a.html }),
    },
    set_element_styles: {
      schema: z.object({ ...mutationInput, selector, styles, ...responseShape }),
      description:
        "Set inline CSS on exactly one matching element. null removes a property. Invalid values are rejected as a whole (nothing applied). Values equal to the current inline value are an acknowledged no-op. Uses FRAME revision.",
      run: (a: Mutation & { selector: string; styles: Record<string, string | null> }) =>
        frameMutation(a, {
          kind: "set_element_styles",
          frameId: a.frameId,
          selector: a.selector,
          styles: a.styles,
        }),
    },
    replace_element_html: {
      schema: z.object({ ...mutationInput, selector, html: htmlSchema, ...responseShape }),
      description: "Replace exactly one element inside the body using FRAME revision.",
      run: (a: Mutation & { selector: string; html: string }) =>
        frameMutation(a, {
          kind: "replace_element_html",
          frameId: a.frameId,
          selector: a.selector,
          html: a.html,
        }),
    },
    move_element: {
      schema: z.object({
        ...mutationInput,
        selector,
        parentSelector: selector,
        beforeSelector: selector.optional(),
        ...responseShape,
      }),
      description:
        "Move one element into a parent, optionally before a sibling, using FRAME revision.",
      run: (a: Mutation & { selector: string; parentSelector: string; beforeSelector?: string }) =>
        frameMutation(a, {
          kind: "move_element",
          frameId: a.frameId,
          selector: a.selector,
          parentSelector: a.parentSelector,
          ...(a.beforeSelector ? { beforeSelector: a.beforeSelector } : {}),
        }),
    },
    update_frame: {
      schema: z.object({
        ...mutationInput,
        patch: frameSchema.omit({ id: true, revision: true, html: true }).partial().strict(),
        ...responseShape,
      }),
      description: "Move, resize or rename a frame using FRAME revision. Equal values are a no-op.",
      run: (a: Mutation & { patch: Partial<DesignFrame> }) =>
        frameMutation(a, { kind: "update_frame", frameId: a.frameId, patch: a.patch }),
    },
    submit_operation: {
      schema: descriptorSchema,
      description:
        "Recoverable edit: submit one operation descriptor ({canvasId, input:{kind,...}, preconditions:{canvasRevision|frameRevision|structureId}, correlationId}). Retrying with the same correlationId returns the original outcome and never duplicates work. Supports rename_canvas, duplicate_canvas, delete_canvas, restore_canvas, create_frame, update_frame, replace_frame_html, set_element_styles, duplicate_frame, delete_frame, restore_checkpoint and batch (≤16 same-canvas operations committed atomically). Returns a compact receipt without HTML.",
      run: submit,
    },
    operation_status: {
      schema: z.object({ ...canvasInput, token: z.string().max(100) }),
      description: "Read the state of a submitted operation. Side-effect free.",
      run: async (a: { canvasId: string; token: string }) =>
        compactStatus(await service.status(environmentId, a.canvasId, a.token)),
    },
    find_operation: {
      schema: z.object({ ...canvasInput, correlationId: correlation }),
      description: "Find the outcome of an earlier submit_operation by its correlationId.",
      run: async (a: { canvasId: string; correlationId: string }) => {
        const { record } = await service.loadFor(a.canvasId, environmentId, { allowDeleted: true });
        const receipt = record.receipts.find(
          (candidate) => candidate.correlationId === a.correlationId,
        );
        return receipt ? compactStatus(receipt) : { state: "unknown" };
      },
    },
    inspect_element: {
      schema: z.object({ ...frameInput, selector }),
      description:
        "Inspect computed styles, inline overrides, attributes and bounds on the backend, even without a connected client.",
      run: async (a: { canvasId: string; frameId: string; selector: string }) =>
        service.inspect(environmentId, a.canvasId, a.frameId, a.selector),
    },
    get_frame_layers: {
      schema: z.object({
        ...frameInput,
        rootSelector: selector.optional(),
        cursor: z.string().max(200).optional(),
        maxNodes: z.number().int().min(1).max(200).optional(),
        maxDepth: z.number().int().min(1).max(32).optional(),
      }),
      description:
        "Page through a frame's element hierarchy (≤200 nodes/128 KiB per page). Continue with nextCursor; a structure change invalidates the cursor.",
      run: (a: {
        canvasId: string;
        frameId: string;
        rootSelector?: string;
        cursor?: string;
        maxNodes?: number;
        maxDepth?: number;
      }) =>
        service.hierarchy(environmentId, a.canvasId, a.frameId, {
          ...(a.rootSelector ? { rootSelector: a.rootSelector } : {}),
          ...(a.cursor ? { cursor: a.cursor } : {}),
          ...(a.maxNodes ? { maxNodes: a.maxNodes } : {}),
          ...(a.maxDepth ? { maxDepth: a.maxDepth } : {}),
        }),
    },
    validate_frame: {
      schema: z.object(frameInput),
      description:
        "Validate a frame's current HTML in the design runtime and report removed scripts, blocked external resources and DOM limits.",
      run: async (a: { canvasId: string; frameId: string }) =>
        (await validateFrame(service, environmentId, a.canvasId, a.frameId)) ?? {
          state: "superseded",
        },
    },
    capture_frame: {
      schema: z.object(frameInput),
      description:
        "Capture a PNG of the authoritative frame in backend Chromium. Works while the canvas is closed. The result names the exact revision it depicts.",
      run: async (a: { canvasId: string; frameId: string }) =>
        service.capture(environmentId, a.canvasId, a.frameId),
    },
    export_canvas: {
      schema: z.object(canvasInput),
      description:
        "Get the portable .orkdes document content. To save it into the repository use save_canvas instead of copying this JSON.",
      run: (a: { canvasId: string }) => service.get(a.canvasId, environmentId),
    },
    save_canvas: {
      schema: z.object({
        ...canvasInput,
        expectedRevision: revision,
        filePath: z.string().max(120),
        replaceFingerprint: z.string().max(80).optional(),
      }),
      description:
        "Save the canvas revision you reviewed to a repository-root .orkdes file. Never overwrites an existing file unless you pass its replaceFingerprint (from a previous collision error); otherwise choose a new filePath. Returns a path/revision receipt, not the document.",
      run: async (a: {
        canvasId: string;
        expectedRevision: number;
        filePath: string;
        replaceFingerprint?: string;
      }) => {
        if (!options.resolveDestination)
          throw new DesignError("unsupported", "Repository export is unavailable here");
        const destination = await options.resolveDestination();
        try {
          return await exportSave(
            service,
            environmentId,
            a.canvasId,
            { destination },
            {
              relativePath: a.filePath,
              revision: a.expectedRevision,
              expected: a.replaceFingerprint
                ? { state: "present", digest: a.replaceFingerprint }
                : { state: "absent" },
            },
          );
        } catch (error) {
          const failure = toDesignFailure(error);
          if (failure.code !== "export-collision") throw error;
          const preview = await exportPreview(
            service,
            environmentId,
            a.canvasId,
            { destination },
            a.filePath,
          ).catch(() => undefined);
          throw new DesignError(
            "export-collision",
            `${failure.message}. Choose another filePath, or pass replaceFingerprint to replace it deliberately.`,
            {
              details: {
                ...(preview?.target.fingerprint
                  ? { replaceFingerprint: preview.target.fingerprint }
                  : {}),
                ...(preview?.target.reason ? { reason: preview.target.reason } : {}),
              },
            },
          );
        }
      },
    },
  };
}

export async function runDesignAction(
  service: DesignService,
  environmentId: string,
  action: string,
  input: unknown,
  options: DesignActionOptions = {},
): Promise<unknown> {
  const actions = designActions(service, environmentId, options);
  if (!Object.hasOwn(actions, action)) throw new Error("Unknown design action");
  const tool = actions[action as keyof typeof actions];
  const args = tool.schema.parse(input);
  return (tool.run as (input: unknown) => Promise<unknown>)(args);
}

export function createDesignMcp(
  service: DesignService,
  environmentId: string,
  resolveDestination?: () => Promise<DesignExportDestination>,
) {
  const server = new McpServer({ name: "orkestrator-design", version: "2.0.0" });
  const options: DesignActionOptions = {
    actor: "agent",
    ...(resolveDestination ? { resolveDestination } : {}),
  };
  for (const [toolName, tool] of Object.entries(designActions(service, environmentId, options))) {
    server.registerTool(
      toolName,
      { description: tool.description, inputSchema: tool.schema },
      async (args: unknown) => {
        try {
          const result = await runDesignAction(service, environmentId, toolName, args, options);
          if (toolName === "capture_frame") {
            const capture = result as { revision: number; data: string; mimeType: string };
            return {
              content: [
                { type: "image" as const, data: capture.data, mimeType: capture.mimeType },
                { type: "text" as const, text: `Frame revision ${capture.revision}` },
              ],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const failure = toDesignFailure(error);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                // Typed code for new clients; the message keeps the legacy prefix.
                text:
                  JSON.stringify({ error: failure }).length < 4096
                    ? `${failure.message}\n${JSON.stringify({ error: failure })}`
                    : failure.message,
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
