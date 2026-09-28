/** Account bound to each live local Claude or Codex bridge process. */
export const localAgentAccountIds = new Map<string, string>();

/** Expiry of a short-lived token handed to a coordinator Claude bridge. */
export const localAgentAccountTokenExpiry = new Map<string, number>();
