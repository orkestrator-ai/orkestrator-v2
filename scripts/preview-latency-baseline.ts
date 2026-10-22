/**
 * Service preview latency baseline for the two-machine qualification
 * (docs/development/preview-two-machine-runbook.md).
 *
 * Run on the CLIENT machine against a backend on another machine (or, for a
 * self-test, against a local isolated backend). For one registered preview
 * service it measures, per route and per sample on a fresh connection, the
 * connect time and the time to the first response byte, after warm-ups:
 *
 *   direct          plain HTTP to the service's host port on the backend's
 *                   address (normally unreachable from another machine);
 *   legacy          the gateway's `/__orkestrator/browser/loopback/<port>/`
 *                   route with the gateway bearer token;
 *   desktop-tunnel  one `desktop-tunnel` attachment, then Electron's own
 *                   `openPreviewTunnel` per sample (WS, HELLO, OPEN, OPEN_OK);
 *   private-origin  `create_preview_handoff_url`, the session cookie, then
 *                   TLS GETs to the service's private origin.
 *
 * The gateway token comes from ORKESTRATOR_PREVIEW_BASELINE_TOKEN or
 * `--token-file` (a raw token or a `gateway-auth.json`), never from argv. No
 * token, tunnel credential, grant, session code, cookie or response body is
 * ever printed; the output is checked for every secret the run handled before
 * it is written. JSON goes to stdout, a Markdown table to stderr.
 *
 * Helpers for the same runbook, as subcommands: `decoy` (a client-local
 * listener on the remote service's port that must see zero connections),
 * `throttle` (a no-root userspace TCP forwarder adding latency and a rate
 * cap), `watch` (polls `get_preview_diagnostics`, numbers only) and
 * `download` (a slow reader over the real tunnel, with the backend's queue
 * gauges). `--help` lists every option.
 */
import { readFileSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, rootCertificates } from "node:tls";

import {
  PREVIEW_SESSION_COOKIE,
  PREVIEW_TUNNEL_PATH,
  type PreviewAttachmentDescriptor,
} from "@orkestrator/protocol/preview-access";
import {
  previewErrorFromUnknown,
  redactPreviewPath,
  type PreviewCapabilities,
  type PreviewRegistrySnapshot,
  type PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";

import { openPreviewTunnel } from "../apps/desktop/electron/preview-tunnel-client";

export const BASELINE_SCHEMA = "orkestrator.preview-latency-baseline.v1";
export const TOKEN_ENV = "ORKESTRATOR_PREVIEW_BASELINE_TOKEN";
export const ROUTES = ["direct", "legacy", "desktop-tunnel", "private-origin"] as const;
export type Route = (typeof ROUTES)[number];

const INVOKE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const RESPONSE_HEAD_MAX_BYTES = 32 * 1024;
const USER_AGENT = "orkestrator-preview-baseline/1";

export class UsageError extends Error {}

/** A failure whose message is a fixed, secret-free description. */
export class BaselineFailure extends Error {}

// ---------------------------------------------------------------------------
// Options

export type DirectMode = { kind: "auto" } | { kind: "off" } | { kind: "host"; host: string };

export interface BaselineOptions {
  url: URL;
  token: string;
  service?: string;
  environment?: string;
  samples: number;
  warmups: number;
  path: string;
  routes: Route[];
  direct: DirectMode;
  timeoutMs: number;
  intervalMs: number;
  /** Extra CA (PEM) added to the system roots for the gateway and private origins. */
  ca?: string;
  /** Connect private-origin hosts to this address instead of resolving them. */
  publicationAddress?: string;
  label?: string;
}

export const USAGE = `Usage:
  bun scripts/preview-latency-baseline.ts --url <backend URL> [--service <id|label>] [options]
  bun scripts/preview-latency-baseline.ts decoy --port <port> [--hosts 127.0.0.1,::1]
  bun scripts/preview-latency-baseline.ts throttle --listen <port> --target <host:port>
      [--latency-ms 40] [--rate-kib 256] [--listen-host 127.0.0.1]
  bun scripts/preview-latency-baseline.ts watch --url <backend URL> [--interval-ms 1000]
      (token as for the baseline; prints preview gauges as JSON lines, peaks on Ctrl-C)
  bun scripts/preview-latency-baseline.ts download --url <backend URL> --path /endless
      [--service <id|label>] [--seconds 30] [--read-kib 64]
      (one desktop-tunnel GET read at a capped rate; prints bytes and backend tunnel gauges)

Baseline options:
  --url <url>                  Backend gateway origin, e.g. https://build.tailnet.ts.net
  --token-file <path>          Raw token or gateway-auth.json (or set ${TOKEN_ENV})
  --service <id|label>         Service to measure (default: the only registered one)
  --environment <id>           Restrict --service label matching to one environment
  --samples <n>                Measured samples per route (default 50)
  --warmups <n>                Unmeasured warm-ups per route (default 5)
  --path <path>                Application path to GET (default /)
  --routes <list>              Comma list of ${ROUTES.join(", ")} (default all)
  --direct auto|off|<host>     Direct route target (default auto: the backend URL's
                               host; skipped when that host is loopback)
  --timeout-ms <n>             Per-sample deadline (default 10000)
  --interval-ms <n>            Pause between samples (default 0)
  --ca-file <path>             Extra CA (PEM) for the gateway and private origins
  --publication-address <ip>   Connect private-origin hosts here instead of DNS
  --label <text>               Free-form run label copied into the JSON
`;

function positiveInteger(value: string | undefined, flag: string, min: number, max: number) {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

/** Accepts a raw token or a `gateway-auth.json` body (`{ "token": "…" }`). */
export function tokenFromFileContents(contents: string): string {
  const trimmed = contents.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new UsageError("The token file is neither a raw token nor valid JSON");
    }
    const token = (parsed as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || !token.trim()) {
      throw new UsageError("The token file has no string `token` field");
    }
    return token.trim();
  }
  if (!trimmed || /\s/.test(trimmed)) throw new UsageError("The token file is empty or malformed");
  return trimmed;
}

export interface ParseDependencies {
  readFile(path: string): string;
  /** File mode bits, or null when unknown. */
  fileMode(path: string): number | null;
  warn(message: string): void;
}

const defaultDependencies: ParseDependencies = {
  readFile: (path) => readFileSync(path, "utf8"),
  fileMode: (path) => {
    try {
      return statSync(path).mode;
    } catch {
      return null;
    }
  },
  warn: (message) => process.stderr.write(`[preview-baseline] ${message}\n`),
};

export function parseBaselineArgs(
  argv: string[],
  env: Record<string, string | undefined>,
  dependencies: ParseDependencies = defaultDependencies,
): BaselineOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) throw new UsageError(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf("=");
    const name = equals < 0 ? argument.slice(2) : argument.slice(2, equals);
    if (name === "token" || name === "credential" || name === "cookie") {
      throw new UsageError(
        `--${name} is not accepted: secrets never go on the command line. Use ${TOKEN_ENV} or --token-file.`,
      );
    }
    let value: string | undefined;
    if (equals >= 0) value = argument.slice(equals + 1);
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (values.has(name)) throw new UsageError(`--${name} was given twice`);
    values.set(name, value);
  }
  const known = new Set([
    "url",
    "token-file",
    "service",
    "environment",
    "samples",
    "warmups",
    "path",
    "routes",
    "direct",
    "timeout-ms",
    "interval-ms",
    "ca-file",
    "publication-address",
    "label",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new UsageError(`Unknown option --${name}`);
  }

  const rawUrl = values.get("url");
  if (!rawUrl) throw new UsageError("--url is required");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UsageError("--url is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("--url must be http:// or https://");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new UsageError("--url must be a bare origin: no path, query, fragment or credentials");
  }

  const tokenFile = values.get("token-file");
  const envToken = env[TOKEN_ENV]?.trim();
  if (tokenFile && envToken) {
    throw new UsageError(`Use either ${TOKEN_ENV} or --token-file, not both`);
  }
  let token: string;
  if (tokenFile) {
    let contents: string;
    try {
      contents = dependencies.readFile(tokenFile);
    } catch {
      throw new UsageError("The token file could not be read");
    }
    token = tokenFromFileContents(contents);
    const mode = dependencies.fileMode(tokenFile);
    if (mode !== null && (mode & 0o077) !== 0) {
      dependencies.warn("The token file is readable by other users; chmod 600 it.");
    }
  } else if (envToken) {
    token = envToken;
  } else {
    throw new UsageError(`A gateway token is required: set ${TOKEN_ENV} or pass --token-file`);
  }

  const routes = values.has("routes")
    ? values
        .get("routes")!
        .split(",")
        .map((route) => route.trim())
        .filter(Boolean)
    : [...ROUTES];
  for (const route of routes) {
    if (!(ROUTES as readonly string[]).includes(route)) {
      throw new UsageError(`Unknown route ${route}; expected ${ROUTES.join(", ")}`);
    }
  }
  if (routes.length === 0) throw new UsageError("--routes is empty");

  const rawDirect = values.get("direct") ?? "auto";
  const direct: DirectMode =
    rawDirect === "auto"
      ? { kind: "auto" }
      : rawDirect === "off"
        ? { kind: "off" }
        : /^[A-Za-z0-9.:[\]-]{1,255}$/.test(rawDirect)
          ? { kind: "host", host: rawDirect.replace(/^\[|\]$/g, "") }
          : (() => {
              throw new UsageError("--direct must be auto, off or a host name or address");
            })();

  const path = values.get("path") ?? "/";
  if (!path.startsWith("/") || /[\s\r\n]/.test(path) || path.length > 2048) {
    throw new UsageError("--path must start with / and contain no whitespace");
  }

  let ca: string | undefined;
  const caFile = values.get("ca-file");
  if (caFile) {
    try {
      ca = dependencies.readFile(caFile);
    } catch {
      throw new UsageError("The CA file could not be read");
    }
    if (!ca.includes("BEGIN CERTIFICATE"))
      throw new UsageError("The CA file is not a PEM certificate");
  }

  const publicationAddress = values.get("publication-address");
  if (publicationAddress !== undefined && isIP(publicationAddress) === 0) {
    throw new UsageError("--publication-address must be an IP address");
  }

  const label = values.get("label");
  if (label !== undefined && label.length > 200) throw new UsageError("--label is too long");

  return {
    url,
    token,
    service: values.get("service"),
    environment: values.get("environment"),
    samples: values.has("samples")
      ? positiveInteger(values.get("samples"), "--samples", 1, 10_000)
      : 50,
    warmups: values.has("warmups")
      ? positiveInteger(values.get("warmups"), "--warmups", 0, 1_000)
      : 5,
    path,
    routes: routes as Route[],
    direct,
    timeoutMs: values.has("timeout-ms")
      ? positiveInteger(values.get("timeout-ms"), "--timeout-ms", 100, 120_000)
      : 10_000,
    intervalMs: values.has("interval-ms")
      ? positiveInteger(values.get("interval-ms"), "--interval-ms", 0, 60_000)
      : 0,
    ca,
    publicationAddress,
    label,
  };
}

// ---------------------------------------------------------------------------
// Statistics and results

export interface Summary {
  p50: number;
  p95: number;
  max: number;
}

/**
 * Same nearest-rank method as `preview-bench.test.ts` and `PreviewMetrics`
 * (`sorted[floor(q * n)]`), so loopback bench, backend histograms and this
 * tool report comparable figures. Values are rounded to 0.01 ms.
 */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
  const round = (value: number) => Math.round(value * 100) / 100;
  return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)!) };
}

export type SampleOutcome =
  | { ok: true; connectMs: number; firstByteMs: number; status: number }
  | { ok: false; failure: string };

export type RouteStatus = "measured" | "skipped" | "unreachable" | "failed";

export interface RouteResult {
  status: RouteStatus;
  /** Why the route was skipped, unreachable or failed. Never a secret. */
  reason?: string;
  samples: number;
  failures: number;
  connectMs: Summary | null;
  firstByteMs: Summary | null;
  /** HTTP status code counts of the measured samples. */
  statuses: Record<string, number>;
  /** Failure kinds of the measured samples. */
  failureKinds: Record<string, number>;
  /** One-off setup timings (attachment issuance, session exchange). */
  setupMs?: Record<string, number>;
}

/** A sample is a failure on a transport error, a timeout or an HTTP 5xx. */
export function routeResult(
  outcomes: readonly SampleOutcome[],
  setupMs?: Record<string, number>,
): RouteResult {
  const connect: number[] = [];
  const firstByte: number[] = [];
  const statuses: Record<string, number> = {};
  const failureKinds: Record<string, number> = {};
  let failures = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failures += 1;
      failureKinds[outcome.failure] = (failureKinds[outcome.failure] ?? 0) + 1;
      continue;
    }
    statuses[String(outcome.status)] = (statuses[String(outcome.status)] ?? 0) + 1;
    if (outcome.status >= 500) {
      failures += 1;
      failureKinds[`http-${outcome.status}`] = (failureKinds[`http-${outcome.status}`] ?? 0) + 1;
      continue;
    }
    connect.push(outcome.connectMs);
    firstByte.push(outcome.firstByteMs);
  }
  return {
    status: connect.length > 0 ? "measured" : "failed",
    ...(connect.length > 0 ? {} : { reason: "every measured sample failed" }),
    samples: outcomes.length,
    failures,
    connectMs: summarize(connect),
    firstByteMs: summarize(firstByte),
    statuses,
    failureKinds,
    ...(setupMs ? { setupMs } : {}),
  };
}

export function skippedRoute(
  status: Exclude<RouteStatus, "measured">,
  reason: string,
): RouteResult {
  return {
    status,
    reason,
    samples: 0,
    failures: 0,
    connectMs: null,
    firstByteMs: null,
    statuses: {},
    failureKinds: {},
  };
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(bare) ||
    bare === "0.0.0.0"
  );
}

export function hostKind(host: string): "loopback" | "tailnet-address" | "ip-address" | "name" {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(bare)) return "loopback";
  if (isIP(bare) === 4) {
    const [a, b] = bare.split(".").map(Number);
    return a === 100 && b! >= 64 && b! <= 127 ? "tailnet-address" : "ip-address";
  }
  if (isIP(bare) === 6)
    return bare.toLowerCase().startsWith("fd7a:115c:a1e0") ? "tailnet-address" : "ip-address";
  return "name";
}

export type RoutePlan =
  | { run: true; host?: string; port?: number }
  | { run: false; result: RouteResult };

/** Decides, before any traffic, which routes can run and why the others cannot. */
export function planRoutes(input: {
  options: Pick<BaselineOptions, "routes" | "direct" | "url">;
  capabilities: PreviewCapabilities;
  service: PreviewServiceSnapshot;
}): Record<Route, RoutePlan> {
  const { options, capabilities, service } = input;
  const skip = (reason: string): RoutePlan => ({
    run: false,
    result: skippedRoute("skipped", reason),
  });
  const plans = {} as Record<Route, RoutePlan>;
  const hostPort = service.endpoint.hostPort;
  for (const route of ROUTES) {
    if (!options.routes.includes(route)) {
      plans[route] = skip("not selected with --routes");
      continue;
    }
    if (service.endpoint.state !== "available") {
      plans[route] = skip(`the service endpoint is ${service.endpoint.state}`);
      continue;
    }
    switch (route) {
      case "direct": {
        if (options.direct.kind === "off") plans[route] = skip("disabled with --direct off");
        else if (hostPort === null)
          plans[route] = skip("the service has no host port (container relay or unresolved)");
        else if (service.definition.scheme !== "http")
          plans[route] = skip("the service is HTTPS; the direct route measures plain HTTP only");
        else {
          const host = options.direct.kind === "host" ? options.direct.host : options.url.hostname;
          if (options.direct.kind === "auto" && isLoopbackHost(host)) {
            plans[route] = skip(
              "the backend URL is loopback on this client, so a direct request would reach a client-local process; pass --direct 127.0.0.1 only when the backend runs on this machine",
            );
          } else plans[route] = { run: true, host: host.replace(/^\[|\]$/g, ""), port: hostPort };
        }
        break;
      }
      case "legacy":
        if (!capabilities.surfaces.legacyPath.available)
          plans[route] = skip(
            capabilities.surfaces.legacyPath.reason ?? "the legacy route is unavailable",
          );
        else if (hostPort === null)
          plans[route] = skip("the service has no host port (container relay or unresolved)");
        else if (service.definition.scheme !== "http")
          plans[route] = skip("the legacy route proxies plain HTTP only");
        else plans[route] = { run: true, port: hostPort };
        break;
      case "desktop-tunnel":
        if (!capabilities.surfaces.desktopTunnel.available)
          plans[route] = skip(
            capabilities.surfaces.desktopTunnel.reason ?? "the desktop tunnel is unavailable",
          );
        else if (service.definition.scheme !== "http")
          plans[route] = skip("the desktop tunnel carries HTTP services only");
        else plans[route] = { run: true };
        break;
      case "private-origin":
        if (!capabilities.surfaces.browserTopLevel.available)
          plans[route] = skip(
            capabilities.surfaces.browserTopLevel.reason ??
              "private-origin publication is unavailable",
          );
        else plans[route] = { run: true };
        break;
    }
  }
  return plans;
}

/** Keeps only finite numbers and booleans, so a diagnostics object cannot carry text. */
export function numbersOnly(value: unknown, depth = 0): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[\w.{}-]{1,96}$/.test(key)) continue;
    const kept = numbersOnly(entry, depth + 1);
    if (
      kept !== undefined &&
      !(typeof kept === "object" && Object.keys(kept as object).length === 0)
    )
      result[key] = kept;
  }
  return result;
}

/** The safe parts of `get_preview_diagnostics`: metrics and access/registry counts. */
export function sanitizeDiagnostics(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return numbersOnly({
    metrics: record.metrics,
    access: record.access,
    registry: record.registry,
    relay: record.relay,
  });
}

const FORBIDDEN_KEYS = /^(token|credential|grant|cookie|session|code|authorization|secret|url)$/i;

/**
 * Fails closed if any secret the run handled, or a key that names one, would
 * be written. Runs over the exact text about to be printed.
 */
export function assertNoSecrets(text: string, secrets: Iterable<string>): void {
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new BaselineFailure("refusing to print: the output contains a secret");
    }
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new BaselineFailure(`refusing to print: the output has a "${key}" field`);
      }
      walk(entry);
    }
  };
  walk(parsed);
}

export interface BaselineResult {
  schema: typeof BASELINE_SCHEMA;
  label: string | null;
  startedAt: string;
  finishedAt: string;
  client: { platform: string; arch: string; bun: string };
  backend: {
    scheme: string;
    hostKind: ReturnType<typeof hostKind>;
    capabilities: {
      access: boolean;
      desktopTunnel: boolean;
      browserTopLevel: boolean;
      legacyPath: boolean;
      relay: boolean;
    };
  };
  service: {
    targetKind: string;
    transportKind: string | null;
    scheme: string;
    addressFamily: string | null;
  };
  config: {
    samples: number;
    warmups: number;
    path: string;
    timeoutMs: number;
    intervalMs: number;
    direct: string;
  };
  routes: Record<Route, RouteResult>;
  /** `get_preview_diagnostics`, numbers only: before, after sampling, after release. */
  diagnostics: { before: unknown; afterSampling: unknown; afterRelease: unknown };
}

function cell(summary: Summary | null): string {
  return summary ? `${summary.p50} / ${summary.p95} / ${summary.max}` : "-";
}

export function formatTable(result: BaselineResult): string {
  const lines = [
    `Preview latency baseline${result.label ? `: ${result.label}` : ""} (${result.startedAt}, ${result.config.samples} samples after ${result.config.warmups} warm-ups, GET ${result.config.path})`,
    "",
    "| Route | Status | Samples | Failures | Connect p50 / p95 / max (ms) | First byte p50 / p95 / max (ms) |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const notes: string[] = [];
  for (const route of ROUTES) {
    const entry = result.routes[route];
    lines.push(
      `| ${route} | ${entry.status} | ${entry.samples} | ${entry.failures} | ${cell(entry.connectMs)} | ${cell(entry.firstByteMs)} |`,
    );
    if (entry.reason) notes.push(`- ${route}: ${entry.reason}`);
    const kinds = Object.entries(entry.failureKinds);
    if (kinds.length > 0)
      notes.push(
        `- ${route} failures: ${kinds.map(([kind, count]) => `${kind} ${count}`).join(", ")}`,
      );
  }
  return `${[...lines, "", ...notes].join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Network

function caList(ca: string | undefined): string[] | undefined {
  return ca ? [...rootCertificates, ca] : undefined;
}

function failureKind(error: unknown): string {
  if (error instanceof BaselineFailure) return error.message;
  const category = previewErrorFromUnknown(error)?.category;
  if (category) return category;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "error";
}

/** Authenticated control call. Errors carry only an HTTP status or preview category. */
export async function invokeCommand(
  options: Pick<BaselineOptions, "url" | "token" | "ca" | "timeoutMs">,
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const body = JSON.stringify({ command, args });
  const target = new URL("/__orkestrator/invoke", options.url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const request = send(
      target,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-encoding": "identity",
          "user-agent": USER_AGENT,
        },
        ca: caList(options.ca),
        timeout: options.timeoutMs,
      },
      (incoming: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > INVOKE_RESPONSE_MAX_BYTES) {
            incoming.destroy();
            reject(new BaselineFailure(`${command}: response too large`));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
        incoming.on("error", () => reject(new BaselineFailure(`${command}: response interrupted`)));
      },
    );
    request.on("timeout", () => request.destroy(new BaselineFailure(`${command}: timed out`)));
    request.on("error", (error) =>
      reject(
        error instanceof BaselineFailure
          ? error
          : new BaselineFailure(`${command}: ${failureKind(error)}`),
      ),
    );
    request.end(body);
  });
  if (response.status === 401 || response.status === 403) {
    throw new BaselineFailure(
      `${command}: the gateway refused the token (HTTP ${response.status})`,
    );
  }
  let payload: { result?: unknown; error?: unknown };
  try {
    payload = JSON.parse(response.body.toString("utf8")) as typeof payload;
  } catch {
    throw new BaselineFailure(`${command}: non-JSON response (HTTP ${response.status})`);
  }
  if (response.status >= 200 && response.status < 300) return payload.result;
  const category = previewErrorFromUnknown(
    typeof payload.error === "string" ? payload.error : "",
  )?.category;
  if (typeof payload.error === "string" && payload.error.startsWith("Unknown backend command: ")) {
    throw new BaselineFailure(`${command}: this backend does not support the command`);
  }
  throw new BaselineFailure(`${command}: ${category ?? `HTTP ${response.status}`}`);
}

type Connect = (signal: AbortSignal) => Promise<Duplex>;

function openTcp(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const onAbort = () => {
      socket.destroy();
      reject(new BaselineFailure("timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(new BaselineFailure(failureKind(error)));
    });
  });
}

function openTls(
  host: string,
  port: number,
  servername: string,
  ca: string | undefined,
  signal: AbortSignal,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      ...(isIP(servername) === 0 ? { servername } : {}),
      ca: caList(ca),
      ALPNProtocols: ["http/1.1"],
    });
    const onAbort = () => {
      socket.destroy();
      reject(new BaselineFailure("timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(new BaselineFailure(failureKind(error)));
    });
  });
}

export function httpRequestBytes(path: string, host: string, headers: Record<string, string> = {}) {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `host: ${host}`,
    `user-agent: ${USER_AGENT}`,
    "accept-encoding: identity",
    "connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
}

/** Parses `HTTP/1.1 200 …` from the first bytes; the rest is never kept. */
export function statusFromHead(head: Buffer): number | null {
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, 16).toString("latin1"));
  return match ? Number(match[1]) : null;
}

/**
 * One timed exchange on a fresh connection: connect (TCP, TLS or tunnel
 * OPEN_OK), write the request, stop at the first response byte that completes
 * the status line, then destroy the connection. Bodies are never read.
 */
export async function timedExchange(
  connect: Connect,
  request: Buffer,
  timeoutMs: number,
): Promise<SampleOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let stream: Duplex | null = null;
  try {
    stream = await connect(controller.signal);
    const connectMs = performance.now() - started;
    if (controller.signal.aborted) return { ok: false, failure: "timeout" };
    const connected = stream;
    return await new Promise<SampleOutcome>((resolve) => {
      let firstByteMs: number | null = null;
      let head = Buffer.alloc(0);
      const done = (outcome: SampleOutcome) => {
        controller.signal.removeEventListener("abort", onAbort);
        connected.removeAllListeners("data");
        resolve(outcome);
      };
      const onAbort = () =>
        done({ ok: false, failure: firstByteMs === null ? "timeout" : "truncated-head" });
      controller.signal.addEventListener("abort", onAbort, { once: true });
      connected.on("data", (chunk: Buffer) => {
        firstByteMs ??= performance.now() - started;
        head = Buffer.concat([head, chunk]).subarray(0, 64);
        if (head.length < 12) return;
        const status = statusFromHead(head);
        done(
          status === null
            ? { ok: false, failure: "malformed-response" }
            : { ok: true, connectMs, firstByteMs, status },
        );
      });
      connected.once("error", (error) => done({ ok: false, failure: failureKind(error) }));
      connected.once("end", () => done({ ok: false, failure: "closed-before-response" }));
      connected.once("close", () => done({ ok: false, failure: "closed-before-response" }));
      connected.write(request);
    });
  } catch (error) {
    return {
      ok: false,
      failure: controller.signal.aborted ? "timeout" : failureKind(error),
    };
  } finally {
    clearTimeout(timer);
    stream?.destroy();
  }
}

/** Reads a whole response head (bounded) for the one-off session exchange. */
function readHead(stream: Duplex, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new BaselineFailure("timeout")), timeoutMs);
    const finish = (error: Error | null) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      if (error) reject(error);
      else resolve(head);
    };
    stream.on("data", (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end >= 0) {
        head = head.subarray(0, end);
        finish(null);
      } else if (head.length > RESPONSE_HEAD_MAX_BYTES)
        finish(new BaselineFailure("response head too large"));
    });
    stream.once("error", (error) => finish(new BaselineFailure(failureKind(error))));
    stream.once("end", () => finish(new BaselineFailure("closed-before-response")));
  });
}

/** The `__Host-orkestrator-preview` value from a response head, or null. */
export function sessionCookieFromHead(head: string): string | null {
  for (const line of head.split("\r\n")) {
    const match = /^set-cookie:\s*([^=;\s]+)=([^;\s]*)/i.exec(line);
    if (match && match[1] === PREVIEW_SESSION_COOKIE && match[2]) return match[2];
  }
  return null;
}

async function sampleRoute(
  options: BaselineOptions,
  run: () => Promise<SampleOutcome>,
  signal: AbortSignal,
  setupMs?: Record<string, number>,
): Promise<RouteResult> {
  const warm: SampleOutcome[] = [];
  for (let index = 0; index < options.warmups && !signal.aborted; index += 1) {
    warm.push(await run());
    if (options.intervalMs) await Bun.sleep(options.intervalMs);
  }
  if (warm.length > 0 && warm.every((outcome) => !outcome.ok)) {
    const first = warm[0] as { failure: string };
    return { ...skippedRoute("failed", `every warm-up failed (${first.failure})`), setupMs };
  }
  const outcomes: SampleOutcome[] = [];
  for (let index = 0; index < options.samples && !signal.aborted; index += 1) {
    outcomes.push(await run());
    if (options.intervalMs) await Bun.sleep(options.intervalMs);
  }
  const result = routeResult(outcomes, setupMs);
  return signal.aborted ? { ...result, reason: "interrupted before every sample ran" } : result;
}

function selectService(
  snapshot: PreviewRegistrySnapshot,
  options: Pick<BaselineOptions, "service" | "environment">,
): PreviewServiceSnapshot {
  const services = snapshot.services.filter(
    (entry) => !options.environment || entry.definition.environmentId === options.environment,
  );
  const describe = () =>
    services
      .map(
        (entry) =>
          `  ${entry.definition.serviceId}  ${entry.definition.label}  (${entry.definition.targetKind}, port ${entry.definition.applicationPort}, ${entry.endpoint.state})`,
      )
      .join("\n");
  if (!options.service) {
    if (services.length === 1) return services[0]!;
    throw new UsageError(
      services.length === 0
        ? "The backend has no registered preview services"
        : `Choose a service with --service:\n${describe()}`,
    );
  }
  const byId = services.find((entry) => entry.definition.serviceId === options.service);
  if (byId) return byId;
  const byLabel = services.filter((entry) => entry.definition.label === options.service);
  if (byLabel.length === 1) return byLabel[0]!;
  throw new UsageError(
    byLabel.length > 1
      ? `Several services are labelled ${options.service}; pass the service id:\n${describe()}`
      : `No service matches --service; registered services:\n${describe()}`,
  );
}

export interface BaselineRun {
  result: BaselineResult;
  /** Every secret the run handled, for the output check. Never printed. */
  secrets: Set<string>;
}

export async function runBaseline(
  options: BaselineOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<BaselineRun> {
  const secrets = new Set<string>([options.token]);
  const startedAt = new Date().toISOString();
  const invoke = (command: string, args: Record<string, unknown> = {}) =>
    invokeCommand(options, command, args);
  const diagnostics = async () =>
    sanitizeDiagnostics(await invoke("get_preview_diagnostics").catch(() => null));

  const capabilities = (await invoke("get_preview_capabilities")) as PreviewCapabilities;
  const snapshot = (await invoke("get_preview_services", {})) as PreviewRegistrySnapshot;
  const selected = selectService(snapshot, options);
  const serviceId = selected.definition.serviceId;
  // Resolve and probe now, as the client does before opening a preview, so
  // the snapshot carries the current host port and endpoint state.
  const service = ((await invoke("probe_preview_service", { serviceId }).catch(() => null)) ??
    selected) as PreviewServiceSnapshot;
  const plans = planRoutes({ options, capabilities, service });
  const before = await diagnostics();
  const routes = {} as Record<Route, RouteResult>;
  const releases: string[] = [];
  const gatewayHost = options.url.host;
  const gatewayName = options.url.hostname.replace(/^\[|\]$/g, "");
  const gatewayPort = Number(options.url.port || (options.url.protocol === "https:" ? 443 : 80));
  const gatewayConnect: Connect = (abort) =>
    options.url.protocol === "https:"
      ? openTls(gatewayName, gatewayPort, gatewayName, options.ca, abort)
      : openTcp(gatewayName, gatewayPort, abort);

  let afterSampling: unknown = null;
  try {
    for (const route of ROUTES) {
      const plan = plans[route];
      if (!plan.run) {
        routes[route] = plan.result;
        continue;
      }
      if (signal.aborted) {
        routes[route] = skippedRoute("skipped", "interrupted");
        continue;
      }
      if (route === "direct") {
        const host = plan.host!;
        const port = plan.port!;
        const probe = await timedExchange(
          (abort) => openTcp(host, port, abort),
          httpRequestBytes(options.path, `${isIP(host) === 6 ? `[${host}]` : host}:${port}`),
          Math.min(options.timeoutMs, 3_000),
        );
        if (!probe.ok) {
          routes[route] = skippedRoute(
            "unreachable",
            `no HTTP response from the service's host port at the backend address (${probe.failure}); expected on a correct two-machine setup`,
          );
          continue;
        }
        const request = httpRequestBytes(
          options.path,
          `${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
        );
        routes[route] = await sampleRoute(
          options,
          () => timedExchange((abort) => openTcp(host, port, abort), request, options.timeoutMs),
          signal,
        );
      } else if (route === "legacy") {
        const request = httpRequestBytes(
          `/__orkestrator/browser/loopback/${plan.port}${options.path}`,
          gatewayHost,
          { authorization: `Bearer ${options.token}` },
        );
        routes[route] = await sampleRoute(
          options,
          () => timedExchange(gatewayConnect, request, options.timeoutMs),
          signal,
        );
      } else if (route === "desktop-tunnel") {
        const issued = performance.now();
        let attachment: PreviewAttachmentDescriptor;
        try {
          attachment = (await invoke("create_preview_attachment", {
            serviceId,
            surface: "desktop-tunnel",
            clientKey: "preview-latency-baseline",
          })) as PreviewAttachmentDescriptor;
        } catch (error) {
          routes[route] = skippedRoute("failed", failureKind(error));
          continue;
        }
        const attachmentMs = Math.round((performance.now() - issued) * 100) / 100;
        releases.push(attachment.attachmentId);
        const credential = attachment.tunnel?.credential;
        if (!credential) {
          routes[route] = skippedRoute("failed", "the attachment carried no tunnel credential");
          continue;
        }
        secrets.add(credential);
        const tunnelUrl = new URL(PREVIEW_TUNNEL_PATH, options.url);
        tunnelUrl.protocol = options.url.protocol === "https:" ? "wss:" : "ws:";
        // The Electron ingress rewrites Host to the private authority before
        // bytes enter the tunnel; send what it would send.
        const request = httpRequestBytes(options.path, `localhost:${attachment.applicationPort}`);
        routes[route] = await sampleRoute(
          options,
          () =>
            timedExchange(
              (abort) =>
                openPreviewTunnel({
                  url: tunnelUrl.toString(),
                  attachmentId: attachment.attachmentId,
                  credential,
                  signal: abort,
                  connectTimeoutMs: options.timeoutMs,
                  handshakeTimeoutMs: options.timeoutMs,
                  ...(options.ca ? { ca: caList(options.ca)!.join("\n") } : {}),
                }),
              request,
              options.timeoutMs,
            ),
          signal,
          { attachment: attachmentMs },
        );
      } else {
        const issued = performance.now();
        let handoff: URL;
        try {
          const created = (await invoke("create_preview_handoff_url", {
            serviceId,
            path: options.path,
            clientKey: "preview-latency-baseline",
          })) as { url?: unknown; attachmentId?: unknown };
          if (typeof created.attachmentId === "string") releases.push(created.attachmentId);
          if (typeof created.url !== "string") throw new BaselineFailure("no handoff URL returned");
          secrets.add(created.url);
          handoff = new URL(created.url);
        } catch (error) {
          routes[route] = skippedRoute("failed", failureKind(error));
          continue;
        }
        const handoffMs = Math.round((performance.now() - issued) * 100) / 100;
        const code = handoff.searchParams.get("code") ?? "";
        if (code) secrets.add(code);
        // The one-use code is `<attachmentId>.<secret>`; the id is what
        // release_preview_attachment needs afterwards.
        const attachmentId = code.split(".", 1)[0];
        if (attachmentId && !releases.includes(attachmentId)) releases.push(attachmentId);
        if (!code || !attachmentId) {
          routes[route] = skippedRoute("failed", "handoff URL carried no session code");
          continue;
        }
        const hostName = handoff.hostname;
        const port = Number(handoff.port || 443);
        const address = options.publicationAddress ?? hostName;
        const connect: Connect = (abort) => openTls(address, port, hostName, options.ca, abort);
        const exchangeStarted = performance.now();
        let cookie: string | null = null;
        let exchangeFailure = "";
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), options.timeoutMs);
          const stream = await connect(controller.signal).finally(() => clearTimeout(timer));
          stream.write(httpRequestBytes(`${handoff.pathname}${handoff.search}`, handoff.host));
          const head = (
            await readHead(stream, options.timeoutMs).finally(() => stream.destroy())
          ).toString("latin1");
          const status = statusFromHead(Buffer.from(head, "latin1"));
          cookie = status === 303 ? sessionCookieFromHead(head) : null;
          if (!cookie) exchangeFailure = `session exchange refused (HTTP ${status ?? "?"})`;
        } catch (error) {
          exchangeFailure = `session exchange failed (${failureKind(error)})`;
        }
        if (!cookie) {
          routes[route] = skippedRoute("failed", exchangeFailure);
          continue;
        }
        secrets.add(cookie);
        const sessionExchangeMs = Math.round((performance.now() - exchangeStarted) * 100) / 100;
        const request = httpRequestBytes(options.path, handoff.host, {
          cookie: `${PREVIEW_SESSION_COOKIE}=${cookie}`,
        });
        routes[route] = await sampleRoute(
          options,
          () => timedExchange(connect, request, options.timeoutMs),
          signal,
          { handoff: handoffMs, sessionExchange: sessionExchangeMs },
        );
      }
    }
  } finally {
    // Captured before release so lingering sockets and attachments show.
    afterSampling = await diagnostics();
    for (const attachmentId of releases) {
      await invoke("release_preview_attachment", { attachmentId }).catch(() => undefined);
    }
  }
  const afterRelease = await diagnostics();

  return {
    secrets,
    result: {
      schema: BASELINE_SCHEMA,
      label: options.label ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      client: { platform: process.platform, arch: process.arch, bun: Bun.version },
      backend: {
        scheme: options.url.protocol.replace(":", ""),
        hostKind: hostKind(options.url.hostname),
        capabilities: {
          access: capabilities.access.available,
          desktopTunnel: capabilities.surfaces.desktopTunnel.available,
          browserTopLevel: capabilities.surfaces.browserTopLevel.available,
          legacyPath: capabilities.surfaces.legacyPath.available,
          relay: capabilities.relay.available,
        },
      },
      service: {
        targetKind: service.definition.targetKind,
        transportKind: service.endpoint.transportKind,
        scheme: service.definition.scheme,
        addressFamily: service.endpoint.addressFamily,
      },
      config: {
        samples: options.samples,
        warmups: options.warmups,
        path: redactPreviewPath(options.path),
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        direct: options.direct.kind === "host" ? "explicit-host" : options.direct.kind,
      },
      routes,
      diagnostics: { before, afterSampling, afterRelease },
    },
  };
}

// ---------------------------------------------------------------------------
// Decoy: a client-local listener on the remote service's port that must
// never be reached. It logs connections, never request contents.

export interface Decoy {
  port: number;
  hosts: string[];
  connections(): number;
  requests(): number;
  close(): Promise<void>;
}

export async function startDecoy(
  port: number,
  hosts: readonly string[],
  onConnection: (count: number, host: string) => void = () => undefined,
): Promise<Decoy> {
  let connections = 0;
  let requests = 0;
  const servers: Server[] = [];
  const bound: string[] = [];
  const closeAll = () =>
    Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  // Port 0 (tests) binds the first host anywhere and the others on the same port.
  let actualPort = port;
  for (const host of hosts) {
    const server = createServer((socket) => {
      connections += 1;
      onConnection(connections, host);
      socket.on("error", () => undefined);
      socket.once("data", () => {
        requests += 1;
        socket.end(
          "HTTP/1.1 421 Misdirected Request\r\nx-service-marker: decoy\r\ncontent-length: 6\r\nconnection: close\r\n\r\ndecoy\n",
        );
      });
    });
    let listening: boolean;
    try {
      listening = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
          error.code === "EADDRNOTAVAIL" && host === "::1" ? resolve(false) : reject(error),
        );
        server.listen({ host, port: actualPort, exclusive: true }, () => resolve(true));
      });
    } catch (error) {
      await closeAll();
      throw error;
    }
    if (listening) {
      servers.push(server);
      bound.push(host);
      const address = server.address();
      if (actualPort === 0 && typeof address === "object" && address) actualPort = address.port;
    }
  }
  return {
    port: actualPort,
    hosts: bound,
    connections: () => connections,
    requests: () => requests,
    close: async () => {
      await closeAll();
    },
  };
}

// ---------------------------------------------------------------------------
// Throttle: a no-root, userspace TCP forwarder that adds one-way latency and
// a shared per-direction rate. It applies only to traffic sent to its
// listener (a plain-HTTP gateway URL), not to the whole network.

export interface ThrottleOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  latencyMs: number;
  rateKiB: number;
}

const THROTTLE_QUEUE_HIGH_WATER = 256 * 1024;

class ThrottledLink {
  private nextFree = 0;
  peakQueuedBytes = 0;
  queuedBytes = 0;
  bytes = 0;
  constructor(private readonly options: { latencyMs: number; bytesPerMs: number }) {}
  /** Departure is serialized on the shared link; delivery adds the latency. */
  schedule(length: number): number {
    const now = performance.now();
    const departure = Math.max(now, this.nextFree) + length / this.options.bytesPerMs;
    this.nextFree = departure;
    this.bytes += length;
    return departure + this.options.latencyMs;
  }
}

/**
 * One direction of a throttled connection. Chunks leave in order at their
 * scheduled time; the source is paused while more than the high-water mark
 * is queued, so the forwarder itself stays bounded. EOF is forwarded after
 * every queued byte (half-close is preserved).
 */
function throttledPipe(source: Socket, target: Socket, link: ThrottledLink) {
  const queue: Array<{ at: number; chunk: Buffer | null }> = [];
  // Account for bytes until the destination completes each write, including
  // bytes in its writable buffer rather than only the scheduling queue.
  let pending = 0;
  let ended = false;
  let stopped = false;
  let blocked = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const resume = () => {
    if (!stopped && !blocked && pending < THROTTLE_QUEUE_HIGH_WATER / 2 && source.isPaused())
      source.resume();
  };
  const pump = () => {
    timer = null;
    if (stopped || blocked) return;
    const now = performance.now();
    while (queue.length > 0 && queue[0]!.at <= now && !blocked) {
      const { chunk } = queue.shift()!;
      if (chunk === null) {
        if (!target.destroyed) target.end();
        continue;
      }
      if (target.destroyed) {
        stop();
        return;
      }
      const writable = target.write(chunk, () => {
        if (stopped) return;
        pending -= chunk.length;
        link.queuedBytes -= chunk.length;
        resume();
      });
      if (!writable) {
        blocked = true;
        source.pause();
      }
    }
    resume();
    if (!blocked && queue.length > 0)
      timer = setTimeout(pump, Math.max(0, queue[0]!.at - performance.now()));
  };
  const drain = () => {
    blocked = false;
    pump();
  };
  target.on("drain", drain);
  const enqueue = (at: number, chunk: Buffer | null) => {
    queue.push({ at, chunk });
    if (!timer && !blocked) timer = setTimeout(pump, Math.max(0, queue[0]!.at - performance.now()));
  };
  const end = () => {
    if (ended || stopped) return;
    ended = true;
    enqueue(queue.at(-1)?.at ?? performance.now(), null);
  };
  const data = (chunk: Buffer) => {
    if (stopped) return;
    pending += chunk.length;
    link.queuedBytes += chunk.length;
    link.peakQueuedBytes = Math.max(link.peakQueuedBytes, link.queuedBytes);
    enqueue(link.schedule(chunk.length), chunk);
    if (blocked || pending >= THROTTLE_QUEUE_HIGH_WATER) source.pause();
  };
  source.on("data", data);
  source.on("end", end);
  // A source that closes without a FIN still gets its queued bytes delivered.
  source.on("close", end);
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    target.off("drain", drain);
    source.off("data", data);
    source.off("end", end);
    source.off("close", end);
    link.queuedBytes -= pending;
    pending = 0;
    queue.length = 0;
  }
  return { stop };
}

export interface Throttle {
  port: number;
  stats(): { connections: number; upBytes: number; downBytes: number; peakQueuedBytes: number };
  close(): Promise<void>;
}

export async function startThrottle(options: ThrottleOptions): Promise<Throttle> {
  const bytesPerMs = (options.rateKiB * 1024) / 1000;
  const up = new ThrottledLink({ latencyMs: options.latencyMs, bytesPerMs });
  const down = new ThrottledLink({ latencyMs: options.latencyMs, bytesPerMs });
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer({ allowHalfOpen: true }, (client) => {
    connections += 1;
    const upstream = netConnect({
      host: options.targetHost,
      port: options.targetPort,
      allowHalfOpen: true,
    });
    sockets.add(client);
    sockets.add(upstream);
    const upPipe = throttledPipe(client, upstream, up);
    const downPipe = throttledPipe(upstream, client, down);
    let closed = 0;
    const onClose = (socket: Socket) => {
      sockets.delete(socket);
      closed += 1;
      if (closed === 2) {
        upPipe.stop();
        downPipe.stop();
      }
    };
    const onError = () => {
      upPipe.stop();
      downPipe.stop();
      client.destroy();
      upstream.destroy();
    };
    client.on("error", onError);
    upstream.on("error", onError);
    client.on("close", () => onClose(client));
    upstream.on("close", () => onClose(upstream));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: options.listenHost, port: options.listenPort }, () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : options.listenPort,
    stats: () => ({
      connections,
      upBytes: up.bytes,
      downBytes: down.bytes,
      peakQueuedBytes: Math.max(up.peakQueuedBytes, down.peakQueuedBytes),
    }),
    close: async () => {
      for (const socket of Array.from(sockets)) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point

function flagValues(argv: string[], known: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equals = argument.indexOf("=");
    const name = argument.startsWith("--")
      ? equals < 0
        ? argument.slice(2)
        : argument.slice(2, equals)
      : "";
    if (!known.includes(name)) throw new UsageError(`Unexpected argument: ${argument}`);
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
  }
  return values;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function runDecoy(argv: string[]): Promise<number> {
  const values = flagValues(argv, ["port", "hosts"]);
  const port = positiveInteger(values.get("port"), "--port", 1, 65_535);
  const hosts = (values.get("hosts") ?? "127.0.0.1,::1").split(",").map((host) => host.trim());
  for (const host of hosts) {
    if (!isLoopbackHost(host) || host === "0.0.0.0") {
      throw new UsageError("The decoy listens on loopback addresses only");
    }
  }
  const decoy = await startDecoy(port, hosts, (count, host) =>
    process.stderr.write(
      `[decoy] ${new Date().toISOString()} connection ${count} on ${host}:${port}\n`,
    ),
  );
  process.stderr.write(
    `[decoy] listening on ${decoy.hosts.map((host) => `${host}:${port}`).join(", ")}; Ctrl-C prints the count\n`,
  );
  await waitForSignal();
  await decoy.close();
  const summary = {
    decoy: {
      port,
      hosts: decoy.hosts,
      connections: decoy.connections(),
      requests: decoy.requests(),
    },
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return decoy.connections() === 0 ? 0 : 1;
}

async function runThrottle(argv: string[]): Promise<number> {
  const values = flagValues(argv, ["listen", "listen-host", "target", "latency-ms", "rate-kib"]);
  const target = values.get("target") ?? "";
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target);
  if (!match) throw new UsageError("--target must be host:port");
  const listenHost = values.get("listen-host") ?? "127.0.0.1";
  if (!isLoopbackHost(listenHost) || listenHost === "0.0.0.0") {
    throw new UsageError("The throttle listens on loopback addresses only");
  }
  const throttle = await startThrottle({
    listenHost,
    listenPort: positiveInteger(values.get("listen"), "--listen", 0, 65_535),
    targetHost: match[1]!,
    targetPort: positiveInteger(match[2], "--target port", 1, 65_535),
    latencyMs: values.has("latency-ms")
      ? positiveInteger(values.get("latency-ms"), "--latency-ms", 0, 10_000)
      : 40,
    rateKiB: values.has("rate-kib")
      ? positiveInteger(values.get("rate-kib"), "--rate-kib", 1, 1_048_576)
      : 256,
  });
  process.stderr.write(
    `[throttle] listening on ${listenHost}:${throttle.port}; point the client at http://${listenHost}:${throttle.port}; Ctrl-C prints totals\n`,
  );
  await waitForSignal();
  await throttle.close();
  process.stdout.write(`${JSON.stringify({ throttle: throttle.stats() })}\n`);
  return 0;
}

/** Highest value seen per gauge, for the throttled-link and reconnect runs. */
export function updatePeaks(
  peaks: Record<string, number>,
  sample: unknown,
): Record<string, number> {
  const gauges = (sample as { metrics?: { gauges?: Record<string, unknown> } } | null)?.metrics
    ?.gauges;
  const access = (sample as { access?: Record<string, unknown> } | null)?.access;
  const values: Record<string, unknown> = {
    ...gauges,
    "access.attachments": access?.attachments,
    "access.resources": access?.resources,
  };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "number") peaks[name] = Math.max(peaks[name] ?? value, value);
  }
  return peaks;
}

async function runWatch(argv: string[]): Promise<number> {
  const options = parseBaselineArgs(argv, process.env);
  const interval = options.intervalMs || 1_000;
  const peaks: Record<string, number> = {};
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const secrets = [options.token];
  while (!stopped) {
    const sample = sanitizeDiagnostics(
      await invokeCommand(options, "get_preview_diagnostics", {}).catch(() => null),
    );
    updatePeaks(peaks, sample);
    const line = JSON.stringify({ at: new Date().toISOString(), diagnostics: sample });
    assertNoSecrets(line, secrets);
    process.stdout.write(`${line}\n`);
    for (let waited = 0; waited < interval && !stopped; waited += 100) await Bun.sleep(100);
  }
  const summary = JSON.stringify({ peaks });
  assertNoSecrets(summary, secrets);
  process.stdout.write(`${summary}\n`);
  return 0;
}

/** Splits subcommand-only flags from the ones `parseBaselineArgs` understands. */
export function takeFlags(
  argv: string[],
  names: readonly string[],
): { values: Map<string, string>; rest: string[] } {
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const equals = argument.indexOf("=");
    const name = argument.startsWith("--")
      ? argument.slice(2, equals < 0 ? undefined : equals)
      : "";
    if (!names.includes(name)) {
      rest.push(argument);
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    values.set(name, value);
  }
  return { values, rest };
}

const TUNNEL_GAUGES = ["tunnel.queued_bytes", "tunnel.sockets", "tunnel.active"] as const;

/**
 * A slow reader over the real desktop tunnel: one GET (normally the
 * fixture's `/endless`), read at `--read-kib` per second for `--seconds`,
 * while the backend's tunnel gauges are sampled once a second. Used on the
 * throttled link to show that backend queues stay bounded. Prints byte
 * counts and gauges only.
 */
async function runDownload(argv: string[]): Promise<number> {
  const { values, rest } = takeFlags(argv, ["seconds", "read-kib"]);
  const seconds = values.has("seconds")
    ? positiveInteger(values.get("seconds"), "--seconds", 1, 3_600)
    : 30;
  const readKiB = values.has("read-kib")
    ? positiveInteger(values.get("read-kib"), "--read-kib", 1, 1_048_576)
    : 64;
  const readBytesPerTick = Math.max(1, Math.floor((readKiB * 1024) / 10));
  const options = parseBaselineArgs(rest, process.env);
  const secrets = new Set<string>([options.token]);
  const invoke = (command: string, args: Record<string, unknown> = {}) =>
    invokeCommand(options, command, args);
  const snapshot = (await invoke("get_preview_services", {})) as PreviewRegistrySnapshot;
  const service = selectService(snapshot, options);
  const attachment = (await invoke("create_preview_attachment", {
    serviceId: service.definition.serviceId,
    surface: "desktop-tunnel",
    clientKey: "preview-latency-baseline",
  })) as PreviewAttachmentDescriptor;
  const credential = attachment.tunnel?.credential;
  if (credential) secrets.add(credential);
  const peaks: Record<string, number> = {};
  const print = (value: unknown) => {
    const line = JSON.stringify(value);
    assertNoSecrets(line, secrets);
    process.stdout.write(`${line}\n`);
  };
  let stream: Duplex | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!credential) throw new BaselineFailure("the attachment carried no tunnel credential");
    const tunnelUrl = new URL(PREVIEW_TUNNEL_PATH, options.url);
    tunnelUrl.protocol = options.url.protocol === "https:" ? "wss:" : "ws:";
    stream = await openPreviewTunnel({
      url: tunnelUrl.toString(),
      attachmentId: attachment.attachmentId,
      credential,
      connectTimeoutMs: options.timeoutMs,
      handshakeTimeoutMs: options.timeoutMs,
      ...(options.ca ? { ca: caList(options.ca)!.join("\n") } : {}),
    });
    const open = stream;
    let ended = false;
    let failure: string | null = null;
    open.on("end", () => (ended = true));
    open.on("error", (error) => (failure = failureKind(error)));
    open.pause();
    open.write(httpRequestBytes(options.path, `localhost:${attachment.applicationPort}`));
    const started = performance.now();
    let received = 0;
    let status: number | null = null;
    for (let tick = 1; tick <= seconds * 10 && !stopped && !ended && !failure; tick += 1) {
      await Bun.sleep(100);
      let budget = readBytesPerTick;
      while (budget > 0) {
        const chunk = open.read() as Buffer | null;
        if (!chunk) break;
        if (chunk.length > budget) open.unshift(chunk.subarray(budget));
        const taken = Math.min(chunk.length, budget);
        if (status === null) status = statusFromHead(chunk);
        received += taken;
        budget -= taken;
      }
      if (tick % 10 === 0) {
        const sample = sanitizeDiagnostics(
          await invoke("get_preview_diagnostics").catch(() => null),
        );
        updatePeaks(peaks, sample);
        const gauges =
          (sample as { metrics?: { gauges?: Record<string, number> } } | null)?.metrics?.gauges ??
          {};
        print({
          elapsedS: Math.round((performance.now() - started) / 100) / 10,
          receivedBytes: received,
          backend: Object.fromEntries(TUNNEL_GAUGES.map((name) => [name, gauges[name] ?? null])),
        });
      }
    }
    print({
      download: {
        status,
        receivedBytes: received,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        ended,
        failure,
        peaks: Object.fromEntries(TUNNEL_GAUGES.map((name) => [name, peaks[name] ?? null])),
      },
    });
    return failure ? 2 : 0;
  } finally {
    stream?.destroy();
    await invoke("release_preview_attachment", { attachmentId: attachment.attachmentId }).catch(
      () => undefined,
    );
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "decoy") return runDecoy(argv.slice(1));
  if (argv[0] === "throttle") return runThrottle(argv.slice(1));
  if (argv[0] === "watch") return runWatch(argv.slice(1));
  if (argv[0] === "download") return runDownload(argv.slice(1));
  const options = parseBaselineArgs(argv, process.env);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { result, secrets } = await runBaseline(options, controller.signal);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    const table = formatTable(result);
    assertNoSecrets(json, secrets);
    assertNoSecrets(table, secrets);
    process.stdout.write(json);
    process.stderr.write(`\n${table}`);
    return ROUTES.some((route) => result.routes[route].status === "failed") ? 2 : 0;
  } catch (error) {
    // UsageError and BaselineFailure messages are fixed text; anything else
    // is reduced to an error code so no server text can reach the terminal.
    const message =
      error instanceof UsageError || error instanceof BaselineFailure
        ? error.message
        : failureKind(error);
    process.stderr.write(`[preview-baseline] ${message}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `[preview-baseline] ${error instanceof UsageError ? `${error.message}\n\n${USAGE}` : failureKind(error)}\n`,
      );
      process.exit(1);
    },
  );
}
