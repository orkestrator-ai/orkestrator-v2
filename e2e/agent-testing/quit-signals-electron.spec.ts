import { expect, test } from "./electron-fixtures";
import { _electron as electron, type ElectronApplication } from "playwright";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { closeElectronWithin } from "./design-electron-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { electronSpecEnvironment } from "./electron-spec-environment";
import { recordElectronDiagnostics, recordProcessOutput } from "./electron-diagnostics";

const requireDesktop = createRequire(
  path.resolve(import.meta.dirname, "../../apps/desktop/package.json"),
);

function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(
    (resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal, at: performance.now() }));
      child.once("error", reject);
    },
  );
}

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  test(`real ${signal} and a repeat finish Electron shutdown despite an unload veto and a slow backend`, async () => {
    test.skip(process.platform === "win32", "Requires POSIX signal delivery");
    const scratch = await mkdtemp(path.join(os.tmpdir(), "ork-native-quit-"));
    const file = (name: string) => path.join(scratch, name);
    const exists = (name: string) => existsSync(file(name));
    const waitForFile = async (name: string) => {
      await expect
        .poll(() => exists(name), { message: name, intervals: [25, 50, 100], timeout: 5_000 })
        .toBe(true);
    };
    const essentialFile = file("profile/logs/essential/essential.jsonl");
    const readEssential = () => readFile(essentialFile, "utf8").catch(() => "");
    let app: ElectronApplication | undefined;
    let replacement: ChildProcess | undefined;
    let replacementExit: ReturnType<typeof exited> | undefined;
    try {
      const backend = file("apps/backend/src/main.ts");
      await mkdir(path.dirname(backend), { recursive: true });
      await mkdir(file("profile"), { recursive: true });
      const electronMain = file("main.mjs");
      for (const [source, out, target] of [
        ["quit-signals-electron-fixture.ts", electronMain, "node"],
        ["quit-signals-backend-fixture.ts", backend, "bun"],
      ]) {
        const built = spawnSync(
          "bun",
          [
            "build",
            path.join(import.meta.dirname, source!),
            `--target=${target}`,
            "--external=electron",
            `--outfile=${out}`,
          ],
          { encoding: "utf8" },
        );
        expect(built.status, built.stderr).toBe(0);
      }
      // Use the actual browser executable. The npm CLI is a Node wrapper and
      // only forwards a subset of POSIX signals.
      app = await electron.launch({
        executablePath: requireDesktop("electron") as string,
        args: [...ELECTRON_TEST_SWITCHES, `--user-data-dir=${file("profile")}`, electronMain],
        cwd: scratch,
        env: electronSpecEnvironment(process.env),
      });
      recordElectronDiagnostics(app);
      const child = app.process();
      const electronExit = exited(child);
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Enable unload veto" }).click();
      await expect(page.getByRole("button", { name: "Veto enabled" })).toBeVisible();
      const quitAlreadyRequested = signal === "SIGTERM";
      if (quitAlreadyRequested) {
        await app.evaluate(({ app }) => app.quit());
        await waitForFile("veto-honoured");
      }

      const signalAt = performance.now();
      expect(child.kill(signal)).toBe(true);
      await expect
        .poll(async () => (await readEssential()).includes("quit.signal-received"), {
          timeout: 3_000,
          intervals: [25, 50, 100],
        })
        .toBe(true);
      expect(child.kill(signal === "SIGTERM" ? "SIGHUP" : "SIGTERM")).toBe(true);
      await waitForFile("signal-repeated");
      const exit = await electronExit;
      expect({ code: exit.code, signal: exit.signal }).toEqual({ code: 0, signal: null });
      const quitMs = exit.at - signalAt;
      test
        .info()
        .annotations.push({ type: "signal-to-exit-ms", description: String(Math.round(quitMs)) });
      expect(quitMs).toBeLessThan(5_000);
      expect(exists("veto-overridden")).toBe(true);
      expect(exists("application-flush")).toBe(true);
      expect(exists("backend-draining")).toBe(true);
      const records = (await readEssential())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.filter((record) => record.event === "quit.signal-received")).toEqual([
        expect.objectContaining({ fields: { signal, backendWaitMs: 3_000, quitAlreadyRequested } }),
      ]);
      expect(records.filter((record) => record.event === "essential.stopped")).toHaveLength(1);
      expect(records.at(-1)?.event).toBe("essential.stopped");

      replacement = spawn("bun", ["--no-env-file", backend, "--replacement"], {
        cwd: scratch,
        env: electronSpecEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
      recordProcessOutput("replacement backend", replacement);
      replacementExit = exited(replacement);
      await waitForFile("replacement-waiting");
      expect(exists("replacement-acquired")).toBe(false);
      await writeFile(file("release-backend"), "");
      await waitForFile("replacement-acquired");
      expect((await replacementExit).code).toBe(0);
    } finally {
      await writeFile(file("release-backend"), "");
      if (replacement && replacement.exitCode === null && replacement.signalCode === null)
        replacement.kill();
      await replacementExit?.catch(() => undefined);
      if (app) await closeElectronWithin(app).catch(() => undefined);
      // The old owner removes the lock synchronously on exit.
      await expect
        .poll(() => exists("profile/desktop-backend/.owner-lock"), { timeout: 5_000 })
        .toBe(false);
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
