/**
 * The design renderer records each browser profile it launches so a later
 * backend can remove the profile of a killed one (0248), and only that: never
 * a profile it did not record, one a live browser or backend still owns, one
 * changed within the age floor, or one a live process names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";

import {
  DESIGN_PROFILE_STALE_MS,
  DesignProfileLedger,
  userDataDirFromArgs,
  type DesignProfileLedgerOptions,
} from "./browser-profiles.js";
import { DesignRenderer, type DesignBrowserHandle } from "./renderer.js";
import { DESIGN_BROWSER_PROFILES_DIRECTORY, DesignService } from "./service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ork-design-profiles-test-"));
  roots.push(root);
  const temp = path.join(root, "tmp");
  mkdirSync(temp);
  return { ledgerDir: path.join(root, "data", "design-browser-profiles"), temp };
}

let profileCounter = 0;
function makeProfile(temp: string, ageMs = DESIGN_PROFILE_STALE_MS + 60_000): string {
  const profile = path.join(
    temp,
    `playwright_chromiumdev_profile-${String(++profileCounter).padStart(6, "a")}`,
  );
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  const old = new Date(Date.now() - ageMs);
  utimesSync(profile, old, old);
  return profile;
}

const BROWSER_PID = 4_000_001;

/** Everything but this process has exited, and identities never change, unless overridden. */
function ledger(dir: string, options: DesignProfileLedgerOptions = {}) {
  return new DesignProfileLedger(dir, {
    isProcessAlive: (pid) => pid === process.pid,
    processStartIdentity: (pid) => `start-${pid}`,
    liveCommandLines: async () => "",
    ...options,
  });
}

/** Rewrites a record as if a backend that has since exited had written it. */
function orphan(recordPath: string, backendPid = 4_000_000) {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.backend = { pid: backendPid, start: `start-${backendPid}` };
  writeFileSync(recordPath, JSON.stringify(record));
}

describe("userDataDirFromArgs", () => {
  test("reads the profile Playwright passed to Chromium", () => {
    expect(
      userDataDirFromArgs(["/chrome", "--headless", "--user-data-dir=/tmp/p x", "--remote"]),
    ).toBe("/tmp/p x");
    expect(userDataDirFromArgs(["/chrome"])).toBeUndefined();
    expect(userDataDirFromArgs(undefined)).toBeUndefined();
  });
});

describe("DesignProfileLedger", () => {
  test("a profile Playwright removed on close takes its record with it", async () => {
    const { ledgerDir, temp } = fixture();
    const profile = makeProfile(temp);
    const target = ledger(ledgerDir);
    const record = await target.record(BROWSER_PID, profile);
    expect(record).not.toBeNull();
    await target.release(record);
    expect(existsSync(record!)).toBe(true);
    rmSync(profile, { recursive: true });
    await target.release(record);
    expect(existsSync(record!)).toBe(false);
  });

  test("records nothing that is not a Playwright profile", async () => {
    const { ledgerDir, temp } = fixture();
    const target = ledger(ledgerDir);
    expect(await target.record(BROWSER_PID, temp)).toBeNull();
    expect(await target.record(BROWSER_PID, "playwright_chromiumdev_profile-abcdef")).toBeNull();
    expect(await target.record(undefined, makeProfile(temp))).toBeNull();
  });

  test("startup removes a killed backend's profile once its browser has exited", async () => {
    const { ledgerDir, temp } = fixture();
    const profile = makeProfile(temp);
    const unrelated = makeProfile(temp);
    orphan((await ledger(ledgerDir).record(BROWSER_PID, profile))!);

    expect(await ledger(ledgerDir).sweep()).toEqual([profile]);
    expect(existsSync(profile)).toBe(false);
    expect(readdirSync(ledgerDir)).toEqual([]);
    // Never a profile it did not record: other tools share the prefix.
    expect(existsSync(unrelated)).toBe(true);
  });

  test("a recycled backend PID does not keep a profile", async () => {
    const { ledgerDir, temp } = fixture();
    const profile = makeProfile(temp);
    const backendPid = process.pid + 1;
    orphan((await ledger(ledgerDir).record(BROWSER_PID, profile))!, backendPid);
    // The PID is alive again, but as another process.
    const recycled = ledger(ledgerDir, {
      isProcessAlive: (pid) => pid === backendPid,
      processStartIdentity: (pid) => (pid === backendPid ? "a later process" : `start-${pid}`),
    });
    expect(await recycled.sweep()).toEqual([profile]);
  });

  for (const [label, options, ageMs] of [
    ["its backend still runs", { isProcessAlive: () => true }, undefined],
    [
      "its browser outlived the backend",
      { isProcessAlive: (pid: number) => pid === BROWSER_PID },
      undefined,
    ],
    ["it changed within the age floor", {}, 60_000],
    [
      "a live process names it",
      { liveCommandLines: async () => "chrome --user-data-dir=PROFILE" },
      undefined,
    ],
    ["the process list cannot be read", { liveCommandLines: async () => null }, undefined],
  ] as const) {
    test(`startup keeps a recorded profile when ${label}`, async () => {
      const { ledgerDir, temp } = fixture();
      const profile = makeProfile(temp, ageMs);
      orphan((await ledger(ledgerDir).record(BROWSER_PID, profile))!);
      const overrides: DesignProfileLedgerOptions = { ...options };
      if ("liveCommandLines" in options) {
        const lines = await options.liveCommandLines();
        overrides.liveCommandLines = async () => lines?.replace("PROFILE", profile) ?? null;
      }
      expect(await ledger(ledgerDir, overrides).sweep()).toEqual([]);
      expect(existsSync(profile)).toBe(true);
      expect(readdirSync(ledgerDir)).toHaveLength(1);
    });
  }

  test("startup drops records that name nothing removable, touching nothing", async () => {
    const { ledgerDir, temp } = fixture();
    const precious = path.join(temp, "precious");
    mkdirSync(precious);
    mkdirSync(ledgerDir, { recursive: true });
    const forged = {
      profile: precious,
      backend: { pid: 4_000_000, start: null },
      browser: { pid: BROWSER_PID, start: null },
    };
    writeFileSync(path.join(ledgerDir, "4000000-4000001-0123abcd.json"), JSON.stringify(forged));
    writeFileSync(path.join(ledgerDir, "4000000-4000002-0123abcd.json"), "{not json");
    const gone = makeProfile(temp);
    const record = (await ledger(ledgerDir).record(BROWSER_PID, gone))!;
    orphan(record);
    rmSync(gone, { recursive: true });

    expect(await ledger(ledgerDir).sweep()).toEqual([]);
    expect(readdirSync(ledgerDir)).toEqual([]);
    expect(existsSync(precious)).toBe(true);
  });
});

async function until(predicate: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return predicate();
}

describe("DesignRenderer with a profile ledger", () => {
  function handle(profile: string, removeOnClose: boolean): DesignBrowserHandle {
    const browser = {
      once: () => undefined,
      newContext: async () => {
        throw new Error("unused");
      },
    } as unknown as Browser;
    return {
      browser,
      pid: BROWSER_PID,
      profileDir: profile,
      close: async () => {
        if (removeOnClose) rmSync(profile, { recursive: true, force: true });
      },
      kill: async () => undefined,
    };
  }

  for (const removeOnClose of [true, false]) {
    test(`closing keeps the record only while the profile remains (${removeOnClose ? "removed" : "left"})`, async () => {
      const { ledgerDir, temp } = fixture();
      const profile = makeProfile(temp);
      const renderer = new DesignRenderer({
        launchBrowser: async () => handle(profile, removeOnClose),
        executablePath: () => "/chromium",
        profiles: ledger(ledgerDir),
      });
      await renderer.probe(true);
      expect(await until(() => existsSync(ledgerDir) && readdirSync(ledgerDir).length === 1)).toBe(
        true,
      );
      await renderer.close();
      expect(readdirSync(ledgerDir)).toHaveLength(removeOnClose ? 0 : 1);
    });
  }

  test("sweepStaleProfiles reports what the ledger removed", async () => {
    const { ledgerDir, temp } = fixture();
    orphan((await ledger(ledgerDir).record(BROWSER_PID, makeProfile(temp)))!);
    const renderer = new DesignRenderer({ profiles: ledger(ledgerDir) });
    expect(await renderer.sweepStaleProfiles()).toBe(1);
    expect(await new DesignRenderer().sweepStaleProfiles()).toBe(0);
    await renderer.close();
  });
});

describe("design service startup", () => {
  test("removes the recorded profile of a backend that was killed", async () => {
    const { temp } = fixture();
    const dataDir = path.dirname(temp);
    const ledgerDir = path.join(dataDir, DESIGN_BROWSER_PROFILES_DIRECTORY);
    // Real liveness checks: both recorded processes have exited.
    const exited = () => spawnSync(process.execPath, ["--eval", ""], { timeout: 5_000 }).pid;
    const [backendPid, browserPid] = [exited(), exited()];
    const profile = makeProfile(temp);
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      path.join(ledgerDir, `${backendPid}-${browserPid}-0123abcd.json`),
      JSON.stringify({
        profile,
        backend: { pid: backendPid, start: null },
        browser: { pid: browserPid, start: null },
      }),
    );

    const service = new DesignService(dataDir, () => undefined);
    try {
      await service.initialize();
      expect(await until(() => !existsSync(profile))).toBe(true);
      expect(readdirSync(ledgerDir)).toEqual([]);
    } finally {
      await service.close();
    }
  });
});
