import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  nativeAgentWithholdsGitHubCredential,
  withheldGitHubCredentialEnvironment,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

export const GITHUB_CREDENTIAL_FILE_ENV = "ORKESTRATOR_GITHUB_CREDENTIAL_FILE";
/** Read by the official GitHub plugin's MCP `Authorization` header. */
export const GITHUB_MCP_TOKEN_ENV = "GITHUB_PERSONAL_ACCESS_TOKEN";

type ReadTextFile = (path: string, encoding: "utf8") => Promise<string>;
type ReadGitHubCliToken = (env: NodeJS.ProcessEnv) => Promise<string | undefined>;

const execFileAsync = promisify(execFile);
const GH_TOKEN_TIMEOUT_MS = 2_000;
const GH_TOKEN_CACHE_MS = 5 * 60_000;
const GH_TOKEN_FAILURE_CACHE_MS = 15_000;
type CachedGhToken = { expiresAt: number; value: Promise<string | undefined> };
const ghTokenCache = new WeakMap<ReadGitHubCliToken, Map<string, CachedGhToken>>();

export async function readGitHubCliToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      env,
      timeout: GH_TOKEN_TIMEOUT_MS,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function cachedGitHubCliToken(
  env: NodeJS.ProcessEnv,
  reader: ReadGitHubCliToken,
): Promise<string | undefined> {
  // A local login changes rarely. Keep separate entries for the configuration
  // locations that can select a different gh account in the same process.
  const key = JSON.stringify([env.PATH, env.HOME, env.XDG_CONFIG_HOME, env.GH_CONFIG_DIR]);
  let entries = ghTokenCache.get(reader);
  if (!entries) {
    entries = new Map();
    ghTokenCache.set(reader, entries);
  }
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (!cached && entries.size >= 8) entries.clear();

  const value = Promise.resolve()
    .then(() => reader(env))
    .catch(() => undefined)
    .then((token) => {
      if (entries.get(key)?.value === value) {
        entries.set(key, {
          value: Promise.resolve(token),
          expiresAt: Date.now() + (token ? GH_TOKEN_CACHE_MS : GH_TOKEN_FAILURE_CACHE_MS),
        });
      }
      return token;
    });
  entries.set(key, { value, expiresAt: now + GH_TOKEN_TIMEOUT_MS });
  return value;
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
 * On local bridges, an explicit MCP token wins. Otherwise GH_TOKEN takes
 * precedence over GITHUB_TOKEN, matching gh's github.com resolution, with a
 * bounded cached `gh auth token` lookup as the final fallback.
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
        snapshot.GH_TOKEN?.trim() ||
        snapshot.GITHUB_TOKEN?.trim() ||
        (await cachedGitHubCliToken(snapshot, readGhToken));
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
    snapshot[GITHUB_MCP_TOKEN_ENV] = token;
  } else {
    delete snapshot.GITHUB_TOKEN;
    delete snapshot.GH_TOKEN;
    delete snapshot[GITHUB_MCP_TOKEN_ENV];
  }
  return snapshot;
}

let withheldGhConfigDir: Promise<string> | undefined;

/** An empty `gh` configuration directory for sessions that must not see the stored login. */
function emptyGhConfigDir(): Promise<string> {
  withheldGhConfigDir ??= mkdtemp(path.join(tmpdir(), "orkestrator-gh-withheld-")).catch(
    (error: unknown) => {
      withheldGhConfigDir = undefined;
      throw error;
    },
  );
  return withheldGhConfigDir;
}

/**
 * The environment for one query of a session with `policy`. A session whose
 * policy denies `github.write` (every graph agent node, item 209) gets no
 * GitHub credential at all: no token variables, no managed credential file
 * (it is not read), an empty `gh` configuration directory and reset Git
 * credential helpers (`withheldGitHubCredentialEnvironment`). The MCP token
 * is not resolved for it either, so the GitHub plugin cannot authenticate.
 * Every other session gets {@link runtimeEnvironmentForAgentQuery}.
 */
export async function runtimeEnvironmentForSessionQuery(
  policy: Pick<NativeAgentExecutionPolicy, "capabilityPolicy"> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    readTextFile?: ReadTextFile;
    readGhToken?: ReadGitHubCliToken;
    ghConfigDir?: () => Promise<string>;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  if (!nativeAgentWithholdsGitHubCredential(policy)) {
    return runtimeEnvironmentForAgentQuery(
      env,
      options.readTextFile ?? readFile,
      options.readGhToken ?? readGitHubCliToken,
    );
  }
  const ghConfigDir = await (options.ghConfigDir ?? emptyGhConfigDir)();
  return withheldGitHubCredentialEnvironment(env, { ghConfigDir }) as NodeJS.ProcessEnv;
}

/**
 * The longer 529 backoff for sessions nobody is watching (todo 1010).
 *
 * Claude Code retries an overload itself, up to `CLAUDE_CODE_MAX_RETRIES`
 * times; these two variables stretch only that wait, which the pinned CLI reads
 * for a 529 or an `overloaded_error` body and for nothing else. About 7.5
 * minutes in all rather than under 3, with the attempt count unchanged. A person in
 * a tab can retry by hand and would rather see the failure, so interactive
 * sessions keep the defaults. Never `CLAUDE_CODE_RETRY_WATCHDOG` or a higher
 * retry count: both also wait out usage and rate limits.
 */
export const UNATTENDED_OVERLOAD_RETRY_ENV = {
  CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS: "4000",
  CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS: "64000",
} as const;

/**
 * Adds {@link UNATTENDED_OVERLOAD_RETRY_ENV} for a `pipeline` session: Multi
 * Review, build stages and graph nodes. Takes the session's own policy, not the
 * turn's: a read-only turn replaces the policy it runs under, and a reviewer's
 * turns are exactly those. A value the user set keeps precedence.
 */
export function withUnattendedOverloadRetry(
  sessionPolicy: Pick<NativeAgentExecutionPolicy, "id"> | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (sessionPolicy?.id !== "pipeline") return environment;
  return { ...UNATTENDED_OVERLOAD_RETRY_ENV, ...environment };
}
