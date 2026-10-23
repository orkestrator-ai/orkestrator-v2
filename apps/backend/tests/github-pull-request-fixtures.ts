import { createGitHubConditionalCache } from "../src/core/github-pull-requests";

export const TOKEN = "github_pat_pull_request_secret";
export const HEAD_SHA = "a".repeat(40);
export const REF = { owner: "acme", repo: "repo", number: 7 } as const;

export type FakeRequest = {
  method: string;
  url: URL;
  body: Record<string, unknown> | null;
  headers: Headers;
};

type Handler = (request: FakeRequest) => Response | Promise<Response>;
/** A static JSON body, or a handler for dynamic responses. */
type Route = Handler | Record<string, unknown> | unknown[];

export function json(
  payload: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
}

/**
 * In-memory api.github.com: REST routes keyed by `METHOD /path` (query
 * ignored) and GraphQL routes keyed by the operation name in the document.
 */
export function createFakeGitHub() {
  const routes = new Map<string, Handler>();
  const graphqlRoutes = new Map<string, Handler>();
  const requests: FakeRequest[] = [];
  const unexpected: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const request: FakeRequest = { method, url, body, headers: new Headers(init?.headers) };
    requests.push(request);
    let handler: Handler | undefined;
    let label = `${method} ${url.pathname}`;
    if (url.pathname === "/graphql") {
      const name = /(?:query|mutation)\s+(\w+)/.exec(String(body?.query))?.[1] ?? "";
      label = `graphql ${name}`;
      handler = graphqlRoutes.get(name);
    } else {
      handler = routes.get(label);
    }
    if (!handler) {
      unexpected.push(`${label}${url.search}`);
      return json({ message: "Not Found" }, { status: 404 });
    }
    return handler(request);
  };
  const fetchImpl = Object.assign(impl, { preconnect: fetch.preconnect }) as typeof fetch;
  const cache = createGitHubConditionalCache();
  return {
    fetchImpl,
    cache,
    options: { fetchImpl, cache },
    requests,
    unexpected,
    on(method: string, path: string, handler: Route) {
      routes.set(
        `${method} ${path}`,
        typeof handler === "function" ? (handler as Handler) : () => json(handler),
      );
    },
    onGraphql(name: string, handler: Route) {
      graphqlRoutes.set(
        name,
        typeof handler === "function" ? (handler as Handler) : () => json({ data: handler }),
      );
    },
    requestsTo(method: string, path: string): FakeRequest[] {
      return requests.filter(
        (request) => request.method === method && request.url.pathname === path,
      );
    },
  };
}

export function apiUser(login: string) {
  return {
    login,
    avatar_url: `https://avatars.example/${login}`,
    html_url: `https://github.com/${login}`,
  };
}

export function apiPull(overrides: Record<string, unknown> = {}) {
  return {
    number: REF.number,
    node_id: "PR_node7",
    title: "Add widgets",
    body: "Body",
    html_url: "https://github.com/acme/repo/pull/7",
    state: "open",
    draft: false,
    merged: false,
    merged_at: null,
    closed_at: null,
    merged_by: null,
    user: apiUser("author"),
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    head: { ref: "feature/widgets", sha: HEAD_SHA, repo: { full_name: "acme/repo" } },
    base: { ref: "main", repo: { full_name: "acme/repo" } },
    additions: 10,
    deletions: 2,
    changed_files: 2,
    commits: 3,
    comments: 1,
    review_comments: 2,
    labels: [{ name: "bug", color: "ff0000", description: "Broken" }],
    assignees: [apiUser("ann")],
    requested_reviewers: [apiUser("rita")],
    requested_teams: [{ slug: "core" }],
    mergeable_state: "blocked",
    ...overrides,
  };
}

export function apiRepository(overrides: Record<string, unknown> = {}) {
  return {
    full_name: "acme/repo",
    html_url: "https://github.com/acme/repo",
    permissions: { push: true },
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: false,
    ...overrides,
  };
}

/** Routes every read `getGitHubPullRequest` makes, with sensible defaults. */
export function routePullRequestDetail(
  fake: ReturnType<typeof createFakeGitHub>,
  overrides: {
    pull?: Record<string, unknown>;
    reviews?: unknown[];
    comments?: unknown[];
    repository?: Record<string, unknown>;
    viewer?: string;
  } = {},
) {
  fake.on("GET", "/repos/acme/repo/pulls/7", apiPull(overrides.pull));
  fake.on("GET", "/repos/acme/repo/pulls/7/reviews", overrides.reviews ?? []);
  fake.on("GET", "/repos/acme/repo/issues/7/comments", overrides.comments ?? []);
  fake.on("GET", "/repos/acme/repo", apiRepository(overrides.repository));
  fake.on("GET", "/user", apiUser(overrides.viewer ?? "viewer"));
  fake.on("GET", `/repos/acme/repo/commits/${HEAD_SHA}/check-runs`, {
    total_count: 0,
    check_runs: [],
  });
  fake.on("GET", `/repos/acme/repo/commits/${HEAD_SHA}/status`, { state: "pending", statuses: [] });
}
