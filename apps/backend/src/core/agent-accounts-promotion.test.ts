import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as shell from "./shell.js";
import { claudeKeychainService } from "./agent-accounts-homes.js";
import { promoteClaudeLogin } from "./agent-accounts-promotion.js";

let root: string;
let source: string;
let destination: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-promotion-"));
  source = path.join(root, "temporary");
  destination = path.join(root, "account");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await fs.writeFile(
    path.join(source, ".credentials.json"),
    '{"claudeAiOauth":{"refreshToken":"new-fixture"}}',
  );
  await fs.writeFile(path.join(source, ".claude.json"), '{"oauthAccount":{"accountUuid":"new"}}');
  await fs.writeFile(
    path.join(destination, ".credentials.json"),
    '{"claudeAiOauth":{"refreshToken":"old-fixture"}}',
  );
  await fs.writeFile(
    path.join(destination, ".claude.json"),
    '{"oauthAccount":{"accountUuid":"old"},"projects":{"keep":{}}}',
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin")(
  "Keychain promotion uses private stdin and rolls back when registry persistence fails",
  async () => {
    const service = claudeKeychainService(destination);
    const previousKeychain = '{"claudeAiOauth":{"refreshToken":"old-keychain-fixture"}}';
    const writes: string[] = [];
    const run = spyOn(shell, "runCommand").mockImplementation(
      async (command, args = [], options) => {
        expect(command).toBe("security");
        if (args[0] === "find-generic-password") {
          if (args.includes(service)) return { stdout: previousKeychain, stderr: "" };
          throw Object.assign(new Error("not found"), { exitCode: 44 });
        }
        expect(args).toEqual(["-i"]);
        expect(options?.redactValues?.length).toBe(2);
        writes.push(String(options?.stdin));
        return { stdout: "", stderr: "" };
      },
    );
    const previousFiles = await Promise.all(
      [".credentials.json", ".claude.json"].map((file) =>
        fs.readFile(path.join(destination, file), "utf8"),
      ),
    );
    try {
      await expect(
        promoteClaudeLogin(
          source,
          destination,
          path.join(destination, ".claude.json"),
          true,
          async (promote) => {
            await promote();
            throw new Error("registry unavailable");
          },
        ),
      ).rejects.toThrow("registry unavailable");
      expect(writes).toHaveLength(2);
      expect(writes[0]).toContain("new-fixture");
      expect(writes[1]).toContain("old-keychain-fixture");
      expect(
        await Promise.all(
          [".credentials.json", ".claude.json"].map((file) =>
            fs.readFile(path.join(destination, file), "utf8"),
          ),
        ),
      ).toEqual(previousFiles);
    } finally {
      run.mockRestore();
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "a Keychain update failure restores files and reports a content-free error",
  async () => {
    const writes: string[] = [];
    const run = spyOn(shell, "runCommand").mockImplementation(
      async (_command, args = [], options) => {
        if (args[0] === "find-generic-password") {
          if (args.includes(claudeKeychainService(destination)))
            return {
              stdout: '{"claudeAiOauth":{"refreshToken":"old-keychain-fixture"}}',
              stderr: "",
            };
          throw Object.assign(new Error("not found"), { exitCode: 44 });
        }
        writes.push(String(options?.stdin));
        return {
          stdout: "",
          stderr:
            writes.length === 1 ? "SecKeychainItemModifyAttributesAndData: denied new-fixture" : "",
        };
      },
    );
    try {
      await expect(
        promoteClaudeLogin(
          source,
          destination,
          path.join(destination, ".claude.json"),
          true,
          async (promote) => promote(),
        ),
      ).rejects.toThrow("Unable to save the renewed login to Keychain");
      expect(writes).toHaveLength(2);
      expect(await fs.readFile(path.join(destination, ".credentials.json"), "utf8")).toContain(
        "old-fixture",
      );
    } finally {
      run.mockRestore();
    }
  },
);
