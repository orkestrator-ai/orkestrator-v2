import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { StorageService } from "../storage/service.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { CapabilityExecutor, type NodePlanTarget } from "./executor.js";
import { capabilityHomes } from "./index.js";
import { collectCapabilityInventory } from "./inventory.js";
import { CAPABILITY_MARKER_FILE, treeDigest, validatePackageFiles } from "./security.js";

import { agentTestCapabilityHomes, testCapabilityHomes } from "./native-ownership.js";

let root: string;
let data: string;
let isolated: string;
let fallback: ReturnType<typeof agentTestCapabilityHomes>;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-capability-homes-")));
  data = path.join(root, "data");
  await fs.mkdir(data);
  isolated = path.join(data, "agent-credentials");
  fallback = {
    ...testCapabilityHomes(path.join(data, "capability-test-home")),
    isolationRoot: data,
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The environment `createBackendProcessEnvironment` gives an isolated profile's backend. */
function profileEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ORKESTRATOR_AGENT_TEST_ISOLATED: "1",
    HOME: path.join(isolated, "home"),
    CLAUDE_CONFIG_DIR: path.join(isolated, "claude"),
    CODEX_HOME: path.join(isolated, "codex"),
    XDG_CONFIG_HOME: path.join(isolated, "xdg-config"),
    ...overrides,
  };
}

describe("agentTestCapabilityHomes", () => {
  test("an isolated profile writes into the homes its own agents read", () => {
    expect(agentTestCapabilityHomes(data, profileEnv())).toEqual({
      home: path.join(isolated, "home"),
      claudeConfigDir: path.join(isolated, "claude"),
      codexHome: path.join(isolated, "codex"),
      xdgConfigHome: path.join(isolated, "xdg-config"),
      isolationRoot: data,
    });
  });

  test("unset provider homes default under the isolated HOME", () => {
    const env = profileEnv({
      CLAUDE_CONFIG_DIR: undefined,
      CODEX_HOME: undefined,
      XDG_CONFIG_HOME: undefined,
    });
    const home = path.join(isolated, "home");
    expect(agentTestCapabilityHomes(data, env)).toEqual({
      ...testCapabilityHomes(home),
      isolationRoot: data,
    });
  });

  test("without the isolation marker it keeps the private test home", () => {
    expect(
      agentTestCapabilityHomes(data, profileEnv({ ORKESTRATOR_AGENT_TEST_ISOLATED: undefined })),
    ).toEqual(fallback);
  });

  test("any home outside the data directory falls back for all of them", () => {
    for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
      expect(agentTestCapabilityHomes(data, profileEnv({ [key]: "/Users/someone" }))).toEqual(
        fallback,
      );
    }
    // A sibling whose name only starts with the data directory's is outside it.
    expect(agentTestCapabilityHomes(data, profileEnv({ HOME: `${data}-other/home` }))).toEqual(
      fallback,
    );
    expect(
      agentTestCapabilityHomes(data, profileEnv({ CODEX_HOME: path.join(data, "..", "codex") })),
    ).toEqual(fallback);
    expect(agentTestCapabilityHomes(data, profileEnv({ HOME: data }))).toEqual(fallback);
    expect(agentTestCapabilityHomes(data, profileEnv({ HOME: "relative/home" }))).toEqual(fallback);
  });
});

test("the backend agent-test runtime uses the data directory's physical path", async () => {
  const alias = path.join(root, "profile-data");
  await fs.symlink(data, alias, "dir");
  const old = process.env.ORKESTRATOR_AGENT_TEST_ISOLATED;
  delete process.env.ORKESTRATOR_AGENT_TEST_ISOLATED;
  try {
    expect(
      capabilityHomes({ runtimeFlavor: "agent-test", storage: { getDataDir: () => alias } }),
    ).toEqual(fallback);
  } finally {
    if (old !== undefined) process.env.ORKESTRATOR_AGENT_TEST_ISOLATED = old;
  }
});

test.each([
  ["Claude home", "claude-user-skills", "CLAUDE_CONFIG_DIR", ""],
  ["Codex home", "codex-user-skills", "CODEX_HOME", ""],
  ["XDG home", "opencode-user-skills", "XDG_CONFIG_HOME", "opencode"],
  ["Cursor directory", "cursor-user-skills", "HOME", ".cursor"],
  ["fallback home", "claude-user-skills", null, ".claude"],
] as const)(
  "%s links are refused by install, inventory and remove",
  async (_, locationId, variable, child) => {
    const env = variable ? profileEnv() : {};
    const homes = agentTestCapabilityHomes(data, env);
    const linked =
      variable === "HOME" ? path.join(env.HOME!, child) : variable ? env[variable]! : homes.home;
    const standIn = path.join(root, "host");
    const hostParent = variable === "HOME" ? standIn : path.join(standIn, child);
    const existing = path.join(hostParent, "skills", "demo");
    const skill = "# demo";
    const marker = JSON.stringify({
      packageId: "pkg",
      componentId: "component",
      digest: treeDigest(validatePackageFiles([{ path: "SKILL.md", content: Buffer.from(skill) }])),
    });
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "SKILL.md"), skill);
    await fs.writeFile(path.join(existing, CAPABILITY_MARKER_FILE), marker);
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.symlink(standIn, linked, "dir");

    // Retain previously resolved homes to exercise the access boundary independently.
    const storage = new StorageService(data);
    try {
      await storage.init();
      const artifacts = new CapabilityArtifactStore(data);
      const artifactDigest = await artifacts.put(
        validatePackageFiles([{ path: "SKILL.md", content: Buffer.from("# new contents") }]),
      );
      const executor = new CapabilityExecutor({
        storage: { capabilities: storage.capabilities },
        artifacts,
        homes: () => homes,
      });
      const target: NodePlanTarget = {
        key: "slot",
        action: "install",
        kind: "skill",
        packageId: "pkg",
        componentId: "component",
        componentName: "demo",
        pathOrKey: "",
        locationId,
        artifactDigest,
        force: true,
      };
      if (variable !== "HOME")
        expect(() => agentTestCapabilityHomes(data, env)).toThrow("symbolic link");
      expect(await executor.apply([target])).toMatchObject([
        { status: "failed", reason: expect.stringContaining("symbolic link") },
      ]);
      const inventory = await collectCapabilityInventory("local", {
        homes,
        providers: async () => [],
      });
      expect(inventory.items).toEqual([]);
      expect(inventory.errors.length).toBeGreaterThan(0);
      expect(await executor.apply([{ ...target, action: "remove" }])).toMatchObject([
        { status: "failed", reason: expect.stringContaining("symbolic link") },
      ]);
      expect(await fs.readFile(path.join(existing, "SKILL.md"), "utf8")).toBe(skill);
      expect(await fs.readFile(path.join(existing, CAPABILITY_MARKER_FILE), "utf8")).toBe(marker);
      expect(await fs.readdir(path.dirname(existing))).toEqual(["demo"]);
    } finally {
      storage.close();
    }
  },
);
