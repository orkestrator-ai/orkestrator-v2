import {
  GitHubApiError,
  githubRequest,
  isRecord,
  optionalString,
  type GitHubFetch,
  type GitHubRequestSubject,
} from "./github.js";

const MAX_GRAPHQL_ERROR_LENGTH = 300;

function graphqlErrorCode(type: string | undefined): GitHubApiError["code"] {
  switch (type) {
    case "NOT_FOUND":
      return "not-found";
    case "FORBIDDEN":
    case "INSUFFICIENT_SCOPES":
      return "permission";
    case "RATE_LIMITED":
      return "rate-limit";
    case "UNPROCESSABLE":
    case "ARGUMENT_ERROR":
      return "validation";
    default:
      return "github";
  }
}

function graphqlErrorStatus(code: GitHubApiError["code"]): number | undefined {
  switch (code) {
    case "not-found":
      return 404;
    case "permission":
      return 403;
    case "rate-limit":
      return 429;
    case "validation":
      return 422;
    default:
      return undefined;
  }
}

/**
 * POST a GraphQL document to api.github.com. GitHub answers GraphQL failures
 * with HTTP 200 and an `errors` array; the first error becomes a
 * `GitHubApiError` whose code mirrors the REST mapping. Error text is GitHub's
 * own message with URLs stripped, never the query or variables.
 */
export async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  operation: string,
  fetchImpl: GitHubFetch = fetch,
  subject: GitHubRequestSubject = "pull-request",
): Promise<T> {
  const { data: payload } = await githubRequest<unknown>(
    token,
    "/graphql",
    operation,
    { method: "POST", body: JSON.stringify({ query, variables }) },
    fetchImpl,
    { subject },
  );
  if (!isRecord(payload)) {
    throw new GitHubApiError(
      `GitHub returned an invalid response while trying to ${operation}. Try again.`,
    );
  }
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (errors.length > 0) {
    const first: unknown = errors[0];
    const type = isRecord(first) ? optionalString(first.type) : undefined;
    const rawMessage = isRecord(first) ? optionalString(first.message) : undefined;
    const detail = rawMessage
      ?.replace(/https?:\/\/\S+/g, "GitHub documentation")
      .slice(0, MAX_GRAPHQL_ERROR_LENGTH);
    const code = graphqlErrorCode(type);
    const message =
      code === "rate-limit"
        ? "GitHub rate limit reached. Wait a moment and try again."
        : `GitHub could not ${operation}${detail ? `: ${detail}` : ". Try again."}`;
    throw new GitHubApiError(message, { code, status: graphqlErrorStatus(code), detail });
  }
  if (!isRecord(payload.data)) {
    throw new GitHubApiError(
      `GitHub returned an invalid response while trying to ${operation}. Try again.`,
    );
  }
  return payload.data as T;
}
