import { describe, expect, test } from "bun:test";
import { getNativeSlashCommands } from "./slash-command-registry";

describe("getNativeSlashCommands", () => {
  test("includes documented TUI slash commands by default", () => {
    const commands = getNativeSlashCommands([]);

    expect(commands.length).toBeGreaterThan(10);
    expect(commands.find((command) => command.name === "/help")).toBeDefined();
    expect(commands.find((command) => command.name === "/models")).toBeDefined();
    expect(commands.find((command) => command.name === "/sessions")).toBeDefined();
  });

  test("merges discovered commands and prefers discovered metadata", () => {
    const commands = getNativeSlashCommands([
      {
        name: "init",
        description: "create/update AGENTS.md",
        hints: ["sync rules"],
      },
      {
        name: "/review",
        description: "review changes [commit|branch|pr]",
      },
    ]);

    const initMatches = commands.filter((command) => command.name === "/init");
    expect(initMatches).toHaveLength(1);
    expect(initMatches[0]).toEqual({
      name: "/init",
      description: "create/update AGENTS.md",
      hints: ["sync rules"],
    });

    expect(commands.find((command) => command.name === "/review")).toEqual({
      name: "/review",
      description: "review changes [commit|branch|pr]",
    });
  });

  test("sorts merged commands alphabetically", () => {
    const commands = getNativeSlashCommands([{ name: "/zzz" }, { name: "/aaa" }]);

    const names = commands.map((command) => command.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sortedNames);
  });
});
