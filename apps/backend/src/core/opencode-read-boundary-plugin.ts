import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";

export const OPENCODE_READ_BOUNDARY_PLUGIN_FILE = "orkestrator-coordinator-read-boundary.js";

export const OPENCODE_READ_BOUNDARY_REFUSAL =
  "Coordinators cannot read Orkestrator's data directory, which holds credentials with wider authority than this conversation.";

/**
 * A coordinator's data-directory check for OpenCode, as a server plugin.
 *
 * The coordinator's `{"*": "deny"}` rules already refuse a direct read of the
 * data directory, because it is never inside the checkout and so every read of
 * it is an `external_directory` access. OpenCode decides that from the path as
 * written, though, so a link inside the checkout that points into the data
 * directory was read (qualified on 1.19.5 in
 * `opencode-coordinator-read-boundary-live.test.ts`). This plugin resolves the
 * path the way the filesystem will and refuses the call before it runs.
 *
 * It is inert in every server but a coordinator's: the launcher names the data
 * directory only in a coordinator's environment. Only OpenCode's own reading
 * tools are checked; a coordinator has no shell, and an MCP tool reads nothing
 * OpenCode can name. The source is self-contained because OpenCode imports it
 * from its configuration directory, where no workspace module resolves.
 */
export function buildOpenCodeReadBoundaryPluginSource(): string {
  return `import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const PATH_ARGUMENTS = { read: ["filePath"], grep: ["path"], glob: ["path"], list: ["path"] };
const SEARCHES = new Set(["grep", "glob", "list"]);
const REFUSAL = ${JSON.stringify(OPENCODE_READ_BOUNDARY_REFUSAL)};

function canonical(path) {
  let existing = path;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...tail.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      tail.push(existing.slice(parent.length).replace(/^[/\\\\]+/, ""));
      existing = parent;
    }
  }
}

function within(root, path) {
  if (path === root) return true;
  return path.startsWith(root === parse(root).root ? root : root + sep);
}

function forms(path) {
  return [...new Set([resolve(path), canonical(path)])];
}

export const OrkestratorCoordinatorReadBoundary = async ({ directory } = {}) => {
  const dataDir = process.env[${JSON.stringify(COORDINATOR_PROTECTED_DATA_DIR_ENV)}]?.trim();
  if (!dataDir || !isAbsolute(dataDir)) return {};
  const deny = forms(dataDir);
  const base = typeof directory === "string" && isAbsolute(directory) ? directory : process.cwd();
  // A checkout inside the data directory stays readable, and nothing above it.
  const allow = forms(base).filter((path) => !deny.includes(path) && deny.some((root) => within(root, path)));
  const denied = (path) =>
    deny.some((root) => within(root, path)) && !allow.some((root) => within(root, path));
  const refuses = (value, traversal) => {
    const expanded = value === "~" ? homedir() : value.startsWith("~/") ? homedir() + sep + value.slice(2) : value;
    const raw = isAbsolute(expanded) ? expanded : base + sep + expanded;
    const paths = forms(raw);
    if (paths.some(denied)) return true;
    // A search rooted above the data directory would walk into it.
    return traversal && paths.some((path) => deny.some((root) => within(path, root)));
  };
  return {
    "tool.execute.before": async (input, output) => {
      const keys = PATH_ARGUMENTS[input?.tool];
      if (!keys) return;
      const args = output?.args ?? {};
      const traversal = SEARCHES.has(input.tool);
      const values = keys.map((key) => args[key]).filter((value) => typeof value === "string" && value.trim());
      if (traversal && values.length === 0) values.push(base);
      if (values.some((value) => refuses(value, traversal))) throw new Error(REFUSAL);
    },
  };
};
`;
}
