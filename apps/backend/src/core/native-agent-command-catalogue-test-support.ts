/**
 * Synthetic command inventories and a fake bridge for catalogue load tests.
 *
 * Shared by `native-agent-command-catalogue-scale.test.ts` and
 * `scripts/benchmark-slash-command-catalogue.ts`. Everything is seeded, so a
 * given size and profile always produces the same bytes. Never imported by
 * production code.
 */
import {
  COMMAND_CATALOGUE_LIMITS,
  NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
  utf8ByteLength,
} from "@orkestrator/protocol/agent-command-catalogue";
import type { BridgeConnection } from "./agent-provider-contract.js";

/**
 * `realistic`: names, descriptions and hints sized like real plugin, skill
 * and template rows. `wire-max`: the same rows with descriptions padded so a
 * 512-row response sits just under `COMMAND_CATALOGUE_LIMITS.maxWireBytes`.
 */
export type SyntheticInventoryProfile = "realistic" | "wire-max";

/** One row as an enhanced (version 1) bridge serves it. */
export interface SyntheticBridgeRow {
  name: string;
  id: string;
  source: string;
  executionKind: string;
  bindingRevision: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

const WORDS = [
  "review",
  "the",
  "current",
  "diff",
  "and",
  "summarise",
  "risky",
  "changes",
  "before",
  "merge",
  "generate",
  "tests",
  "for",
  "selected",
  "files",
  "using",
  "project",
  "conventions",
  "explain",
  "failing",
  "build",
  "output",
  "with",
  "suggested",
  "fixes",
  "deploy",
  "staging",
  "environment",
  "after",
  "checks",
  "pass",
  "update",
  "changelog",
  "release",
  "notes",
];
const NAMESPACES = ["acme", "team-tools", "docs", "infra", "qa", "release", "sec", "data"];
const VERBS = ["review", "test", "explain", "deploy", "lint", "plan", "fix", "triage", "audit"];
const SOURCES = ["builtin", "project", "user", "plugin", "skill", "template"] as const;
const HINTS = ["<path>", "[--fast]", "<branch> [--dry-run]", "<issue-id>", "[scope]", ""];

/** Small deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function sentence(random: () => number, minBytes: number, maxBytes: number): string {
  const target = minBytes + Math.floor(random() * (maxBytes - minBytes + 1));
  let out = "";
  while (out.length < target) {
    out += `${out ? " " : ""}${WORDS[Math.floor(random() * WORDS.length)]}`;
  }
  return `${out.slice(0, target).trimEnd()}.`;
}

/** Bridge-side rows for an inventory of `size` commands. */
export function syntheticCommandRows(
  size: number,
  profile: SyntheticInventoryProfile = "realistic",
  seed = 1,
): SyntheticBridgeRow[] {
  const random = seeded(seed * 7919 + size);
  const rows: SyntheticBridgeRow[] = [];
  for (let index = 0; index < size; index += 1) {
    const namespace = NAMESPACES[index % NAMESPACES.length]!;
    const verb = VERBS[Math.floor(random() * VERBS.length)]!;
    const name = `/${namespace}:${verb}-${index.toString(36)}`;
    const source = SOURCES[index % SOURCES.length]!;
    const hint = HINTS[index % HINTS.length]!;
    rows.push({
      name,
      id: `bench:${source}:${name.slice(1)}`,
      source,
      executionKind: source === "skill" ? "structured-skill" : "provider-prompt",
      bindingRevision: (index * 2_654_435_761).toString(16).padStart(16, "0").slice(-16),
      description: sentence(random, 40, 220),
      ...(hint ? { argumentHint: hint } : {}),
      ...(index % 11 === 0 ? { aliases: [`/${verb}-${index.toString(36)}`] } : {}),
    });
  }
  return profile === "wire-max" ? padToWireBudget(rows) : rows;
}

/** Serialized enhanced bridge response, exactly as a bridge would send it. */
export function bridgeCataloguePayload(
  rows: readonly SyntheticBridgeRow[],
  options: { revision?: number; generation?: string } = {},
): string {
  return JSON.stringify({
    catalogueVersion: NATIVE_AGENT_COMMAND_CATALOGUE_VERSION,
    status: "ready",
    revision: options.revision ?? 1,
    generation: options.generation ?? "bench-generation",
    freshness: "ttl",
    commands: rows,
  });
}

/**
 * Grow descriptions evenly (within their own limit) until the response is as
 * close to the wire budget as whole bytes allow, without crossing it.
 */
function padToWireBudget(rows: SyntheticBridgeRow[]): SyntheticBridgeRow[] {
  const budget = COMMAND_CATALOGUE_LIMITS.maxWireBytes - 64;
  const base = utf8ByteLength(bridgeCataloguePayload(rows));
  const perRow = Math.floor((budget - base) / Math.max(1, rows.length));
  const padded = rows.map((row) => {
    const description = row.description ?? "";
    const room = COMMAND_CATALOGUE_LIMITS.maxDescriptionBytes - description.length;
    const extra = Math.max(0, Math.min(perRow, room));
    return extra > 0
      ? {
          ...row,
          description: `${description} ${"detail ".repeat(extra)}`.slice(
            0,
            description.length + extra,
          ),
        }
      : row;
  });
  // Trim from the end if rounding overshot.
  while (utf8ByteLength(bridgeCataloguePayload(padded)) > budget) {
    const last = padded.findLastIndex((row) => (row.description?.length ?? 0) > 50);
    if (last < 0) break;
    const row = padded[last]!;
    padded[last] = { ...row, description: row.description!.slice(0, -64) };
  }
  return padded;
}

export interface FakeCatalogueBridge {
  fetch: typeof fetch;
  connection: BridgeConnection;
  /** Every request path, in order. */
  requests: string[];
  /** Replace the response the session route serves. */
  setPayload: (payload: string) => void;
}

/**
 * An in-process bridge that serves `GET /session/:id/commands`, the legacy
 * global routes and `POST /session/:id/commands/refresh`. `legacy: true`
 * answers 404 on the session routes, like a bridge that predates the contract.
 */
export function fakeCatalogueBridge(
  initialPayload: string,
  options: { legacy?: boolean; agent?: BridgeConnection["agent"] } = {},
): FakeCatalogueBridge {
  let payload = initialPayload;
  const requests: string[] = [];
  const json = (body: string, status = 200) =>
    new Response(body, { status, headers: { "Content-Type": "application/json" } });
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    requests.push(url.pathname);
    if (/^\/session\/[^/]+\/commands\/refresh$/.test(url.pathname)) {
      return options.legacy ? json('{"error":"not found"}', 404) : json('{"outcome":"reloaded"}');
    }
    if (/^\/session\/[^/]+\/commands$/.test(url.pathname)) {
      return options.legacy ? json('{"error":"not found"}', 404) : json(payload);
    }
    return json('{"error":"not found"}', 404);
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    connection: {
      agent: options.agent ?? "claude",
      baseUrl: "http://bench.invalid",
      authToken: "bench-token",
    },
    requests,
    setPayload: (next) => {
      payload = next;
    },
  };
}
