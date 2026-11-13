import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  hostClaudeSignedOut,
  isKeychainFile,
  probeKeychainItemCommand,
  type KeychainItemPresence,
} from "./claude-host-credentials.js";

/**
 * A host Claude sign-out may remove the host's login from containers, so the
 * reading must say "signed out" only when every place Claude keeps a login
 * says there is none. An expired login, an unreadable file or an inconclusive
 * Keychain answer must never count.
 */
let root: string;
let home: string;
let configDir: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-claude-signed-out-")));
  home = path.join(root, "home");
  configDir = path.join(root, "config");
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const homeCredentials = () => path.join(home, ".claude", ".credentials.json");
const configCredentials = () => path.join(configDir, ".credentials.json");
const login = JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 1 } });

function keychain(answers: KeychainItemPresence[]) {
  const calls: string[][] = [];
  return {
    calls,
    probe: async (args: string[]) => {
      calls.push(args);
      return answers[calls.length - 1] ?? "unknown";
    },
  };
}

describe("hostClaudeSignedOut on Linux", () => {
  test("no credential file anywhere reads as signed out", async () => {
    expect(await hostClaudeSignedOut("linux", home, configDir)).toBe(true);
    expect(await hostClaudeSignedOut("linux", home)).toBe(true);
  });

  test("a file emptied of logins reads as signed out", async () => {
    await fs.writeFile(homeCredentials(), "{}");
    await fs.writeFile(configCredentials(), '{"mcpOAuth":{}}');
    expect(await hostClaudeSignedOut("linux", home, configDir)).toBe(true);
  });

  test("an expired login, an MCP login or a login in either place is not a sign-out", async () => {
    await fs.writeFile(configCredentials(), login);
    expect(await hostClaudeSignedOut("linux", home, configDir)).toBe(false);
    await fs.rm(configCredentials());
    await fs.writeFile(homeCredentials(), '{"mcpOAuth":{"linear":{"accessToken":"m"}}}');
    expect(await hostClaudeSignedOut("linux", home, configDir)).toBe(false);
  });

  test("a file that cannot be read or parsed says nothing", async () => {
    await fs.writeFile(homeCredentials(), "not json");
    expect(await hostClaudeSignedOut("linux", home)).toBe(false);
    await fs.rm(homeCredentials());
    await fs.writeFile(homeCredentials(), "[]");
    expect(await hostClaudeSignedOut("linux", home)).toBe(false);
    await fs.rm(homeCredentials());
    // A directory where the file should be is unreadable as a file.
    await fs.mkdir(homeCredentials());
    expect(await hostClaudeSignedOut("linux", home)).toBe(false);
  });

  test("a symlinked credential file is not followed and does not count", async () => {
    const target = path.join(root, "elsewhere.json");
    await fs.writeFile(target, "{}");
    await fs.symlink(target, homeCredentials());
    expect(await hostClaudeSignedOut("linux", home)).toBe(false);
  });

  test("an explicit configuration directory looks only there, and nowhere is no evidence", async () => {
    await fs.writeFile(homeCredentials(), login);
    expect(await hostClaudeSignedOut("linux", home, configDir, { configDirOnly: true })).toBe(true);
    expect(await hostClaudeSignedOut("linux", home, undefined, { configDirOnly: true })).toBe(
      false,
    );
  });
});

const pinnedKeychain = () => path.join(home, "Library", "Keychains", "login.keychain-db");

/** A file that starts like a keychain, which is all the reading checks for. */
async function writeKeychainFile(file = pinnedKeychain()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([Buffer.from("kych"), Buffer.alloc(64)]));
}

describe("hostClaudeSignedOut on macOS", () => {
  beforeEach(async () => {
    await writeKeychainFile();
  });

  test("signed out only when every Keychain lookup reports the record missing", async () => {
    const both = keychain(["absent", "absent"]);
    expect(
      await hostClaudeSignedOut(
        "darwin",
        home,
        undefined,
        { allowDefaultKeychainSearchList: true },
        both.probe,
      ),
    ).toBe(true);
    // A metadata lookup: never `-w`, so no access prompt can be declined.
    expect(both.calls).toEqual([
      [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        path.join(home, "Library", "Keychains", "login.keychain-db"),
      ],
      ["find-generic-password", "-s", "Claude Code-credentials"],
    ]);

    for (const answers of [
      ["present"],
      ["unknown"],
      ["absent", "present"],
      ["absent", "unknown"],
    ] as KeychainItemPresence[][]) {
      const probe = keychain(answers).probe;
      expect(
        await hostClaudeSignedOut(
          "darwin",
          home,
          undefined,
          { allowDefaultKeychainSearchList: true },
          probe,
        ),
      ).toBe(false);
    }
  });

  test("a missing Keychain record with a login on disk is not a sign-out", async () => {
    await fs.writeFile(homeCredentials(), login);
    expect(
      await hostClaudeSignedOut("darwin", home, undefined, {}, keychain(["absent"]).probe),
    ).toBe(false);
  });

  test("an added account's directory reads its own Keychain entry", async () => {
    const probe = keychain(["absent"]);
    expect(
      await hostClaudeSignedOut(
        "darwin",
        home,
        configDir,
        { keychainService: "Claude Code-credentials-abcd1234", configDirOnly: true },
        probe.probe,
      ),
    ).toBe(true);
    expect(probe.calls[0]?.[2]).toBe("Claude Code-credentials-abcd1234");
  });

  // `security` exits 44 for a keychain path with no keychain behind it
  // (measured, see `SECURITY_ITEM_NOT_FOUND_EXIT`), so that 44 must not count.
  test("a pinned-only lookup with no keychain file is not a sign-out", async () => {
    for (const make of [
      async () => fs.rm(pinnedKeychain()),
      async () => fs.writeFile(pinnedKeychain(), ""),
      async () => fs.writeFile(pinnedKeychain(), "not a keychain file at all"),
      async () => {
        await fs.rm(pinnedKeychain());
        await fs.mkdir(pinnedKeychain());
      },
    ]) {
      await fs.rm(pinnedKeychain(), { recursive: true, force: true });
      await writeKeychainFile();
      await make();
      const probe = keychain(["absent"]);
      expect(await hostClaudeSignedOut("darwin", home, undefined, {}, probe.probe)).toBe(false);
      expect(probe.calls).toEqual([]);
    }
  });

  test("with no pinned keychain file the default search list alone decides", async () => {
    await fs.rm(pinnedKeychain());
    const absent = keychain(["absent"]);
    expect(
      await hostClaudeSignedOut(
        "darwin",
        home,
        undefined,
        { allowDefaultKeychainSearchList: true },
        absent.probe,
      ),
    ).toBe(true);
    expect(absent.calls).toEqual([["find-generic-password", "-s", "Claude Code-credentials"]]);
    expect(
      await hostClaudeSignedOut(
        "darwin",
        home,
        undefined,
        { allowDefaultKeychainSearchList: true },
        keychain(["present"]).probe,
      ),
    ).toBe(false);
  });
});

describe("isKeychainFile", () => {
  test("only a file starting with the keychain magic is a keychain", async () => {
    const file = path.join(root, "k.keychain-db");
    expect(await isKeychainFile(file)).toBe(false);
    await fs.writeFile(file, "kyc");
    expect(await isKeychainFile(file)).toBe(false);
    await fs.writeFile(file, "kych");
    expect(await isKeychainFile(file)).toBe(true);
    expect(await isKeychainFile(root)).toBe(false);
  });
});

/**
 * The real `security` against a keychain this test creates and deletes, in a
 * HOME of its own so the search-list change `create-keychain` makes lands
 * there. It never names a real keychain, and never looks a record up without
 * an explicit keychain path, which would search the user's login keychain.
 */
describe.skipIf(process.platform !== "darwin")("security against a temporary keychain", () => {
  const saved = { HOME: process.env.HOME, CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME };
  let keychainFile: string;

  function security(...args: string[]): void {
    execFileSync("security", args, { stdio: "ignore", env: { ...process.env } });
  }

  beforeEach(async () => {
    await fs.mkdir(path.join(home, "Library", "Preferences"), { recursive: true });
    await fs.mkdir(path.join(home, "Library", "Keychains"), { recursive: true });
    process.env.HOME = home;
    process.env.CFFIXED_USER_HOME = home;
    keychainFile = pinnedKeychain();
    security("create-keychain", "-p", "throwaway-not-a-secret", keychainFile);
  });

  afterEach(() => {
    try {
      security("delete-keychain", keychainFile);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("exit 44 means the record is missing, and a missing keychain answers 44 too", async () => {
    const service = `orkestrator-4580-probe-${process.pid}`;
    expect(await isKeychainFile(keychainFile)).toBe(true);
    const lookup = (file: string) =>
      probeKeychainItemCommand(["find-generic-password", "-s", service, file]);
    expect(await lookup(keychainFile)).toBe("absent");
    security("add-generic-password", "-s", service, "-a", "probe", "-w", "throwaway", keychainFile);
    expect(await lookup(keychainFile)).toBe("present");
    security("delete-generic-password", "-s", service, keychainFile);
    expect(await lookup(keychainFile)).toBe("absent");
    // Why the reading checks the file before trusting a 44.
    expect(await lookup(path.join(home, "Library", "Keychains", "absent.keychain-db"))).toBe(
      "absent",
    );
  });

  test("a pinned lookup reads signed out only while the keychain lacks Claude's record", async () => {
    expect(await hostClaudeSignedOut("darwin", home)).toBe(true);
    security(
      "add-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      "probe",
      "-w",
      "throwaway",
      keychainFile,
    );
    expect(await hostClaudeSignedOut("darwin", home)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("probeKeychainItemCommand", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  async function fakeSecurity(script: string): Promise<void> {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "security"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath ?? "/usr/bin:/bin"}`;
  }

  test("maps security's item-not-found status, and only that, to absent", async () => {
    await fakeSecurity("echo 'keychain: \"x\"'; exit 0");
    expect(await probeKeychainItemCommand(["find-generic-password"])).toBe("present");
    await fakeSecurity("echo 'security: The specified item could not be found.' >&2; exit 44");
    expect(await probeKeychainItemCommand(["find-generic-password"])).toBe("absent");
    // A locked keychain or any other failure. (A missing keychain file
    // answers 44 itself; `hostClaudeSignedOut` checks the file first.)
    await fakeSecurity("exit 51");
    expect(await probeKeychainItemCommand(["find-generic-password"])).toBe("unknown");
    await fakeSecurity("exit 50");
    expect(await probeKeychainItemCommand(["find-generic-password"])).toBe("unknown");
  });

  test("a lookup that times out is unknown, never absent", async () => {
    await fakeSecurity("sleep 5; exit 44");
    expect(await probeKeychainItemCommand(["find-generic-password"], 100)).toBe("unknown");
  });
});
