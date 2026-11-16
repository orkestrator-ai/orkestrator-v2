import path from "node:path";

/**
 * Where the public-site suite builds the hosted client, outside
 * apps/web-public/dist: the aggregate suite's Turbo build writes that
 * directory, and review validation runs the two concurrently. Shared by the
 * Playwright config, which builds and serves it, and the specs that inspect
 * the built output.
 */
export const publicSiteDistDirectory = path.resolve(
  import.meta.dirname,
  "../../output/playwright/public-site-dist",
);
