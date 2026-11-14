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
  writeFileSync(seed(join(dataDir, "control-mcp.json")), "unique-credential-fixture-marker");
  seed(join(dataDir, "orkestrator.sqlite"));
  seed(join(dataDir, "toolchains", "claude", "claude"));
  seed(join(dataDir, "agent-accounts", "claude", "a1", "skills", "s", "SKILL.md"));
  seed(join(home, "projects", "p", "memory", "MEMORY.md"));
  seed(join(home, "projects", "p", "s", "tool-results", "big.txt"));
  seed(join(attachments, "pasted.png"));
  symlinkSync(join(dataDir, "control-mcp.json"), join(checkout, "innocent.json"));
  symlinkSync(join(dataDir, "control-mcp.json"), join(home, "projects", "p", "planted.json"));
  mkdirSync(join(dataDir, "nested"));
  symlinkSync(join(dataDir, "nested"), join(checkout, "alias"));
  symlinkSync(dataDir, join(checkout, "directory-link"));
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

describe("the allowance", () => {
  const boundaryFor = (workspace: string, configDir = home) =>
    coordinatorReadBoundary([workspace], {
      [COORDINATOR_PROTECTED_DATA_DIR_ENV]: dataDir,
      CLAUDE_CONFIG_DIR: configDir,
    })!;

  test("a checkout above the data directory does not re-open it", () => {
    const above = boundaryFor(root);
    expect(above.allow).not.toContain(root);
    expect(readBoundaryRefuses(above, join(dataDir, "control-mcp.json"), root)).toBe(true);
  });

  test("a home that is the data directory itself does not re-open it", () => {
    const whole = boundaryFor(checkout, dataDir);
    expect(whole.allow).not.toContain(dataDir);
    expect(readBoundaryRefuses(whole, join(dataDir, "control-mcp.json"), checkout)).toBe(true);
  });

  test("a checkout inside the data directory stays readable", () => {
    const inside = join(dataDir, "workspaces", "project");
    expect(readBoundaryRefuses(boundaryFor(inside), join(inside, "README.md"), inside)).toBe(false);
  });
});

describe("readBoundaryRefuses", () => {
  test("refuses the operator credentials and the database", () => {
    expect(refuses(join(dataDir, "control-mcp.json"))).toBe(true);
    expect(refuses(join(dataDir, "orkestrator.sqlite"))).toBe(true);
    expect(refuses(join(dataDir, "orkestrator.sqlite-wal"))).toBe(true);
  });

  test("refuses every file that stores provider secrets", () => {
    expect(refuses(join(dataDir, "config.json"))).toBe(true);
    expect(refuses(join(dataDir, "config.json.bak.1"))).toBe(true);
    expect(refuses(join(dataDir, ".config.json.remnant.tmp"))).toBe(true);
    expect(
      refuses(
        join(dataDir, "portable-inputs", "e1", "r1", "claude-config", ".orkestrator-anthropic-key"),
      ),
    ).toBe(true);
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

  test("symlink parent components resolve before lexical normalization", () => {
    const path = `${checkout}/alias/../control-mcp.json`;
    expect(realpathSync.native(path)).toBe(join(dataDir, "control-mcp.json"));
    expect(refuses(path)).toBe(true);
    expect(refused(`cat ${path}`, true)).toBe(true);
    expect(refuses(`${checkout}/alias/../missing/credential`)).toBe(true);
    expect(refuses(`${checkout}/../checkout/README.md`)).toBe(false);
  });

  test("hook-only searches cannot follow descendant credential symlinks", () => {
    for (const command of [
      "grep -R fixture .",
      "grep -nR fixture .",
      "grep -rS fixture .",
      "diff -r . safe",
      "grep --dereference-recursive fixture .",
      "rg --follow fixture .",
      "rg -L fixture directory-link",
    ]) {
      expect({ command, refused: refused(command, true) }).toEqual({ command, refused: true });
    }
    expect(refused("grep -r fixture .", true)).toBe(false);
    expect(refused("rg --hidden fixture .", true)).toBe(false);
    expect(refused("grep -R fixture .", false)).toBe(false);
  });

  test("hook-only searches check the implicit cwd", () => {
    for (const command of ["grep -r fixture", "rg --hidden fixture"]) {
      expect(shellCommandRefused(boundary, command, root, { traversal: true })).toBe(true);
      expect(shellCommandRefused(boundary, command, checkout, { traversal: true })).toBe(false);
    }
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

  test("every pipeline stage is held to the boundary on its own", async () => {
    // The boundary reads a command's program from its first word, so a stage
    // after a pipe has to be judged as a command of its own.
    const credentials = join(dataDir, "control-mcp.json");
    for (const command of [`ls . | cat ${credentials}`, "echo x | grep -R fixture ."]) {
      const answer = await run("Bash", { command }, "unavailable");
      expect({ command, decision: answer?.permissionDecision }).toEqual({
        command,
        decision: "deny",
      });
      expect(answer?.permissionDecisionReason).toContain("data directory");
    }
    expect(await run("Bash", { command: "ls . | grep -n checkout" }, "unavailable")).toBe(
      undefined,
    );
  });

  test("hook-only commands refuse symlink traversal and keep safe searches", async () => {
    for (const command of [
      "grep -R fixture .",
      "rg --follow fixture .",
      "cat alias/../control-mcp.json",
    ]) {
      expect((await run("Bash", { command }, "unavailable"))?.permissionDecision).toBe("deny");
    }
    expect(await run("Bash", { command: "rg fixture ." }, "unavailable")).toBeUndefined();
  });

  test("hook-only diff denies every recursive abbreviation before reading descendant links", async () => {
    const left = join(checkout, "diff-left");
    const right = join(checkout, "diff-right");
    mkdirSync(left);
    mkdirSync(right);
    symlinkSync(join(dataDir, "control-mcp.json"), join(left, "credential"));
    writeFileSync(join(right, "credential"), "");
    const commands = ["-r", "-ur"];
    for (let length = 3; length <= "--recursive".length; length++) {
      commands.push("--recursive".slice(0, length));
    }
    for (const flag of commands) {
      const command = `diff ${flag} diff-left diff-right`;
      const answer = await run("Bash", { command }, "unavailable");
      expect({ flag, decision: answer?.permissionDecision }).toEqual({ flag, decision: "deny" });
      expect(answer?.permissionDecisionReason).toContain("data directory");
      expect(JSON.stringify(answer)).not.toContain("unique-credential-fixture-marker");
    }
    expect(
      await run("Bash", { command: "diff README.md other.md" }, "unavailable"),
    ).toBeUndefined();
    expect(await run("Bash", { command: "diff --rec diff-left diff-right" })).toBeUndefined();
  });

  test("hook-only filename lists are refused before a protected fixture can be read", async () => {
    writeFileSync(join(checkout, "paths.list"), `${join(dataDir, "control-mcp.json")}\0`);
    for (const program of ["sort", "wc"]) {
      for (let length = 3; length <= "--files0-from".length; length++) {
        const flag = "--files0-from".slice(0, length);
        for (const argument of [`${flag}=paths.list`, `${flag} paths.list`]) {
          const command = `${program} ${argument}`;
          const answer = await run("Bash", { command }, "unavailable");
          expect(answer?.permissionDecision).toBe("deny");
          expect(JSON.stringify(answer)).not.toContain("unique-credential-fixture-marker");
        }
      }
    }
    for (const command of [
      "file -0fpaths.list",
      "file --files-from=paths.list",
      "sha256sum -bc paths.list",
      "md5sum --chec=paths.list",
      "cksum --check paths.list",
    ]) {
      expect((await run("Bash", { command }, "unavailable"))?.permissionDecision).toBe("deny");
    }
    expect(await run("Bash", { command: "sort paths.list" }, "unavailable")).toBeUndefined();
    const result = join(home, "projects", "p", "s", "tool-results", "big.txt");
    expect(await run("Bash", { command: `sort ${result}` }, "unavailable")).toBeUndefined();
  });

  test("hook-only commands deny clustered path operands before reading a credential fixture", async () => {
    const credentials = join(dataDir, "control-mcp.json");
    for (const operand of [
      credentials,
      "../data/control-mcp.json",
      "innocent.json",
      "alias/../control-mcp.json",
    ]) {
      for (const flags of ["-nFf", "-nf", "-Ff", "-0nFf", "-n0Ff"]) {
        const command = `rg --no-ignore ${flags}${operand} --trace README.md`;
        // This is the execution gate: no shell is started after a denial.
        const answer = await run("Bash", { command }, "unavailable");
        expect(answer?.permissionDecision).toBe("deny");
        expect(JSON.stringify(answer)).not.toContain("unique-credential-fixture-marker");
      }
    }
    expect(
      await run("Bash", { command: "rg -nFfREADME.md --trace README.md" }, "unavailable"),
    ).toBeUndefined();
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
