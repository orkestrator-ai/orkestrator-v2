import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import type { BackendClient } from "./client";

/**
 * Plan item 3002: every `lib/backend/<x>.ts` exports `createXApi(client)`, and
 * each function it returns sends through that client, never the window's
 * command scope (`@/lib/native/backend` `invoke`, mocked by `tests/setup.ts`).
 * The two fixed-node files have no factory; the last block pins their binding.
 */

const commandInvoke = invoke as unknown as ReturnType<typeof mock>;

const FIXED_NODE_FILES: ReadonlySet<string> = new Set(["command-nodes.ts", "self-improvement.ts"]);

const directory = import.meta.dir;
const modules = readdirSync(directory)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  // Not command files: the client builders, shared helpers and the per-scope
  // aggregate of every factory (`backendForScope`, plan item 4001).
  .filter((file) => file !== "client.ts" && file !== "shared.ts" && file !== "scope-backend.ts")
  // Bound to one node by design, so they have no factory (7571 task 14):
  // command-node commands always go to the command node over the portal, and
  // self-improvement is this window's own backend.
  .filter((file) => !FIXED_NODE_FILES.has(file))
  .sort();

/**
 * Functions that also write a command-node setting (`invokeCommandNodeSetting`)
 * before asking `machine`: those settings belong to the command node whatever
 * the client, so the command scope is reached on purpose.
 */
const ALSO_COMMAND_NODE = new Set([
  "setAgentAccountAutoSwitchEnabled",
  "setAgentAccountAutoSwitchIncluded",
]);

function factoryName(file: string): string {
  const base = file.replace(/\.ts$/, "");
  return `create${base
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")}Api`;
}

async function call(fn: (...args: unknown[]) => unknown, args: unknown[]): Promise<void> {
  try {
    await fn(...args);
  } catch {
    // Only the transport reached is asserted; the fake answer may be rejected.
  }
}

afterEach(() => {
  commandInvoke.mockClear();
});

describe("lib/backend factories", () => {
  test("every source file has a factory", () => {
    expect(modules.length).toBe(37);
  });

  for (const file of modules) {
    const name = factoryName(file);
    test(`${name} (${file}) sends through the client it is given`, async () => {
      const module = (await import(path.join(directory, file))) as Record<string, unknown>;
      const create = module[name];
      expect(typeof create, `${file} exports ${name}`).toBe("function");

      const invokeRaw = mock(() => Promise.resolve(undefined as never));
      const client: BackendClient = { invokeRaw };
      const api = (create as (client: BackendClient) => Record<string, unknown>)(client);
      const functions = Object.entries(api).filter(
        (entry): entry is [string, (...args: unknown[]) => unknown] =>
          typeof entry[1] === "function",
      );
      expect(functions.length).toBeGreaterThan(0);

      for (const [fnName, fn] of functions) {
        // The command-bound named export is the same function over the command scope.
        expect(typeof module[fnName], `${file} keeps ${fnName} as a named export`).toBe("function");
        const values = Array.from({ length: fn.length }, () => "value");
        // A trailing `machine` of "value" asks another node through the
        // command node; without one the call is for the client's own node.
        const attempts = [values, [...values.slice(0, -1), undefined], []];
        for (const args of attempts) {
          invokeRaw.mockClear();
          commandInvoke.mockClear();
          await call(fn, args);
          if (invokeRaw.mock.calls.length > 0) break;
        }
        expect(invokeRaw.mock.calls.length, `${fnName} reaches the given client`).toBeGreaterThan(
          0,
        );
        if (!ALSO_COMMAND_NODE.has(fnName))
          expect(commandInvoke.mock.calls, `${fnName} leaves the command scope alone`).toEqual([]);
      }
    });
  }
});

/** Exports of the fixed-node files that are helpers, not commands. */
const FIXED_NODE_HELPERS = new Set(["nodeErrorText"]);

function commandName(fnName: string): string {
  return fnName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// The fixed-node files have no factory to hand a client to, so pin their
// binding instead (7571 task 14): `command-nodes.ts` sends through
// `portalBackendClient` and `self-improvement.ts` through
// `commandBackendClient`, and both of those are the window's command scope
// (`@/lib/native/backend` `invoke`). A function rebound to another node's
// client, or to `invokeOnMachine`, would leave that mock untouched.
describe("lib/backend fixed-node files", () => {
  for (const file of Array.from(FIXED_NODE_FILES).sort()) {
    test(`${file} sends every command through the window's command scope`, async () => {
      const module = (await import(path.join(directory, file))) as Record<string, unknown>;
      expect(typeof module[factoryName(file)], `${file} has no factory`).toBe("undefined");
      const functions = Object.entries(module).filter(
        (entry): entry is [string, (...args: unknown[]) => unknown] =>
          typeof entry[1] === "function" && !FIXED_NODE_HELPERS.has(entry[0]),
      );
      expect(functions.length).toBeGreaterThan(0);

      for (const [fnName, fn] of functions) {
        commandInvoke.mockClear();
        await call(
          fn,
          Array.from({ length: Math.max(fn.length, 1) }, () => ({})),
        );
        expect(
          commandInvoke.mock.calls.map((call) => call[0]),
          `${fnName} reaches the command scope`,
        ).toEqual([commandName(fnName)]);
      }
    });
  }
});
