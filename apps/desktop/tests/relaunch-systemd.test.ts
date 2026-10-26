import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const hasUserManager =
  process.platform === "linux" &&
  spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore", timeout: 2_000 })
    .status === 0;

async function waitForFile(file: string) {
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path.basename(file)}`);
    await Bun.sleep(20);
  }
}

for (const kind of ["scope", "service"] as const) {
  test.skipIf(!hasUserManager)(
    `AppImage restart survives systemd stopping its original ${kind}`,
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ork-systemd-relaunch-"));
      const unit = `app-ork-relaunch-test-${randomUUID()}.${kind}`;
      const scheduled = path.join(root, "scheduled");
      const launched = path.join(root, "launched");
      const fallback = path.join(root, "fallback");
      const image = path.join(root, "fake.appimage");
      const fixture = path.join(root, "main.ts");
      const owd = path.join(root, "deleted-worktree");
      await mkdir(owd);
      await rm(owd, { recursive: true });
      await writeFile(
        image,
        `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } > "${launched}.tmp"\nmv "${launched}.tmp" "${launched}"\n`,
        { mode: 0o755 },
      );
      const moduleUrl = pathToFileURL(
        path.resolve(import.meta.dir, "../electron/relaunch.ts"),
      ).href;
      await writeFile(
        fixture,
        `
import { relaunchApplication } from ${JSON.stringify(moduleUrl)};
import { writeFileSync } from "node:fs";
process.env.APPIMAGE = ${JSON.stringify(image)};
process.env.OWD = ${JSON.stringify(owd)};
process.argv = ["/tmp/.mount_old/orkestrator", "--flag", "$literal%"];
relaunchApplication({ relaunch() { writeFileSync(${JSON.stringify(fallback)}, "fallback"); } });
writeFileSync(${JSON.stringify(scheduled)}, "scheduled");
setInterval(() => {}, 1000);
`,
      );
      const child = spawn(
        "systemd-run",
        [
          "--user",
          ...(kind === "scope" ? ["--scope"] : ["--service-type=exec"]),
          "--collect",
          "--quiet",
          `--unit=${unit}`,
          process.execPath,
          fixture,
        ],
        { stdio: "ignore" },
      );
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      try {
        await waitForFile(scheduled);
        expect(await Bun.file(launched).exists()).toBe(false);
        expect(
          spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10_000 })
            .status,
        ).toBe(0);
        await closed;
        await waitForFile(launched);
        expect(await readFile(launched, "utf8")).toBe(`${homedir()}\n--flag\n$literal%\n`);
        expect(await Bun.file(fallback).exists()).toBe(false);
      } finally {
        spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10_000 });
        child.kill("SIGKILL");
        await closed;
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
