import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { defineCommand, InvalidCommandResultError } from "@orkestrator/protocol/contract/command";
import { defineDomain } from "@orkestrator/protocol/contract/domain";
import {
  incompatibility,
  UnsupportedFieldError,
  UnsupportedVersionError,
} from "@orkestrator/protocol/contract/errors";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import {
  CommandRegistry,
  contractResultValidationDefault,
  createRegistryRegistrar,
  registrarFrom,
} from "./commands-registry-contracts.js";
import { createCommandRegistry } from "./commands-registry.js";
import { designAdmissionRegistrar } from "./commands-registry-design.js";
import { mcpCorrelatedRegistrar } from "./commands-registry-mcp.js";
import { containerBridgeStartRegistrar } from "./commands-registry-servers.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { gatedRegistrar } from "./commands-registry-web-annotations.js";

// A throwaway definition: no real handler is converted in plan item 1003.
const system = defineDomain({ name: "system", version: 3, min: 2 });

const probeEcho = defineCommand({
  domain: system,
  name: "contract_probe_echo",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    text: Schema.String,
    count: Schema.optionalKey(Schema.Finite),
    options: Schema.optionalKey(
      Schema.Struct({
        loud: Schema.Boolean,
        tags: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
    label: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(1, { message: "Expected label to be a non-blank string" }),
      ),
    ),
    mode: Schema.optionalKey(Schema.Literals(["plain", "rich"])),
  }),
  result: Schema.Struct({ echoed: Schema.String }),
  critical: ["count"],
});

const probeEncoded = defineCommand({
  domain: system,
  name: "contract_probe_encoded",
  since: 3,
  access: "workspace",
  read: true,
  args: Schema.Struct({}),
  result: Schema.Struct({ rows: Schema.Array(Schema.String) }),
  critical: [],
  encoded: true,
});

const context = {} as CommandContext;

function registry(validateResults = true) {
  const commands = new CommandRegistry();
  const register = createRegistryRegistrar(commands, { validateResults });
  return { commands, register };
}

function call(commands: CommandRegistry, name: string, args: unknown, invocation?: unknown) {
  return commands.get(name)!(args as Record<string, unknown>, context, invocation as never);
}

describe("registry: definitions and names", () => {
  test("defined and string commands coexist; only definitions enter contracts", async () => {
    const { commands, register } = registry();
    register("plain_echo", (args) => ({ args }));
    register(probeEcho, ({ text }) => ({ echoed: text }));
    expect([...commands.keys()].sort()).toEqual(["contract_probe_echo", "plain_echo"]);
    expect([...commands.contracts.keys()]).toEqual(["contract_probe_echo"]);
    expect(commands.contracts.get("contract_probe_echo")).toBe(probeEcho);
    expect(commands.domainRanges.get("system")).toEqual({ min: 2, max: 3 });
    // A string command still receives its arguments untouched.
    expect(await call(commands, "plain_echo", { a: 1, b: { c: 2 } })).toEqual({
      args: { a: 1, b: { c: 2 } },
    });
    expect(await call(commands, "contract_probe_echo", { text: "hi" })).toEqual({ echoed: "hi" });
  });

  test("a duplicate name across forms throws, in either order", () => {
    const first = registry();
    first.register("contract_probe_echo", () => null);
    expect(() => first.register(probeEcho, ({ text }) => ({ echoed: text }))).toThrow(
      "Command contract_probe_echo is already registered.",
    );
    const second = registry();
    second.register(probeEcho, ({ text }) => ({ echoed: text }));
    expect(() => second.register("contract_probe_echo", () => null)).toThrow(
      "Command contract_probe_echo is already registered with its definition.",
    );
    expect(() => second.register(probeEcho, ({ text }) => ({ echoed: text }))).toThrow(
      "already registered",
    );
  });

  test("two definitions disagreeing on a domain's range throw", () => {
    const { register } = registry();
    register(probeEcho, ({ text }) => ({ echoed: text }));
    const otherSystem = defineDomain({ name: "system", version: 4 });
    const other = defineCommand({
      domain: otherSystem,
      name: "contract_probe_other",
      since: 1,
      access: "workspace",
      read: true,
      args: Schema.Struct({}),
      result: Schema.Null,
      critical: [],
    });
    expect(() => register(other, () => null)).toThrow("defined with two version ranges");
  });

  test("the real registry's definitions and ranges are the committed manifest's", () => {
    const commands = createCommandRegistry();
    expect(commands).toBeInstanceOf(Map);
    expect(commands.size).toBeGreaterThan(100);
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../../packages/protocol/contracts/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as {
      counts: { defined: number };
      domains: Record<string, { version: number; min: number }>;
    };
    expect(commands.contracts.size).toBe(manifest.counts.defined);
    expect(commands.helloDomains()).toEqual(
      Object.fromEntries(
        Object.entries(manifest.domains).map(([name, { version, min }]) => [
          name,
          { min, max: version },
        ]),
      ),
    );
  });
});

describe("parsing: tolerant arguments and must-understand fields", () => {
  test("the real registry fences an environment mutation after contract decoding", async () => {
    const commands = createCommandRegistry({ validateContractResults: false });
    const environment = { id: "environment", containerId: "replacement" };
    const updates: unknown[] = [];
    const guardedContext = {
      storage: {
        getDataDir: () => "/isolated-contract-test",
        getEnvironment: async () => environment,
        updateEnvironment: async (id: string, update: unknown) => {
          updates.push({ id, update });
          return environment;
        },
      },
    } as unknown as CommandContext;
    const mutate = (expectedRuntimeGeneration: unknown) =>
      commands.get("update_port_mappings")!(
        { environmentId: environment.id, portMappings: [], expectedRuntimeGeneration },
        guardedContext,
      );
    expect(commands.contracts.has("update_port_mappings")).toBe(true);
    await expect(mutate(0)).rejects.toMatchObject({
      name: "ContainerLifecycleError",
      code: "runtime-changed",
    });
    expect(updates).toEqual([]);
    for (const invalid of [null, "1", -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(mutate(invalid)).rejects.toMatchObject({ code: "invalid-request" });
    }
    expect(updates).toEqual([]);
    await mutate(1);
    expect(updates).toEqual([{ id: environment.id, update: { portMappings: [] } }]);
    // Legacy callers that supply no fence still work.
    await mutate(undefined);
    expect(updates).toHaveLength(2);
  });

  test("unknown fields are stripped before the handler runs", async () => {
    const { commands, register } = registry();
    let seen: unknown;
    register(probeEcho, (args) => {
      seen = args;
      return { echoed: args.text };
    });
    await call(commands, "contract_probe_echo", { text: "a", count: 2, extra: true, nested: {} });
    expect(seen).toEqual({ text: "a", count: 2 });
  });

  test("an unknown critical field the arguments carry is refused with code and field", () => {
    const { commands, register } = registry();
    register(probeEcho, ({ text }) => ({ echoed: text }));
    let caught: unknown;
    try {
      call(commands, "contract_probe_echo", { text: "a", steer: true }, { critical: ["steer"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedFieldError);
    expect(incompatibility(caught)).toEqual({
      code: "unsupported-field",
      domain: "system",
      field: "steer",
      command: "contract_probe_echo",
    });
  });

  test("a known or absent critical field is accepted", async () => {
    const { commands, register } = registry();
    register(probeEcho, ({ text, count }) => ({ echoed: `${text}${count ?? ""}` }));
    expect(
      await call(commands, "contract_probe_echo", { text: "a", count: 1 }, { critical: ["count"] }),
    ).toEqual({ echoed: "a1" });
    expect(
      await call(commands, "contract_probe_echo", { text: "a" }, { critical: ["steer"] }),
    ).toEqual({ echoed: "a" });
  });

  test("a string command refuses a critical field it carries, and runs without one", async () => {
    const { commands, register } = registry();
    register("plain_echo", (args) => args);
    expect(() => call(commands, "plain_echo", { steer: true }, { critical: ["steer"] })).toThrow(
      UnsupportedFieldError,
    );
    expect(await call(commands, "plain_echo", { other: 1 }, { critical: ["steer"] })).toEqual({
      other: 1,
    });
    expect(await call(commands, "plain_echo", { steer: true })).toEqual({ steer: true });
  });

  test("schema failures keep the commands-validation phrasing", () => {
    const { commands, register } = registry();
    register(probeEcho, ({ text }) => ({ echoed: text }));
    const message = (args: unknown) => {
      try {
        call(commands, "contract_probe_echo", args);
      } catch (error) {
        return (error as Error).message;
      }
      return "accepted";
    };
    expect(message({})).toBe("Expected text to be a string");
    expect(message({ text: 3 })).toBe("Expected text to be a string");
    expect(message({ text: "a", count: "1" })).toBe("Expected count to be a number");
    expect(message({ text: "a", options: [] })).toBe("Expected options to be an object");
    expect(message({ text: "a", options: { loud: 1 } })).toBe(
      "Expected options.loud to be a boolean",
    );
    expect(message({ text: "a", options: { loud: true, tags: ["x", 2] } })).toBe(
      "Expected options.tags[1] to be a string",
    );
    expect(message({ text: "a", label: "" })).toBe("Expected label to be a non-blank string");
    expect(message({ text: "a", mode: "loud" })).toBe('Expected mode to be one of "plain", "rich"');
    expect(message({ text: "a", count: Number.POSITIVE_INFINITY })).toBe(
      "Expected count to be a finite number",
    );
    // Values never appear in the text.
    expect(message({ text: "secret-value-123", count: "secret-value-456" })).not.toContain(
      "secret",
    );
  });
});

describe("result validation", () => {
  test("defaults on in development and tests only", () => {
    expect(contractResultValidationDefault({ NODE_ENV: "test" })).toBe(true);
    expect(contractResultValidationDefault({ NODE_ENV: "development" })).toBe(true);
    expect(contractResultValidationDefault({ NODE_ENV: "production" })).toBe(false);
    expect(contractResultValidationDefault({})).toBe(false);
    expect(contractResultValidationDefault()).toBe(true);
  });

  test("fires in test mode for synchronous and asynchronous handlers", async () => {
    const { commands, register } = registry(true);
    register(probeEcho, () => ({ echoed: 3 }) as never);
    register("plain_echo", () => ({ echoed: 3 }));
    expect(() => call(commands, "contract_probe_echo", { text: "a" })).toThrow(
      InvalidCommandResultError,
    );
    const asyncRegistry = registry(true);
    asyncRegistry.register(probeEcho, async () => ({ wrong: true }) as never);
    await expect(
      call(asyncRegistry.commands, "contract_probe_echo", { text: "a" }) as Promise<unknown>,
    ).rejects.toThrow("Invalid result from contract_probe_echo");
    // A string command's result is never validated.
    expect(await call(commands, "plain_echo", {})).toEqual({ echoed: 3 });
  });

  test("returns the handler's own value and keeps a synchronous handler synchronous", () => {
    const { commands, register } = registry(true);
    const value = { echoed: "a", extra: 1 };
    register(probeEcho, () => value as never);
    expect(call(commands, "contract_probe_echo", { text: "a" })).toBe(value);
  });

  test("skips encoded results and production registries", async () => {
    const { commands, register } = registry(true);
    const spliced = { rows: [1, 2] };
    register(probeEncoded, () => spliced as never);
    expect(await call(commands, "contract_probe_encoded", {})).toBe(spliced);
    const production = registry(false);
    production.register(probeEcho, () => ({ echoed: 3 }) as never);
    expect(await call(production.commands, "contract_probe_echo", { text: "a" })).toEqual({
      echoed: 3,
    });
  });
});

describe("domain version range", () => {
  test("a version outside the range is refused with the range, for every command", () => {
    const { commands, register } = registry();
    register(probeEcho, ({ text }) => ({ echoed: text }));
    register("plain_echo", () => "ok");
    for (const name of ["contract_probe_echo", "plain_echo"]) {
      let caught: unknown;
      try {
        call(commands, name, { text: "a" }, { domain: "system", version: 7 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsupportedVersionError);
      expect(incompatibility(caught)).toEqual({
        code: "unsupported-version",
        domain: "system",
        range: { min: 2, max: 3 },
        command: name,
      });
      expect((caught as Error).message).toContain("accepts versions 2 to 3");
    }
    expect(() => call(commands, "plain_echo", {}, { domain: "system", version: 1 })).toThrow(
      UnsupportedVersionError,
    );
  });

  test("a version in range, a domain without definitions, or no version runs", async () => {
    const { commands, register } = registry();
    register(probeEcho, ({ text }) => ({ echoed: text }));
    expect(
      await call(commands, "contract_probe_echo", { text: "a" }, { domain: "system", version: 2 }),
    ).toEqual({ echoed: "a" });
    expect(
      await call(commands, "contract_probe_echo", { text: "a" }, { domain: "kanban", version: 9 }),
    ).toEqual({ echoed: "a" });
    expect(
      await call(commands, "contract_probe_echo", { text: "a" }, { domain: "system" }),
    ).toEqual({ echoed: "a" });
  });
});

describe("wrapping registrars forward both forms", () => {
  const wrappers: Array<[string, (register: CommandRegistrar) => CommandRegistrar]> = [
    ["web annotation rollout gate", gatedRegistrar],
    ["MCP correlation", mcpCorrelatedRegistrar],
    ["design admission", designAdmissionRegistrar],
    [
      "container bridge start",
      (register) => {
        const start = containerBridgeStartRegistrar(register);
        return ((target: never, handler: CommandHandler) =>
          start(target, "opencode", handler)) as unknown as CommandRegistrar;
      },
    ],
  ];

  for (const [label, wrap] of wrappers) {
    test(label, async () => {
      const { commands, register } = registry();
      const wrapped = wrap(register);
      let seen: unknown;
      wrapped(probeEcho, (args) => {
        seen = args;
        return { echoed: args.text };
      });
      wrapped("plain_echo", (args) => args);
      expect(commands.contracts.get("contract_probe_echo")).toBe(probeEcho);
      expect(commands.has("plain_echo")).toBe(true);
      const realContext = {
        runtime: { environments: { fence: { beginMutation: () => () => undefined } } },
        storage: { getEnvironment: async () => null },
      } as unknown as CommandContext;
      const result = await commands.get("contract_probe_echo")!(
        { text: "a", extra: 1 },
        realContext,
      );
      expect(result).toEqual({ echoed: "a" });
      expect(seen).toEqual({ text: "a" });
      expect(() =>
        commands.get("contract_probe_echo")!({ text: "a", steer: 1 }, realContext, {
          critical: ["steer"],
        }),
      ).toThrow(UnsupportedFieldError);
    });
  }
});

describe("registrarFrom", () => {
  test("hands string handlers through and decodes definitions", async () => {
    const sink = new Map<string, CommandHandler>();
    const register = registrarFrom((name, handler) => sink.set(name, handler));
    const plain: CommandHandler = (args) => args;
    register("plain_echo", plain);
    register(probeEcho, ({ text }) => ({ echoed: text }));
    expect(sink.get("plain_echo")).toBe(plain);
    expect(await sink.get("contract_probe_echo")!({ text: "a", extra: 1 }, context)).toEqual({
      echoed: "a",
    });
  });
});

describe("beforeDecode", () => {
  test("wraps decoding: the wrapper sees the raw arguments and the decode failure", async () => {
    for (const make of [
      () => {
        const { commands, register } = registry();
        return { register, get: (name: string) => commands.get(name)! };
      },
      () => {
        const sink = new Map<string, CommandHandler>();
        return {
          register: registrarFrom((name, handler) => sink.set(name, handler)),
          get: (name: string) => sink.get(name)!,
        };
      },
    ]) {
      const { register, get } = make();
      const raw: unknown[] = [];
      let decoded: unknown;
      register(
        probeEcho,
        (args) => {
          decoded = args;
          return { echoed: args.text };
        },
        {
          beforeDecode: (run) => (args, ctx, invocation) => {
            raw.push(args);
            try {
              return run(args, ctx, invocation);
            } catch (error) {
              throw new Error(`wrapped: ${(error as Error).message}`);
            }
          },
        },
      );
      expect(await get("contract_probe_echo")({ text: "a", extra: 1 }, context)).toEqual({
        echoed: "a",
      });
      expect(raw).toEqual([{ text: "a", extra: 1 }]);
      expect(decoded).toEqual({ text: "a" });
      expect(() => get("contract_probe_echo")({ text: 1 }, context)).toThrow("wrapped:");
    }
  });
});
