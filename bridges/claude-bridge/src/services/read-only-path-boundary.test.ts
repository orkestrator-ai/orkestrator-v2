import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
} from "@orkestrator/protocol/coordinator";
import { claudeExecutionSandbox } from "./claude-execution-sandbox.js";
import {
  coordinatorReadBoundary,
  readBoundaryRefuses,
  readToolRefused,
  shellCommandRefused,
  type ReadBoundary,
} from "./read-only-path-boundary.js";
import {
  claudeReadOnlySandbox,
  coordinatorProcessPolicy,
  createCoordinatorReadOnlyHook,
} from "./read-only-policy.js";

// A fixture data directory. Nothing here touches a real one.
let root: string;
let dataDir: string;
let checkout: string;
let home: string;
let attachments: string;
let boundary: ReadBoundary;

const seed = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fixture");
  return path;
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "read-boundary-")));
  dataDir = join(root, "data");
  checkout = join(root, "checkout");
  home = join(dataDir, "coordinator-runtime", "c1", "conversations", "v1", "claude-home");
  attachments = join(dataDir, "coordinator-attachments", "c1", "v1");
  mkdirSync(checkout, { recursive: true });
  seed(join(dataDir, "control-mcp.json"));
  seed(join(dataDir, "orkestrator.sqlite"));
  seed(join(dataDir, "toolchains", "claude", "claude"));
  seed(join(dataDir, "agent-accounts", "claude", "a1", "skills", "s", "SKILL.md"));
  seed(join(home, "projects", "p", "memory", "MEMORY.md"));
  seed(join(home, "projects", "p", "s", "tool-results", "big.txt"));
  seed(join(attachments, "pasted.png"));
  symlinkSync(join(dataDir, "control-mcp.json"), join(checkout, "innocent.json"));
  symlinkSync(join(dataDir, "control-mcp.json"), join(home, "projects", "p", "planted.json"));
  boundary = coordinatorReadBoundary([checkout], {
    [COORDINATOR_PROTECTED_DATA_DIR_ENV]: dataDir,
    CLAUDE_CONFIG_DIR: home,
    ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT: attachments,
    [COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV]: join(
      dataDir,
      "agent-accounts",
      "claude",
      "a1",
      "skills",
    ),
  })!;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const refuses = (path: string, traversal = false) =>
  readBoundaryRefuses(boundary, path, checkout, { traversal });

describe("coordinatorReadBoundary", () => {
  test("is absent outside a coordinator, and with a relative path", () => {
    expect(coordinatorReadBoundary([checkout], {})).toBeNull();
    expect(
      coordinatorReadBoundary([checkout], { [COORDINATOR_PROTECTED_DATA_DIR_ENV]: "data" }),
    ).toBeNull();
  });
});

describe("readBoundaryRefuses", () => {
  test("refuses the operator credentials and the database", () => {
    expect(refuses(join(dataDir, "control-mcp.json"))).toBe(true);
    expect(refuses(join(dataDir, "orkestrator.sqlite"))).toBe(true);
    expect(refuses(join(dataDir, "orkestrator.sqlite-wal"))).toBe(true);
  });

  test("refuses another account's login and another conversation's runtime", () => {
    expect(refuses(join(dataDir, "agent-accounts", "claude", "a2", "credentials"))).toBe(true);
    expect(
      refuses(join(dataDir, "coordinator-runtime", "c1", "conversations", "v2", "claude-home")),
    ).toBe(true);
  });

  test("leaves this conversation's own tool results, memory and attachments readable", () => {
    expect(refuses(join(home, "projects", "p", "s", "tool-results", "big.txt"))).toBe(false);
    expect(refuses(join(home, "projects", "p", "memory", "MEMORY.md"))).toBe(false);
    expect(refuses(join(attachments, "pasted.png"))).toBe(false);
  });

  test("leaves the skills it was given, the toolchains and the checkout readable", () => {
    expect(
      refuses(join(dataDir, "agent-accounts", "claude", "a1", "skills", "s", "SKILL.md")),
    ).toBe(false);
    expect(refuses(join(dataDir, "toolchains", "claude", "claude"))).toBe(false);
    expect(refuses(join(checkout, "README.md"))).toBe(false);
  });

  test("sees through a link, an upward path and a home-relative spelling", () => {
    expect(refuses(join(checkout, "innocent.json"))).toBe(true);
    // Inside the allowed runtime, pointing out of it.
    expect(refuses(join(home, "projects", "p", "planted.json"))).toBe(true);
    expect(refuses(join(home, "..", "..", "..", "..", "..", "control-mcp.json"))).toBe(true);
    expect(refuses("../data/control-mcp.json")).toBe(true);
  });

  test("a search rooted above the data directory is refused; a read of it is not", () => {
    expect(refuses(root, true)).toBe(true);
    expect(refuses(root)).toBe(false);
    expect(refuses(checkout, true)).toBe(false);
  });

  (process.platform === "darwin" ? test : test.skip)(
    "a different letter case is the same file on a case-insensitive volume",
    () => {
      expect(refuses(join(dataDir, "CONTROL-MCP.JSON"))).toBe(true);
    },
  );
});

describe("readToolRefused", () => {
  const refused = (tool: string, input: Record<string, unknown>) =>
    readToolRefused(boundary, tool, input, checkout);

  test("Read", () => {
    expect(refused("Read", { file_path: join(dataDir, "control-mcp.json") })).toBe(true);
    expect(refused("Read", { file_path: join(home, "projects", "p", "memory", "MEMORY.md") })).toBe(
      false,
    );
  });

  test("Grep, including from above the directory and with no path", () => {
    expect(refused("Grep", { pattern: "token", path: dataDir })).toBe(true);
    expect(refused("Grep", { pattern: "token", path: root })).toBe(true);
    expect(refused("Grep", { pattern: "token" })).toBe(false);
    expect(refused("Grep", { pattern: "x", path: join(home, "projects") })).toBe(false);
  });

  test("Glob, including a pattern that names the directory itself", () => {
    expect(refused("Glob", { pattern: "*.json", path: dataDir })).toBe(true);
    expect(refused("Glob", { pattern: `${dataDir}/*.json` })).toBe(true);
    expect(refused("Glob", { pattern: "../data/*.json" })).toBe(true);
    expect(refused("Glob", { pattern: "**/*.ts" })).toBe(false);
  });

  test("other tools are not this check's business", () => {
    expect(refused("TodoWrite", { file_path: join(dataDir, "control-mcp.json") })).toBe(false);
  });
});

describe("shellCommandRefused", () => {
  const refused = (command: string, traversal = false) =>
    shellCommandRefused(boundary, command, checkout, { traversal });

  test("a command naming a denied path, however the value is attached", () => {
    expect(refused(`cat ${join(dataDir, "control-mcp.json")}`)).toBe(true);
    expect(refused(`grep --file=${join(dataDir, "control-mcp.json")} x`)).toBe(true);
    expect(refused(`grep -f${join(dataDir, "control-mcp.json")} x`)).toBe(true);
    expect(refused("cat innocent.json")).toBe(true);
  });

  test("ordinary commands and the conversation's own files pass", () => {
    expect(refused("ls -la")).toBe(false);
    expect(refused("git log --oneline -5")).toBe(false);
    expect(refused(`cat ${join(home, "projects", "p", "memory", "MEMORY.md")}`)).toBe(false);
  });

  test("with no sandbox behind it, a walk from above the directory is refused too", () => {
    expect(refused(`grep -r token ${root}`)).toBe(false);
    expect(refused(`grep -r token ${root}`, true)).toBe(true);
    expect(refused("ls .", true)).toBe(false);
  });
});

describe("createCoordinatorReadOnlyHook", () => {
  const policy = coordinatorProcessPolicy({});
  const run = async (
    tool: string,
    input: Record<string, unknown>,
    commandSandbox: "required" | "unavailable" = "required",
    readBoundary: ReadBoundary | null = boundary,
  ) => {
    const hook = createCoordinatorReadOnlyHook(policy, [], { commandSandbox, readBoundary });
    const answer = (await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: input,
        cwd: checkout,
      } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    )) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    return answer.hookSpecificOutput;
  };

  test("refuses Read, Grep, Glob and a command on the credentials", async () => {
    const credentials = join(dataDir, "control-mcp.json");
    for (const [tool, input] of [
      ["Read", { file_path: credentials }],
      ["Grep", { pattern: "x", path: dataDir }],
      ["Glob", { pattern: "*", path: dataDir }],
      ["Bash", { command: `cat ${credentials}` }],
    ] as const) {
      const answer = await run(tool, input);
      expect(answer?.permissionDecision).toBe("deny");
      expect(answer?.permissionDecisionReason).toContain("data directory");
    }
  });

  test("leaves the conversation's saved tool results and memory readable", async () => {
    const result = join(home, "projects", "p", "s", "tool-results", "big.txt");
    expect(await run("Read", { file_path: result })).toBeUndefined();
    expect(await run("Grep", { pattern: "x", path: join(home, "projects") })).toBeUndefined();
    expect(await run("Bash", { command: `cat ${result}` })).toBeUndefined();
  });

  test("a turn outside a coordinator has no boundary to apply", async () => {
    const credentials = join(dataDir, "control-mcp.json");
    expect(await run("Read", { file_path: credentials }, "required", null)).toBeUndefined();
  });
});

describe("the sandbox block", () => {
  const policy = coordinatorProcessPolicy({});

  test("denies the data directory and carves the runtime back out", () => {
    const sandbox = claudeReadOnlySandbox(policy, {
      workspaces: [checkout],
      readBoundary: boundary,
    });
    expect(sandbox.filesystem.denyRead).toEqual([dataDir]);
    expect(sandbox.filesystem.allowRead).toContain(home);
    expect(sandbox.filesystem.allowRead).toContain(attachments);
    expect(sandbox.filesystem.denyWrite).toEqual([checkout]);
  });

  test("names no read rule without a boundary, so other read-only turns are as they were", () => {
    const sandbox = claudeExecutionSandbox(policy, false, {
      cwd: checkout,
      commandSandbox: "required",
      readBoundary: null,
    }) as { filesystem: { denyRead?: string[] } };
    expect(sandbox.filesystem.denyRead).toBeUndefined();
  });
});
