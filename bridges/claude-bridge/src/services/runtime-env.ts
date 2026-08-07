import { readFile } from "node:fs/promises";

export const GITHUB_CREDENTIAL_FILE_ENV = "ORKESTRATOR_GITHUB_CREDENTIAL_FILE";

type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;

/**
 * Build the environment for one Claude Agent SDK query.
 *
 * Container bridges receive an owner-only credential-file path while keeping
 * their own process environment credential-free. Reading the file per query
 * makes rotations and clearing authoritative without restarting the bridge or
 * exposing the token to title/model helper processes. Local bridges have no
 * managed file configured and retain their ordinary host environment.
 */
export async function runtimeEnvironmentForAgentQuery(
  env: NodeJS.ProcessEnv = process.env,
  readTextFile: ReadTextFile = readFile,
): Promise<NodeJS.ProcessEnv> {
  const snapshot = { ...env };
  const credentialFile = env[GITHUB_CREDENTIAL_FILE_ENV]?.trim();
  if (!credentialFile) return snapshot;

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
  } else {
    delete snapshot.GITHUB_TOKEN;
    delete snapshot.GH_TOKEN;
  }
  return snapshot;
}
