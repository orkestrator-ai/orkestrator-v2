import { describe, expect, test } from "bun:test";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { normalizeCommands } from "./session-manager-catalog.js";

/**
 * Provenance of Claude slash commands.
 *
 * The SDK marks Claude Code's own commands with `builtin: true` and leaves the
 * marker off everything a user, project, plugin or MCP server defines. The
 * bridge used to read `source`/`scope` fields the SDK never sent, so every
 * command — a user's own skills included — was grouped under "Built in".
 */
function row(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return { name, description: `${name} description`, argumentHint: "", ...extra };
}

describe("normalizeCommands provenance", () => {
  test("labels a marked row builtin", () => {
    const [command] = normalizeCommands([row("compact", { builtin: true })]);
    expect(command).toMatchObject({ name: "/compact", source: "builtin", scope: "global" });
  });

  test("labels an unmarked namespaced row as a plugin command", () => {
    const [command] = normalizeCommands([row("code-review:code-review")]);
    expect(command).toMatchObject({ name: "/code-review:code-review", source: "plugin" });
  });

  test("labels an unmarked plain row as the user's own command", () => {
    const [command] = normalizeCommands([
      row("yolocommit", { description: "Create well-formatted commits (user)" }),
    ]);
    expect(command).toMatchObject({ name: "/yolocommit", source: "user", scope: "global" });
  });

  test("keeps a project command scoped to the session", () => {
    const [command] = normalizeCommands([
      row("deploy", { description: "Ship this repository (project)" }),
    ]);
    expect(command).toMatchObject({ name: "/deploy", source: "project", scope: "session" });
  });

  test("never labels an unmarked row builtin, even with no hints at all", () => {
    const commands = normalizeCommands([row("mystery", { description: "" })]);
    expect(commands[0]?.source).toBe("user");
    expect(commands[0]).not.toHaveProperty("description");
  });

  test("still honours a legacy source field when one is present", () => {
    const legacy = { ...row("legacy"), source: "projectSettings" } as SlashCommand;
    expect(normalizeCommands([legacy])[0]?.source).toBe("project");
  });

  test("a builtin marker outranks a legacy source field", () => {
    const legacy = { ...row("help", { builtin: true }), source: "userSettings" } as SlashCommand;
    expect(normalizeCommands([legacy])[0]?.source).toBe("builtin");
  });
});

describe("normalizeCommands shared names", () => {
  test("a marked row wins over an unmarked row listed before it", () => {
    const commands = normalizeCommands([
      row("review", { description: "User review (user)" }),
      row("review", { description: "Claude review", builtin: true }),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ source: "builtin", description: "Claude review" });
  });

  test("a marked row is not displaced by an unmarked row listed after it", () => {
    const commands = normalizeCommands([
      row("review", { description: "Claude review", builtin: true }),
      row("review", { description: "User review (user)" }),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ source: "builtin", description: "Claude review" });
  });

  test("keeps distinct names and their order", () => {
    const commands = normalizeCommands([
      row("compact", { builtin: true }),
      row("seed"),
      row("frontend-design:frontend-design"),
    ]);
    expect(commands.map((command) => [command.name, command.source])).toEqual([
      ["/compact", "builtin"],
      ["/seed", "user"],
      ["/frontend-design:frontend-design", "plugin"],
    ]);
  });

  test("normalizes aliases and appends session skills", () => {
    const commands = normalizeCommands(
      [row("usage", { builtin: true, aliases: ["cost", "/stats"] })],
      ["pdf"],
    );
    expect(commands).toEqual([
      {
        name: "/usage",
        source: "builtin",
        description: "usage description",
        aliases: ["/cost", "/stats"],
        scope: "global",
      },
      { name: "/skill:pdf", source: "skill", scope: "session" },
    ]);
  });
});
