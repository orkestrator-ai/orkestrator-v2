/**
 * The contract manifest generator (`scripts/generate-contract-manifest.ts`,
 * plan item 1006) over a fake registry: stable order, digest stability, the
 * domain map's failures, and `--check` drift detection. The real registry is
 * checked by `mise run contract:check` in CI.
 *
 * It lives in the backend package because the fake definitions need
 * `effect`, which the repository root does not depend on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Schema from "effect/Schema";
import { defineCommand } from "@orkestrator/protocol/contract/command";
import { defineDomain, isDomainName } from "@orkestrator/protocol/contract/domain";
import { BACKEND_EVENTS } from "@orkestrator/protocol/contract/domains/events";
import { defineEvent, defineEventFamily } from "@orkestrator/protocol/contract/event";
import { canonicalJsonSchema } from "@orkestrator/protocol/contract/json-schema";
import {
  buildContractManifest,
  CONTRACT_MANIFEST_SCHEMA_VERSION,
  eventManifestKey,
  ContractManifestError,
  describeManifestDrift,
  parseArguments,
  runContractManifest,
  schemaDigest,
  serializeContractManifest,
  untypedCommandCounts,
  type ContractManifest,
} from "../../../../scripts/generate-contract-manifest.ts";
import type { CommandHandler } from "./commands-context.js";
import { CommandRegistry, createRegistryRegistrar } from "./commands-registry-contracts.js";
import {
  CONTRACT_DOMAIN_MAP,
  contractDomainsByCommand,
  type ContractDomainMap,
} from "./contract-domain-map.js";

const nodeMail = defineDomain({ name: "node-mail", version: 2, min: 1 });

const deliverArgs = () =>
  Schema.Struct({
    mailbox: Schema.String,
    steer: Schema.optionalKey(Schema.Boolean),
    idempotencyKey: Schema.optionalKey(Schema.String),
  });

const deliver = defineCommand({
  domain: nodeMail,
  name: "fake_deliver_mail",
  since: 1,
  access: "internal",
  read: false,
  args: deliverArgs(),
  result: Schema.Struct({ delivered: Schema.Boolean }),
  critical: ["steer", "idempotencyKey"],
});

const handler: CommandHandler = () => null;

const terminals = defineDomain({ name: "terminals", version: 1 });
const outboxReady = defineEvent({
  domain: nodeMail,
  name: "fake-outbox-ready",
  payload: Schema.Struct({ controllerId: Schema.String }),
});
const output = defineEventFamily({
  domain: terminals,
  prefix: "fake-output-",
  payload: Schema.Struct({ text: Schema.String }),
});
const FAKE_EVENTS = [output, outboxReady];

/** A registry holding `deliver` and the given string-registered commands, in that order. */
function fakeRegistry(untyped: readonly string[]): CommandRegistry {
  const registry = new CommandRegistry();
  const register = createRegistryRegistrar(registry, { validateResults: false });
  for (const name of untyped) register(name, handler);
  register(deliver, () => ({ delivered: true }));
  return registry;
}

const FAKE_MAP: ContractDomainMap = {
  kanban: ["zeta_update_task", "get_kanban_board"],
  system: ["alpha_restart"],
};
const FAKE_COMMANDS = ["zeta_update_task", "alpha_restart", "get_kanban_board"];

function build(untyped: readonly string[] = FAKE_COMMANDS, domainMap = FAKE_MAP) {
  return buildContractManifest(fakeRegistry(untyped), { domainMap, events: FAKE_EVENTS });
}

function problemsOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractManifestError) return error.problems;
    throw error;
  }
  throw new Error("expected a ContractManifestError");
}

describe("buildContractManifest", () => {
  test("describes defined and untyped commands, sorted by name", () => {
    const manifest = build();
    expect(Object.keys(manifest.commands)).toEqual([
      "alpha_restart",
      "fake_deliver_mail",
      "get_kanban_board",
      "zeta_update_task",
    ]);
    expect(manifest.commands.fake_deliver_mail).toEqual({
      domain: "node-mail",
      since: 1,
      access: "internal",
      read: false,
      critical: ["idempotencyKey", "steer"],
      argsDigest: schemaDigest(deliver.args),
      resultDigest: schemaDigest(deliver.result),
    });
    // `read` for an untyped command is the routing classifier's answer.
    expect(manifest.commands.get_kanban_board).toEqual({
      domain: "kanban",
      untyped: true,
      read: true,
    });
    expect(manifest.commands.zeta_update_task).toEqual({
      domain: "kanban",
      untyped: true,
      read: false,
    });
    expect(manifest.domains).toEqual({ "node-mail": { version: 2, min: 1 } });
    expect(manifest.events).toEqual({
      "fake-outbox-ready": {
        domain: "node-mail",
        payloadDigest: schemaDigest(outboxReady.payload),
      },
      "fake-output-*": {
        domain: "terminals",
        family: true,
        prefix: "fake-output-",
        key: output.key.source,
        payloadDigest: schemaDigest(output.payload),
      },
    });
    expect(Object.keys(manifest.events)).toEqual(["fake-outbox-ready", "fake-output-*"]);
    expect(manifest.counts).toEqual({ commands: 4, defined: 1, untyped: 3, events: 2 });
    expect(manifest.untypedByDomain).toEqual({ kanban: 2, system: 1 });
    expect(Object.keys(manifest.untypedByDomain)).toEqual(["kanban", "system"]);
  });

  test("gives the same text whatever order commands were registered in", () => {
    const first = serializeContractManifest(build());
    expect(serializeContractManifest(build([...FAKE_COMMANDS].reverse()))).toBe(first);
    expect(serializeContractManifest(build())).toBe(first);
    expect(JSON.parse(first).schemaVersion).toBe(CONTRACT_MANIFEST_SCHEMA_VERSION);
  });

  test("fails on a registered command missing from the domain map", () => {
    const problems = problemsOf(() => build([...FAKE_COMMANDS, "brand_new_command"]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("No contract domain for brand_new_command");
    expect(problems[0]).toContain("contract-domain-map.ts");
  });

  test("fails on stale, redundant and duplicate map entries", () => {
    expect(problemsOf(() => build(["alpha_restart", "get_kanban_board"]))).toEqual([
      expect.stringContaining("not registered: zeta_update_task"),
    ]);
    expect(
      problemsOf(() => build(FAKE_COMMANDS, { ...FAKE_MAP, "node-mail": ["fake_deliver_mail"] })),
    ).toEqual([expect.stringContaining("fake_deliver_mail is registered with its definition")]);
    expect(
      problemsOf(() => build(FAKE_COMMANDS, { ...FAKE_MAP, config: ["alpha_restart"] })).join("\n"),
    ).toContain("listed under contract domains system and config");
    expect(
      problemsOf(() =>
        build(FAKE_COMMANDS, { ...FAKE_MAP, system: ["alpha_restart", "alpha_restart"] }),
      ),
    ).toContainEqual(expect.stringContaining("listed twice under contract domain system"));
  });
});

describe("schemaDigest", () => {
  test("is stable across calls, identically built schemas and field order", () => {
    const digest = schemaDigest(deliverArgs());
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(schemaDigest(deliverArgs())).toBe(digest);
    expect(schemaDigest(deliver.args)).toBe(digest);
    const reordered = Schema.Struct({
      idempotencyKey: Schema.optionalKey(Schema.String),
      steer: Schema.optionalKey(Schema.Boolean),
      mailbox: Schema.String,
    });
    expect(schemaDigest(reordered)).toBe(digest);
  });

  test("changes when the schema does, including union order", () => {
    const digest = schemaDigest(deliverArgs());
    const required = Schema.Struct({
      mailbox: Schema.String,
      steer: Schema.Boolean,
      idempotencyKey: Schema.optionalKey(Schema.String),
    });
    expect(schemaDigest(required)).not.toBe(digest);
    expect(schemaDigest(Schema.Literals(["a", "b"]))).not.toBe(
      schemaDigest(Schema.Literals(["b", "a"])),
    );
  });

  test("digests the pinned canonical text, so an effect upgrade that moves it is seen", () => {
    const schema = Schema.Struct({ id: Schema.String, n: Schema.optionalKey(Schema.Finite) });
    expect(canonicalJsonSchema(schema)).toBe(
      '{"definitions":{},"dialect":"draft-2020-12","schema":{"additionalProperties":true,' +
        '"properties":{"id":{"type":"string"},"n":{"type":"number"}},"required":["id"],' +
        '"type":"object"}}',
    );
    expect(schemaDigest(schema)).toBe(
      "sha256:1c0b371bd4f3579505927a7b654797a1046bcd95f33445caaabe4cb695cced6c",
    );
  });
});

describe("runContractManifest", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function manifestPath(): Promise<string> {
    directory = await mkdtemp(path.join(tmpdir(), "contract-manifest-test-"));
    return path.join(directory, "contracts", "manifest.json");
  }

  const text = (untyped: readonly string[] = FAKE_COMMANDS, map = FAKE_MAP) =>
    serializeContractManifest(build(untyped, map));

  test("writes the manifest, then --check passes on it", async () => {
    const file = await manifestPath();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(
      await runContractManifest({
        check: false,
        manifestPath: file,
        generate: async () => text(),
        log,
      }),
    ).toBe(0);
    expect(await readFile(file, "utf8")).toBe(text());
    expect(lines.at(-1)).toContain("4 commands (1 defined, 3 untyped)");
    expect(
      await runContractManifest({
        check: true,
        manifestPath: file,
        generate: async () => text(),
        log,
      }),
    ).toBe(0);
  });

  test("--check detects drift without writing", async () => {
    const file = await manifestPath();
    await runContractManifest({
      check: false,
      manifestPath: file,
      generate: async () => text(),
      log: () => {},
    });
    const committed = await readFile(file, "utf8");
    const lines: string[] = [];
    const drifted = text([...FAKE_COMMANDS, "added_command"], {
      ...FAKE_MAP,
      system: ["alpha_restart", "added_command"],
    });
    expect(
      await runContractManifest({
        check: true,
        manifestPath: file,
        generate: async () => drifted,
        log: (line) => lines.push(line),
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("command added: added_command");
    expect(lines.join("\n")).toContain("mise run contract:manifest");
    expect(await readFile(file, "utf8")).toBe(committed);

    // A hand edit that keeps the commands is drift too.
    await writeFile(file, committed.replace('"read": true', '"read": false'));
    expect(describeManifestDrift(await readFile(file, "utf8"), committed)).toEqual([
      "command changed: get_kanban_board",
    ]);
    await writeFile(file, committed.trimEnd());
    expect(describeManifestDrift(await readFile(file, "utf8"), committed)).toEqual([
      expect.stringContaining("differs from the generated text"),
    ]);
  });

  test("--check fails on a missing manifest and on a generator failure", async () => {
    const file = await manifestPath();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(
      await runContractManifest({
        check: true,
        manifestPath: file,
        generate: async () => text(),
        log,
      }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("is missing");
    const failing = async () => text([...FAKE_COMMANDS, "unmapped"]);
    expect(
      await runContractManifest({ check: true, manifestPath: file, generate: failing, log }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("No contract domain for unmapped");
  });

  test("parses only --check", () => {
    expect(parseArguments([])).toEqual({ check: false });
    expect(parseArguments(["--check"])).toEqual({ check: true });
    expect(() => parseArguments(["--write"])).toThrow(/usage/u);
  });
});

describe("untypedCommandCounts", () => {
  test("reads the totals from the text or the parsed manifest", () => {
    const manifest = build();
    const expected = { total: 3, byDomain: { kanban: 2, system: 1 } };
    expect(untypedCommandCounts(manifest)).toEqual(expected);
    expect(untypedCommandCounts(serializeContractManifest(manifest))).toEqual(expected);
    expect(() =>
      untypedCommandCounts({ ...manifest, schemaVersion: 2 } as unknown as ContractManifest),
    ).toThrow(/schemaVersion/u);
  });
});

describe("CONTRACT_DOMAIN_MAP", () => {
  test("names only known domains and lists each command once", () => {
    for (const domain of Object.keys(CONTRACT_DOMAIN_MAP)) expect(isDomainName(domain)).toBe(true);
    const byCommand = contractDomainsByCommand();
    for (const [domain, commands] of Object.entries(CONTRACT_DOMAIN_MAP)) {
      expect([...commands].sort()).toEqual([...commands]);
      for (const command of commands) expect(byCommand.get(command)).toBe(domain as never);
    }
  });
});

describe("manifest events (plan item 7011)", () => {
  test("default to every backend event", () => {
    const manifest = buildContractManifest(fakeRegistry(FAKE_COMMANDS), { domainMap: FAKE_MAP });
    expect(Object.keys(manifest.events)).toEqual(BACKEND_EVENTS.map(eventManifestKey).sort());
    expect(manifest.counts.events).toBe(BACKEND_EVENTS.length);
    expect(manifest.events["terminal-output-*"]).toMatchObject({
      domain: "terminals",
      family: true,
    });
    expect(manifest.events["resource-changed"]).toMatchObject({ domain: "system" });
  });

  test("fail on a duplicate event and on a family prefix covering another event", () => {
    const covered = defineEvent({ domain: terminals, name: "fake-output-x", payload: Schema.Null });
    const problems = problemsOf(() =>
      buildContractManifest(fakeRegistry(FAKE_COMMANDS), {
        domainMap: FAKE_MAP,
        events: [outboxReady, outboxReady, output, covered],
      }),
    );
    expect(problems).toEqual([
      "Event fake-outbox-ready is defined twice.",
      "Event family fake-output-* also covers fake-output-x.",
    ]);
  });

  test("a payload schema change is drift", () => {
    const changed = defineEvent({
      domain: nodeMail,
      name: "fake-outbox-ready",
      payload: Schema.Struct({ controllerId: Schema.String, count: Schema.Finite }),
    });
    const before = serializeContractManifest(build());
    const after = serializeContractManifest(
      buildContractManifest(fakeRegistry(FAKE_COMMANDS), {
        domainMap: FAKE_MAP,
        events: [output, changed],
      }),
    );
    expect(describeManifestDrift(before, after)).toEqual(["event changed: fake-outbox-ready"]);
  });
});
