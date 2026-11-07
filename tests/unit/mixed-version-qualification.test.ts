/**
 * The mixed-version qualification runner (plan item 1012,
 * `scripts/qualify-contract-mixed-versions.ts`): which release it runs (the
 * floor as `contract:ci` computes it, with the npm substitution), the
 * constructed backend environment and port choice, how a scenario's
 * requirements and outcome become its status, the adapter counters, and that
 * every registered scenario module names a real domain and only commands this
 * checkout registers. The live run itself is the scheduled workflow's job.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isDomainName } from "@orkestrator/protocol/contract/domain";

import { supportFloor } from "../../scripts/contract-ci";
import { CONTRACTS_DIRECTORY, readReleaseIndex } from "../../scripts/contract-snapshots";
import {
  backendEnvironment,
  FORBIDDEN_PORTS,
  freePort,
  SetupError,
  type Build,
} from "../../scripts/mixed-version/harness";
import {
  NotApplicable,
  requirementGaps,
  scenarioStatus,
  type ScenarioModule,
} from "../../scripts/mixed-version/scenario";
import { SCENARIOS } from "../../scripts/mixed-version/scenarios/index";
import {
  adapterCounters,
  counterDelta,
  currentCommands,
  exitCodeFor,
  expectedAdapterFor,
  parseArguments,
  releaseCommands,
  resolveOldVersion,
  selectScenarios,
  topologyBuilds,
} from "../../scripts/qualify-contract-mixed-versions";

const index = readReleaseIndex(CONTRACTS_DIRECTORY);
/** npm's `orkestrator` versions lack v2.21.0 and v2.21.1 (plan item 1007). */
const npm = new Set(
  index.releases.map((entry) => entry.version).filter((v) => v !== "2.21.0" && v !== "2.21.1"),
);
const NOW = new Date("2026-11-07T12:00:00Z");

describe("arguments", () => {
  test("defaults to the floor in both topologies", () => {
    expect(parseArguments([])).toEqual({
      oldVersion: "floor",
      topologies: ["current-command", "old-command"],
      keep: false,
      list: false,
    });
  });

  test("takes a topology, scenarios, a date and a report", () => {
    const options = parseArguments([
      "--old-version",
      "2.36.1",
      "--topology",
      "old-command",
      "--scenarios",
      "node-mail, ticket-sync",
      "--now",
      "2026-12-20T00:00:00Z",
      "--report",
      "out.json",
      "--keep",
    ]);
    expect(options.oldVersion).toBe("2.36.1");
    expect(options.topologies).toEqual(["old-command"]);
    expect(options.scenarios).toEqual(["node-mail", "ticket-sync"]);
    expect(options.now?.toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(options.report).toBe("out.json");
    expect(options.keep).toBe(true);
  });

  test("profiles run this checkout on both sides, current-command only", () => {
    const options = parseArguments(["--profiles", "uf-1012-cmd,uf-1012-leaf"]);
    expect(options.profiles).toEqual(["uf-1012-cmd", "uf-1012-leaf"]);
    expect(options.oldVersion).toBe("current");
    expect(options.topologies).toEqual(["current-command"]);
    expect(() => parseArguments(["--profiles", "a,b", "--old-version", "2.36.1"])).toThrow(
      "no --old-version",
    );
  });

  test("refuses unknown or malformed options", () => {
    for (const argv of [
      ["--old-version", "latest"],
      ["--topology", "sideways"],
      ["--profiles", "only-one"],
      ["--now", "yesterday"],
      ["--report"],
      ["--bogus"],
    ]) {
      expect(() => parseArguments(argv)).toThrow();
    }
  });
});

describe("which release", () => {
  test("the floor is contract:ci's floor, substituted when npm lacks it", () => {
    expect(supportFloor(index, NOW).version).toBe("2.21.0");
    const resolved = resolveOldVersion("floor", index, NOW, npm);
    expect(resolved.floor).toBe("2.21.0");
    expect(resolved.version).toBe("2.22.3");
    expect(resolved.note).toContain("not on npm");
  });

  test("a floor npm carries runs as is", () => {
    // 2.22.3 becomes the floor 60 days after its publication (plan item 1008).
    const later = new Date("2026-12-17T00:00:00Z");
    const resolved = resolveOldVersion("floor", index, later, npm);
    expect(resolved).toEqual({ version: "2.22.3", spec: "floor", floor: "2.22.3" });
  });

  test("latest-stable is the newest published Stable release on npm", () => {
    const newest = [...index.releases]
      .filter((entry) => entry.channel === "stable" && entry.publishedAt !== null)
      .map((entry) => entry.version)
      .at(-1);
    expect(resolveOldVersion("latest-stable", index, NOW, npm).version).toBe(newest!);
  });

  test("an exact version must be on npm; current needs no release", () => {
    expect(resolveOldVersion("2.36.1", index, NOW, npm).version).toBe("2.36.1");
    expect(() => resolveOldVersion("2.21.1", index, NOW, npm)).toThrow(SetupError);
    expect(resolveOldVersion("current", index, NOW, new Set()).version).toBeNull();
  });

  test("a release's commands come from its snapshot, this checkout's from the manifest", () => {
    expect(releaseCommands("2.22.3").has("add_node")).toBe(false);
    expect(releaseCommands("2.36.1").has("apply_ticket_sync")).toBe(true);
    expect(currentCommands().has("deliver_node_mail")).toBe(true);
  });
});

describe("backend environment", () => {
  const base = {
    PATH: "/opt/agents/bin:/usr/bin",
    HOME: "/Users/someone",
    LANG: "en_GB.UTF-8",
    ORKESTRATOR_AGENT_MCP_TOKEN: "host-session",
    ORKESTRATOR_VERSION: "9.9.9",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    GITHUB_PERSONAL_ACCESS_TOKEN: "secret",
    CLAUDE_CODE_SESSION_ID: "session",
  };
  const env = backendEnvironment(base, { home: "/tmp/h", tmp: "/tmp/t", token: "tok" }, [
    "/opt/bun/bin",
  ]);

  test("inherits nothing ORKESTRATOR_ and no credential", () => {
    expect(
      Object.keys(env)
        .filter((key) => key.startsWith("ORKESTRATOR_"))
        .sort(),
    ).toEqual(["ORKESTRATOR_GATEWAY_TOKEN", "ORKESTRATOR_HOST_REACHABILITY_CHECK"]);
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "CLAUDE_CODE_SESSION_ID",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.LANG).toBe("en_GB.UTF-8");
  });

  test("a private HOME, the reachability check off, and a PATH without the host's tools", () => {
    expect(env.HOME).toBe("/tmp/h");
    expect(env.TMPDIR).toBe("/tmp/t");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/h/.config");
    expect(env.ORKESTRATOR_HOST_REACHABILITY_CHECK).toBe("off");
    expect(env.ORKESTRATOR_GATEWAY_TOKEN).toBe("tok");
    expect(env.PATH).toBe("/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  test("a port is never one of the production ports", async () => {
    expect([...FORBIDDEN_PORTS].sort()).toEqual([34121, 34122, 45507]);
    const offered = [34121, 45507, 34122, 40001];
    expect(await freePort(FORBIDDEN_PORTS, async () => offered.shift()!)).toBe(40001);
    await expect(freePort(FORBIDDEN_PORTS, async () => 34121)).rejects.toThrow(SetupError);
  });
});

describe("scenario outcome", () => {
  const module: ScenarioModule = {
    domain: "node-mail",
    title: "t",
    requires: { command: ["send_coordinator_node_mail"], leaf: ["deliver_node_mail"] },
    run: async () => undefined,
  };
  const node = (kind: Build["kind"], has: string[]) => ({
    build: (kind === "current"
      ? { kind }
      : { kind, version: "2.22.3", packageRoot: "/x" }) as Build,
    missing: (required: readonly string[]) => required.filter((name) => !has.includes(name)),
  });

  test("a release lacking a command is a skip; this checkout lacking one is a bug", () => {
    expect(
      requirementGaps(module, node("current", ["send_coordinator_node_mail"]), node("old", [])),
    ).toEqual({ old: ["deliver_node_mail (leaf)"], current: [] });
    expect(
      requirementGaps(module, node("current", []), node("old", ["deliver_node_mail"])),
    ).toEqual({ old: [], current: ["send_coordinator_node_mail (command node)"] });
  });

  test("status: passed, failed, not applicable, and no checks is a failure", () => {
    const ok = { id: "X-01", description: "d", ok: true };
    expect(scenarioStatus([ok], {})).toBe("passed");
    expect(scenarioStatus([ok, { ...ok, ok: false }], {})).toBe("failed");
    expect(scenarioStatus([ok], { error: new Error("boom") })).toBe("failed");
    expect(scenarioStatus([], { error: new NotApplicable("no nodes") })).toBe("not-applicable");
    expect(scenarioStatus([ok], { error: new NotApplicable("no nodes") })).toBe("not-applicable");
    // A refusal check that failed before the skip still fails it.
    expect(scenarioStatus([{ ...ok, ok: false }], { error: new NotApplicable("no nodes") })).toBe(
      "failed",
    );
    expect(scenarioStatus([], {})).toBe("failed");
  });

  test("exit code: setup error 2, a failure or a token in a log 1, else 0", () => {
    const release = { version: "2.22.3", spec: "floor", floor: "2.21.0" };
    const topology = (status: "passed" | "failed" | "not-applicable", leaks: string[] = []) => ({
      topology: "current-command" as const,
      command: { build: "current", version: "x", hello: null },
      leaf: { build: "npm 2.22.3", version: "2.22.3", hello: null },
      results: [{ domain: "d", title: "t", status, checks: [], evidence: [], ms: 0 }],
      tokenLeaks: leaks,
    });
    expect(exitCodeFor({ release, topologies: [topology("not-applicable")] })).toBe(0);
    expect(exitCodeFor({ release, topologies: [topology("failed")] })).toBe(1);
    expect(exitCodeFor({ release, topologies: [topology("passed", ["Leaf"])] })).toBe(1);
    expect(exitCodeFor({ release, topologies: [], setupError: "npm" })).toBe(2);
  });
});

describe("adapters", () => {
  test("counters are the backend domain-adapter paths, and their movement", () => {
    const usage = {
      version: 1,
      paths: {
        "domain-adapter.backend.node-mail.v0": { count: 3 },
        "domain-adapter.renderer.sessions.v0": { count: 9 },
        "workspace-grant.config-echo": { count: 1 },
      },
    };
    const before = adapterCounters(usage);
    expect(before).toEqual({ "domain-adapter.backend.node-mail.v0": 3 });
    expect(
      counterDelta(before, {
        "domain-adapter.backend.node-mail.v0": 5,
        "domain-adapter.backend.ticket-sync.v0": 1,
      }),
    ).toEqual({
      "domain-adapter.backend.node-mail.v0": 2,
      "domain-adapter.backend.ticket-sync.v0": 1,
    });
    expect(adapterCounters(null)).toEqual({});
  });

  test("the expected adapter follows the leaf's advertised domains", () => {
    expect(expectedAdapterFor("node-mail", undefined)).toBe(0);
    expect(expectedAdapterFor("node-mail", { "node-mail": { min: 1, max: 1 } })).toBe(1);
    expect(expectedAdapterFor("node-mail", { "node-mail": { min: 2, max: 3 } })).toBe(0);
  });

  test("topologies put the release on the leaf, then on the command node", () => {
    const old: Build = { kind: "old", version: "2.36.1", packageRoot: "/p" };
    expect(topologyBuilds("current-command", old)).toEqual({
      command: { kind: "current" },
      leaf: old,
    });
    expect(topologyBuilds("old-command", old)).toEqual({ command: old, leaf: { kind: "current" } });
  });
});

describe("registered scenario modules", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(CONTRACTS_DIRECTORY, "manifest.json"), "utf8"),
  ) as { commands: Record<string, unknown> };

  test("cover the pilot domains, one module each, named after a contract domain", () => {
    const domains = SCENARIOS.map((module) => module.domain);
    expect(new Set(domains).size).toBe(domains.length);
    expect(domains).toEqual(expect.arrayContaining(["node-mail", "node-files", "ticket-sync"]));
    for (const domain of domains)
      expect({ domain, known: isDomainName(domain) }).toEqual({ domain, known: true });
  });

  test("require only commands this checkout registers", () => {
    for (const module of SCENARIOS) {
      for (const name of [...(module.requires?.command ?? []), ...(module.requires?.leaf ?? [])]) {
        expect({ module: module.domain, name, known: name in manifest.commands }).toEqual({
          module: module.domain,
          name,
          known: true,
        });
      }
    }
  });

  test("--scenarios selects by domain and refuses an unknown one", () => {
    expect(selectScenarios(SCENARIOS, ["ticket-sync"]).map((module) => module.domain)).toEqual([
      "ticket-sync",
    ]);
    expect(selectScenarios(SCENARIOS, undefined)).toHaveLength(SCENARIOS.length);
    expect(() => selectScenarios(SCENARIOS, ["nope"])).toThrow("No scenario module for nope");
  });
});
