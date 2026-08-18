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

export const AGENT_TEST_LOGIN_MINT_TIMEOUT_MS = 10_000;

/**
 * The durable token may only travel to the profile's own loopback gateway.
 * `localhost` / `127.0.0.1` / `::1` match what agent-test profiles bind;
 * anything else, including userinfo-shaped URLs, is refused before the auth
 * file is read.
 */
export function isLoopbackBrowserGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

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
  timeoutMs?: number;
}): Promise<AgentTestLogin> {
  const { status } = options;
  if (status.flavor !== "agent-test") {
    throw new Error(
      `Profile ${status.profile} is not an agent-test profile; refusing to mint a login link`,
    );
  }
  if (status.status !== "ready") {
    throw new Error(
      `Profile ${status.profile} is ${status.status}; start it with bun run dev:test first`,
    );
  }
  if (!status.browserUrl) throw new Error(`Profile ${status.profile} has no browser gateway URL`);
  if (!isLoopbackBrowserGatewayUrl(status.browserUrl)) {
    throw new Error(
      `Profile ${status.profile} browser gateway URL is not loopback; refusing to mint a login link`,
    );
  }
  if (!status.authFile) throw new Error(`Profile ${status.profile} has no gateway auth file`);

  const read = options.readTokenFile ?? ((filePath: string) => readFile(filePath, "utf8"));
  let parsed: { token?: unknown };
  try {
    parsed = JSON.parse(await read(status.authFile)) as { token?: unknown };
  } catch {
    throw new Error(`Gateway auth file is invalid: ${status.authFile}`);
  }
  if (typeof parsed.token !== "string" || !parsed.token) {
    throw new Error(`Gateway auth file is invalid: ${status.authFile}`);
  }

  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? AGENT_TEST_LOGIN_MINT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  let response: Response | null = null;
  let minted: { code?: unknown; expiresAt?: unknown };
  try {
    response = await Promise.race([
      fetchImpl(new URL("/__orkestrator/agent-test/bootstrap", status.browserUrl).href, {
        method: "POST",
        headers: { authorization: `Bearer ${parsed.token}` },
        redirect: "error",
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      throw new Error(`Gateway refused to mint a login link (HTTP ${response.status})`);
    }
    minted = await Promise.race([
      response.json() as Promise<{ code?: unknown; expiresAt?: unknown }>,
      deadline,
    ]);
  } catch (error) {
    if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
      void response?.body?.cancel().catch(() => undefined);
      throw new Error(`Timed out minting a login link for profile ${status.profile}`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (
    typeof minted.code !== "string" ||
    minted.code.length === 0 ||
    typeof minted.expiresAt !== "number" ||
    !Number.isFinite(minted.expiresAt)
  ) {
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
