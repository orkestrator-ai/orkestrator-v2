/**
 * The adapter list (docs/reports/unified-federation.md §11.3 step 3; plan
 * items 1009 and 1008).
 *
 * {@link DOMAIN_CLIENTS} is the one place every domain client definition is
 * listed, and `packages/protocol/contracts/adapters.json` is its committed,
 * machine-readable form: per domain, the client's current version and the
 * adapter versions it has, highest first. The contract CI job (plan item
 * 1008) reads the file and asserts that every (domain, version) in an
 * in-window release snapshot has an adapter here (a release without
 * `domains` is version 0 for every domain). `mise run contract:adapters`
 * rewrites the file and `mise run contract:adapters:check` fails on drift.
 *
 * Rules:
 *
 * - A domain client is defined in `packages/protocol/src/contract/domains/`
 *   and added here; there is one client per domain, so "an adapter exists for
 *   (domain, version)" has one answer.
 * - {@link ADAPTER_RETIREMENT_RULE}: adapter `v` is deleted when the support
 *   floor passes the first Stable release with `v + 1`. Its usage counter
 *   (`client-usage.ts`) shows whether any peer still takes it.
 *
 * Browser-safe: no Node or Bun imports.
 */
import type { DomainClientDef } from "./client.js";
import { MAX_DOMAIN_VERSION, isDomainName, type DomainName } from "./domain.js";
import { dockerClient } from "./domains/docker/client.js";
import { environmentsClient } from "./domains/environments/client.js";
import { claudeTmuxClient } from "./domains/claude-tmux/client.js";
import { configClient } from "./domains/config/client.js";
import { agentServersClient } from "./domains/agent-servers/client.js";
import { coordinatorClient } from "./domains/coordinator/client.js";
import { designClient } from "./domains/design/client.js";
import { filesClient } from "./domains/files/client.js";
import { gitClient } from "./domains/git/client.js";
import { graphsClient } from "./domains/graphs/client.js";
import { multiReviewClient } from "./domains/multi-review/client.js";
import { pipelinesClient } from "./domains/pipelines/client.js";
import { nativeSessionsClient } from "./domains/native-sessions/client.js";
import { nodeFilesClient } from "./domains/node-files/client.js";
import { nodesClient } from "./domains/nodes/client.js";
import { nodeMailClient } from "./domains/node-mail/client.js";
import { previewsClient } from "./domains/previews/client.js";
import { pullRequestsClient } from "./domains/pull-requests/client.js";
import { projectsClient } from "./domains/projects/client.js";
import { terminalsClient } from "./domains/terminals/client.js";
import { systemClient } from "./domains/system/client.js";
import { ticketSyncClient } from "./domains/ticket-sync/client.js";
import { transcriptsClient } from "./domains/transcripts/client.js";
import { webAnnotationsClient } from "./domains/web-annotations/client.js";
import { kanbanClient } from "./domains/kanban/client.js";
import { accountsClient } from "./domains/accounts/client.js";
import { mcpClient } from "./domains/mcp/client.js";
import { agentMailClient } from "./domains/agent-mail/client.js";

/**
 * Every domain client definition. The pilot domains (plan item 1010) were the
 * first; each later domain adds its client here.
 */
export const DOMAIN_CLIENTS: readonly DomainClientDef[] = Object.freeze([
  dockerClient,
  environmentsClient,
  claudeTmuxClient,
  configClient,
  agentServersClient,
  coordinatorClient,
  designClient,
  filesClient,
  gitClient,
  graphsClient,
  multiReviewClient,
  pipelinesClient,
  nativeSessionsClient,
  nodeFilesClient,
  nodesClient,
  nodeMailClient,
  previewsClient,
  pullRequestsClient,
  projectsClient,
  terminalsClient,
  systemClient,
  ticketSyncClient,
  transcriptsClient,
  webAnnotationsClient,
  kanbanClient,
  accountsClient,
  mcpClient,
  agentMailClient,
] as readonly DomainClientDef[]);

/** The committed list, relative to the repository root. */
export const ADAPTER_LIST_PATH = "packages/protocol/contracts/adapters.json";

/** The file format; a reader refuses a version it does not know. */
export const ADAPTER_LIST_SCHEMA_VERSION = 1;

export const ADAPTER_RETIREMENT_RULE =
  "Adapter v is deleted when the support floor passes the first Stable release with v + 1.";

/** One domain's client adapters. */
export interface AdapterListDomain {
  /** The domain's current version: the client always has this adapter. */
  readonly current: number;
  /** Every adapter version, highest first. */
  readonly adapters: readonly number[];
}

export interface AdapterList {
  readonly schemaVersion: typeof ADAPTER_LIST_SCHEMA_VERSION;
  readonly generatedBy: string;
  readonly retirement: string;
  /** Sorted by domain name. */
  readonly domains: Readonly<Partial<Record<DomainName, AdapterListDomain>>>;
}

/** The list for `clients`. Throws when two clients name the same domain. */
export function buildAdapterList(
  clients: readonly DomainClientDef[] = DOMAIN_CLIENTS,
): AdapterList {
  const byDomain = new Map<DomainName, AdapterListDomain>();
  for (const client of clients) {
    const name = client.domain.name;
    if (byDomain.has(name)) {
      throw new Error(`Two domain clients name the ${name} domain; keep one per domain.`);
    }
    byDomain.set(name, { current: client.domain.version, adapters: [...client.versions] });
  }
  const domains: Partial<Record<DomainName, AdapterListDomain>> = {};
  for (const name of [...byDomain.keys()].sort()) domains[name] = byDomain.get(name)!;
  return {
    schemaVersion: ADAPTER_LIST_SCHEMA_VERSION,
    generatedBy: "scripts/generate-contract-adapters.ts (mise run contract:adapters)",
    retirement: ADAPTER_RETIREMENT_RULE,
    domains,
  };
}

/**
 * The committed text: two-space JSON with each `adapters` list on one line,
 * as `bun fmt` leaves it, and a trailing newline.
 */
export function serializeAdapterList(list: AdapterList): string {
  const lines = [
    "{",
    `  "schemaVersion": ${JSON.stringify(list.schemaVersion)},`,
    `  "generatedBy": ${JSON.stringify(list.generatedBy)},`,
    `  "retirement": ${JSON.stringify(list.retirement)},`,
  ];
  const entries = Object.entries(list.domains) as [DomainName, AdapterListDomain][];
  if (entries.length === 0) {
    lines.push(`  "domains": {}`);
  } else {
    lines.push(`  "domains": {`);
    entries.forEach(([name, domain], index) => {
      const comma = index < entries.length - 1 ? "," : "";
      lines.push(
        `    ${JSON.stringify(name)}: { "current": ${domain.current}, "adapters": [${domain.adapters.join(", ")}] }${comma}`,
      );
    });
    lines.push("  }");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function isVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DOMAIN_VERSION
  );
}

/**
 * Reads a committed list, or `null` when it is not one: an unknown schema
 * version, an unknown domain, or a domain whose adapters are not distinct
 * versions sorted highest first that include `current`.
 */
export function parseAdapterList(value: unknown): AdapterList | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ADAPTER_LIST_SCHEMA_VERSION) return null;
  if (typeof record.generatedBy !== "string" || typeof record.retirement !== "string") return null;
  const raw = record.domains;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const domains: Partial<Record<DomainName, AdapterListDomain>> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!isDomainName(name) || typeof entry !== "object" || entry === null) return null;
    const { current, adapters } = entry as Record<string, unknown>;
    if (!isVersion(current) || current < 1 || !Array.isArray(adapters)) return null;
    if (!adapters.every(isVersion) || !adapters.includes(current)) return null;
    if (adapters.some((version, index) => index > 0 && version >= adapters[index - 1]!))
      return null;
    if (adapters[0] !== current) return null;
    domains[name] = { current, adapters: [...adapters] };
  }
  return {
    schemaVersion: ADAPTER_LIST_SCHEMA_VERSION,
    generatedBy: record.generatedBy,
    retirement: record.retirement,
    domains,
  };
}

/** Whether the list has a client adapter for `domain` at `version`. */
export function hasDomainAdapter(list: AdapterList, domain: string, version: number): boolean {
  if (!isDomainName(domain)) return false;
  return list.domains[domain]?.adapters.includes(version) ?? false;
}

/**
 * The adapters below their domain's current version (the ones that are
 * counted), as `domain@version` keys: the pairs a backend accepts in a
 * renderer's usage upload.
 */
export function countedAdapterKeys(list: AdapterList): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [name, domain] of Object.entries(list.domains) as [DomainName, AdapterListDomain][]) {
    for (const version of domain.adapters) {
      if (version < domain.current) keys.add(adapterKey(name, version));
    }
  }
  return keys;
}

/** The `domain@version` key {@link countedAdapterKeys} uses. */
export function adapterKey(domain: DomainName, version: number): string {
  return `${domain}@${version}`;
}

/** A human-readable list of differences between the committed list and the generated one. */
export function describeAdapterListDrift(
  committed: string | null,
  generated: AdapterList,
): string[] {
  if (committed === null) return [`${ADAPTER_LIST_PATH} is missing.`];
  const text = serializeAdapterList(generated);
  if (committed === text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(committed);
  } catch {
    return [`${ADAPTER_LIST_PATH} is not valid JSON.`];
  }
  const previous = parseAdapterList(parsed);
  if (!previous) return [`${ADAPTER_LIST_PATH} is not a valid adapter list.`];
  const problems: string[] = [];
  const names = new Set([...Object.keys(previous.domains), ...Object.keys(generated.domains)]);
  for (const name of [...names].sort() as DomainName[]) {
    const was = previous.domains[name];
    const now = generated.domains[name];
    if (!was) problems.push(`${name}: added (adapters ${now!.adapters.join(", ")}).`);
    else if (!now) problems.push(`${name}: removed.`);
    else if (was.current !== now.current || was.adapters.join() !== now.adapters.join()) {
      problems.push(
        `${name}: committed current ${was.current} adapters [${was.adapters.join(", ")}], generated current ${now.current} adapters [${now.adapters.join(", ")}].`,
      );
    }
  }
  if (problems.length === 0) problems.push(`${ADAPTER_LIST_PATH} differs from the generated text.`);
  return problems;
}
