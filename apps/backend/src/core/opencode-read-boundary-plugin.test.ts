import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_PROTECTED_DATA_DIR_ENV } from "@orkestrator/protocol/coordinator";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import { writeHostOpenCodeCredentialPlugin } from "./opencode-host-credential.js";
import { openCodePermissionRules } from "./opencode-provider-helpers.js";
import {
  buildOpenCodeReadBoundaryPluginSource,
  OPENCODE_READ_BOUNDARY_PLUGIN_FILE,
  OPENCODE_READ_BOUNDARY_REFUSAL,
} from "./opencode-read-boundary-plugin.js";

type Hook = (input: { tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;
type Plugin = (context?: { directory?: string }) => Promise<{ "tool.execute.before"?: Hook }>;

let root: string;
let dataDir: string;
let checkout: string;
let plugin: Plugin;
const previous = process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode-read-boundary-")));
  dataDir = path.join(root, "data");
  checkout = path.join(root, "checkout");
  await mkdir(path.join(dataDir, "agent-accounts"), { recursive: true });
  await mkdir(checkout);
  await writeFile(path.join(dataDir, "control-mcp.json"), "{}");
  await writeFile(path.join(checkout, "README.md"), "readme");
  await symlink(path.join(dataDir, "control-mcp.json"), path.join(checkout, "innocent.json"));
  await symlink(dataDir, path.join(checkout, "linked-dir"));
  // Loaded from a file, as OpenCode loads it, so the source itself is under test.
  const file = path.join(root, OPENCODE_READ_BOUNDARY_PLUGIN_FILE);
  await writeFile(file, buildOpenCodeReadBoundaryPluginSource());
  plugin = (await import(file)).OrkestratorCoordinatorReadBoundary as Plugin;
});

afterEach(async () => {
  if (previous === undefined) delete process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];
  else process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
});

async function hook(directory = checkout): Promise<Hook> {
  process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = dataDir;
  const hooks = await plugin({ directory });
  return hooks["tool.execute.before"]!;
}

async function refused(
  tool: string,
  args: Record<string, unknown>,
  directory?: string,
): Promise<boolean> {
  const before = await hook(directory);
  try {
    await before({ tool }, { args });
    return false;
  } catch (error) {
    expect((error as Error).message).toBe(OPENCODE_READ_BOUNDARY_REFUSAL);
    return true;
  }
}

describe("the OpenCode coordinator read-boundary plugin", () => {
  test("adds no hook to a server that is not a coordinator's", async () => {
    delete process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV];
    expect(await plugin({ directory: checkout })).toEqual({});
    process.env[COORDINATOR_PROTECTED_DATA_DIR_ENV] = "relative/data";
    expect(await plugin({ directory: checkout })).toEqual({});
  });

  test("refuses a read of the data directory, directly or through a link in the checkout", async () => {
    expect(await refused("read", { filePath: path.join(dataDir, "control-mcp.json") })).toBe(true);
    expect(await refused("read", { filePath: path.join(checkout, "innocent.json") })).toBe(true);
    expect(await refused("read", { filePath: "innocent.json" })).toBe(true);
    expect(await refused("read", { filePath: "linked-dir/control-mcp.json" })).toBe(true);
    // A file that does not exist yet is judged by the directory it would be in.
    expect(await refused("read", { filePath: path.join(dataDir, "agent-accounts", "x") })).toBe(
      true,
    );
  });

  test("refuses a search rooted in the data directory, at a link to it, or above it", async () => {
    expect(await refused("grep", { pattern: "x", path: dataDir })).toBe(true);
    expect(await refused("grep", { pattern: "x", path: "linked-dir" })).toBe(true);
    expect(await refused("glob", { pattern: "**/*.json", path: root })).toBe(true);
    expect(await refused("list", { path: path.join(checkout, "linked-dir") })).toBe(true);
  });

  test("leaves the checkout readable and searchable", async () => {
    expect(await refused("read", { filePath: path.join(checkout, "README.md") })).toBe(false);
    expect(await refused("read", { filePath: "README.md" })).toBe(false);
    expect(await refused("grep", { pattern: "x" })).toBe(false);
    expect(await refused("glob", { pattern: "**/*.md", path: checkout })).toBe(false);
  });

  test("leaves a checkout inside the data directory readable, and nothing beside it", async () => {
    const inside = path.join(dataDir, "worktrees", "w1");
    await mkdir(inside, { recursive: true });
    expect(await refused("read", { filePath: path.join(inside, "a.ts") }, inside)).toBe(false);
    expect(await refused("grep", { pattern: "x" }, inside)).toBe(false);
    expect(
      await refused("read", { filePath: path.join(dataDir, "control-mcp.json") }, inside),
    ).toBe(true);
  });

  test("ignores tools that name no path it can judge", async () => {
    expect(await refused("bash", { command: `cat ${dataDir}/control-mcp.json` })).toBe(false);
    expect(await refused("orkestrator_list_environments", {})).toBe(false);
  });

  test("is installed beside the credential plugin, private to the user", async () => {
    const configDir = await writeHostOpenCodeCredentialPlugin(path.join(root, "host-data"));
    const file = path.join(configDir, "plugins", OPENCODE_READ_BOUNDARY_PLUGIN_FILE);
    expect(await readFile(file, "utf8")).toBe(buildOpenCodeReadBoundaryPluginSource());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

// The plugin covers links; a direct read of the data directory is refused by the
// coordinator's rules alone, because nothing in them allows external_directory.
test("a coordinator's OpenCode rules allow no external_directory access", () => {
  const rules = openCodePermissionRules(
    resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "restricted" },
      "coordinator",
    ),
  );
  const action = rules.findLast(
    (rule) =>
      (rule.permission === "external_directory" || rule.permission === "*") && rule.pattern === "*",
  )?.action;
  expect(action).toBe("deny");
  expect(rules.some((rule) => rule.permission === "external_directory")).toBe(false);
});
