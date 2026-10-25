import { gitHubCli } from "./github-cli-binary.js";
import { gitHubCliEnv } from "./github-credentials.js";
import { isGitRemoteUrl } from "@orkestrator/protocol/git-remote-url";
import {
  compareGitHubNames,
  GITHUB_CLONE_REPOSITORY_PAGE_SIZE,
  isGitHubLogin,
  type GitHubCloneAccount,
  type GitHubCloneRepository,
  type GitHubCloneRepositoryList,
} from "@orkestrator/protocol/github-clone";
import { CommandFailedError, type runCommand } from "./shell.js";
import { conciseError } from "./commands-error-text.js";

const GITHUB_HOST = "github.com";
const GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_REPOSITORY_LIST_TIMEOUT_MS = 90_000;
const DESCRIPTION_MAX_CHARS = 300;
const REPOSITORY_QUERY = `query($owner: String!, $endCursor: String) {
  repositoryOwner(login: $owner) {
    repositories(first: 100, after: $endCursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes { name nameWithOwner description isPrivate isFork isArchived pushedAt updatedAt url sshUrl }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const CURSOR_MAX_CHARS = 512;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;

function gitHubCliError(action: string, error: unknown): Error {
  if (error instanceof CommandFailedError && error.executableMissing) {
    return new Error(
      "GitHub CLI is not available. Set it up under GitHub authentication in Settings, then retry",
    );
  }
  return new Error(`Could not ${action}: ${conciseError(error)}`);
}

function outputLogins(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(isGitHubLogin);
}

/**
 * The signed-in GitHub CLI user and the organizations they belong to, sorted
 * by name. The user's own account is always included, and every organization
 * page is fetched so none are left out.
 */
export async function listGitHubCloneAccounts(
  run: typeof runCommand,
): Promise<GitHubCloneAccount[]> {
  let viewer: string[];
  let organizations: string[];
  try {
    const env = await gitHubCliEnv();
    [viewer, organizations] = await Promise.all([
      run(gitHubCli(), ["api", "--hostname", GITHUB_HOST, "user", "--jq", ".login"], {
        timeoutMs: GITHUB_API_TIMEOUT_MS,
        env,
      }).then(({ stdout }) => outputLogins(stdout)),
      run(
        gitHubCli(),
        [
          "api",
          "--hostname",
          GITHUB_HOST,
          "--paginate",
          "user/orgs?per_page=100",
          "--jq",
          ".[].login",
        ],
        { timeoutMs: GITHUB_API_TIMEOUT_MS, env },
      ).then(({ stdout }) => outputLogins(stdout)),
    ]);
  } catch (error) {
    throw gitHubCliError("list your GitHub organizations", error);
  }

  const login = viewer[0];
  if (!login) throw new Error("Could not determine the signed-in GitHub account");

  const seen = new Set([login.toLowerCase()]);
  const accounts: GitHubCloneAccount[] = [{ login, kind: "user" }];
  for (const organization of organizations) {
    const key = organization.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ login: organization, kind: "organization" });
  }
  return accounts.sort((left, right) => compareGitHubNames(left.login, right.login));
}

async function preferredGitProtocol(run: typeof runCommand): Promise<"ssh" | "https"> {
  try {
    const { stdout } = await run(
      gitHubCli(),
      ["config", "get", "git_protocol", "--host", GITHUB_HOST],
      {
        timeoutMs: GITHUB_API_TIMEOUT_MS,
      },
    );
    return stdout.trim() === "ssh" ? "ssh" : "https";
  } catch {
    return "https";
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function latestTimestamp(...values: unknown[]): string | null {
  let latest: { value: string; time: number } | null = null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value ?? null;
}

function parseRepository(value: unknown, protocol: "ssh" | "https"): GitHubCloneRepository | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = optionalString(record.name);
  const fullName = optionalString(record.nameWithOwner);
  const httpsUrl = optionalString(record.url);
  const sshUrl = optionalString(record.sshUrl);
  if (!name || !fullName) return null;

  const cloneUrl = protocol === "ssh" && sshUrl ? sshUrl : httpsUrl ? `${httpsUrl}.git` : null;
  if (!cloneUrl || !isGitRemoteUrl(cloneUrl)) return null;

  const description = optionalString(record.description);
  return {
    name,
    fullName,
    description:
      description && description.length > DESCRIPTION_MAX_CHARS
        ? `${description.slice(0, DESCRIPTION_MAX_CHARS)}…`
        : description,
    isPrivate: record.isPrivate === true,
    isFork: record.isFork === true,
    isArchived: record.isArchived === true,
    updatedAt: latestTimestamp(record.pushedAt, record.updatedAt),
    cloneUrl,
  };
}

/** One bounded page of repositories owned by a GitHub user or organization. */
export async function listGitHubCloneRepositories(
  owner: string,
  run: typeof runCommand,
  cursor?: string,
): Promise<GitHubCloneRepositoryList> {
  if (!isGitHubLogin(owner)) throw new Error("Invalid GitHub account name");
  if (cursor !== undefined && (!cursor || cursor.length > CURSOR_MAX_CHARS)) {
    throw new Error("Invalid GitHub repository cursor");
  }
  const env = await gitHubCliEnv();
  const [protocol, stdout] = await Promise.all([
    preferredGitProtocol(run),
    run(
      gitHubCli(),
      [
        "api",
        "--hostname",
        GITHUB_HOST,
        "graphql",
        "-f",
        `query=${REPOSITORY_QUERY}`,
        "-f",
        `owner=${owner}`,
        ...(cursor === undefined ? [] : ["-f", `endCursor=${cursor}`]),
      ],
      { timeoutMs: GITHUB_REPOSITORY_LIST_TIMEOUT_MS, env },
    ).then(
      (result) => result.stdout,
      (error: unknown) => {
        throw gitHubCliError(`list repositories for ${owner}`, error);
      },
    ),
  ]);
  if (Buffer.byteLength(stdout) > PAGE_MAX_BYTES) {
    throw new Error(
      `Could not list repositories for ${owner}: GitHub CLI output exceeded the page limit`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not list repositories for ${owner}: GitHub CLI returned invalid JSON`);
  }
  const page = parsed?.data?.repositoryOwner?.repositories;
  const info = page?.pageInfo;
  if (
    parsed?.errors ||
    !Array.isArray(page?.nodes) ||
    page.nodes.length > GITHUB_CLONE_REPOSITORY_PAGE_SIZE ||
    typeof info?.hasNextPage !== "boolean" ||
    (info.hasNextPage &&
      (typeof info.endCursor !== "string" ||
        !info.endCursor ||
        info.endCursor.length > CURSOR_MAX_CHARS ||
        info.endCursor === cursor))
  ) {
    throw new Error(`Could not list repositories for ${owner}: unexpected GitHub CLI output`);
  }
  return {
    repositories: page.nodes
      .map((entry: unknown) => parseRepository(entry, protocol))
      .filter(
        (repository: GitHubCloneRepository | null): repository is GitHubCloneRepository =>
          repository !== null,
      ),
    truncated: info.hasNextPage,
    ...(info.hasNextPage ? { nextCursor: info.endCursor as string } : {}),
  };
}
