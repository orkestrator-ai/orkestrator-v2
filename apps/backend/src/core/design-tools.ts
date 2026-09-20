import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  designId,
  frameSchema,
  htmlSchema,
  revision,
  type DesignService,
} from "./design-service.js";

const canvasInput = { canvasId: designId };
const frameInput = { ...canvasInput, frameId: designId };
const mutationInput = { ...frameInput, expectedRevision: revision };
const selector = z.string().min(1).max(2048);
const styles = z
  .record(z.string().max(100), z.string().max(2048).nullable())
  .refine((value) => Object.keys(value).length <= 64);

/** Also shared by authenticated UI commands: one validation/mutation boundary. */
export function designActions(service: DesignService, environmentId: string) {
  return {
    list_canvases: {
      schema: z.object({}),
      description: "List canvases in this environment.",
      run: () => service.list(environmentId),
    },
    create_canvas: {
      schema: z.object({ name: z.string().min(1).max(120) }),
      description:
        "Create a backend-owned design canvas. Designs use self-contained HTML/CSS; scripts and external resources are disabled.",
      run: (a: { name: string }) => service.create(environmentId, a.name),
    },
    get_canvas: {
      schema: z.object(canvasInput),
      description:
        "Read the authoritative canvas and its current revisions. Read again on revision conflict; never blindly retry edits.",
      run: (a: { canvasId: string }) => service.get(a.canvasId, environmentId),
    },
    create_frame: {
      schema: z.object({
        ...canvasInput,
        expectedRevision: revision,
        ...frameSchema.omit({ id: true, revision: true }).shape,
      }),
      description:
        "Create an HTML frame using the expected CANVAS revision. Returns frame and canvas revisions.",
      run: (a: z.infer<ReturnType<typeof createFrameInput>>) =>
        service.createFrame(a.canvasId, environmentId, a.expectedRevision, a),
    },
    get_frame: {
      schema: z.object(frameInput),
      description: "Read frame HTML, geometry and revision.",
      run: (a: { canvasId: string; frameId: string }) =>
        service.getFrame(a.canvasId, environmentId, a.frameId),
    },
    replace_frame_html: {
      schema: z.object({ ...mutationInput, html: htmlSchema }),
      description: "Replace HTML using the expected FRAME revision.",
      run: (a: Mutation & { html: string }) =>
        service.mutate(a.canvasId, environmentId, a.frameId, a.expectedRevision, { html: a.html }),
    },
    append_frame_html: {
      schema: z.object({ ...mutationInput, html: htmlSchema }),
      description:
        "Stream a complete HTML fragment into a frame body (styles go in head). Each append commits a frame revision. Do not send incomplete tags.",
      run: (a: Mutation & { html: string }) =>
        service.mutate(a.canvasId, environmentId, a.frameId, a.expectedRevision, {
          op: "appendHtml",
          html: a.html,
        }),
    },
    set_element_styles: {
      schema: z.object({ ...mutationInput, selector, styles }),
      description:
        "Set inline CSS on exactly one matching element. null removes a property. Uses FRAME revision.",
      run: (a: Mutation & { selector: string; styles: Record<string, string | null> }) =>
        service.mutate(a.canvasId, environmentId, a.frameId, a.expectedRevision, {
          op: "setStyles",
          selector: a.selector,
          styles: a.styles,
        }),
    },
    replace_element_html: {
      schema: z.object({ ...mutationInput, selector, html: htmlSchema }),
      description: "Replace exactly one element inside the body using FRAME revision.",
      run: (a: Mutation & { selector: string; html: string }) =>
        service.mutate(a.canvasId, environmentId, a.frameId, a.expectedRevision, {
          op: "replaceElementHtml",
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
      }),
      description:
        "Move one element into a parent, optionally before a sibling, using FRAME revision.",
      run: (a: Mutation & { selector: string; parentSelector: string; beforeSelector?: string }) =>
        service.mutate(a.canvasId, environmentId, a.frameId, a.expectedRevision, {
          op: "moveElement",
          selector: a.selector,
          parentSelector: a.parentSelector,
          beforeSelector: a.beforeSelector,
        }),
    },
    update_frame: {
      schema: z.object({
        ...mutationInput,
        patch: frameSchema.omit({ id: true, revision: true, html: true }).partial().strict(),
      }),
      description: "Move, resize or rename a frame using FRAME revision.",
      run: (a: Mutation & { patch: Partial<z.infer<typeof frameSchema>> }) =>
        service.mutate(a.canvasId, environmentId, a.frameId, a.expectedRevision, a.patch),
    },
    inspect_element: {
      schema: z.object({ ...frameInput, selector }),
      description:
        "Inspect computed styles, attributes and bounds on the backend, even without a connected client.",
      run: async (a: { canvasId: string; frameId: string; selector: string }) => {
        const frame = await service.getFrame(a.canvasId, environmentId, a.frameId);
        return {
          revision: frame.revision,
          element: await service.renderer.run(frame, {
            op: "inspectElement",
            selector: a.selector,
          }),
        };
      },
    },
    capture_frame: {
      schema: z.object(frameInput),
      description:
        "Capture a PNG of the authoritative frame in backend Chromium. Works while the canvas is closed.",
      run: async (a: { canvasId: string; frameId: string }) => {
        const frame = await service.getFrame(a.canvasId, environmentId, a.frameId);
        return {
          revision: frame.revision,
          ...((await service.renderer.run(frame, { op: "capture" })) as {
            data: string;
            mimeType: string;
          }),
        };
      },
    },
    export_canvas: {
      schema: z.object(canvasInput),
      description:
        "Get the portable .orkdes document. Save this JSON to a .orkdes file in the repository with your file tools.",
      run: (a: { canvasId: string }) => service.get(a.canvasId, environmentId),
    },
  };
}
function createFrameInput() {
  return z.object({
    ...canvasInput,
    expectedRevision: revision,
    ...frameSchema.omit({ id: true, revision: true }).shape,
  });
}
type Mutation = { canvasId: string; frameId: string; expectedRevision: number };

export async function runDesignAction(
  service: DesignService,
  environmentId: string,
  action: string,
  input: unknown,
): Promise<unknown> {
  const actions = designActions(service, environmentId);
  if (!Object.hasOwn(actions, action)) throw new Error("Unknown design action");
  const tool = actions[action as keyof typeof actions];
  const args = tool.schema.parse(input);
  return (tool.run as (input: unknown) => Promise<unknown>)(args);
}

export function createDesignMcp(service: DesignService, environmentId: string) {
  const server = new McpServer({ name: "orkestrator-design", version: "1.0.0" });
  for (const [toolName, tool] of Object.entries(designActions(service, environmentId))) {
    server.registerTool(
      toolName,
      { description: tool.description, inputSchema: tool.schema },
      async (args: unknown) => {
        try {
          const result = await runDesignAction(service, environmentId, toolName, args);
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
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof z.ZodError
                    ? "Invalid design input"
                    : error instanceof Error
                      ? error.message
                      : "Design operation failed",
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
