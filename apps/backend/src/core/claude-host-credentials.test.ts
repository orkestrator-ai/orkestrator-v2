import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  hostClaudeSignedOut,
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

describe("hostClaudeSignedOut on macOS", () => {
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
    // A locked keychain, a missing keychain file or any other failure.
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
