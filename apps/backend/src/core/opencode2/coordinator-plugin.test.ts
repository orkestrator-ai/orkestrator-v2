import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
} from "@orkestrator/protocol/coordinator-web-research";
import {
  ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV,
  ORKESTRATOR_BRIDGE_EXECUTION_POLICY_ENV,
} from "../commands-servers.js";
import {
  OPENCODE2_ATTACHMENT_ROOT_ENV,
  OPENCODE2_COORDINATOR_READ_REFUSAL,
  OPENCODE2_COORDINATOR_TOOL_REFUSAL,
  OPENCODE2_EXECUTION_POLICY_ENV,
  buildOpenCode2CoordinatorGuardPluginSource,
} from "./coordinator-plugin.js";

type Event = { tool: string; input: Record<string, unknown> };
type Plugin = {
  id: string;
  setup(ctx: unknown): Promise<void>;
};

const NAMES = [
  OPENCODE2_EXECUTION_POLICY_ENV,
  OPENCODE2_ATTACHMENT_ROOT_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
  COORDINATOR_RESEARCH_MCP_ENV,
];
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

let root: string;
let dataDir: string;
let checkout: string;
let plugin: Plugin;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode2-guard-")));
  dataDir = path.join(root, "data");
  checkout = path.join(root, "checkout");
  await mkdir(dataDir, { recursive: true });
  await mkdir(checkout);
  await writeFile(path.join(dataDir, "control-mcp.json"), "{}");
  await writeFile(path.join(checkout, "README.md"), "readme");
  await symlink(dataDir, path.join(checkout, "linked-dir"));
  // Loaded from a file, as OpenCode 2 loads it, so the source itself is under test.
  const file = path.join(root, "guard.ts");
  await writeFile(file, buildOpenCode2CoordinatorGuardPluginSource());
  plugin = (await import(file)).default as Plugin;
});

afterEach(async () => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await rm(root, { recursive: true, force: true });
});

/** Run the plugin's setup under `env` and return its `execute.before` hook, if any. */
async function setup(
  env: Record<string, string | undefined>,
  directory = checkout,
): Promise<((event: Event) => unknown) | undefined> {
  for (const name of NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) process.env[name] = value;
  let hook: ((event: Event) => unknown) | undefined;
  await plugin.setup({
    location: { directory },
    tool: {
      hook: async (name: string, callback: (event: Event) => unknown) => {
        expect(name).toBe("execute.before");
        hook = callback;
        return { dispose() {} };
      },
    },
  });
  return hook;
}

function coordinatorEnv(extra: Record<string, string> = {}) {
  return {
    [OPENCODE2_EXECUTION_POLICY_ENV]: "coordinator-read-only",
    [COORDINATOR_PROTECTED_DATA_DIR_ENV]: dataDir,
    ...extra,
  };
}

function refusal(hook: (event: Event) => unknown, tool: string, input: Record<string, unknown>) {
  try {
    hook({ tool, input });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("the OpenCode 2 coordinator guard", () => {
  test("spells the launcher's process-authority variables", () => {
    expect(OPENCODE2_EXECUTION_POLICY_ENV).toBe(ORKESTRATOR_BRIDGE_EXECUTION_POLICY_ENV);
    expect(OPENCODE2_ATTACHMENT_ROOT_ENV).toBe(ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT_ENV);
  });

  test("does nothing in a server that is not a coordinator's", async () => {
    expect(await setup({})).toBeUndefined();
    expect(await setup({ [OPENCODE2_EXECUTION_POLICY_ENV]: "pipeline" })).toBeUndefined();
  });

  test("allows only the read-only tools and the coordinator's own tools", async () => {
    const hook = (await setup(coordinatorEnv()))!;
    for (const tool of ["read", "glob", "grep", "skill", "subagent", "todowrite"]) {
      expect(refusal(hook, tool, {})).toBeNull();
    }
    expect(refusal(hook, "orkestrator_list_environments", {})).toBeNull();
    for (const tool of [
      "write",
      "edit",
      "patch",
      "shell",
      "bash",
      "webfetch",
      "websearch",
      "opencode_worktree_create",
      "orkestrator_tab_0123456789ab_send_message",
      "orkestrator_workflow_result_submit_review_report",
      "orkestrator_not_a_control_tool",
      "project_server_tool",
    ]) {
      expect(refusal(hook, tool, {})).toBe(OPENCODE2_COORDINATOR_TOOL_REFUSAL);
    }
  });

  test("allows hosted search and the research servers' tools only as the launch's research setting says", async () => {
    const servers = JSON.stringify([{ name: "context7", url: "https://example.test/mcp" }]);
    const off = (await setup(coordinatorEnv({ [COORDINATOR_RESEARCH_MCP_ENV]: servers })))!;
    expect(refusal(off, "websearch", {})).toBe(OPENCODE2_COORDINATOR_TOOL_REFUSAL);
    expect(refusal(off, "context7_resolve", {})).toBe(OPENCODE2_COORDINATOR_TOOL_REFUSAL);

    const search = (await setup(coordinatorEnv({ [COORDINATOR_WEB_RESEARCH_ENV]: "search" })))!;
    expect(refusal(search, "websearch", {})).toBeNull();
    expect(refusal(search, "context7_resolve", {})).toBe(OPENCODE2_COORDINATOR_TOOL_REFUSAL);

    const mcp = (await setup(
      coordinatorEnv({
        [COORDINATOR_WEB_RESEARCH_ENV]: "search-and-mcp",
        [COORDINATOR_RESEARCH_MCP_ENV]: servers,
      }),
    ))!;
    expect(refusal(mcp, "websearch", {})).toBeNull();
    expect(refusal(mcp, "context7_resolve", {})).toBeNull();
    expect(refusal(mcp, "context7_", {})).toBe(OPENCODE2_COORDINATOR_TOOL_REFUSAL);
    expect(refusal(mcp, "other_resolve", {})).toBe(OPENCODE2_COORDINATOR_TOOL_REFUSAL);
  });

  test("refuses reads of the data directory, directly or through a link in the checkout", async () => {
    const hook = (await setup(coordinatorEnv()))!;
    expect(refusal(hook, "read", { path: "README.md" })).toBeNull();
    expect(refusal(hook, "read", { path: path.join(dataDir, "control-mcp.json") })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
    expect(refusal(hook, "read", { path: "linked-dir/control-mcp.json" })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
    expect(refusal(hook, "grep", { pattern: "x", path: "linked-dir" })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
    expect(refusal(hook, "glob", { pattern: "**/*", path: "linked-dir" })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
    // A search rooted above the data directory would walk into it.
    expect(refusal(hook, "grep", { pattern: "x", path: root })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
    // An absolute glob pattern names its own root.
    expect(refusal(hook, "glob", { pattern: `${dataDir}/**/*.json` })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
    expect(refusal(hook, "glob", { pattern: "**/*.md" })).toBeNull();
  });

  test("keeps a checkout and an attachment root inside the data directory readable", async () => {
    const inner = path.join(dataDir, "coordinator-runtime", "checkout");
    const attachments = path.join(dataDir, "attachments", "c1");
    await mkdir(inner, { recursive: true });
    await mkdir(attachments, { recursive: true });
    await writeFile(path.join(attachments, "pasted.txt"), "x");
    const hook = (await setup(
      coordinatorEnv({ [OPENCODE2_ATTACHMENT_ROOT_ENV]: attachments }),
      inner,
    ))!;
    expect(refusal(hook, "read", { path: path.join(inner, "a.ts") })).toBeNull();
    expect(refusal(hook, "read", { path: path.join(attachments, "pasted.txt") })).toBeNull();
    expect(refusal(hook, "read", { path: path.join(dataDir, "control-mcp.json") })).toBe(
      OPENCODE2_COORDINATOR_READ_REFUSAL,
    );
  });

  test("refuses every path tool when no data directory was named", async () => {
    const hook = (await setup({ [OPENCODE2_EXECUTION_POLICY_ENV]: "coordinator-read-only" }))!;
    expect(refusal(hook, "read", { path: "README.md" })).toBe(OPENCODE2_COORDINATOR_READ_REFUSAL);
    expect(refusal(hook, "subagent", {})).toBeNull();
  });
});
