/**
 * The retirement schedule of the contract CI job (plan item 7013,
 * `scripts/contract-ci-retirements.ts`): with synthetic release indexes, an
 * adapter or capability command is reported unreachable exactly when the
 * support floor passes the first Stable release that advertises the next
 * domain version, and not a millisecond before.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAdapterList, type AdapterList } from "@orkestrator/protocol/contract/client-adapters";
import {
  checkRemovedCommands,
  parseArguments,
  runContractCi,
  supportFloor,
} from "../../scripts/contract-ci";
import { parseRegisterDocument } from "../../scripts/contract-ci-register";
import {
  checkRetirementList,
  checkRetirements,
  firstStableAdvertising,
  floorReachesOn,
  formatRetirementSchedule,
  parseRetirementList,
  retiredCommands,
  retirementSchedule,
  RETIREMENT_LIST_PATH,
  type RetirementList,
  type StableRelease,
} from "../../scripts/contract-ci-retirements";
import {
  emptyReleaseIndex,
  withReleaseIndexEntries,
  writeReleaseIndex,
  writeReleaseSnapshot,
} from "../../scripts/contract-snapshots";

const root = path.resolve(import.meta.dir, "../..");
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

const HEADER = [
  "## Register",
  "",
  "| Path | Where | Counter | Serves | Retire when | Owner |",
  "| --- | --- | --- | --- | --- | --- |",
];

function register(rows: string[]) {
  return parseRegisterDocument(
    [
      ...HEADER,
      ...rows,
      "",
      "### Retired",
      "",
      "| Path | Retired | Why |",
      "| --- | --- | --- |",
      "",
    ].join("\n"),
  );
}

const REGISTER = register([
  "| Pre-contract leaves | v0 adapter | `domain-adapter.backend.node-mail.v0` | Leaves before node-mail | Floor | me |",
  "| Renderers before `config` | `get_client_state_capabilities` kept | None (renderer) | Renderers before config | Floor | me |",
]);

function adapterList(domains: AdapterList["domains"]): AdapterList {
  return { schemaVersion: 1, generatedBy: "test", retirement: "test", domains };
}

const LIST: RetirementList = {
  schemaVersion: 1,
  capabilityCommands: {
    get_client_state_capabilities: {
      domain: "config",
      retireAtDomainVersion: 1,
      why: "kept for pre-contract renderers",
    },
    design_capabilities: { domain: "design", retireAtDomainVersion: null, why: "runtime state" },
  },
};

/** Pre-contract Stable releases, then the first Stable with domains on 2027-01-10. */
const STABLE: StableRelease[] = [
  { version: "2.21.0", publishedAt: "2026-10-16T15:32:43Z", domains: {} },
  { version: "2.36.1", publishedAt: "2026-11-03T10:00:00Z", domains: {} },
  {
    version: "2.40.0",
    publishedAt: "2027-01-10T12:00:00Z",
    domains: { "node-mail": { version: 1 }, config: { version: 1 } },
  },
  {
    version: "2.41.0",
    publishedAt: "2027-02-01T12:00:00Z",
    domains: { "node-mail": { version: 2 }, config: { version: 1 } },
  },
];

const FIRES_AT = new Date("2027-03-11T12:00:00Z"); // 2027-01-10T12:00Z + 60 days

function index(releases: readonly StableRelease[]) {
  return withReleaseIndexEntries(
    emptyReleaseIndex(),
    releases.map(({ version, publishedAt }) => ({ version, publishedAt })),
  );
}

function scheduleOn(
  now: Date,
  adapters: AdapterList["domains"],
  stable: readonly StableRelease[] = STABLE,
) {
  return retirementSchedule({
    adapters: adapterList(adapters),
    list: LIST,
    stable,
    floor: supportFloor(index(stable), now).version,
    now,
    register: REGISTER,
  });
}

describe("dates", () => {
  test("the first Stable release with the domain at a version, and when the floor reaches it", () => {
    expect(firstStableAdvertising(STABLE, "node-mail", 1)?.version).toBe("2.40.0");
    expect(firstStableAdvertising(STABLE, "node-mail", 2)?.version).toBe("2.41.0");
    expect(firstStableAdvertising(STABLE, "node-mail", 3)).toBeNull();
    expect(firstStableAdvertising(STABLE, "docker", 1)).toBeNull();
    expect(floorReachesOn(STABLE, "2.40.0")).toEqual(FIRES_AT);
    expect(floorReachesOn(STABLE, "2.41.0")).toEqual(new Date("2027-04-02T12:00:00Z"));
    expect(floorReachesOn(STABLE, "2.42.0")).toBeNull();
  });

  test("an unpublished first release has no date until it or a later Stable release ships", () => {
    const unpublished: StableRelease[] = [
      { version: "2.40.0", publishedAt: null, domains: { "node-mail": { version: 1 } } },
    ];
    expect(floorReachesOn(unpublished, "2.40.0")).toBeNull();
    const later = [
      ...unpublished,
      { version: "2.40.1", publishedAt: "2027-01-12T00:00:00Z", domains: {} },
    ];
    expect(floorReachesOn(later, "2.40.0")).toEqual(new Date("2027-03-13T00:00:00Z"));
  });
});

describe("retirement schedule", () => {
  const nodeMail: AdapterList["domains"] = { "node-mail": { current: 1, adapters: [1, 0] } };

  test("today (no Stable release with domains): every v0 adapter waits, nothing fails", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const schedule = scheduleOn(now, nodeMail, STABLE.slice(0, 2));
    expect(schedule.floor).toBe("2.21.0");
    const adapter = schedule.entries.find((entry) => entry.kind === "adapter")!;
    expect(adapter).toMatchObject({
      domain: "node-mail",
      adapter: 0,
      domainVersion: 1,
      status: "waiting",
      firstRelease: null,
      earliest: null,
      counters: ["domain-adapter.backend.node-mail.v0", "domain-adapter.renderer.node-mail.v0"],
      registerRows: [REGISTER.register[0]!.line],
    });
    expect(checkRetirements(schedule)).toEqual([]);
    expect(formatRetirementSchedule(schedule).join("\n")).toContain(
      "adapter node-mail v0: 60 days after the first Stable release that advertises node-mail; not yet shipped as of 2026-11-07",
    );
  });

  test("once it ships, the earliest date is known and nothing fails before it", () => {
    const before = new Date(FIRES_AT.getTime() - 1);
    const schedule = scheduleOn(before, nodeMail);
    expect(schedule.floor).toBe("2.36.1");
    const adapter = schedule.entries.find((entry) => entry.kind === "adapter")!;
    expect(adapter.status).toBe("scheduled");
    expect(adapter.firstRelease).toEqual({
      version: "2.40.0",
      publishedAt: "2027-01-10T12:00:00Z",
    });
    expect(adapter.earliest).toBe(FIRES_AT.toISOString());
    expect(checkRetirements(schedule)).toEqual([]);
    expect(formatRetirementSchedule(schedule).join("\n")).toContain(
      "adapter node-mail v0: earliest 2027-03-11 (v2.40.0, published 2027-01-10T12:00:00Z)",
    );
  });

  test("fires exactly when the floor passes the first Stable release with the domain", () => {
    const schedule = scheduleOn(FIRES_AT, nodeMail);
    expect(schedule.floor).toBe("2.40.0");
    const problems = checkRetirements(schedule);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toStartWith(
      "adapter node-mail v0 is unreachable: delete it and move its register rows to Retired (the floor v2.40.0 has passed v2.40.0, the first Stable release that advertises node-mail;",
    );
    expect(problems[0]).toContain("`domain-adapter.renderer.node-mail.v0`");
    expect(problems[1]).toStartWith(
      'capability command get_client_state_capabilities is unreachable: delete it, mark it `"retired": "<date>"` in packages/protocol/contracts/retirements.json and move its register rows to Retired',
    );
  });

  test("adapter v waits for the first Stable release with v + 1, not v", () => {
    const twoVersions: AdapterList["domains"] = {
      "node-mail": { current: 3, adapters: [3, 2, 1] },
    };
    // On 2027-03-11 the floor is 2.40.0 (node-mail v1): adapter 1 is still reachable.
    const atV1 = scheduleOn(FIRES_AT, twoVersions);
    const byAdapter = (schedule: typeof atV1, version: number) =>
      schedule.entries.find((entry) => entry.kind === "adapter" && entry.adapter === version)!;
    expect(byAdapter(atV1, 1).status).toBe("scheduled");
    expect(byAdapter(atV1, 1).earliest).toBe("2027-04-02T12:00:00.000Z");
    expect(byAdapter(atV1, 2).status).toBe("waiting");
    expect(atV1.entries.some((entry) => entry.adapter === 3)).toBe(false);
    // On 2027-04-02 the floor is 2.41.0 (node-mail v2): adapter 1 is due, adapter 2 is not.
    const atV2 = scheduleOn(new Date("2027-04-02T12:00:00Z"), twoVersions);
    expect(byAdapter(atV2, 1).status).toBe("due");
    expect(byAdapter(atV2, 2).status).toBe("waiting");
    expect(checkRetirements(atV2).filter((line) => line.startsWith("adapter "))).toEqual([
      expect.stringContaining(
        "adapter node-mail v1 is unreachable: delete it and move its register rows to Retired (the floor v2.41.0 has passed v2.41.0, the first Stable release that advertises node-mail v2; no register row names it)",
      ),
    ]);
  });

  test("Beta releases never date a retirement", () => {
    const beta: StableRelease[] = [
      { version: "2.21.0", publishedAt: "2026-10-16T15:32:43Z", domains: {} },
    ];
    const index = withReleaseIndexEntries(emptyReleaseIndex(), [
      { version: "2.21.0", publishedAt: "2026-10-16T15:32:43Z" },
      { version: "2.40.0-beta", publishedAt: "2026-11-10T00:00:00Z" },
    ]);
    // Only Stable releases are passed to the schedule; a Beta never becomes the floor.
    const now = new Date("2027-06-01T00:00:00Z");
    expect(supportFloor(index, now).version).toBe("2.21.0");
    const schedule = retirementSchedule({
      adapters: adapterList(nodeMail),
      list: LIST,
      stable: beta,
      floor: supportFloor(index, now).version,
      now,
      register: REGISTER,
    });
    expect(checkRetirements(schedule)).toEqual([]);
  });

  test("a kept capability command is never due", () => {
    const schedule = scheduleOn(new Date("2030-01-01T00:00:00Z"), nodeMail);
    const kept = schedule.entries.find((entry) => entry.command === "design_capabilities")!;
    expect(kept.status).toBe("kept");
    expect(checkRetirements(schedule).some((line) => line.includes("design_capabilities"))).toBe(
      false,
    );
  });
});

describe("a capability command deleted on schedule", () => {
  const retiredList: RetirementList = {
    schemaVersion: 1,
    capabilityCommands: {
      get_client_state_capabilities: {
        domain: "config",
        retireAtDomainVersion: 1,
        why: "kept for pre-contract renderers",
        retired: "2027-03-12",
      },
    },
  };
  const retiredRegister = parseRegisterDocument(
    [
      ...HEADER,
      "",
      "### Retired",
      "",
      "| Path | Retired | Why |",
      "| --- | --- | --- |",
      "| Renderers before `config`: `get_client_state_capabilities` | 2027-03-12 | Floor |",
      "",
    ].join("\n"),
  );
  function scheduleWith(now: Date) {
    return retirementSchedule({
      adapters: adapterList({}),
      list: retiredList,
      stable: STABLE,
      floor: supportFloor(index(STABLE), now).version,
      now,
      register: retiredRegister,
    });
  }

  test("is listed as retired once the floor has passed, and needs no domain bump to leave", () => {
    const schedule = scheduleWith(FIRES_AT);
    expect(schedule.entries[0]).toMatchObject({ status: "retired", retired: "2027-03-12" });
    expect(checkRetirements(schedule)).toEqual([]);
    expect(checkRetirementList(retiredList, {}, retiredRegister, {})).toEqual([]);
    const inWindow = {
      version: "2.40.0",
      channel: "stable" as const,
      preContract: false,
      readClassified: true,
      domains: { config: { version: 1, min: 1 } },
      commands: { get_client_state_capabilities: { domain: "config", untyped: true as const } },
      events: {},
    };
    const manifest = { domains: { config: { version: 1, min: 1 } }, commands: {} };
    expect(
      checkRemovedCommands([inWindow], manifest, retiredRegister, retiredCommands(schedule)),
    ).toEqual([]);
    expect(checkRemovedCommands([inWindow], manifest, retiredRegister)).toEqual([
      expect.stringContaining("removing it needs a domain bump (config is v1, as in the release)"),
    ]);
  });

  test("fails when deleted before the floor passed, or still registered", () => {
    const early = scheduleWith(new Date(FIRES_AT.getTime() - 1));
    expect(early.entries[0]!.status).toBe("scheduled");
    expect(retiredCommands(early).size).toBe(0);
    expect(checkRetirements(early)).toEqual([
      expect.stringContaining(
        "capability command get_client_state_capabilities is marked retired on 2027-03-12",
      ),
    ]);
    expect(
      checkRetirementList(
        retiredList,
        { get_client_state_capabilities: { domain: "config" } },
        retiredRegister,
        {},
      ),
    ).toEqual([expect.stringContaining("but it is still registered")]);
  });
});

describe("retirement list", () => {
  const commands = {
    get_client_state_capabilities: { domain: "config" },
    design_capabilities: { domain: "design" },
  };

  test("parses the committed list, and refuses a malformed one", () => {
    expect(typeof parseRetirementList(readJson(RETIREMENT_LIST_PATH))).toBe("object");
    expect(parseRetirementList({ schemaVersion: 2, capabilityCommands: {} })).toContain(
      "schemaVersion 2",
    );
    expect(
      parseRetirementList({
        schemaVersion: 1,
        capabilityCommands: { x: { domain: "config", retireAtDomainVersion: 0, why: "w" } },
      }),
    ).toContain("x needs");
    expect(
      parseRetirementList({
        schemaVersion: 1,
        capabilityCommands: {
          x: { domain: "config", retireAtDomainVersion: null, why: "w", retired: "2027-01-01" },
        },
      }),
    ).toContain("x needs");
  });

  test("agrees with the code", () => {
    expect(checkRetirementList(LIST, commands, REGISTER, {})).toEqual([]);
    const problems = checkRetirementList(
      LIST,
      { design_capabilities: { domain: "previews" } },
      register([]),
      { config: ["get_client_state_capabilities"], git: ["changes_get_capabilities"] },
    );
    expect(problems).toEqual([
      expect.stringContaining(
        "changes_get_capabilities is a legacy capability command of git (LEGACY_CAPABILITY_COMMANDS) but not in",
      ),
      expect.stringContaining("lists get_client_state_capabilities, which is no longer registered"),
      expect.stringContaining(
        "no register row in docs/architecture/version-compatibility.md names `get_client_state_capabilities`",
      ),
      expect.stringContaining(
        "lists design_capabilities under design; the manifest has it in previews",
      ),
    ]);
  });

  test("the committed list classifies every legacy capability command, and nothing is due today", () => {
    const list = parseRetirementList(readJson(RETIREMENT_LIST_PATH)) as RetirementList;
    const manifest = readJson("packages/protocol/contracts/manifest.json") as {
      commands: Record<string, { domain: string }>;
    };
    const document = parseRegisterDocument(
      readFileSync(path.join(root, "docs/architecture/version-compatibility.md"), "utf8"),
    );
    expect(checkRetirementList(list, manifest.commands, document)).toEqual([]);
    const adapters = parseAdapterList(readJson("packages/protocol/contracts/adapters.json"))!;
    const now = new Date("2026-11-07T12:00:00Z");
    const schedule = retirementSchedule({
      adapters,
      list,
      stable: [],
      floor: "2.21.0",
      now,
      register: document,
    });
    expect(checkRetirements(schedule)).toEqual([]);
    const adapterEntries = schedule.entries.filter((entry) => entry.kind === "adapter");
    expect(adapterEntries.length).toBe(
      Object.values(adapters.domains).reduce(
        (sum, client) => sum + client!.adapters.filter((v) => v < client!.current).length,
        0,
      ),
    );
    expect(adapterEntries.every((entry) => entry.status === "waiting")).toBe(true);
  });
});

describe("runContractCi", () => {
  test("parses --retirements and --json", () => {
    expect(parseArguments(["--retirements"])).toEqual({ retirements: "text" });
    expect(parseArguments(["--retirements", "--json", "--now", "2027-01-01"])).toEqual({
      retirements: "json",
      now: new Date("2027-01-01"),
    });
    expect(() => parseArguments(["--json"])).toThrow("--json needs --retirements");
  });

  async function retirementRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "contract-ci-retirements-"));
    temporaryDirs.push(dir);
    const contracts = path.join(dir, "packages/protocol/contracts");
    await mkdir(path.join(contracts, "releases"), { recursive: true });
    const mail = { domain: "node-mail", entry: { untyped: true as const, read: false } };
    writeReleaseSnapshot(contracts, {
      version: "2.21.0",
      preContract: true,
      source: "registry",
      commands: [["send_mail", mail]],
    });
    writeReleaseSnapshot(contracts, {
      version: "2.40.0",
      preContract: false,
      source: "registry",
      commands: [["send_mail", mail]],
      domains: { "node-mail": { version: 1, min: 1 } },
    });
    writeReleaseIndex(contracts, index([STABLE[0]!, STABLE[2]!]));
    await writeFile(
      path.join(contracts, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        domains: { "node-mail": { version: 1, min: 1 } },
        commands: { send_mail: { domain: "node-mail", untyped: true, read: false } },
      }),
    );
    await writeFile(
      path.join(contracts, "adapters.json"),
      JSON.stringify(adapterList({ "node-mail": { current: 1, adapters: [1, 0] } })),
    );
    await writeFile(
      path.join(contracts, "retirements.json"),
      JSON.stringify({ schemaVersion: 1, capabilityCommands: {} }),
    );
    await mkdir(path.join(dir, "docs/architecture"), { recursive: true });
    await writeFile(
      path.join(dir, "docs/architecture/version-compatibility.md"),
      [
        ...HEADER,
        "| Pre-contract leaves | v0 adapter | `domain-adapter.backend.node-mail.v0` | Leaves before node-mail | Floor | me |",
        "",
      ].join("\n"),
    );
    return dir;
  }

  async function run(dir: string, now: Date, retirements?: "text" | "json") {
    const lines: string[] = [];
    const status = await runContractCi({
      root: dir,
      now,
      stage2: false,
      counterIds: [],
      legacyCapabilityCommands: {},
      ...(retirements === undefined ? {} : { retirements }),
      log: (line) => lines.push(line),
    });
    return { status, output: lines.join("\n") };
  }

  test("passes before the floor reaches the first Stable release with the domain, fails from then", async () => {
    const dir = await retirementRoot();
    const before = await run(dir, new Date(FIRES_AT.getTime() - 1));
    expect(before.output).toContain("Contract CI passed");
    expect(before.status).toBe(0);
    const after = await run(dir, FIRES_AT);
    expect(after.status).toBe(1);
    expect(after.output).toContain(
      "Retirements:\n  - adapter node-mail v0 is unreachable: delete it and move its register rows to Retired (the floor v2.40.0 has passed v2.40.0",
    );
    expect(after.output).toContain("docs/architecture/version-compatibility.md:5");
  });

  test("--retirements prints the schedule and does not check", async () => {
    const dir = await retirementRoot();
    const text = await run(dir, FIRES_AT, "text");
    expect(text.status).toBe(0);
    expect(text.output).toContain("Due (the job fails until deleted): 1");
    const json = await run(dir, new Date("2027-02-01T00:00:00Z"), "json");
    expect(json.status).toBe(0);
    const schedule = JSON.parse(json.output) as ReturnType<typeof retirementSchedule>;
    expect(schedule.floor).toBe("2.21.0");
    expect(schedule.entries).toEqual([
      expect.objectContaining({
        kind: "adapter",
        domain: "node-mail",
        adapter: 0,
        status: "scheduled",
        earliest: FIRES_AT.toISOString(),
      }),
    ]);
  });

  test("a missing list fails the retirements check", async () => {
    const dir = await retirementRoot();
    await rm(path.join(dir, RETIREMENT_LIST_PATH));
    const result = await run(dir, new Date("2027-01-01T00:00:00Z"));
    expect(result.status).toBe(1);
    expect(result.output).toContain(`Retirements:\n  - ${RETIREMENT_LIST_PATH} is missing.`);
  });
});
