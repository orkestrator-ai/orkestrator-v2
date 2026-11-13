/**
 * The coordinator guard, a 2.x server plugin
 * (to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`), coordinators on 2.x).
 *
 * A coordinator's 2.x server is its own process, launched with
 * `ORKESTRATOR_BRIDGE_EXECUTION_POLICY=coordinator-read-only`. This plugin
 * reads that variable once, at setup, and from then on runs in front of every
 * tool call the server makes, a sub-agent's included:
 *
 * - **Tool allowlist.** Only the read-only built-ins (`read`, `glob`, `grep`,
 *   `list`, `skill`, `subagent`, `todowrite`, `todoread`), hosted search when
 *   the launch's research mode allows it, the coordinator's Orkestrator
 *   control tools by exact id, and the tools of the research servers named at
 *   launch run. Anything else is refused, whatever the session's permission
 *   rules say. This is the process-held half of the read-only boundary: a
 *   session whose stored rules were widened (a persisted record, a request)
 *   still cannot write, run a command or fetch a page on this server.
 * - **Data-directory reads.** The rules deny every path outside the checkout
 *   (`external_directory`), but 2.x judges that from the path as written, so
 *   a link inside the checkout pointing out of it was read (observed on 2.2.6:
 *   `read`, `grep` and `glob` through a linked directory). The plugin resolves
 *   paths the way the filesystem will and refuses a call that would reach
 *   Orkestrator's data directory, as the retired 1.x plugin did
 *   (`git show 5f4e27b1c:apps/backend/src/core/opencode-read-boundary-plugin.ts`). The checkout and the conversation's
 *   attachment directory stay readable.
 *
 * Without the policy variable the plugin does nothing, so it is safe in any
 * server; it is only ever written into the coordinator configuration
 * directory. The source is self-contained: 2.x imports it from that
 * directory, where no workspace module resolves.
 *
 * 2.2.6's hook (`ctx.tool.hook("execute.before", event)`) hands the tool id as
 * `event.tool` and its arguments as `event.input`; throwing refuses the call
 * and the message reaches the model as the tool's error.
 */
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  COORDINATOR_CONTROL_TOOL_NAMES,
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
} from "@orkestrator/protocol/coordinator";
import { ORKESTRATOR_AGENT_MCP_SERVER_NAME } from "../agent-tools.js";

/**
 * The launcher's process-authority variables (`commands-servers.ts`), spelled
 * here so this module does not import the launcher; a test pins them equal.
 */
export const OPENCODE2_EXECUTION_POLICY_ENV = "ORKESTRATOR_BRIDGE_EXECUTION_POLICY";
export const OPENCODE2_ATTACHMENT_ROOT_ENV = "ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT";

export const OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID = "orkestrator-coordinator-guard";

export const OPENCODE2_COORDINATOR_TOOL_REFUSAL =
  "Coordinators are read-only: this tool is not available to them.";

export const OPENCODE2_COORDINATOR_READ_REFUSAL =
  "Coordinators cannot read Orkestrator's data directory, which holds credentials with wider authority than this conversation.";

/** Built-in tools a coordinator may run on 2.2.6 (the rules allow the same set). */
export const OPENCODE2_COORDINATOR_BUILTIN_TOOLS = Object.freeze([
  "read",
  "glob",
  "grep",
  "list",
  "skill",
  "subagent",
  "todowrite",
  "todoread",
]);

/** Hosted search, allowed only when the launch's research mode includes search. */
export const OPENCODE2_COORDINATOR_SEARCH_TOOLS = Object.freeze(["websearch", "codesearch"]);

/** The coordinator's Orkestrator control tools, as 2.x names them (`<server>_<tool>`). */
export function openCode2CoordinatorControlToolIds(): string[] {
  return COORDINATOR_CONTROL_TOOL_NAMES.map(
    (name) => `${ORKESTRATOR_AGENT_MCP_SERVER_NAME}_${name}`,
  );
}

export function buildOpenCode2CoordinatorGuardPluginSource(): string {
  return `// Written by Orkestrator. The read-only boundary of a coordinator's OpenCode 2 server.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const POLICY_ENV = ${JSON.stringify(OPENCODE2_EXECUTION_POLICY_ENV)};
const POLICY = ${JSON.stringify(COORDINATOR_EXECUTION_POLICY)};
const DATA_DIR_ENV = ${JSON.stringify(COORDINATOR_PROTECTED_DATA_DIR_ENV)};
const ATTACHMENT_ROOT_ENV = ${JSON.stringify(OPENCODE2_ATTACHMENT_ROOT_ENV)};
const RESEARCH_MODE_ENV = ${JSON.stringify(COORDINATOR_WEB_RESEARCH_ENV)};
const RESEARCH_MCP_ENV = ${JSON.stringify(COORDINATOR_RESEARCH_MCP_ENV)};
const BUILTIN = ${JSON.stringify(OPENCODE2_COORDINATOR_BUILTIN_TOOLS)};
const SEARCH = ${JSON.stringify(OPENCODE2_COORDINATOR_SEARCH_TOOLS)};
const CONTROL = ${JSON.stringify(openCode2CoordinatorControlToolIds())};
const TOOL_REFUSAL = ${JSON.stringify(OPENCODE2_COORDINATOR_TOOL_REFUSAL)};
const READ_REFUSAL = ${JSON.stringify(OPENCODE2_COORDINATOR_READ_REFUSAL)};
const PATH_ARGUMENTS = { read: ["path", "filePath"], grep: ["path"], glob: ["path"], list: ["path"] };
const SEARCHES = new Set(["grep", "glob", "list"]);

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

function researchNamespaces(env) {
  const mode = env[RESEARCH_MODE_ENV];
  if (mode !== "search-and-mcp") return [];
  try {
    const servers = JSON.parse(env[RESEARCH_MCP_ENV] ?? "[]");
    return Array.isArray(servers)
      ? servers
          .map((server) => (typeof server?.name === "string" ? server.name.replace(/[^a-zA-Z0-9_-]/g, "_") : ""))
          .filter((name) => name.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** The leading part of a glob pattern that names no wildcard. */
function staticPrefix(pattern) {
  const index = pattern.search(/[*?[{]/);
  const head = index < 0 ? pattern : pattern.slice(0, index);
  return index < 0 ? head : dirname(head + "x");
}

export default {
  id: ${JSON.stringify(OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID)},
  async setup(ctx) {
    const env = process.env;
    if (env[POLICY_ENV] !== POLICY) return;
    const allowed = new Set([...BUILTIN, ...CONTROL]);
    const mode = env[RESEARCH_MODE_ENV];
    if (mode === "search" || mode === "search-and-mcp") for (const tool of SEARCH) allowed.add(tool);
    const research = researchNamespaces(env).map((name) => name + "_");
    const permitted = (tool) =>
      typeof tool === "string" && (allowed.has(tool) || research.some((prefix) => tool.startsWith(prefix) && tool.length > prefix.length));

    const base = typeof ctx?.location?.directory === "string" && isAbsolute(ctx.location.directory)
      ? ctx.location.directory
      : process.cwd();
    const dataDir = env[DATA_DIR_ENV]?.trim();
    // No data directory named: refuse every path tool rather than read unchecked.
    const deny = dataDir && isAbsolute(dataDir) ? forms(dataDir) : null;
    const carved = [base, env[ATTACHMENT_ROOT_ENV]?.trim()]
      .filter((path) => typeof path === "string" && isAbsolute(path))
      .flatMap(forms);
    // A checkout (or attachment root) inside the data directory stays readable, and nothing above it.
    const allow = deny ? carved.filter((path) => !deny.includes(path) && deny.some((root) => within(root, path))) : [];
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

    await ctx.tool.hook("execute.before", (event) => {
      const tool = event?.tool;
      if (!permitted(tool)) throw new Error(TOOL_REFUSAL);
      const keys = PATH_ARGUMENTS[tool];
      if (!keys) return;
      if (!deny) throw new Error(READ_REFUSAL);
      const input = event.input && typeof event.input === "object" ? event.input : {};
      const traversal = SEARCHES.has(tool);
      const values = keys.map((key) => input[key]).filter((value) => typeof value === "string" && value.trim());
      if (traversal && values.length === 0) values.push(base);
      // An absolute glob pattern names its own root.
      if (tool === "glob" && typeof input.pattern === "string") {
        const pattern = input.pattern.trim();
        if (isAbsolute(pattern) || pattern.startsWith("~")) values.push(staticPrefix(pattern));
      }
      if (values.some((value) => refuses(value, traversal))) throw new Error(READ_REFUSAL);
    });
  },
};
`;
}
