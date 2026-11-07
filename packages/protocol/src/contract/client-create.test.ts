/**
 * `createDomainClient` (plan item 1009): selection per connection
 * generation, the legacy adapter for pre-contract nodes, the coded
 * `unsupported-version` refusal, the envelope, result decoding, the legacy
 * context and the usage counter. The "Done when" case drives a test domain
 * with versions 0, 1 and 2 against fake backends advertising each range.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import type { NegotiatedDomainRange, NegotiatedDomains } from "../node-client.js";
import {
  LEGACY_CAPABILITY_COMMANDS,
  createDomainClient,
  domainClient,
  type CommandCall,
  type ContractEnvelopeFields,
  type DomainAdapterContext,
  type DomainCall,
} from "./client.js";
import { InvalidCommandResultError, defineCommand } from "./command.js";
import { DOMAIN_NAMES, defineDomain } from "./domain.js";
import {
  UnsupportedVersionError,
  incompatibility,
  unknownCommand,
  unsupportedVersion,
} from "./errors.js";

const files = defineDomain({ name: "node-files", version: 2, min: 1 });

/** Version 1's listing: names only. */
const listNames = defineCommand({
  domain: files,
  name: "fake_list_names",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ dir: Schema.String }),
  result: Schema.Array(Schema.String),
  critical: [],
});

/** Version 2's listing: entries with sizes, and a must-understand `hidden`. */
const listEntries = defineCommand({
  domain: files,
  name: "fake_list_entries",
  since: 2,
  access: "workspace",
  read: true,
  args: Schema.Struct({ dir: Schema.String, hidden: Schema.optionalKey(Schema.Boolean) }),
  result: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Finite })),
  critical: ["hidden"],
});

interface Entry {
  readonly name: string;
  readonly size: number | null;
}

interface FilesApi {
  list(dir: string, options?: { hidden?: boolean }): Promise<readonly Entry[]>;
  readonly version: number;
}

const filesClient = domainClient(files, {
  2: (call): FilesApi => ({
    version: 2,
    list: async (dir, options = {}) =>
      call(listEntries, {
        dir,
        ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
      }),
  }),
  1: (call): FilesApi => ({
    version: 1,
    list: async (dir, options = {}) => {
      if (options.hidden) throw new Error("Hidden files need a newer node.");
      return (await call(listNames, { dir })).map((name) => ({ name, size: null }));
    },
  }),
  // Today's behaviour on a pre-contract node: an untyped command, gated by a
  // hello capability.
  0: (_call, legacy): FilesApi => ({
    version: 0,
    list: async (dir) => {
      if (!legacy.capabilities?.has("legacy-listing")) return [];
      const names = (await legacy.invoke("legacy_list_files", { dir })) as string[];
      return names.map((name) => ({ name, size: null }));
    },
  }),
});

interface Sent {
  readonly command: string;
  readonly args: unknown;
  readonly envelope: ContractEnvelopeFields | undefined;
}

/**
 * A fake backend. `range` is what its hello advertises for `node-files`;
 * `null` is a pre-contract node, which ignores the envelope and has only
 * today's untyped command. A contract node refuses a version outside its
 * range with its range, as the registry does, and serves the commands its
 * newest version has.
 */
function fakeBackend(range: NegotiatedDomainRange | null) {
  const sent: Sent[] = [];
  const listing = [
    { name: "a.txt", size: 1 },
    { name: ".hidden", size: 2 },
  ];
  const call: DomainCall = async (def, args, envelope) => {
    sent.push({ command: def.name, args, envelope });
    if (range === null || def.since > range.max) throw unknownCommand(def.name);
    if (
      envelope &&
      envelope.domain === files.name &&
      (envelope.version < range.min || envelope.version > range.max)
    ) {
      throw unsupportedVersion({ domain: files.name, range, version: envelope.version });
    }
    const { hidden } = args as { hidden?: boolean };
    const visible = listing.filter((entry) => hidden || !entry.name.startsWith("."));
    if (def.name === listNames.name) return visible.map((entry) => entry.name);
    // An extra key a newer node might add is dropped by the client.
    return visible.map((entry) => ({ ...entry, mtime: 0 }));
  };
  const invoke = async (command: string, args?: Readonly<Record<string, unknown>>) => {
    sent.push({ command, args, envelope: undefined });
    if (command === "legacy_list_files") return ["legacy.txt"];
    throw new Error(`Unknown backend command: ${command}`);
  };
  const domains: NegotiatedDomains | null = range === null ? null : { [files.name]: range };
  return { sent, call, invoke, domains };
}

describe("createDomainClient selection", () => {
  const cases: [string, NegotiatedDomains | null | undefined, number | null][] = [
    ["both versions in range", { "node-files": { min: 1, max: 2 } }, 2],
    ["a node at version 1", { "node-files": { min: 1, max: 1 } }, 1],
    ["a newer node still accepting 2", { "node-files": { min: 2, max: 7 } }, 2],
    ["a pre-contract node (no domains)", null, 0],
    ["no domains yet", undefined, 0],
    ["a contract node without the domain", { "node-mail": { min: 1, max: 1 } }, 0],
    ["a node past every adapter", { "node-files": { min: 3, max: 4 } }, null],
  ];
  for (const [name, domains, expected] of cases) {
    it(`picks ${expected} for ${name}`, () => {
      const client = createDomainClient(filesClient, { call: fakeBackend(null).call, domains });
      expect(client.version()).toBe(expected);
      if (expected === null) expect(() => client.api()).toThrow(UnsupportedVersionError);
      else expect(client.api().version).toBe(expected);
    });
  }

  it("refuses with a coded unsupported-version naming the node's range", () => {
    const client = createDomainClient(filesClient, {
      call: fakeBackend(null).call,
      domains: { "node-files": { min: 3, max: 4 } },
    });
    let thrown: unknown;
    try {
      client.api();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedVersionError);
    expect(incompatibility(thrown)).toEqual({
      code: "unsupported-version",
      domain: "node-files",
      range: { min: 3, max: 4 },
    });
    expect((thrown as Error).message).toContain("version 2");
  });

  it("refuses a pre-contract node when the client has no legacy adapter", () => {
    const modern = domainClient(files, { 2: (call) => ({ call }) });
    const client = createDomainClient(modern, { call: fakeBackend(null).call, domains: null });
    expect(client.version()).toBeNull();
    expect(() => client.api()).toThrow(/accepts versions 0 to 0/);
    expect(incompatibility(capture(() => client.api()))?.range).toEqual({ min: 0, max: 0 });
  });

  it("caches the choice per domains identity and picks again for a new generation", () => {
    let builds = 0;
    const counted = domainClient(files, {
      2: () => ({ version: 2, build: ++builds }),
      1: () => ({ version: 1, build: ++builds }),
      0: () => ({ version: 0, build: ++builds }),
    });
    let domains: NegotiatedDomains | null = { "node-files": { min: 1, max: 2 } };
    const client = createDomainClient(counted, {
      call: fakeBackend(null).call,
      domains: () => domains,
    });
    const first = client.api();
    expect(client.api()).toBe(first);
    expect(client.version()).toBe(2);
    expect(builds).toBe(1);

    // A new connection generation: a new hello, so a new domains object.
    domains = { "node-files": { min: 1, max: 1 } };
    expect(client.api()).toMatchObject({ version: 1, build: 2 });
    domains = null;
    expect(client.api()).toMatchObject({ version: 0, build: 3 });
    expect(client.api()).toMatchObject({ build: 3 });
    // An equal but distinct object is a new generation too.
    domains = { "node-files": { min: 1, max: 1 } };
    expect(client.api()).toMatchObject({ version: 1, build: 4 });
    client.reset();
    expect(client.api()).toMatchObject({ version: 1, build: 5 });
  });

  it("reads the range as an own key only", () => {
    const domains = Object.create({ "node-files": { min: 2, max: 2 } }) as NegotiatedDomains;
    const client = createDomainClient(filesClient, { call: fakeBackend(null).call, domains });
    expect(client.version()).toBe(0);
  });
});

describe("domain client calls", () => {
  it("sends the picked version and present critical fields, without args", async () => {
    const backend = fakeBackend({ min: 1, max: 2 });
    const client = createDomainClient(filesClient, backend);
    expect(await client.api().list("/w", { hidden: true })).toEqual([
      { name: "a.txt", size: 1 },
      { name: ".hidden", size: 2 },
    ]);
    await client.api().list("/w");
    expect(backend.sent).toEqual([
      {
        command: "fake_list_entries",
        args: { dir: "/w", hidden: true },
        envelope: { domain: "node-files", version: 2, critical: ["hidden"] },
      },
      {
        command: "fake_list_entries",
        args: { dir: "/w" },
        envelope: { domain: "node-files", version: 2 },
      },
    ]);
    expect(Object.keys(backend.sent[0]!.envelope!)).not.toContain("args");
  });

  it("decodes results tolerantly and throws the typed error on a mismatch", async () => {
    const call: DomainCall = async () => [{ name: "x", size: "big" }];
    const client = createDomainClient(filesClient, {
      call,
      domains: { "node-files": { min: 2, max: 2 } },
    });
    const thrown = await client
      .api()
      .list("/w")
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(InvalidCommandResultError);
    expect((thrown as InvalidCommandResultError).command).toBe("fake_list_entries");
  });

  it("passes the node's own incompatibility errors through with their code", async () => {
    const call: DomainCall = async (def) => {
      throw unknownCommand(def.name);
    };
    const client = createDomainClient(filesClient, {
      call,
      domains: { "node-files": { min: 1, max: 2 } },
    });
    const thrown = await client
      .api()
      .list("/w")
      .catch((error: unknown) => error);
    expect(incompatibility(thrown)?.code).toBe("unknown-command");
  });

  it("refuses another domain's command and a command newer than the adapter", async () => {
    const mail = defineDomain({ name: "node-mail", version: 1 });
    const foreign = defineCommand({
      domain: mail,
      name: "fake_foreign",
      since: 1,
      access: "internal",
      read: true,
      args: Schema.Struct({}),
      result: Schema.Struct({}),
      critical: [],
    });
    const wrong = domainClient(files, {
      2: (call: CommandCall) => ({ run: () => call(foreign, {}) }),
      1: (call: CommandCall) => ({ run: () => call(listEntries, { dir: "/" }) }),
    });
    const sent: string[] = [];
    const call: DomainCall = async (def) => {
      sent.push(def.name);
      return {};
    };
    const v2 = createDomainClient(wrong, { call, domains: { "node-files": { min: 2, max: 2 } } });
    await expect(v2.api().run()).rejects.toThrow(/belongs to the node-mail domain/);
    const v1 = createDomainClient(wrong, { call, domains: { "node-files": { min: 1, max: 1 } } });
    await expect(v1.api().run()).rejects.toThrow(/arrived in version 2; adapter 1/);
    expect(sent).toEqual([]);
  });
});

describe("the legacy adapter", () => {
  it("sends no envelope, so a pre-contract node gets today's body", async () => {
    const legacyCall = domainClient(files, {
      2: (call) => ({ run: () => call(listNames, { dir: "/" }) }),
      0: (call) => ({ run: () => call(listNames, { dir: "/" }) }),
    });
    const sent: (ContractEnvelopeFields | undefined)[] = [];
    const call: DomainCall = async (_def, _args, envelope) => {
      sent.push(envelope);
      return ["a"];
    };
    const client = createDomainClient(legacyCall, { call, domains: null });
    expect(await client.api().run()).toEqual(["a"]);
    expect(sent).toEqual([undefined]);
  });

  it("gets the hello capabilities and the untyped invoke", async () => {
    const backend = fakeBackend(null);
    const capabilities = ["legacy-listing"];
    const client = createDomainClient(filesClient, {
      ...backend,
      capabilities: () => capabilities,
    });
    expect(await client.api().list("/w")).toEqual([{ name: "legacy.txt", size: null }]);
    expect(backend.sent).toEqual([
      { command: "legacy_list_files", args: { dir: "/w" }, envelope: undefined },
    ]);
    const without = createDomainClient(filesClient, { ...backend, capabilities: [] });
    expect(await without.api().list("/w")).toEqual([]);
  });

  it("refuses an untyped invoke when the transport has none", async () => {
    const client = createDomainClient(filesClient, {
      call: fakeBackend(null).call,
      domains: null,
      capabilities: new Set(["legacy-listing"]),
    });
    await expect(client.api().list("/w")).rejects.toThrow(/no untyped invoke/);
  });

  it("reads the domain's capability command once per generation", async () => {
    const design = defineDomain({ name: "design", version: 1 });
    let context: DomainAdapterContext | null = null;
    const designClient = domainClient(design, {
      1: () => ({}),
      0: (_call, legacy) => {
        context = legacy;
        return {};
      },
    });
    const answers: unknown[] = [
      new Error("socket hang up"),
      { canvas: true },
      new Error("Unknown backend command: design_capabilities"),
    ];
    const asked: string[] = [];
    const invoke = async (command: string) => {
      asked.push(command);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    };
    let domains: NegotiatedDomains | null = null;
    const client = createDomainClient(designClient, {
      call: async () => ({}),
      invoke,
      domains: () => domains,
    });
    client.api();
    const legacy = context!;
    expect(legacy.version).toBe(0);
    expect(legacy.range).toBeNull();
    expect(legacy.capabilities).toBeNull();
    // A transient failure is thrown and not kept.
    await expect(legacy.capability("design_capabilities")).rejects.toThrow(/socket hang up/);
    expect(await legacy.capability("design_capabilities")).toEqual({ canvas: true });
    expect(await legacy.capability("design_capabilities")).toEqual({ canvas: true });
    expect(asked).toEqual(["design_capabilities", "design_capabilities"]);
    await expect(legacy.capability("get_preview_capabilities")).rejects.toThrow(
      /not this domain's capability command/,
    );

    // A new generation reads it again; a node that predates it answers null.
    domains = { other: { min: 1, max: 1 } };
    client.api();
    expect(context).not.toBe(legacy);
    expect(await context!.capability("design_capabilities")).toBeNull();
    expect(asked).toHaveLength(3);
  });

  it("lists the eight capability commands under their domains", () => {
    const listed = Object.entries(LEGACY_CAPABILITY_COMMANDS).flatMap(([domain, commands]) => {
      expect(DOMAIN_NAMES).toContain(domain as never);
      return commands ?? [];
    });
    expect(listed.sort()).toEqual([
      "changes_get_capabilities",
      "design_capabilities",
      "get_agent_handoff_capabilities",
      "get_client_state_capabilities",
      "get_native_agent_sync_capabilities",
      "get_preview_capabilities",
      "transcript_artifact_capabilities",
      "web_annotations_capabilities",
    ]);
  });
});

describe("adapter usage", () => {
  it("counts each call through an adapter below the current version, names and numbers only", async () => {
    const counts: unknown[][] = [];
    const usage = (...args: unknown[]) => {
      counts.push(args);
    };
    for (const range of [{ min: 1, max: 2 }, { min: 1, max: 1 }, null]) {
      const backend = fakeBackend(range);
      const client = createDomainClient(filesClient, {
        ...backend,
        capabilities: ["legacy-listing"],
        usage,
      });
      await client.api().list("/w");
      await client.api().list("/w");
    }
    expect(counts).toEqual([
      ["node-files", 1],
      ["node-files", 1],
      ["node-files", 0],
      ["node-files", 0],
    ]);
  });

  it("never fails a call when the recorder throws", async () => {
    const client = createDomainClient(filesClient, {
      ...fakeBackend({ min: 1, max: 1 }),
      usage: () => {
        throw new Error("full");
      },
    });
    expect(await client.api().list("/w")).toEqual([{ name: "a.txt", size: null }]);
  });
});

describe("Done when: a domain with versions 0, 1 and 2 against each backend range", () => {
  const ranges: [string, NegotiatedDomainRange | null, number, readonly Entry[]][] = [
    ["pre-contract", null, 0, [{ name: "legacy.txt", size: null }]],
    ["accepts 1 only", { min: 1, max: 1 }, 1, [{ name: "a.txt", size: null }]],
    ["accepts 1 to 2", { min: 1, max: 2 }, 2, [{ name: "a.txt", size: 1 }]],
    ["accepts 2 only", { min: 2, max: 2 }, 2, [{ name: "a.txt", size: 1 }]],
  ];
  for (const [name, range, version, expected] of ranges) {
    it(`${name} uses adapter ${version}`, async () => {
      const backend = fakeBackend(range);
      const client = createDomainClient(filesClient, {
        ...backend,
        capabilities: ["legacy-listing"],
      });
      expect(client.version()).toBe(version);
      expect(await client.api().list("/w")).toEqual(expected);
      expect(backend.sent).toHaveLength(1);
      expect(backend.sent[0]!.envelope?.version).toBe(version === 0 ? undefined : version);
    });
  }

  it("a backend whose floor moved past 2 is refused before any call", () => {
    const backend = fakeBackend({ min: 3, max: 3 });
    const client = createDomainClient(filesClient, backend);
    expect(capture(() => client.api())).toBeInstanceOf(UnsupportedVersionError);
    expect(backend.sent).toEqual([]);
  });

  it("the fake backend itself refuses a version outside its range", async () => {
    // Without the client's selection, sending 2 to a node at 1 is refused with the range.
    const backend = fakeBackend({ min: 1, max: 3 });
    const outside = await backend
      .call(listNames, { dir: "/" }, { domain: "node-files", version: 4 })
      .catch((error: unknown) => error);
    expect(incompatibility(outside)).toMatchObject({
      code: "unsupported-version",
      range: { min: 1, max: 3 },
    });
  });
});

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
