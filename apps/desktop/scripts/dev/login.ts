import { readFile } from "node:fs/promises";

import type { RuntimeStatusManifest } from "../../electron/runtime-profile.js";

export type AgentTestLogin = {
  profile: string;
  browserUrl: string;
  loginUrl: string;
  expiresAt: number;
  expiresInSeconds: number;
};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Mints a single-use browser login link for an isolated agent-test profile.
 *
 * The durable gateway token is read here, on the host, and travels no further
 * than the loopback mint request: what comes back — and what the caller may
 * hand to a browser — is a bootstrap code that the gateway destroys on first
 * use and expires within minutes. Anything that prints or stores the result is
 * therefore handling a spent credential, not the profile's real token.
 */
export async function mintAgentTestLoginUrl(options: {
  status: Pick<RuntimeStatusManifest, "profile" | "flavor" | "status" | "browserUrl" | "authFile">;
  fetchImpl?: Fetcher;
  readTokenFile?: (path: string) => Promise<string>;
}): Promise<AgentTestLogin> {
  const { status } = options;
  if (status.flavor !== "agent-test") {
    throw new Error(`Profile ${status.profile} is not an agent-test profile; refusing to mint a login link`);
  }
  if (status.status !== "ready") {
    throw new Error(`Profile ${status.profile} is ${status.status}; start it with bun run dev:test first`);
  }
  if (!status.browserUrl) throw new Error(`Profile ${status.profile} has no browser gateway URL`);
  if (!status.authFile) throw new Error(`Profile ${status.profile} has no gateway auth file`);

  const read = options.readTokenFile ?? ((filePath: string) => readFile(filePath, "utf8"));
  const parsed = JSON.parse(await read(status.authFile)) as { token?: unknown };
  if (typeof parsed.token !== "string" || !parsed.token) {
    throw new Error(`Gateway auth file is invalid: ${status.authFile}`);
  }

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(new URL("/__orkestrator/agent-test/bootstrap", status.browserUrl).href, {
    method: "POST",
    headers: { authorization: `Bearer ${parsed.token}` },
  });
  if (!response.ok) {
    throw new Error(`Gateway refused to mint a login link (HTTP ${response.status})`);
  }
  const minted = await response.json() as { code?: unknown; expiresAt?: unknown };
  if (typeof minted.code !== "string" || typeof minted.expiresAt !== "number") {
    throw new Error("Gateway returned an unexpected bootstrap response");
  }

  const loginUrl = new URL("/__orkestrator/agent-test/login", status.browserUrl);
  loginUrl.searchParams.set("code", minted.code);
  return {
    profile: status.profile,
    browserUrl: status.browserUrl,
    loginUrl: loginUrl.href,
    expiresAt: minted.expiresAt,
    expiresInSeconds: Math.max(0, Math.round((minted.expiresAt - Date.now()) / 1000)),
  };
}

export function formatAgentTestLogin(login: AgentTestLogin): string {
  return [
    `Profile: ${login.profile}`,
    `Login URL (single use, expires in ${login.expiresInSeconds}s):`,
    login.loginUrl,
    "Open it in the browser under test. It signs that browser in and redirects to the app.",
    "The gateway token itself is never in this URL; mint a new link if this one expires.",
  ].join("\n");
}
