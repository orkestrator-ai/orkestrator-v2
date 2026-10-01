/** Account bound to each live local Claude or Codex bridge process. */
export const localAgentAccountIds = new Map<string, string>();

/** Expiry of a short-lived token handed to a coordinator Claude bridge. */
export const localAgentAccountTokenExpiry = new Map<string, number>();

/**
 * Local bridges that were running when their account was signed in again. They
 * may be holding the old (or missing) login, so each is replaced once idle.
 * Cleared when the bridge is launched.
 */
export const staleLoginLocalBridges = new Set<string>();

/** In-process refresh hint; durable login generations and container markers recover missed hints after restart. */
export const staleLoginEnvironmentIds = new Set<string>();
