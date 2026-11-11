/**
 * Restricted-mode allowlist entries.
 *
 * Under network policy 3 an entry is an address, protocol and port tuple: a
 * bare domain allows HTTPS (TCP 443) to its addresses, and a domain with a
 * port allows exactly that port, `db.example.com:5432` over TCP or
 * `example.com:443/udp` over UDP. GitHub's published ranges allow TCP 443 and
 * 22 without an entry. `docker/firewall-domains.sh` parses the same syntax
 * inside the container.
 *
 * Earlier policies allow every port of an allowed address and do not accept a
 * port, so a container on one receives each entry's domain alone.
 */

export const DEFAULT_ALLOWLIST_PORT = 443;

/** Settings help for the allowlist editors. */
export const ALLOWLIST_ENTRY_HINT =
  "One per line. A domain allows HTTPS (port 443); name a port for anything else, such as db.example.com:5432, or example.com:443/udp for UDP. GitHub also allows SSH.";

/**
 * What the allowlist does not do, stated wherever it is edited (security
 * finding M12). Never claim that it prevents exfiltration: it limits
 * destinations, and an allowed service accepts what it is sent.
 */
export const ALLOWLIST_RESIDUAL_RISK =
  "The allowlist limits where a restricted container can connect, not what it sends: an allowed service such as GitHub, npm or a model provider's API accepts whatever an agent sends it, including to an account or key that is not yours. Containers from current images also check the name each connection and DNS lookup asks for, so other sites sharing an allowed address are refused. That check cannot see a name hidden inside encrypted traffic (an encrypted ClientHello, domain fronting), and UDP entries and protocols other than HTTPS and HTTP are checked by address only. On a port an entry names, a protocol where the client speaks first must end its first command with a newline: a first message of plain text without one is held, then refused after 30 seconds.";

export interface AllowlistEntry {
  domain: string;
  protocol: "tcp" | "udp";
  port: number;
}

const DOMAIN = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const ENTRY = /^([^:/]+)(?::([1-9][0-9]{0,4})(?:\/(tcp|udp))?)?$/;

/** An entry's domain, protocol and port; null when it is not a valid entry. */
export function parseAllowlistEntry(value: string): AllowlistEntry | null {
  const match = ENTRY.exec(value.trim());
  if (!match || !DOMAIN.test(match[1]!)) return null;
  const port = match[2] === undefined ? DEFAULT_ALLOWLIST_PORT : Number(match[2]);
  if (port > 65535) return null;
  return { domain: match[1]!, protocol: match[3] === "udp" ? "udp" : "tcp", port };
}

/** The domain an entry names, without its port. */
export function allowlistEntryDomain(value: string): string {
  const separator = value.indexOf(":");
  return separator === -1 ? value : value.slice(0, separator);
}

/**
 * The list a container on `policyVersion` receives: every entry for policy 3,
 * and each domain once for earlier policies, which open every port anyway.
 */
export function allowlistForNetworkPolicy(
  entries: readonly string[],
  policyVersion: number,
): string[] {
  if (policyVersion >= 3) return [...entries];
  return [...new Set(entries.map(allowlistEntryDomain))];
}

/**
 * The global allowlist a new install persists, and the one canonical default
 * list. The renderer seeds its unloaded config from it, and the image's
 * firewall fallback (`docker/default-allowed-domains`, used only when a
 * container boots without `ALLOWED_DOMAINS`) is generated from it by
 * `scripts/generate-default-allowed-domains.ts`. A stored user list is never
 * widened to match it.
 *
 * It carries no telemetry hosts. `sentry.io`, `statsig.anthropic.com` and
 * `statsig.com` came from Anthropic's reference dev-container firewall and
 * were removed (to-do 6100): with them refused, Claude Code, Codex, OpenCode,
 * Pi and Grok finished turns against a fake provider
 * (`apps/backend/tests/container-live-telemetry-hosts.test.ts`). The opt-in
 * packet trace recorded no lookups of these hosts during those turns; the
 * test assertions check refusal and bounded turn completion. Cursor
 * live qualification remains outstanding (to-do 7420). Sentry accepts events
 * for whatever project a request names, so allowing it creates a channel out
 * of the container.
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  "github.com",
  "api.github.com",
  "registry.npmjs.org",
  "nodejs.org",
  "bun.sh",
  "mise.jdx.dev",
  "mise-versions.jdx.dev",
  "aube.jdx.dev",
  "api.anthropic.com",
  "marketplace.visualstudio.com",
  "vscode.blob.core.windows.net",
  "update.code.visualstudio.com",
  "mcp.context7.com",
  // Playwright browser downloads. The image ships its own pinned Chromium, so
  // this only matters when a project pins a different Playwright version.
  "cdn.playwright.dev",
]);

/** Endpoints each managed provider requires in restricted containers. */
export const AGENT_NETWORK_DOMAINS_BY_PLATFORM = Object.freeze({
  /**
   * Codex signed in with ChatGPT talks to ChatGPT's backend and refreshes its
   * token at OpenAI's auth host. Without them its turns complete with no
   * reply in a restricted container.
   */
  codex: Object.freeze(["chatgpt.com", "auth.openai.com"] as readonly string[]),
  /**
   * The Cursor SDK opens its agent through `api.cursor.com` as well as the
   * `cursor.sh` API hosts. Without it every container attach failed in
   * restricted mode while full-network containers worked (live, 2026-10-23).
   */
  cursor: Object.freeze([
    "api.cursor.com",
    "api2.cursor.sh",
    "api3.cursor.sh",
    "api4.cursor.sh",
    "api5.cursor.sh",
    "repo42.cursor.sh",
    "authenticator.cursor.sh",
    "marketplace.cursorapi.com",
    "cursor-cdn.com",
    "cursor.com",
  ] as readonly string[]),
  /**
   * OpenCode's own providers (OpenCode Zen and Go, the models a fresh install
   * offers with no other login) are served from `opencode.ai`. Without it
   * those turns could not connect in a restricted container (live,
   * 2026-10-23); a user signed in to another provider reaches that provider's
   * host instead, which belongs in `allowedDomains` unless it is a default.
   */
  opencode: Object.freeze(["opencode.ai"] as readonly string[]),
  grok: Object.freeze([
    "x.ai",
    "auth.x.ai",
    "api.x.ai",
    "cli-chat-proxy.grok.com",
  ] as readonly string[]),
  /**
   * Pi is a harness in front of other people's models, so "the hosts Pi needs"
   * is really "the hosts the user's own providers need". This list covers Pi's
   * own catalogue router and the mainstream providers it ships credentials
   * support for; a provider outside it — a self-hosted endpoint, a regional
   * mirror, an OpenAI-compatible gateway — is a host only the user knows, and
   * belongs in the environment's `allowedDomains` rather than being guessed at
   * here. Adding all of them unconditionally would quietly widen the isolation
   * boundary for every Pi environment to reach every vendor Pi has ever known.
   */
  pi: Object.freeze([
    "pi.dev",
    "radius.pi.dev",
    "api.anthropic.com",
    "api.openai.com",
    "generativelanguage.googleapis.com",
    "api.x.ai",
    "api.mistral.ai",
    "api.groq.com",
    "api.deepseek.com",
    "api.cerebras.ai",
    "api.together.ai",
    "openrouter.ai",
  ] as readonly string[]),
} as const);

/**
 * Hosts that must be reachable for the agent platforms this install has
 * enabled.
 *
 * These are deliberately NOT part of the default allowlist: an explicit
 * allowlist is the isolation boundary the user configured, and a restricted
 * container running none of these platforms has no reason to reach their
 * vendors. Container creation unions in only what the enabled platforms need.
 */
export function requiredAgentNetworkDomains(
  enabledPlatforms: readonly string[] | undefined,
): readonly string[] {
  if (!enabledPlatforms) return [];
  const domains = new Set<string>();
  for (const platform of ["codex", "cursor", "opencode", "grok", "pi"] as const) {
    if (enabledPlatforms.includes(platform)) {
      for (const domain of AGENT_NETWORK_DOMAINS_BY_PLATFORM[platform]) {
        domains.add(domain);
      }
    }
  }
  return Array.from(domains);
}

/**
 * The image's fallback list: the defaults plus every platform's hosts, since
 * a container that boots without `ALLOWED_DOMAINS` has no backend to say
 * which platforms are enabled and the image ships all of them.
 */
export function imageDefaultAllowedDomains(): string[] {
  return [
    ...new Set([
      ...DEFAULT_ALLOWED_DOMAINS,
      ...requiredAgentNetworkDomains(Object.keys(AGENT_NETWORK_DOMAINS_BY_PLATFORM)),
    ]),
  ];
}
