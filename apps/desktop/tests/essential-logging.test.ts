import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { claimDesktopLogging, exitWithEssentialLog } from "../electron/essential-logging.js";
import { configureLogger, createLogger, resetLogger } from "@orkestrator/protocol/logger";

test("a rejected secondary launch leaves the primary's unmatched start intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-essential-"));
  const file = path.join(root, "logs", "essential", "essential.jsonl");
  const fakeApp = (primary: boolean) =>
    ({
      requestSingleInstanceLock: () => primary,
      quit() {},
      on() {},
    }) as unknown as Parameters<typeof claimDesktopLogging>[0];
  const primary = claimDesktopLogging(fakeApp(true), root);
  try {
    await primary.essentialLog!.flush();
    const before = await readFile(file, "utf8");
    const secondary = claimDesktopLogging(fakeApp(false), root);
    expect(secondary).toEqual({ isPrimaryInstance: false, essentialLog: null });
    expect(await readFile(file, "utf8")).toBe(before);
    // Still the primary's sink; the rejected launch must not replace it either.
    configureLogger({ sink: () => {} });
    createLogger("backend").info("shutdown.finished", { code: 7 });
    await primary.essentialLog!.flush();
    const after = await readFile(file, "utf8");
    expect(after.match(/"event":"essential.started"/g)).toHaveLength(1);
    expect(after).not.toContain('"event":"essential.stopped"');
    expect(after).toContain('"code":7');
  } finally {
    await primary.essentialLog?.stop();
    resetLogger();
    await rm(root, { recursive: true, force: true });
  }
});

test("immediate native exit receives already persisted queued entries without will-quit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-essential-exit-"));
  const { installEssentialLog } = await import("@orkestrator/protocol/node/essential-log");
  configureLogger({ sink: () => {} });
  const log = installEssentialLog({ dataDir: root, owner: "desktop" });
  try {
    createLogger("backend").info("shutdown.finished", { code: 42 });
    let called = false;
    exitWithEssentialLog(
      {
        exit: (code) => {
          called = true;
          expect(code).toBe(3);
          // Read synchronously at the exact point native exit takes over.
          const text = readFileSync(path.join(log.directory, "essential.jsonl"), "utf8");
          expect(text).toContain('"code":42');
          expect(text).not.toContain('"event":"essential.stopped"');
        },
      },
      log,
      3,
    );
    expect(called).toBe(true);
    await log.flush();
    const text = await readFile(path.join(log.directory, "essential.jsonl"), "utf8");
    expect(text.match(/"code":42/g)).toHaveLength(1);
  } finally {
    await log.stop();
    resetLogger();
    await rm(root, { recursive: true, force: true });
  }
});
