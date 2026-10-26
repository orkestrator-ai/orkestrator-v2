import { expect, test } from "bun:test";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { parseCopyOutput } from "../src/core/container-replacement";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const live = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE ? test : test.skip;
const ROOT = path.resolve(import.meta.dir, "../../..");
const RUN = `data-${Date.now().toString(36)}-${process.pid}`;
const LABEL = `orkestrator-qualification=${RUN}`;
const docker = async (args: string[]) =>
  (await runCommand("docker", args, { timeoutMs: 120_000 })).stdout.trim();

live(
  "production copy-volume preserves user xattrs and file capabilities on Docker volumes",
  async () => {
    const volumes: string[] = [];
    try {
      for (const role of ["source", "destination"]) {
        const name = `ork-${RUN}-${role}`;
        await docker(["volume", "create", "--label", LABEL, name]);
        volumes.push(name);
      }
      const fixture = [
        "--mount",
        `type=bind,src=${ROOT}/apps/backend/tests/container-xattr-fixture.js,dst=/fixture.js,readonly`,
      ];
      const before = await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "root",
        "--label",
        LABEL,
        "--mount",
        `type=volume,src=${volumes[0]},dst=/source,volume-nocopy`,
        ...fixture,
        "--entrypoint",
        "bun",
        IMAGE,
        "/fixture.js",
        "seed",
        "/source",
      ]);
      const output = await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "root",
        "--label",
        LABEL,
        "--mount",
        `type=volume,src=${volumes[0]},dst=/source,readonly,volume-nocopy`,
        "--mount",
        `type=volume,src=${volumes[1]},dst=/destination,volume-nocopy`,
        "--mount",
        `type=bind,src=${ROOT}/docker/orkestrator-migrate.sh,dst=/migrate.sh,readonly`,
        "--entrypoint",
        "bash",
        IMAGE,
        "/migrate.sh",
        "copy-volume",
        "/source",
        "/destination",
      ]);
      expect(parseCopyOutput(output)).toMatchObject({ ok: true, files: 1 });
      const after = await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "root",
        "--label",
        LABEL,
        "--mount",
        `type=volume,src=${volumes[1]},dst=/destination,readonly,volume-nocopy`,
        ...fixture,
        "--entrypoint",
        "bun",
        IMAGE,
        "/fixture.js",
        "read",
        "/destination",
      ]);
      expect(JSON.parse(before).slice(0, 2)).toEqual(["000102ff", "000102ff"]);
      expect(JSON.parse(before)[2].length).toBeGreaterThan(0);
      expect(after).toBe(before);
    } finally {
      // One per call (see container-live-cleanup.ts).
      for (const volume of volumes) await docker(["volume", "rm", volume]);
    }
  },
  180_000,
);

live(
  "OpenCode host-data omissions work with an authenticated active console account",
  async () => {
    const { stdout } = await runCommand(
      "bash",
      [path.join(ROOT, "scripts/qualify-opencode-seeded-data.sh"), IMAGE],
      { timeoutMs: 300_000 },
    );
    expect(stdout).toContain("PASS: OpenCode used none of the seeded host data");
    expect(stdout.match(/ok   console_authenticated=yes/g)).toHaveLength(4);
  },
  330_000,
);
