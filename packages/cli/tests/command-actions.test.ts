import { describe, expect, test } from "bun:test";
import { PUBLIC_ACTION_NAMES, type PublicActionName } from "@orkestrator/protocol/public-api";
import { PUBLIC_ACTION_CLI_COMMANDS } from "@orkestrator/protocol/public-api-cli";
import { PUBLIC_ACTION_INPUTS } from "@orkestrator/protocol/public-api-inputs";
import { CLIENT_COMMANDS } from "../src/client/main.js";
import { SHARED_INPUT_FIELDS } from "../src/client/spec.js";

/**
 * One contract for the CLI and Control MCP: every public action has a
 * command, every command that talks to a backend names its action, and its
 * flags and positionals name that action's input properties (directly, or
 * through `SHARED_INPUT_FIELDS` or the command's own `inputFields`). Control MCP's `describe_action`
 * reads `PUBLIC_ACTION_CLI_COMMANDS`, which must equal what this table says.
 */

/** Flags that shape how the CLI observes or prints, never the action's input. */
const OBSERVER_FLAGS = new Set([
  "request-id",
  "wait",
  "timeout",
  "continue-on-interaction",
  "follow",
  "raw",
  "exit-code",
]);

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const backendCommands = CLIENT_COMMANDS.filter((command) => !command.local);

describe("CLI commands name their public actions", () => {
  test("every command that reaches a backend names its action", () => {
    expect(
      backendCommands.filter((command) => !command.action).map((command) => command.path.join(" ")),
    ).toEqual([]);
    expect(
      CLIENT_COMMANDS.filter((command) => command.local && command.action).map((command) =>
        command.path.join(" "),
      ),
    ).toEqual([]);
  });

  test("every public action except capabilities maps to at least one command", () => {
    const covered = new Set(backendCommands.map((command) => command.action));
    expect(PUBLIC_ACTION_NAMES.filter((action) => !covered.has(action))).toEqual(["capabilities"]);
  });

  test("describe_action's CLI table is the first command naming each action", () => {
    const derived: Record<string, string | null> = Object.fromEntries(
      PUBLIC_ACTION_NAMES.map((action) => [action, null]),
    );
    for (const command of backendCommands) {
      if (command.action && derived[command.action] === null) {
        derived[command.action] = `orkestrator ${command.path.join(" ")}`;
      }
    }
    expect(PUBLIC_ACTION_CLI_COMMANDS).toEqual(derived as Record<PublicActionName, string | null>);
  });

  test("each command's flags and positionals name its action's input properties", () => {
    const problems: string[] = [];
    for (const command of backendCommands) {
      const action = command.action!;
      const properties = Object.keys(PUBLIC_ACTION_INPUTS[action].input.properties);
      const fields = command.inputFields ?? {};
      const names = [
        ...command.options.map((option) => option.name),
        ...command.positionals.map((positional) => positional.name),
      ];
      for (const name of names) {
        if (OBSERVER_FLAGS.has(name)) continue;
        const own = Object.hasOwn(fields, name);
        if (own || Object.hasOwn(SHARED_INPUT_FIELDS, name)) {
          const mapped = own ? fields[name] : SHARED_INPUT_FIELDS[name];
          if (mapped !== null && !properties.includes(mapped!)) {
            problems.push(`${command.path.join(" ")}: ${name} → ${mapped} is not an input`);
          }
          continue;
        }
        if (!properties.includes(camel(name))) {
          problems.push(`${command.path.join(" ")}: ${name} names no ${action} input`);
        }
      }
      for (const name of Object.keys(fields)) {
        if (!names.includes(name)) {
          problems.push(`${command.path.join(" ")}: inputFields names unknown flag ${name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
