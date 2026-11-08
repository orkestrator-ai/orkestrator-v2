/**
 * The contract CI job (plan item 1008, `scripts/contract-ci.ts`): the support
 * floor from the release index, and a failing fixture for each check (a
 * missing adapter, a removed command, a domain bump without a register row,
 * a register row whose adapter is gone, a register row without a counter id,
 * a new required field, and an argument the current parser refuses).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterList } from "@orkestrator/protocol/contract/client-adapters";
import {
  CONTRACT_CI_STAGE_2,
  checkAdapters,
  checkDomainRegister,
  checkNewRequiredFields,
  checkReleaseIndex,
  checkRemovedCommands,
  fixtureCases,
  parseArguments,
  runContractCi,
  supportFloor,
  windowReleases,
  type CiManifest,
} from "../../scripts/contract-ci";
import {
  checkRegisterCounters,
  parseRegisterDocument,
  rowAdapters,
  rowCounterIds,
} from "../../scripts/contract-ci-register";
import {
  checkSchemaStore,
  documentDigest,
  importableSchemaNode,
  isUnconstrainedRefusal,
  loadFixtureGenerator,
  newRequiredFields,
  readStoredSchema,
  runArgumentFixtures,
  runFixturesInChild,
  schemaStoreFile,
  storedSchemaText,
  unconstrainedPaths,
  writeSchemaStore,
  type JsonSchemaDocument,
} from "../../scripts/contract-ci-schemas";
import { CONTRACT_DOCS } from "../../scripts/contract-check";
import {
  writeReleaseIndex,
  writeReleaseSnapshot,
  withReleaseIndexEntries,
  emptyReleaseIndex,
  type ReleaseContract,
  type ReleaseIndex,
} from "../../scripts/contract-snapshots";

// One test loads the real registry in a sandboxed child process.
setDefaultTimeout(30_000);

const root = path.resolve(import.meta.dir, "../..");
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "contract-ci-test-"));
  temporaryDirs.push(dir);
  return dir;
}

function index(releases: Array<{ version: string; publishedAt: string | null }>): ReleaseIndex {
  return withReleaseIndexEntries(emptyReleaseIndex(), releases);
}

const committedIndex = JSON.parse(
  readFileSync(path.join(root, "packages/protocol/contracts/releases/index.json"), "utf8"),
) as ReleaseIndex;

function release(
  version: string,
  commands: ReleaseContract["commands"],
  domains: ReleaseContract["domains"] = {},
): ReleaseContract {
  return {
    version,
    channel: "stable",
    preContract: Object.keys(domains).length === 0,
    readClassified: true,
    domains,
    commands,
    events: {},
  };
}

function manifest(
  commands: CiManifest["commands"],
  domains: CiManifest["domains"] = {},
): CiManifest {
  return { commands, domains };
}

function adapterList(domains: AdapterList["domains"]): AdapterList {
  return { schemaVersion: 1, generatedBy: "test", retirement: "test", domains };
}

const HEADER = [
  "## Register",
  "",
  "| Path | Where | Counter | Serves | Retire when | Owner |",
  "| --- | --- | --- | --- | --- | --- |",
];

function register(rows: string[], retired: string[] = []) {
  return parseRegisterDocument(
    [
      "# Doc",
      ...HEADER,
      ...rows,
      "",
      "### Retired",
      "",
      "| Path | Retired | Why it could go |",
      "| --- | --- | --- |",
      ...retired,
      "",
      "## Next",
      "| not | a | register | row | at | all |",
    ].join("\n"),
  );
}

const emptyRegister = register([]);

function objectSchema(properties: Record<string, unknown>, required: string[]): JsonSchemaDocument {
  return {
    definitions: {},
    dialect: "draft-2020-12",
    schema: { additionalProperties: true, properties, required, type: "object" },
  } as JsonSchemaDocument;
}

describe("support floor", () => {
  test("is v2.21.0 until a Stable release is 60 days old, then moves by itself", () => {
    expect(supportFloor(committedIndex, new Date("2026-11-07T12:00:00Z")).version).toBe("2.21.0");
    expect(supportFloor(committedIndex, new Date("2026-11-07T12:00:00Z")).release).toBeNull();
    // version-compatibility.md: v2.21.1 on 2026-12-15, v2.22.3 on 2026-12-16, v2.23.0 on 2026-12-18.
    expect(supportFloor(committedIndex, new Date("2026-12-15T16:00:00Z")).version).toBe("2.21.0");
    expect(supportFloor(committedIndex, new Date("2026-12-15T17:00:00Z")).version).toBe("2.21.1");
    expect(supportFloor(committedIndex, new Date("2026-12-16T23:00:00Z")).version).toBe("2.22.3");
    expect(supportFloor(committedIndex, new Date("2026-12-18T19:00:00Z")).version).toBe("2.23.0");
  });

  test("ignores Beta releases and releases with no publication time", () => {
    const releases = index([
      { version: "2.21.0", publishedAt: "2026-10-16T15:32:43Z" },
      { version: "2.22.0-beta", publishedAt: "2026-10-17T00:00:00Z" },
      { version: "2.23.0", publishedAt: null },
    ]);
    const floor = supportFloor(releases, new Date("2027-06-01T00:00:00Z"));
    expect(floor.version).toBe("2.21.0");
    expect(floor.release?.publishedAt).toBe("2026-10-16T15:32:43Z");
  });

  test("the window is every release at or above the floor, unpublished ones included", () => {
    const releases = index([
      { version: "2.21.0", publishedAt: "2026-01-01T00:00:00Z" },
      { version: "2.22.0", publishedAt: "2026-02-01T00:00:00Z" },
      { version: "2.23.0-beta", publishedAt: "2026-05-01T00:00:00Z" },
      { version: "2.23.0", publishedAt: null },
    ]);
    const floor = supportFloor(releases, new Date("2026-05-02T00:00:00Z"));
    expect(floor.version).toBe("2.22.0");
    expect(windowReleases(releases, floor.version).map((entry) => entry.version)).toEqual([
      "2.22.0",
      "2.23.0-beta",
      "2.23.0",
    ]);
  });

  test("the index and the snapshot files must agree", () => {
    const releases = index([{ version: "2.21.0", publishedAt: "2026-10-16T15:32:43Z" }]);
    expect(checkReleaseIndex(releases, ["2.21.0"])).toEqual([]);
    expect(checkReleaseIndex(releases, ["2.21.0", "2.22.0"]).join("\n")).toContain(
      "releases/2.22.0.json is not in releases/index.json",
    );
    expect(checkReleaseIndex(releases, []).join("\n")).toContain("has no releases/2.21.0.json");
  });
});

describe("client adapters", () => {
  const preContract = release("2.21.0", { send_mail: { domain: "node-mail", untyped: true } });
  const contract = release(
    "2.40.0",
    { send_mail: { domain: "node-mail", untyped: true } },
    { "node-mail": { version: 1, min: 1 } },
  );

  test("a domain with no client is called untyped, version 0 for every peer", () => {
    expect(checkAdapters([preContract, contract], adapterList({}))).toEqual([]);
  });

  test("fails when a client lacks the version an in-window release speaks", () => {
    const list = adapterList({ "node-mail": { current: 2, adapters: [2, 1] } });
    const problems = checkAdapters([preContract, contract], list);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2.21.0 speaks node-mail v0");
    expect(problems[0]).toContain("keep adapter 0");
    expect(checkAdapters([contract], list)).toEqual([]);
    const noV1 = adapterList({ "node-mail": { current: 2, adapters: [2, 0] } });
    expect(checkAdapters([preContract, contract], noV1).join("\n")).toContain(
      "2.40.0 speaks node-mail v1",
    );
  });

  test("fails for a versioned domain that no longer exists", () => {
    const gone = release(
      "2.40.0",
      { old_thing: { domain: "retired-domain", untyped: true } },
      { "retired-domain": { version: 1, min: 1 } },
    );
    expect(checkAdapters([gone], adapterList({})).join("\n")).toContain(
      "retired-domain v1, which is no longer in DOMAIN_NAMES",
    );
  });
});

describe("removed commands", () => {
  const old = release("2.21.0", {
    kept: { domain: "nodes", untyped: true },
    dropped: { domain: "nodes", untyped: true },
    unmapped_gone: { domain: null, untyped: true },
  });
  const current = manifest({ kept: { domain: "nodes", untyped: true } });

  test("fails without a register row naming the command", () => {
    const problems = checkRemovedCommands([old], current, emptyRegister);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("dropped (nodes) is in 2.21.0 but no longer registered");
    expect(problems.join("\n")).toContain("naming `unmapped_gone`");
  });

  test("a retired row is enough while the domain is unversioned on both sides", () => {
    const rows = register(
      [],
      ["| `dropped` and `unmapped_gone` | 2026-11-07 | Nothing calls them. |"],
    );
    expect(checkRemovedCommands([old], current, rows)).toEqual([]);
  });

  test("a versioned domain also needs a bump", () => {
    const versioned = release(
      "2.40.0",
      {
        deliver: {
          domain: "node-mail",
          since: 1,
          access: "admin",
          read: false,
          critical: [],
          argsDigest: "sha256:a",
          resultDigest: "sha256:b",
        },
        keep: { domain: "node-mail", untyped: true },
      },
      { "node-mail": { version: 1, min: 1 } },
    );
    const rows = register(
      ["| `deliver` v1 | here | `domain-adapter.renderer.node-mail.v1` | old | later | 1010 |"],
      [],
    );
    const unbumped = manifest(
      { keep: { domain: "node-mail", untyped: true } },
      { "node-mail": { version: 1, min: 1 } },
    );
    expect(checkRemovedCommands([versioned], unbumped, rows).join("\n")).toContain(
      "a domain bump (node-mail is v1, as in the release)",
    );
    const bumped = manifest(
      { keep: { domain: "node-mail", untyped: true } },
      { "node-mail": { version: 2, min: 1 } },
    );
    expect(checkRemovedCommands([versioned], bumped, rows)).toEqual([]);
    expect(checkRemovedCommands([versioned], bumped, emptyRegister).join("\n")).toContain(
      "naming `deliver`",
    );
  });
});

describe("register", () => {
  const known = new Set(["preview.tunnel-v1", "bridge-close.upgrade-required"]);

  test("parses register and retired rows, and the counter ids of a row", () => {
    const rows = register(
      [
        "| A | `a.ts` | `preview.tunnel-v1` (counts `relayedEvents` sockets in `x.ts`) | old | later | me |",
        "| B | `b.ts` | None (renderer side) | old | later | me |",
      ],
      ["| C | 2026-10-24 | Gone. |"],
    );
    expect(rows.register).toHaveLength(2);
    expect(rows.retired).toHaveLength(1);
    expect(rowCounterIds(rows.register[0]!)).toEqual(["preview.tunnel-v1"]);
    expect(rowCounterIds(rows.register[1]!)).toBeNull();
    expect(checkRegisterCounters(rows, known)).toEqual([]);
  });

  test("fails for a row with a counter but no counter id, or an unknown id", () => {
    const rows = register([
      "| A | `a.ts` | Counted in the backend | old | later | me |",
      "| B | `b.ts` | `preview.tunnel-v2` | old | later | me |",
      "| C | `c.ts` | `domain-adapter.backend.node-mail.v1` | old | later | me |",
      "| D | `d.ts` | None |",
    ]);
    const problems = checkRegisterCounters(rows, known);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain("has 3 cells; a register row has 6");
    expect(problems.join("\n")).toContain("has a counter but names no counter id");
    expect(problems.join("\n")).toContain(
      "`preview.tunnel-v2`, which is not in COMPATIBILITY_PATH_IDS",
    );
  });

  test("every row of the committed register names known counter ids", async () => {
    const { COMPATIBILITY_PATH_IDS } =
      await import("../../apps/backend/src/core/compatibility-path-usage");
    const document = parseRegisterDocument(
      readFileSync(path.join(root, "docs/architecture/version-compatibility.md"), "utf8"),
    );
    expect(document.register.length).toBeGreaterThan(50);
    expect(checkRegisterCounters(document, new Set(COMPATIBILITY_PATH_IDS))).toEqual([]);
  });

  const v1 = release(
    "2.40.0",
    { send: { domain: "node-mail", untyped: true } },
    {
      "node-mail": { version: 1, min: 1 },
    },
  );
  const list = adapterList({ "node-mail": { current: 2, adapters: [2, 1, 0] } });
  const bumped = manifest(
    { send: { domain: "node-mail", untyped: true } },
    {
      "node-mail": { version: 2, min: 1 },
    },
  );

  test("a domain bump past an in-window release needs a register row", () => {
    expect(checkDomainRegister([v1], bumped, emptyRegister, list).join("\n")).toContain(
      "node-mail went from v1 (2.40.0) to v2 without a register row",
    );
    const rows = register([
      "| node-mail v1 clients | `client.ts` | `domain-adapter.renderer.node-mail.v1` | 2.40.0 | floor | 1010 |",
    ]);
    expect(rowAdapters(rows.register[0]!)).toEqual([
      { domain: "node-mail", version: 1, id: "domain-adapter.renderer.node-mail.v1" },
    ]);
    expect(checkDomainRegister([v1], bumped, rows, list)).toEqual([]);
  });

  test("a register row whose adapter is gone fails", () => {
    const rows = register([
      "| node-mail v1 clients | `client.ts` | `domain-adapter.renderer.node-mail.v1` | 2.40.0 | floor | 1010 |",
    ]);
    const gone = adapterList({ "node-mail": { current: 2, adapters: [2] } });
    expect(checkDomainRegister([], bumped, rows, gone).join("\n")).toContain(
      "has no node-mail adapter 1: move the row to Retired",
    );
  });

  test("a domain version never goes down", () => {
    const lower = manifest({}, { "node-mail": { version: 1, min: 1 } });
    const v2 = release(
      "2.41.0",
      { send: { domain: "node-mail", untyped: true } },
      {
        "node-mail": { version: 2, min: 1 },
      },
    );
    expect(checkDomainRegister([v2], lower, emptyRegister, list).join("\n")).toContain(
      "node-mail is at v1, below v2 in 2.41.0",
    );
  });
});

describe("argument schemas", () => {
  const before = objectSchema({ to: { type: "string" }, body: { type: "string" } }, ["to"]);
  const optional = objectSchema(
    { to: { type: "string" }, body: { type: "string" }, priority: { type: "integer" } },
    ["to"],
  );
  const required = objectSchema(
    {
      to: { type: "string" },
      body: { type: "string" },
      thread: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    ["body", "thread", "to"],
  );

  test("newRequiredFields lists fields required now and not before", () => {
    expect(newRequiredFields(before, optional)).toEqual([]);
    expect(newRequiredFields(before, required)).toEqual(["body", "thread"]);
    const nested = objectSchema(
      { to: { type: "object", properties: { id: { type: "string" } }, required: [] } },
      [],
    );
    const nestedRequired = {
      ...objectSchema({ to: { $ref: "#/$defs/Target" } }, []),
      definitions: {
        Target: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    } as JsonSchemaDocument;
    expect(newRequiredFields(nested, nestedRequired)).toEqual(["to.id"]);
  });

  test("the store writes, verifies and prunes by digest", async () => {
    const dir = await temporaryDir();
    const digest = documentDigest(before);
    expect(checkSchemaStore(dir, new Map([[digest, ["send (2.40.0)"]]])).join("\n")).toContain(
      "No stored argument schema",
    );
    writeSchemaStore(dir, [before], []);
    expect(readStoredSchema(dir, digest)).toEqual(before);
    expect(checkSchemaStore(dir, new Map([[digest, ["send (2.40.0)"]]]))).toEqual([]);
    await writeFile(path.join(dir, schemaStoreFile(digest)), storedSchemaText(required));
    expect(() => readStoredSchema(dir, digest)).toThrow("does not hold the schema");
    writeSchemaStore(dir, [optional], [digest]);
    expect(existsSync(path.join(dir, schemaStoreFile(digest)))).toBe(true);
    const pruned = writeSchemaStore(dir, [], []);
    expect(pruned.removed).toHaveLength(2);
  });

  function definedRelease(version: string, argsDigest: string, domainVersion: number) {
    return release(
      version,
      {
        send: {
          domain: "node-mail",
          since: 1,
          access: "admin",
          read: false,
          critical: [],
          argsDigest,
          resultDigest: "sha256:r",
        },
      },
      { "node-mail": { version: domainVersion, min: 1 } },
    );
  }

  test("a new required field without a domain bump fails (stage 2)", async () => {
    const dir = await temporaryDir();
    writeSchemaStore(dir, [before, optional, required], []);
    const old = definedRelease("2.40.0", documentDigest(before), 1);
    const now = (document: JsonSchemaDocument, version: number) =>
      manifest(
        { send: { domain: "node-mail", argsDigest: documentDigest(document) } },
        { "node-mail": { version, min: 1 } },
      );
    expect(checkNewRequiredFields([old], now(optional, 1), dir)).toEqual([]);
    const problems = checkNewRequiredFields([old], now(required, 1), dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("send now requires `body`, `thread`, which 2.40.0 did not send");
    expect(checkNewRequiredFields([old], now(required, 2), dir)).toEqual([]);
    expect(fixtureCases([old], now(required, 1), dir).map((entry) => entry.command)).toEqual([
      "send",
    ]);
    expect(fixtureCases([old], now(required, 2), dir)).toEqual([]);
  });

  test("fixtures from an older schema that the current parser refuses fail (stage 2)", async () => {
    const generator = await loadFixtureGenerator();
    const cases = [
      { command: "send", digest: documentDigest(before), releases: ["2.40.0"], document: before },
    ];
    const tolerant = runArgumentFixtures(cases, () => null, generator, 10);
    expect(tolerant).toEqual({ checked: 10, unconstrained: 0, failures: [] });
    const requiresBody = runArgumentFixtures(
      cases,
      (_command, args) =>
        typeof (args as { body?: unknown }).body === "string"
          ? null
          : "Expected body to be a string",
      generator,
      25,
    );
    expect(requiresBody.failures).toHaveLength(1);
    expect(requiresBody.failures[0]!.message).toBe("Expected body to be a string");
    // Seeded: the same fixtures every run.
    expect(generator.sample(before, 5, "seed")).toEqual(generator.sample(before, 5, "seed"));
  });

  test("Schema.Struct({}) arguments, exported as any value but null, generate fixtures", async () => {
    const generator = await loadFixtureGenerator();
    const noArgs: JsonSchemaDocument = {
      dialect: "draft-2020-12",
      schema: { not: { type: "null" } },
      definitions: {},
    };
    const samples = generator.sample(noArgs, 25, "no-args");
    expect(samples).toHaveLength(25);
    expect(samples.some((sample) => sample === null)).toBe(false);
    expect(importableSchemaNode({ not: { type: "string" } })).toEqual({ not: { type: "string" } });
    // Any other `not` still fails rather than being silently widened.
    expect(() =>
      generator.sample({ ...noArgs, schema: { not: { type: "string" } } }, 1, "other"),
    ).toThrow('"not"');
  });

  test("a refusal only inside an unconstrained value is counted, not failed (stage 2)", async () => {
    const generator = await loadFixtureGenerator();
    const opaque = objectSchema({ to: { type: "string" }, capture: {} }, ["to", "capture"]);
    expect(unconstrainedPaths(opaque)).toEqual([["capture"]]);
    const cases = [
      { command: "send", digest: documentDigest(opaque), releases: ["2.40.0"], document: opaque },
    ];
    const inCapture = runArgumentFixtures(
      cases,
      () => ({ message: "Capture must be an object", paths: [["capture"], ["capture", "kind"]] }),
      generator,
      5,
    );
    expect(inCapture).toEqual({ checked: 5, unconstrained: 5, failures: [] });
    const elsewhere = runArgumentFixtures(
      cases,
      () => ({ message: "Expected to", paths: [["capture"], ["to"]] }),
      generator,
      5,
    );
    expect(elsewhere.unconstrained).toBe(0);
    expect(elsewhere.failures.map((failure) => failure.message)).toEqual(["Expected to"]);
    // A refusal with no path (an unsupported critical field) is always evidence.
    expect(isUnconstrainedRefusal({ message: "critical", paths: [] }, [["capture"]])).toBe(false);
  });

  test("fixtures run through the real registry's parser in a sandboxed child", async () => {
    const manifestJson = JSON.parse(
      readFileSync(path.join(root, "packages/protocol/contracts/manifest.json"), "utf8"),
    ) as CiManifest;
    const digest = manifestJson.commands.record_domain_adapter_usage!.argsDigest!;
    const current = readStoredSchema(path.join(root, "packages/protocol/contracts"), digest)!;
    const stringEntries = objectSchema({ entries: { type: "string" } }, ["entries"]);
    const report = await runFixturesInChild(
      [
        { command: "record_domain_adapter_usage", digest, releases: ["now"], document: current },
        {
          command: "record_domain_adapter_usage",
          digest: documentDigest(stringEntries),
          releases: ["2.40.0"],
          document: stringEntries,
        },
      ],
      10,
    );
    expect(report.failures.map((failure) => failure.releases)).toEqual([["2.40.0"]]);
    expect(report.failures[0]!.message).toContain("record_domain_adapter_usage");
  });
});

describe("runContractCi", () => {
  test("stage 2 is on by default (plan item 7001)", () => {
    expect(CONTRACT_CI_STAGE_2).toBe(true);
    expect(parseArguments([])).toEqual({});
    expect(parseArguments(["--stage2", "--now", "2026-12-16T00:00:00Z"])).toEqual({
      stage2: true,
      now: new Date("2026-12-16T00:00:00Z"),
    });
    expect(() => parseArguments(["--now", "soon"])).toThrow("bad date");
    expect(() => parseArguments(["--other"])).toThrow("usage");
  });

  test("passes on the committed tree", async () => {
    const lines: string[] = [];
    const status = await runContractCi({
      now: new Date("2026-11-07T12:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("Contract CI passed");
    expect(status).toBe(0);
  });

  async function fixtureRoot(adapters: AdapterList["domains"]): Promise<string> {
    const dir = await temporaryDir();
    const contracts = path.join(dir, "packages/protocol/contracts");
    await mkdir(path.join(contracts, "releases"), { recursive: true });
    writeReleaseSnapshot(contracts, {
      version: "2.21.0",
      preContract: true,
      source: "registry",
      commands: [
        ["send_mail", { domain: "node-mail", entry: { untyped: true, read: false } }],
        ["gone_command", { domain: "node-mail", entry: { untyped: true, read: false } }],
      ],
    });
    writeReleaseIndex(
      contracts,
      index([{ version: "2.21.0", publishedAt: "2026-10-16T15:32:43Z" }]),
    );
    await writeFile(
      path.join(contracts, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        domains: {},
        commands: { send_mail: { domain: "node-mail", untyped: true, read: false } },
      }),
    );
    await writeFile(
      path.join(contracts, "adapters.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedBy: "test",
        retirement: "test",
        domains: adapters,
      }),
    );
    await mkdir(path.join(dir, "docs/architecture"), { recursive: true });
    await writeFile(
      path.join(dir, "docs/architecture/version-compatibility.md"),
      [...HEADER, "| A | `a.ts` | Counted somewhere | old | later | me |", ""].join("\n"),
    );
    return dir;
  }

  test("lists every failing check and names the docs", async () => {
    const dir = await fixtureRoot({ "node-mail": { current: 1, adapters: [1] } });
    const lines: string[] = [];
    const status = await runContractCi({
      root: dir,
      now: new Date("2026-11-07T12:00:00Z"),
      counterIds: [],
      log: (line) => lines.push(line),
    });
    const output = lines.join("\n");
    expect(status).toBe(1);
    expect(output).toContain("Client adapters:\n  - 2.21.0 speaks node-mail v0");
    expect(output).toContain("gone_command (node-mail) is in 2.21.0 but no longer registered");
    expect(output).toContain("has a counter but names no counter id");
    expect(output.trimEnd().endsWith(`Contract rules: ${CONTRACT_DOCS}`)).toBe(true);
  });

  test("stage 2 runs the fixtures when switched on", async () => {
    const dir = await fixtureRoot({});
    const lines: string[] = [];
    let ran = false;
    await runContractCi({
      root: dir,
      now: new Date("2026-11-07T12:00:00Z"),
      stage2: true,
      counterIds: [],
      runFixtures: async (cases) => {
        ran = true;
        return { checked: cases.length, unconstrained: 0, failures: [] };
      },
      log: (line) => lines.push(line),
    });
    expect(ran).toBe(true);
    expect(lines.join("\n")).toContain("Argument fixtures: 0 decoded from 0 older schemas.");
  });
});
