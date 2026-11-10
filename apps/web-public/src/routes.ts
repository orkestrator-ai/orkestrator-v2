/** The backend connection page. */
export const CONNECT_PATH = "/connect";

/** The plain-language summaries of recent releases. */
export const RELEASES_PATH = "/releases";

/** Every other path on the public site is the landing page. */
export type PublicPage = "connect" | "releases" | "landing";

function trimTrailingSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

export function isConnectPath(pathname: string): boolean {
  return trimTrailingSlashes(pathname) === CONNECT_PATH;
}

export function isReleasesPath(pathname: string): boolean {
  return trimTrailingSlashes(pathname) === RELEASES_PATH;
}

export function publicPageFor(pathname: string): PublicPage {
  if (isConnectPath(pathname)) return "connect";
  if (isReleasesPath(pathname)) return "releases";
  return "landing";
}
