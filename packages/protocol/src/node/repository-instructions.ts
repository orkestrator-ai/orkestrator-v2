import { open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import {
  REPOSITORY_INSTRUCTIONS_FILE,
  repositoryInstructionsBlock,
} from "../agent-system-instructions.js";

/**
 * Largest share of AGENTS.md a bridge copies into a session. Codex's own
 * project-doc loader stops at 32 KiB by default; this is generous so a large
 * file still arrives whole, while a runaway one cannot fill the context.
 */
export const MAX_REPOSITORY_INSTRUCTIONS_BYTES = 256 * 1024;

/**
 * The working directory's AGENTS.md as a `repositoryInstructionsBlock`, or
 * undefined when there is none, it is empty or unreadable, or it is a link
 * that leaves the working directory (a checkout must not be able to read an
 * arbitrary file into the prompt). Read on every call, so an edit reaches
 * the next session or turn that asks.
 */
export async function readRepositoryInstructions(
  cwd: string,
  maxBytes: number = MAX_REPOSITORY_INSTRUCTIONS_BYTES,
): Promise<string | undefined> {
  const path = join(cwd, REPOSITORY_INSTRUCTIONS_FILE);
  try {
    const [root, target] = await Promise.all([realpath(cwd), realpath(path)]);
    const inside = relative(root, target);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
      const truncated = bytesRead > maxBytes;
      // A cut can split a multi-byte character; drop its replacement mark.
      const text = new TextDecoder()
        .decode(buffer.subarray(0, Math.min(bytesRead, maxBytes)))
        .replace(/�$/, "");
      return text.trim() ? repositoryInstructionsBlock(path, text, truncated) : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
