import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Environment } from "../models.js";
import { safeFileTargets } from "./file-targets.js";

test("container checks inspect link ancestors and safely quote paths in the agent filesystem", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "permission-container-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.symlink("/outside", path.join(root, "src", "link"));
    const environment = {
      environmentType: "containerized",
      containerId: "fixture",
      status: "running",
    } as Environment;
    const exec = async (_id: string, script: string) => {
      const child = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      if (await child.exited) throw new Error("unsafe");
      return output;
    };
    expect(await safeFileTargets(environment, root, [`${root}/src/new/file.ts`], exec)).toBe(true);
    expect(await safeFileTargets(environment, root, [`${root}/src/link/new.ts`], exec)).toBe(false);
    expect(await safeFileTargets(environment, root, [`${root}/src/link/../new.ts`], exec)).toBe(
      false,
    );
    expect(await safeFileTargets(environment, root, [`${root}/src/a'$(exit 1).ts`], exec)).toBe(
      true,
    );
    expect(
      await safeFileTargets(environment, root, [`${root}/src/new.ts`], async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
