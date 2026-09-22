import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export const GITHUB_CREDENTIAL_FILE_ENV = "ORKESTRATOR_GITHUB_CREDENTIAL_FILE";
/** Read by the official GitHub plugin's MCP `Authorization` header. */
export const GITHUB_MCP_TOKEN_ENV = "GITHUB_PERSONAL_ACCESS_TOKEN";

type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;
type ReadGitHubCliToken = (env: NodeJS.ProcessEnv) => Promise<string | undefined>;

const execFileAsync = promisify(execFile);

async function readGitHubCliToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      env,
      timeout: 10_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the environment for one Claude Agent SDK query.
 *
 * Container bridges receive an owner-only credential-file path while keeping
 * their own process environment credential-free. Reading the file per query
 * makes rotations and clearing authoritative without restarting the bridge or
 * exposing the token to title/model helper processes. Local bridges have no
 * managed file configured and retain their ordinary host environment.
 *
 * When `GITHUB_PERSONAL_ACCESS_TOKEN` is unset it falls back to the resolved
 * GitHub token, and on local bridges to `gh auth token`, so the GitHub MCP
 * plugin authenticates as the same identity the `gh` CLI already uses.
 */
export async function runtimeEnvironmentForAgentQuery(
  env: NodeJS.ProcessEnv = process.env,
  readTextFile: ReadTextFile = readFile,
  readGhToken: ReadGitHubCliToken = readGitHubCliToken,
): Promise<NodeJS.ProcessEnv> {
  const snapshot = { ...env };
  const credentialFile = env[GITHUB_CREDENTIAL_FILE_ENV]?.trim();
  if (!credentialFile) {
    if (!snapshot[GITHUB_MCP_TOKEN_ENV]?.trim()) {
      const token =
        snapshot.GITHUB_TOKEN?.trim() || snapshot.GH_TOKEN?.trim() || (await readGhToken(snapshot));
      if (token) snapshot[GITHUB_MCP_TOKEN_ENV] = token;
    }
    return snapshot;
  }

  let token = "";
  try {
    token = (await readTextFile(credentialFile, "utf8")).trim();
  } catch {
    // A configured file is authoritative. Missing or unreadable state means
    // the child must not retain an inherited credential.
  }

  if (token) {
    snapshot.GITHUB_TOKEN = token;
    snapshot.GH_TOKEN = token;
    if (!snapshot[GITHUB_MCP_TOKEN_ENV]?.trim()) snapshot[GITHUB_MCP_TOKEN_ENV] = token;
  } else {
    delete snapshot.GITHUB_TOKEN;
    delete snapshot.GH_TOKEN;
  }
  return snapshot;
}
