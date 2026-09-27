import { describe, expect, test } from "bun:test";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { claudeCommandRows, type AnnotationContext } from "./session-manager-commands.js";

function row(name: string, extra: Partial<SlashCommand> = {}): SlashCommand {
  return { name, description: `${name} description`, argumentHint: "", ...extra };
}

function context(extra: Partial<AnnotationContext> = {}): AnnotationContext {
  return {
    skills: new Set(),
    plugins: new Set(),
    terminal: new Set(),
    ...extra,
  };
}

describe("Claude command provenance", () => {
  test("uses a source explicitly supplied by the SDK", () => {
    const project = { ...row("deploy"), source: "projectSettings" } as SlashCommand;
    const plugin = { ...row("review"), source: "plugin" } as SlashCommand;
    const commands = claudeCommandRows([project, plugin], context()).commands;
    expect(commands.map((command) => [command.name, command.source])).toEqual([
      ["/deploy", "project"],
      ["/review", "plugin"],
    ]);
  });

  test("labels a name as a plugin command only when its plugin is loaded", () => {
    const command = row("code-review:review");
    expect(claudeCommandRows([command], context()).commands[0]?.source).toBe("unknown");
    expect(
      claudeCommandRows([command], context({ plugins: new Set(["code-review"]) })).commands[0]
        ?.source,
    ).toBe("plugin");
  });

  test("does not guess provenance from descriptions or the builtin marker", () => {
    const commands = claudeCommandRows(
      [
        row("deploy", { description: "Ship this repository (project)" }),
        row("compact", { builtin: true }),
      ],
      context(),
    ).commands;
    expect(commands.map((command) => command.source)).toEqual(["unknown", "unknown"]);
  });

  test("marks a command as a skill when init metadata identifies it", () => {
    const commands = claudeCommandRows(
      [row("pdf")],
      context({ skills: new Set(["/pdf"]) }),
    ).commands;
    expect(commands[0]).toMatchObject({ name: "/pdf", source: "skill", scope: "session" });
  });

  test("normalizes aliases and preserves command order", () => {
    const commands = claudeCommandRows(
      [row("usage", { aliases: ["cost", "/stats"] }), row("seed")],
      context(),
    ).commands;
    expect(commands.map((command) => command.name)).toEqual(["/usage", "/seed"]);
    expect(commands[0]?.aliases).toEqual(["/cost", "/stats"]);
  });
});
