import type { LocalSubagentResourceProviderFields } from "@cursor/sdk";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import {
  canonicalPath,
  protectedDataDirBoundary,
  readBoundaryRefuses,
  type ReadBoundary,
} from "@orkestrator/protocol/node/coordinator-read-boundary";
import { configuredAttachmentRoot } from "./prompt-attachments.js";
import {
  grepTool,
  lsTool,
  readFileTool,
  resolveRipgrep,
  type GrepArgsLike,
  type GrepResultLike,
  type LsArgsLike,
  type LsResultLike,
  type ReadArgsLike,
  type ReadResultLike,
} from "./read-tools.js";

/**
 * A coordinator's data-directory boundary on Cursor's own reading tools.
 *
 * A read-only Cursor coordinator runs `read`, `grep`, `glob` and `ls` with no
 * shell, and without this nothing checked their paths: it could read
 * `control-mcp.json`, `config.json`, the database and every account's login,
 * Cursor's own credential included. `@cursor/sdk` has no per-call hook that
 * sees a built-in tool's path, so the read, grep (which also serves glob) and
 * ls executors are replaced (`local.resourceProviderOptions`) with ones that
 * check the path and delegate to the bridge's own implementation
 * (`read-tools.ts`). The read executor also serves the `$file:` arguments of
 * an MCP call, so those are checked too. `readLints` and `semSearch` keep the
 * SDK's executors: they report diagnostics and index hits, not file contents
 * the turn names.
 *
 * Carved back out, as on Pi: the checkout and the coordinator's attachment
 * directory, which lives under the data directory and whose files the prompt
 * names for `read`. The launcher names the directory only for a coordinator.
 */
export const CURSOR_READ_BOUNDARY_REFUSAL =
  "Coordinators cannot read Orkestrator's data directory, which holds credentials with wider authority than this conversation. This conversation's own attachments stay readable.";

/** The boundary this process was launched under; null outside a coordinator. */
export function cursorCoordinatorReadBoundary(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadBoundary | null {
  return protectedDataDirBoundary(env[COORDINATOR_PROTECTED_DATA_DIR_ENV], [
    cwd,
    canonicalPath(cwd),
    configuredAttachmentRoot(env),
  ]);
}

/**
 * The absolute path a Cursor tool argument names, as the SDK resolves it
 * (`g1`): a `file://` URL decoded, `~` expanded, anything relative taken
 * against the workspace. Undefined when a URL cannot be decoded, which the
 * caller refuses rather than guesses at.
 */
export function cursorToolPath(value: string, cwd: string): string | undefined {
  let path = value.trim();
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  }
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = `${homedir()}${sep}${path.slice(2)}`;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** A tool's executor slot, typed by its shape as the SDK types it. */
interface Executor<Args, Result> {
  execute(context: unknown, args: Args, options?: unknown): Promise<Result>;
}

export interface CursorReadBoundaryExecutors extends LocalSubagentResourceProviderFields {
  overrideReadExecutor: Executor<ReadArgsLike, ReadResultLike>;
  overrideGrepExecutor: Executor<GrepArgsLike, GrepResultLike>;
  overrideLsExecutor: Executor<LsArgsLike, LsResultLike>;
}

/**
 * The executors a read-only coordinator's agent runs instead of the SDK's.
 *
 * A path inside the data directory is refused before anything is read. A
 * search or listing rooted above it still runs, but every file it would
 * return is checked: a search follows links, so even one rooted in the
 * checkout can reach the data directory through a link inside it.
 */
export function cursorReadBoundaryExecutors(
  boundary: ReadBoundary,
  cwd: string,
  options: { ripgrep?: string } = {},
): CursorReadBoundaryExecutors {
  const refused = (path: string) => readBoundaryRefuses(boundary, path, cwd);
  // Resolved on first use, so a session that never searches never looks.
  let ripgrep = options.ripgrep;
  const rg = () => (ripgrep ??= resolveRipgrep(cwd));
  return {
    overrideReadExecutor: {
      async execute(_context, args) {
        const raw = args?.path ?? "";
        if (raw.trim() === "") {
          return {
            result: {
              case: "error",
              value: { path: raw, error: "path is empty or only whitespace" },
            },
          };
        }
        const path = cursorToolPath(raw, cwd);
        if (path === undefined || refused(path)) {
          return {
            result: {
              case: "rejected",
              value: { path: path ?? raw, reason: CURSOR_READ_BOUNDARY_REFUSAL },
            },
          };
        }
        return readFileTool(path, args);
      },
    },
    overrideGrepExecutor: {
      async execute(_context, args) {
        const named = args?.path?.trim() ? args.path : ".";
        const target = cursorToolPath(named, cwd);
        if (target === undefined || refused(target)) {
          return { result: { case: "error", value: { error: CURSOR_READ_BOUNDARY_REFUSAL } } };
        }
        return grepTool(args ?? {}, { cwd, target, refused, ripgrep: rg() });
      },
    },
    overrideLsExecutor: {
      async execute(_context, args) {
        const named = args?.path?.trim() ? args.path : ".";
        const path = cursorToolPath(named, cwd);
        if (path === undefined || refused(path)) {
          return {
            result: {
              case: "rejected",
              value: { path: path ?? named, reason: CURSOR_READ_BOUNDARY_REFUSAL },
            },
          };
        }
        return lsTool(path, args ?? {}, { refused, ripgrep: rg() });
      },
    },
  };
}
