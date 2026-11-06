import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import {
  canonicalPath,
  protectedDataDirBoundary,
  readBoundaryRefuses,
  type ReadBoundary,
} from "@orkestrator/protocol/node/coordinator-read-boundary";
import { configuredAttachmentRoot } from "./prompt-attachments.js";

/**
 * A coordinator's data-directory boundary on Pi's own reading tools.
 *
 * Pi's `read` takes any path, relative or absolute, so without this a Pi
 * coordinator read `control-mcp.json` and every account's login: nothing else
 * confines it to the checkout. A read-only Pi session runs only `read`, `grep`,
 * `find` and `ls` among the built-ins and has no shell, so checking those calls
 * in the approval gate closes the built-in path. An MCP tool reads nothing Pi
 * can name. The launcher names the directory only for a coordinator process.
 *
 * Carved back out: the checkout and the coordinator's attachment directory,
 * which lives under the data directory and whose files the prompt names for
 * `read`. Pi's agent directory (`~/.pi/agent`, its skills and `auth.json`) is
 * outside the data directory and is not affected.
 */
export const PI_READ_BOUNDARY_REFUSAL =
  "Coordinators cannot read Orkestrator's data directory, which holds credentials with wider authority than this conversation. This conversation's own attachments stay readable.";

/** The boundary this process was launched under; null outside a coordinator. */
export function piCoordinatorReadBoundary(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReadBoundary | null {
  return protectedDataDirBoundary(env[COORDINATOR_PROTECTED_DATA_DIR_ENV], [
    cwd,
    canonicalPath(cwd),
    configuredAttachmentRoot(env),
  ]);
}

const UNICODE_SPACES = /[  -   　]/g;

/**
 * The path as Pi's `resolveToCwd` reads it (pinned SDK 1.4): unicode spaces
 * normalised, a leading `@` dropped, a `file://` URL decoded. `~` is expanded by
 * `readBoundaryRefuses`.
 */
function piPath(value: string): string | undefined {
  let path = value.replace(UNICODE_SPACES, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return undefined;
    }
  }
  return path;
}

/** Built-in tools that search below their path, so one rooted above the directory walks into it. */
const SEARCHES = new Set(["grep", "find"]);
const READERS = new Set(["read", "ls", ...SEARCHES]);

/** Whether one of Pi's reading tools would reach a denied file. */
export function piReadToolRefused(
  boundary: ReadBoundary,
  toolName: string,
  input: unknown,
  cwd: string,
): boolean {
  if (!READERS.has(toolName)) return false;
  const raw =
    input && typeof input === "object" ? (input as Record<string, unknown>).path : undefined;
  // grep, find and ls default to the session's directory; read requires a path.
  const named = typeof raw === "string" && raw.trim() ? raw : toolName === "read" ? undefined : ".";
  if (named === undefined) return false;
  const path = piPath(named);
  // A path Pi itself could not decode is refused rather than guessed at.
  if (path === undefined) return true;
  if (readBoundaryRefuses(boundary, path, cwd, { traversal: SEARCHES.has(toolName) })) {
    return true;
  }
  if (toolName !== "read") return false;

  // Pi 1.4's resolveReadPathAsync tries these spellings after resolveToCwd.
  // Check all candidates, even if the literal file exists: a later fallback
  // must not gain access to a protected target. Search tools have no fallback.
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const resolved = resolve(cwd, expanded);
  const nfd = resolved.normalize("NFD");
  return [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, "\u202f$1."),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ].some((candidate) => readBoundaryRefuses(boundary, candidate, cwd));
}
