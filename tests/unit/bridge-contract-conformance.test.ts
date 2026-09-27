/**
 * The shared bridge HTTP-contract suite cannot quietly lose coverage.
 *
 * The scenarios run inside each bridge's own test group
 * (`bridges/<name>/src/conformance-bridge-contract.test.ts`). This file
 * checks the wiring from outside: every managed bridge has a complete
 * capability row, every unsupported entry says why, every bridge has a runner
 * its package test script actually selects, and no scenario is dead.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { BRIDGE_CONTRACT_CAPABILITIES } from "../conformance/bridge-contract/capabilities";
import { BRIDGE_IDS, CONTRACT_SCENARIOS } from "../conformance/bridge-contract/scenarios";

const root = path.resolve(import.meta.dir, "../..");
const RUNNER = "src/conformance-bridge-contract.test.ts";
const scenarioIds = CONTRACT_SCENARIOS.map((scenario) => scenario.id);

function bridgeDirectory(bridge: string): string {
  return path.join(root, "bridges", `${bridge}-bridge`);
}

describe("bridge contract capability matrix", () => {
  test("covers every managed bridge package and nothing else", () => {
    const packages = readdirSync(path.join(root, "bridges"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(path.join(root, "bridges", entry.name, "package.json")))
      .map((entry) => entry.name.replace(/-bridge$/, ""))
      .sort();
    expect([...BRIDGE_IDS].sort()).toEqual(packages);
    expect(Object.keys(BRIDGE_CONTRACT_CAPABILITIES).sort()).toEqual([...BRIDGE_IDS].sort());
  });

  test.each([...BRIDGE_IDS])("%s has an explicit entry for every scenario", (bridge) => {
    const row = BRIDGE_CONTRACT_CAPABILITIES[bridge];
    expect(Object.keys(row).sort()).toEqual([...scenarioIds].sort());
    for (const capability of Object.values(row)) {
      if (!capability.supported) expect(capability.reason.trim().length).toBeGreaterThan(10);
    }
  });

  test("every scenario applies to at least one bridge", () => {
    for (const id of scenarioIds) {
      expect(
        BRIDGE_IDS.filter((bridge) => BRIDGE_CONTRACT_CAPABILITIES[bridge][id].supported),
      ).not.toHaveLength(0);
    }
  });

  test("scenario ids are unique", () => {
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  });
});

describe("bridge contract runners", () => {
  test.each([...BRIDGE_IDS])("%s runs the shared suite from its own test group", (bridge) => {
    const directory = bridgeDirectory(bridge);
    const runner = path.join(directory, RUNNER);
    expect(existsSync(runner)).toBe(true);
    const source = readFileSync(runner, "utf8");
    expect(source).toContain("runBridgeContractSuite(");
    expect(source).toContain(`bridge: "${bridge}"`);
    // The aggregate runner's bridge group runs `test:bridge`, which selects
    // `src`; a runner outside it would never execute under `mise run test`.
    const { scripts } = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(scripts["test:bridge"]).toMatch(/^bun test src\s/);
  });

  test("a scenario change marks every bridge test task affected", () => {
    const turbo = JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8")) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    expect(turbo.tasks["test:bridge"]?.inputs).toContain("$TURBO_ROOT$/tests/conformance/**");
  });
});
