import { isGitRemoteUrl } from "@orkestrator/protocol/git-remote-url";
import {
  compareGitHubNames,
  GITHUB_CLONE_ACCOUNT_LIMIT,
  GITHUB_CLONE_REPOSITORY_LIMIT,
  isGitHubLogin,
  type GitHubCloneAccount,
  type GitHubCloneRepository,
  type GitHubCloneRepositoryList,
} from "@orkestrator/protocol/github-clone";
import { CommandFailedError, type runCommand } from "./commands-dependencies.js";
import { conciseError } from "./commands-error-text.js";

const GITHUB_HOST = "github.com";
const GITHUB_API_TIMEOUT_MS = 30_000;
const GITHUB_REPOSITORY_LIST_TIMEOUT_MS = 90_000;
const DESCRIPTION_MAX_CHARS = 300;
const REPOSITORY_FIELDS = [
  "name",
  "nameWithOwner",
  "description",
  "isPrivate",
  "isFork",
  "isArchived",
  "pushedAt",
  "updatedAt",
  "url",
  "sshUrl",
].join(",");

function gitHubCliError(action: string, error: unknown): Error {
  if (error instanceof CommandFailedError && error.executableMissing) {
    return new Error("GitHub CLI is not installed. Install gh and run `gh auth login`, then retry");
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
 * by name. The user's own account is always included.
 */
export async function listGitHubCloneAccounts(
  run: typeof runCommand,
): Promise<GitHubCloneAccount[]> {
  let viewer: string[];
  let organizations: string[];
  try {
    [viewer, organizations] = await Promise.all([
      run("gh", ["api", "--hostname", GITHUB_HOST, "user", "--jq", ".login"], {
        timeoutMs: GITHUB_API_TIMEOUT_MS,
      }).then(({ stdout }) => outputLogins(stdout)),
      run(
        "gh",
        [
          "api",
          "--hostname",
          GITHUB_HOST,
          "--paginate",
          "user/orgs?per_page=100",
          "--jq",
          ".[].login",
        ],
        { timeoutMs: GITHUB_API_TIMEOUT_MS },
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
    if (accounts.length >= GITHUB_CLONE_ACCOUNT_LIMIT) break;
    const key = organization.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ login: organization, kind: "organization" });
  }
  return accounts.sort((left, right) => compareGitHubNames(left.login, right.login));
}

async function preferredGitProtocol(run: typeof runCommand): Promise<"ssh" | "https"> {
  try {
    const { stdout } = await run("gh", ["config", "get", "git_protocol", "--host", GITHUB_HOST], {
      timeoutMs: GITHUB_API_TIMEOUT_MS,
    });
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

/** Repositories owned by one GitHub user or organization, in GitHub's order. */
export async function listGitHubCloneRepositories(
  owner: string,
  run: typeof runCommand,
): Promise<GitHubCloneRepositoryList> {
  if (!isGitHubLogin(owner)) throw new Error("Invalid GitHub account name");

  const [protocol, stdout] = await Promise.all([
    preferredGitProtocol(run),
    run(
      "gh",
      [
        "repo",
        "list",
        owner,
        // One past the limit reveals whether the listing was cut short.
        "--limit",
        String(GITHUB_CLONE_REPOSITORY_LIMIT + 1),
        "--json",
        REPOSITORY_FIELDS,
      ],
      {
        timeoutMs: GITHUB_REPOSITORY_LIST_TIMEOUT_MS,
        env: { ...process.env, GH_HOST: GITHUB_HOST },
      },
    ).then(
      (result) => result.stdout,
      (error: unknown) => {
        throw gitHubCliError(`list repositories for ${owner}`, error);
      },
    ),
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not list repositories for ${owner}: GitHub CLI returned invalid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Could not list repositories for ${owner}: unexpected GitHub CLI output`);
  }

  const repositories = parsed
    .slice(0, GITHUB_CLONE_REPOSITORY_LIMIT)
    .map((entry) => parseRepository(entry, protocol))
    .filter((repository): repository is GitHubCloneRepository => repository !== null);
  return { repositories, truncated: parsed.length > GITHUB_CLONE_REPOSITORY_LIMIT };
}
