import { describe, expect, test } from "bun:test";

import { stripCoordinatorContext } from "./coordinator";
import {
  insertUserCommandContext,
  parseUserCommand,
  renderUserCommandContext,
  stripUserCommandContext,
  USER_COMMAND_CONTEXT_TOTAL_CHARS,
  type UserCommandRecord,
} from "./user-commands";

function command(overrides: Partial<UserCommandRecord> = {}): UserCommandRecord {
  return {
    id: "c1",
    environmentId: "env",
    tabId: "tab",
    command: "npm whoami",
    target: "worktree",
    cwd: "/work",
    status: "exited",
    exitCode: 0,
    startedAt: "2026-10-26T13:00:00.000Z",
    output: "arkaydeus\n",
    outputTruncated: false,
    context: { state: "pending" },
    revision: 1,
    ...overrides,
  };
}

describe("parseUserCommand", () => {
  test("a leading ! is a command", () => {
    expect(parseUserCommand("!npm login")).toBe("npm login");
    expect(parseUserCommand("  ! git status  ")).toBe("git status");
  });

  test("anything else, or a bare !, is an ordinary message", () => {
    expect(parseUserCommand("run !this")).toBeNull();
    expect(parseUserCommand("!")).toBeNull();
    expect(parseUserCommand("!   ")).toBeNull();
    expect(parseUserCommand("/compact")).toBeNull();
  });
});

describe("renderUserCommandContext", () => {
  test("says what ran, where, how it ended, and what it printed", () => {
    const block = renderUserCommandContext([
      command(),
      command({ id: "c2", command: "npm login", status: "cancelled", exitCode: 130, output: "" }),
      command({ id: "c3", command: "tail -f log", status: "running", output: "line\n" }),
    ]);
    expect(block).toStartWith("<orkestrator-user-commands>\n");
    expect(block).toContain("$ npm whoami\n(in /work; exit code 0)\n```\narkaydeus\n```");
    expect(block).toContain("$ npm login\n(in /work; cancelled by the user)\n(no output)");
    expect(block).toContain("$ tail -f log\n(in /work; still running)");
    expect(block).toEndWith("</orkestrator-user-commands>\n\n");
  });

  test("output is bounded, keeping its end", () => {
    const output = `${"a".repeat(100_000)}END`;
    const block = renderUserCommandContext([command({ output })]);
    expect(block.length).toBeLessThan(USER_COMMAND_CONTEXT_TOTAL_CHARS);
    expect(block).toContain("earlier characters omitted");
    expect(block).toContain("aEND\n```");
  });

  test("output containing a fence gets a longer fence", () => {
    expect(renderUserCommandContext([command({ output: "```\nx\n```" })])).toContain("````\n```");
  });
});

describe("context insertion and display", () => {
  const block = renderUserCommandContext([command()]);

  test("an ordinary prompt starts with the block, and display removes it", () => {
    const prompt = insertUserCommandContext("Is that the right account?", block);
    expect(prompt).toStartWith("<orkestrator-user-commands>");
    expect(stripUserCommandContext(prompt)).toBe("Is that the right account?");
  });

  test("a coordinator prompt keeps its coordinator block first", () => {
    const coordinatorPrompt =
      "<orkestrator-coordinator-context>\nids\n</orkestrator-coordinator-context>\n\nPublish it.";
    const prompt = insertUserCommandContext(coordinatorPrompt, block);
    expect(prompt).toStartWith("<orkestrator-coordinator-context>");
    expect(stripUserCommandContext(stripCoordinatorContext(prompt))).toBe("Publish it.");
  });

  test("text the user typed is never stripped", () => {
    expect(stripUserCommandContext("hi <orkestrator-user-commands>x</orkestrator-user-commands>")).toBe(
      "hi <orkestrator-user-commands>x</orkestrator-user-commands>",
    );
    expect(stripUserCommandContext("<orkestrator-user-commands> unterminated")).toBe(
      "<orkestrator-user-commands> unterminated",
    );
    expect(insertUserCommandContext("unchanged", "")).toBe("unchanged");
  });
});
