/**
 * The shared provider-replay suite cannot quietly lose coverage.
 *
 * The fixtures replay inside each bridge's own test group
 * (`bridges/<name>/src/conformance-provider-replay.test.ts`). This file checks
 * the wiring from outside: every bridge has a complete capability row, every
 * unsupported entry says why, every bridge's runner is collected by the
 * default tier, every fixture parses as the bridge it sits in, and no fixture
 * or expectation carries anything the recording scrubber would redact.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDER_REPLAY_CAPABILITIES } from "../conformance/provider-replay/capabilities";
import {
  PROVIDER_REPLAY_BRIDGES,
  parseProviderReplayFixture,
} from "../conformance/provider-replay/fixture";
import { PROVIDER_REPLAY_SCENARIOS } from "../conformance/provider-replay/scenarios";
import { buildRedactions, scrub } from "../../scripts/scrub-codex-recording.ts";
import { slowTestFiles } from "../../scripts/test-tiers";

const root = path.resolve(import.meta.dir, "../..");
const RUNNER = "src/conformance-provider-replay.test.ts";
const FIXTURES = "src/testing/provider-replay";
const scenarioIds = PROVIDER_REPLAY_SCENARIOS.map((scenario) => scenario.id);

function bridgeDirectory(bridge: string): string {
  return path.join(root, "bridges", `${bridge}-bridge`);
}

function fixtureFiles(bridge: string): string[] {
  const directory = path.join(bridgeDirectory(bridge), FIXTURES);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe("provider replay capability matrix", () => {
  test("covers every managed bridge except Codex, which replays app-server recordings", () => {
    const packages = readdirSync(path.join(root, "bridges"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(path.join(root, "bridges", entry.name, "package.json")))
      .map((entry) => entry.name.replace(/-bridge$/, ""))
      .filter((name) => name !== "codex")
      .sort();
    expect<string[]>([...PROVIDER_REPLAY_BRIDGES].sort()).toEqual(packages);
    expect(Object.keys(PROVIDER_REPLAY_CAPABILITIES).sort()).toEqual(
      [...PROVIDER_REPLAY_BRIDGES].sort(),
    );
    // Codex's own harness, which this suite deliberately does not duplicate.
    expect(
      existsSync(path.join(bridgeDirectory("codex"), "src/app-server/notification-replay.test.ts")),
    ).toBe(true);
  });

  test.each([...PROVIDER_REPLAY_BRIDGES])(
    "%s has an explicit entry for every scenario",
    (bridge) => {
      const row = PROVIDER_REPLAY_CAPABILITIES[bridge];
      expect(Object.keys(row).sort()).toEqual([...scenarioIds].sort());
      for (const capability of Object.values(row)) {
        if (!capability.supported) expect(capability.reason.trim().length).toBeGreaterThan(10);
      }
    },
  );

  test("every scenario applies to at least one bridge", () => {
    for (const id of scenarioIds) {
      expect(
        PROVIDER_REPLAY_BRIDGES.filter(
          (bridge) => PROVIDER_REPLAY_CAPABILITIES[bridge][id].supported,
        ),
      ).not.toHaveLength(0);
    }
  });

  test("scenario ids are unique", () => {
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  });
});

describe("provider replay runners", () => {
  test.each([...PROVIDER_REPLAY_BRIDGES])(
    "%s replays its corpus from its own default-tier test group",
    (bridge) => {
      const directory = bridgeDirectory(bridge);
      const runner = path.join(directory, RUNNER);
      expect(existsSync(runner)).toBe(true);
      const source = readFileSync(runner, "utf8");
      expect(source).toContain("runProviderReplaySuite(");
      expect(source).toContain(`bridge: "${bridge}"`);
      const { scripts } = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      ) as { scripts: Record<string, string> };
      expect(scripts["test:bridge"]).toMatch(
        /^bun --no-env-file \.\.\/\.\.\/scripts\/bun-test-tier\.ts \S+ src --/,
      );
      // A provider bump must not pass `mise run test` with the corpus unread.
      expect(slowTestFiles(root, path.relative(root, directory))).not.toContain(RUNNER);
    },
  );
});

describe("provider replay corpus", () => {
  test.each([...PROVIDER_REPLAY_BRIDGES])(
    "%s fixtures parse as that bridge and each has an expectation",
    (bridge) => {
      const files = fixtureFiles(bridge);
      const fixtures = files.filter((name) => name.endsWith(".jsonl"));
      expect(fixtures.length).toBeGreaterThan(0);
      for (const name of fixtures) {
        const text = readFileSync(path.join(bridgeDirectory(bridge), FIXTURES, name), "utf8");
        const fixture = parseProviderReplayFixture(name, text);
        expect({ name, bridge: fixture.header.bridge }).toEqual({ name, bridge });
        expect(files).toContain(name.replace(/\.jsonl$/, ".expected.json"));
      }
      // Only fixtures, their expectations and the corpus README live here.
      expect(
        files.filter(
          (name) =>
            !name.endsWith(".jsonl") && !name.endsWith(".expected.json") && name !== "README.md",
        ),
      ).toEqual([]);
    },
  );

  test.each([...PROVIDER_REPLAY_BRIDGES])(
    "%s fixtures and expectations hold nothing the scrubber would redact",
    async (bridge) => {
      // Pinned to the placeholder identity the scrubber writes, so the check
      // means the same on every machine; real home paths are still caught by
      // the generic home-shaped rule.
      const redactions = buildRedactions({ home: "/home/user", user: "user" });
      for (const name of fixtureFiles(bridge)) {
        if (name === "README.md") continue;
        const contents = readFileSync(path.join(bridgeDirectory(bridge), FIXTURES, name), "utf8");
        const { hits, totalHits } = scrub(contents, redactions);
        expect({ name, hits }).toEqual({ name, hits: {} });
        expect(totalHits).toBe(0);
      }
    },
  );
});
