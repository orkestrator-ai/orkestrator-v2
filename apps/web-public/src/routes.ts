/** The backend connection page. Everything else on the public site is the landing page. */
export const CONNECT_PATH = "/connect";

export function isConnectPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === CONNECT_PATH;
}
