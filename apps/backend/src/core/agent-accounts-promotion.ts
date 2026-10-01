import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeKeychainService } from "./agent-accounts-homes.js";
import { readAddedClaudeCredentials } from "./agent-accounts-active.js";
import { runCommand } from "./shell.js";

const MAX_LOGIN_BYTES = 8 * 1024 * 1024;

async function readFile(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_LOGIN_BYTES) throw new Error("Invalid login file");
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("Invalid login metadata");
  }
}

async function restoreFile(file: string, value: string | undefined): Promise<void> {
  if (value === undefined) await fs.rm(file, { force: true });
  else {
    const temporary = `${file}.reauth`;
    await fs.writeFile(temporary, value, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
}

async function keychainPassword(service: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    return (
      await runCommand("security", ["find-generic-password", "-s", service, "-w"], {
        timeoutMs: 10_000,
      })
    ).stdout.trim();
  } catch (error) {
    // security's item-not-found status; other failures must not erase a login.
    if ((error as { exitCode?: number }).exitCode === 44) return undefined;
    throw new Error("Unable to read the previous login from Keychain");
  }
}

async function writeKeychain(service: string, value: string): Promise<void> {
  // security's interactive parser uses double quotes, not shell expansion.
  // Pass the secret on stdin so it never appears in process arguments or logs.
  const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  // Compact the JSON so a pretty-printed credential cannot introduce another
  // interactive command line. JSON escapes any embedded newlines.
  value = JSON.stringify(parseObject(value));
  const stdin = `add-generic-password -U -s ${quote(service)} -a ${quote(os.userInfo().username)} -w ${quote(value)}\n`;
  try {
    const result = await runCommand("security", ["-i"], {
      stdin,
      timeoutMs: 10_000,
      redactValues: [value, stdin],
    });
    // Interactive security may exit zero even when a subcommand failed.
    if (/SecKeychain|error:/i.test(result.stderr)) throw new Error("Keychain update failed");
  } catch {
    throw new Error("Unable to save the renewed login to Keychain");
  }
}

/** Promote only after validation; restore both files and Keychain on store failure. */
export async function promoteClaudeLogin(
  source: string,
  destination: string,
  jsonPath: string,
  added: boolean,
  commit: (promote: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const credentials = await readAddedClaudeCredentials(source);
  if (!credentials || Buffer.byteLength(credentials) > MAX_LOGIN_BYTES)
    throw new Error("Invalid renewed login");
  const credentialPath = path.join(destination, ".credentials.json");
  const previousCredential = await readFile(credentialPath);
  const previousJson = await readFile(jsonPath);
  const nextJson = await readFile(path.join(source, ".claude.json"));
  const service = claudeKeychainService(
    added ? destination : process.env.CLAUDE_CONFIG_DIR?.trim() || undefined,
  );
  const previousKeychain = await keychainPassword(service);
  let promoted = false;
  try {
    await commit(async () => {
      promoted = true;
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      // Preserve existing project settings and replace only the login identity.
      const identity = parseObject(nextJson ?? "{}").oauthAccount;
      await restoreFile(
        jsonPath,
        JSON.stringify({ ...parseObject(previousJson ?? "{}"), oauthAccount: identity }),
      );
      await restoreFile(credentialPath, credentials);
      if (previousKeychain !== undefined) await writeKeychain(service, credentials);
    });
  } catch (error) {
    if (promoted) {
      await restoreFile(credentialPath, previousCredential);
      await restoreFile(jsonPath, previousJson);
      if (previousKeychain !== undefined) await writeKeychain(service, previousKeychain);
    }
    throw error;
  }
}

export async function removeTemporaryClaudeLogin(home: string): Promise<void> {
  await fs.rm(home, { recursive: true, force: true });
  if (process.platform === "darwin") {
    await runCommand("security", ["delete-generic-password", "-s", claudeKeychainService(home)], {
      timeoutMs: 10_000,
    }).catch(() => undefined);
  }
}
