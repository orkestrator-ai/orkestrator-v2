import { z } from "zod";
import { DESIGN_MAX_DOCUMENT_BYTES } from "@orkestrator/protocol/design-canvas";
import { designId, revision } from "./design-service.js";
import { runDesignAction } from "./design-tools.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";

export function registerDesignCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
) {
  register("design_action", async (args, context) => {
    if (!context.design) throw new Error("Design service unavailable");
    const environmentId = z.string().min(1).max(256).parse(args.environmentId);
    if (!(await context.storage.getEnvironment(environmentId)))
      throw new Error("Environment not found");
    return runDesignAction(
      context.design,
      environmentId,
      z.string().parse(args.action),
      args.input,
    );
  });
  register("design_changes", async (args, context) => {
    if (!context.design) throw new Error("Design service unavailable");
    return context.design.changes(
      designId.parse(args.canvasId),
      z.string().min(1).parse(args.environmentId),
      z.string().max(100).optional().parse(args.generation),
      revision.parse(args.after),
    );
  });
  register("design_import", async (args, context) => {
    if (!context.design) throw new Error("Design service unavailable");
    const environmentId = z.string().min(1).parse(args.environmentId);
    if (!(await context.storage.getEnvironment(environmentId)))
      throw new Error("Environment not found");
    const document = z
      .string()
      .refine((value) => Buffer.byteLength(value) <= DESIGN_MAX_DOCUMENT_BYTES)
      .parse(args.document);
    return context.design.create(environmentId, "Imported design", document);
  });
  register("design_save", async (args, context) => {
    if (!context.design) throw new Error("Design service unavailable");
    const environmentId = z.string().min(1).parse(args.environmentId);
    const canvas = await context.design.get(designId.parse(args.canvasId), environmentId);
    if (revision.parse(args.expectedRevision) !== canvas.revision)
      throw new Error("Design revision conflict: refresh before saving");
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) throw new Error("Environment not found");
    const filePath = z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.orkdes$/)
      .parse(args.filePath);
    const base64Data = Buffer.from(JSON.stringify(canvas, null, 2)).toString("base64");
    const local = environment.environmentType === "local";
    const command = dependencies.commands.get(local ? "write_local_file" : "write_container_file");
    if (!command) throw new Error("File writer unavailable");
    await command(
      {
        filePath,
        base64Data,
        ...(local
          ? { worktreePath: environment.worktreePath }
          : { containerId: environment.containerId }),
      },
      context,
    );
    return { filePath, revision: canvas.revision };
  });
}
