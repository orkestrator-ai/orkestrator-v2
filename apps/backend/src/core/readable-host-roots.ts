import type { CommandContext } from "./commands-context.js";
import { coordinatorAttachmentsRoot } from "./storage-coordinators.js";
import { getWorktreeBaseDir } from "./worktree-locations.js";

/**
 * The host roots an environment-less file read may open: `read_file_base64`
 * and the readable-roots media stream (`transcript_media_open_stream` without
 * an `environmentId`) both confine to exactly this list, so a route can never
 * read more than the RPC it replaces.
 *
 * Built per read from the current environments, so a removed custom worktree
 * stops being readable at once.
 */
export async function readableHostFileRoots(
  context: Pick<CommandContext, "storage" | "worktreeDir">,
): Promise<string[]> {
  // Worktrees created in a folder the user chose are readable one by one,
  // never the chosen folder as a whole.
  const customWorktrees = (await context.storage.loadEnvironments())
    .filter(
      (environment) =>
        environment.environmentType === "local" &&
        !environment.projectHome &&
        !!environment.worktreeBaseDir &&
        !!environment.worktreePath,
    )
    .map((environment) => environment.worktreePath!);
  return [
    getWorktreeBaseDir(context),
    ...customWorktrees,
    // A coordinator's pasted images are staged in application data, never
    // in the checkout it must not touch; its transcript names them there.
    coordinatorAttachmentsRoot(context.storage.getDataDir()),
  ];
}
