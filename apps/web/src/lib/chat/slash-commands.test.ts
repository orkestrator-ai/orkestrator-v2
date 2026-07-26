import { describe, expect, test } from "bun:test";
import { parseSlashCommands } from "./slash-commands";

describe("parseSlashCommands", () => {
  test("returns an empty list for missing or empty input", () => {
    expect(parseSlashCommands(undefined)).toEqual([]);
    expect(parseSlashCommands([])).toEqual([]);
  });

  test("adds the leading slash when the SDK omits it", () => {
    expect(parseSlashCommands(["compact"])).toEqual([
      { name: "/compact", description: undefined },
    ]);
    expect(parseSlashCommands(["/compact"])).toEqual([
      { name: "/compact", description: undefined },
    ]);
  });

  test("splits a description on the first ' - ' only", () => {
    // A description may itself contain " - "; splitting on the last one would
    // move part of the prose into the command name.
    expect(parseSlashCommands(["/review - check the diff - carefully"])).toEqual(
      [{ name: "/review", description: "check the diff - carefully" }],
    );
  });

  test("trims surrounding whitespace from the name and description", () => {
    expect(parseSlashCommands(["  /compact   -   shrink it  "])).toEqual([
      { name: "/compact", description: "shrink it" },
    ]);
  });

  test("prefers the described entry when the same command appears twice", () => {
    // Order must not matter: the bare entry arriving second cannot erase the
    // description the user is relying on to tell two commands apart.
    expect(parseSlashCommands(["/clear", "/clear - wipe the transcript"])).toEqual(
      [{ name: "/clear", description: "wipe the transcript" }],
    );
    expect(parseSlashCommands(["/clear - wipe the transcript", "/clear"])).toEqual(
      [{ name: "/clear", description: "wipe the transcript" }],
    );
  });

  test("keeps commands whose names merely share a prefix", () => {
    const commands = parseSlashCommands(["/test", "/testing"]);
    expect(commands.map((command) => command.name)).toEqual([
      "/test",
      "/testing",
    ]);
  });

  test("sorts by name so the menu order does not depend on the server", () => {
    const commands = parseSlashCommands(["/zeta", "/alpha", "/mid - middle"]);
    expect(commands.map((command) => command.name)).toEqual([
      "/alpha",
      "/mid",
      "/zeta",
    ]);
  });

  test("tolerates degenerate entries rather than throwing", () => {
    expect(parseSlashCommands(["/"])).toEqual([
      { name: "/", description: undefined },
    ]);
    expect(parseSlashCommands([""])).toEqual([
      { name: "/", description: undefined },
    ]);
  });
});
