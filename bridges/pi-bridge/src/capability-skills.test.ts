import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_SESSION_PLUGINS_DIR_ENV } from "@orkestrator/protocol/capability-resources";
import {
  capabilityEvidenceBody,
  capabilitySessionSkillPaths,
  capabilitySkillsNeedRebuild,
  effectiveCapabilitySkillPaths,
  noteCapabilityLoad,
  parseCapabilityPlugins,
} from "./capability-skills.js";
import { MAX_CAPABILITY_EVIDENCE_BYTES } from "@orkestrator/protocol/capability-evidence";
import { newSessionState } from "./agent-session.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "pi-capability-skills-")));
  roots.push(base);
  const root = join(base, "capability-session-plugins");
  const plugin = join(root, "0123456789abcdef0123");
  await mkdir(join(plugin, "skills", "ork-one"), { recursive: true });
  return { base, root, plugin, env: { [CAPABILITY_SESSION_PLUGINS_DIR_ENV]: root } };
}

describe("parseCapabilityPlugins", () => {
  test("keeps bounded strings, at most four", () => {
    expect(parseCapabilityPlugins(undefined)).toEqual([]);
    expect(parseCapabilityPlugins("x")).toEqual([]);
    expect(parseCapabilityPlugins(["/a", 2, "", "/b", "/c", "/d", "/e"])).toEqual([
      "/a",
      "/b",
      "/c",
      "/d",
    ]);
  });
});

describe("capabilitySessionSkillPaths", () => {
  test("accepts a content-addressed child of the root and gives Pi its skills folder", async () => {
    const { plugin, env } = await fixture();
    expect(await capabilitySessionSkillPaths([plugin, plugin], env)).toEqual([
      join(plugin, "skills"),
    ]);
  });

  test("refuses without a root, outside it, a non-digest name and a linked plugin", async () => {
    const { base, root, plugin, env } = await fixture();
    expect(await capabilitySessionSkillPaths([plugin], {})).toEqual([]);
    const outside = join(base, "elsewhere", "0123456789abcdef9999");
    await mkdir(join(outside, "skills"), { recursive: true });
    const named = join(root, "not-a-digest");
    await mkdir(join(named, "skills"), { recursive: true });
    const linked = join(root, "fedcba9876543210fedc");
    await symlink(outside, linked);
    expect(await capabilitySessionSkillPaths([outside, named, linked, "relative"], env)).toEqual(
      [],
    );
  });

  test("a plugin without skills gives Pi nothing", async () => {
    const { root, env } = await fixture();
    const commandsOnly = join(root, "abcdefabcdefabcdef00");
    await mkdir(join(commandsOnly, "commands"), { recursive: true });
    expect(await capabilitySessionSkillPaths([commandsOnly], env)).toEqual([]);
  });
});

describe("effective set, rebuild and evidence", () => {
  test("a read-only turn or a coordinator holds no private skills", () => {
    const state = newSessionState();
    state.capabilitySkillPaths = ["/root/digest/skills"];
    expect(effectiveCapabilitySkillPaths(state)).toEqual(["/root/digest/skills"]);
    expect(effectiveCapabilitySkillPaths({ ...state, readOnly: true })).toEqual([]);
    expect(
      effectiveCapabilitySkillPaths({
        ...state,
        policy: {
          id: "coordinator-read-only",
          sandbox: "provider",
          approvals: "deny",
          projectResources: false,
          networkAccess: "restricted",
        },
      }),
    ).toEqual([]);
  });

  test("rebuild is needed only when the set differs from the build's", () => {
    const state = newSessionState();
    expect(capabilitySkillsNeedRebuild(state)).toBe(false);
    state.capabilitySkillPaths = ["/root/a/skills"];
    expect(capabilitySkillsNeedRebuild(state)).toBe(true);
    noteCapabilityLoad(state, ["/root/a/skills"], []);
    expect(capabilitySkillsNeedRebuild(state)).toBe(false);
    state.capabilitySkillPaths = [];
    expect(capabilitySkillsNeedRebuild(state)).toBe(true);
  });

  test("reserves room for staged evidence and marks byte and row truncation", () => {
    const state = newSessionState();
    const root = "/staged/digest/skills";
    const staged = { name: "private", filePath: `${root}/private/SKILL.md` };
    for (const namePart of ["a", "漢".repeat(4000)]) {
      const shared = Array.from({ length: 300 }, (_, i) => ({
        name: `skill-${i}`,
        filePath: `/shared/${namePart}/${i}/SKILL.md`,
      }));
      noteCapabilityLoad(state, [root], [...shared, staged]);
      const evidence = capabilityEvidenceBody(state);
      if (evidence.state !== "evidence") throw new Error("Expected evidence");
      expect(evidence.loadedSkillsIncomplete).toBe(true);
      expect(evidence.loadedSkills?.[0]).toEqual({ name: staged.name, path: staged.filePath });
      if (namePart === "a") expect(evidence.loadedSkills).toHaveLength(256);
      else {
        expect(evidence.loadedSkills!.length).toBeGreaterThan(1);
        expect(evidence.loadedSkills!.length).toBeLessThan(25);
      }
      expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(
        MAX_CAPABILITY_EVIDENCE_BYTES,
      );
    }
  });

  test("the evidence body names loaded skills and their files only, per generation", () => {
    expect(capabilityEvidenceBody(undefined)).toEqual({ state: "missing" });
    const state = newSessionState();
    expect(capabilityEvidenceBody(state)).toEqual({ state: "none" });
    noteCapabilityLoad(
      state,
      [],
      [
        { name: "ork-one", filePath: "/root/a/skills/ork-one/SKILL.md" },
        { name: 3, filePath: "/ignored" },
      ],
      () => "2026-11-26T00:00:00.000Z",
    );
    noteCapabilityLoad(
      state,
      [],
      [{ name: "ork-two", filePath: "/x/ork-two/SKILL.md" }],
      () => "2026-11-26T00:00:01.000Z",
    );
    expect(capabilityEvidenceBody(state)).toEqual({
      state: "evidence",
      generation: 2,
      loadedAt: "2026-11-26T00:00:01.000Z",
      plugins: [],
      skills: ["ork-two"],
      loadedSkills: [{ name: "ork-two", path: "/x/ork-two/SKILL.md" }],
      usedSkills: [],
    });
  });
});
