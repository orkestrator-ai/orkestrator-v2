/**
 * Offline check: does a pinned Claude Code still refresh a login the way
 * `refreshHostClaudeLogin` relies on? Rerun it after every Claude Code bump
 * (docs/development/upgrade-agents.md, "Re-check OAuth refresh-token
 * rotation"); the method is task 5 of to-do 0018 (retired 2026-11-11; `git show
 * 498b68766:docs/todo/containers-and-environments/0018-container-network-and-credential-isolation.md`).
 *
 * The login is fake: made-up `sk-ant-…` strings in a temporary
 * `CLAUDE_CONFIG_DIR` and `HOME`, so the user's own `~/.claude` is never read
 * or written. The CLI runs the refresher's exact arguments
 * (`CLAUDE_HOST_REFRESH_ARGS`) plus `--debug-file`. `HTTPS_PROXY` points at a
 * local logger that records every `CONNECT` target and refuses it, so nothing
 * leaves the machine and the hosts the CLI tries are observed directly. For
 * full isolation run it in a namespace with only loopback:
 *
 *   unshare -rn sh -c 'ip link set lo up && bun scripts/claude-host-refresh-trigger-probe.ts --claude <binary>'
 *
 * Cases (the 2026-11-06 table in that task, run there on 2.1.314):
 * - A–E: the API unreachable (refused by the proxy), so no 401 is possible
 *   and a token-host contact can only be a proactive refresh.
 * - F–I: `ANTHROPIC_BASE_URL` at a local fake Messages API that answers every
 *   request with one fixed error (404 for an unknown model, as the real API
 *   answers one, or 401).
 *
 * Expected, and checked: a refreshable login inside its last five minutes,
 * or expired, contacts the token host first (A, E, F); one with two hours
 * left does not (B, G) unless the API answers 401 (H); an access-only login
 * never does (C, D, I); with the API answering, the run exits 1; and the fake
 * credential file is never rewritten (every refresh is refused). Where the
 * fake API is up (F–I) the CLI must also send it a `POST /v1/messages` carrying
 * the fake access token as its bearer, so a CLI that refuses the command or the
 * login locally cannot pass. A run that could not be started, or that died on a
 * signal, is an infrastructure failure, never an acceptable "no success". An
 * unknown or empty `--cases` selection is refused before anything runs.
 *
 *   bun scripts/claude-host-refresh-trigger-probe.ts --claude <binary> [--json] [--cases A,F]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_PINNED_RUNTIME_ENV } from "../packages/protocol/src/terminal-agent-launch";
import {
  CLAUDE_HOST_REFRESH_ARGS,
  CLAUDE_HOST_REFRESH_TIMEOUT_MS,
} from "../apps/backend/src/core/claude-host-login-refresh-command";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type ApiMode = "unreachable" | "404" | "401";

export interface ProbeCase {
  name: string;
  refreshable: boolean;
  /** Milliseconds from now to `expiresAt`; negative when already expired. */
  expiresInMs: number;
  api: ApiMode;
  expectTokenHost: boolean;
  /** `1` when the API answers; `timeout` or a non-zero exit when it cannot. */
  expectExit: "1" | "no-success";
}

export const PROBE_CASES: readonly ProbeCase[] = [
  {
    name: "A",
    refreshable: true,
    expiresInMs: 2 * MINUTE_MS,
    api: "unreachable",
    expectTokenHost: true,
    expectExit: "no-success",
  },
  {
    name: "B",
    refreshable: true,
    expiresInMs: 2 * HOUR_MS,
    api: "unreachable",
    expectTokenHost: false,
    expectExit: "no-success",
  },
  {
    name: "C",
    refreshable: false,
    expiresInMs: 2 * MINUTE_MS,
    api: "unreachable",
    expectTokenHost: false,
    expectExit: "no-success",
  },
  {
    name: "D",
    refreshable: false,
    expiresInMs: -HOUR_MS,
    api: "unreachable",
    expectTokenHost: false,
    expectExit: "no-success",
  },
  {
    name: "E",
    refreshable: true,
    expiresInMs: -HOUR_MS,
    api: "unreachable",
    expectTokenHost: true,
    expectExit: "no-success",
  },
  {
    name: "F",
    refreshable: true,
    expiresInMs: 2 * MINUTE_MS,
    api: "404",
    expectTokenHost: true,
    expectExit: "1",
  },
  {
    name: "G",
    refreshable: true,
    expiresInMs: 2 * HOUR_MS,
    api: "404",
    expectTokenHost: false,
    expectExit: "1",
  },
  {
    name: "H",
    refreshable: true,
    expiresInMs: 2 * HOUR_MS,
    api: "401",
    expectTokenHost: true,
    expectExit: "1",
  },
  {
    name: "I",
    refreshable: false,
    expiresInMs: 2 * HOUR_MS,
    api: "401",
    expectTokenHost: false,
    expectExit: "1",
  },
];

/**
 * Hosts that serve Claude's OAuth token endpoint. 2.1.314 and 2.1.319 use
 * `platform.claude.com`; the others are earlier or alternative issuers.
 */
export const TOKEN_HOSTS: ReadonlySet<string> = new Set([
  "platform.claude.com",
  "console.anthropic.com",
  "claude.ai",
]);

/** The Messages API host, reached through the proxy when no base URL is set. */
const API_HOST = "api.anthropic.com";

/** The request the refresher's command sends; recorded as `METHOD /path`. */
export const MESSAGES_REQUEST = "POST /v1/messages";

export interface ProbeEvent {
  atMs: number;
  kind: "connect" | "api";
  /** `host:port` for a proxy request; `METHOD /path` for the fake API. */
  target: string;
}

export interface CaseResult {
  name: string;
  hostsTried: string[];
  tokenHostContacted: boolean;
  /** Whether the first token-host contact came before the first API request. */
  tokenHostBeforeApi: boolean | null;
  apiRequests: string[];
  /** A Messages request to the fake API carried the fake access token as its bearer. */
  usedOAuthLogin: boolean;
  exit: string;
  elapsedMs: number;
  credentialFileUnchanged: boolean;
  refreshDebugLines: string[];
  matches: boolean;
  mismatches: string[];
}

function fakeCredentials(probe: ProbeCase, nowMs: number): { text: string; accessToken: string } {
  const accessToken = `sk-ant-oat01-probe-${probe.name.toLowerCase()}-not-a-real-token`;
  const login: Record<string, unknown> = {
    accessToken,
    expiresAt: nowMs + probe.expiresInMs,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "pro",
  };
  if (probe.refreshable) login.refreshToken = "sk-ant-ort01-probe-not-a-real-token";
  return { text: JSON.stringify({ claudeAiOauth: login }), accessToken };
}

/** Strips anything token-shaped from a debug line before it is reported. */
export function scrubLine(line: string): string {
  return line
    .replace(/sk-ant-[\w-]+/g, "<token>")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "<jwt>")
    .trim()
    .slice(0, 200);
}

export function hostOf(target: string): string {
  return target.replace(/:\d+$/, "").toLowerCase();
}

/** Compares one observed case with what the refresher relies on. */
export function judge(
  probe: ProbeCase,
  observed: Pick<
    CaseResult,
    | "tokenHostContacted"
    | "tokenHostBeforeApi"
    | "exit"
    | "credentialFileUnchanged"
    | "apiRequests"
    | "usedOAuthLogin"
  >,
): string[] {
  const mismatches: string[] = [];
  // Not a verdict on the CLI at all: the run never happened or was killed from outside.
  if (observed.exit === "spawn-error" || observed.exit.startsWith("signal")) {
    mismatches.push(`the CLI did not run to an outcome (${observed.exit})`);
  }
  if (observed.tokenHostContacted !== probe.expectTokenHost) {
    mismatches.push(
      probe.expectTokenHost
        ? "expected a token-host contact, saw none"
        : "unexpected token-host contact",
    );
  }
  if (
    probe.expectTokenHost &&
    probe.api !== "401" &&
    observed.tokenHostContacted &&
    observed.tokenHostBeforeApi === false
  ) {
    mismatches.push("the refresh came after an API request, so it was not proactive");
  }
  if (probe.expectExit === "1" && observed.exit !== "1") {
    mismatches.push(`expected exit 1, saw ${observed.exit}`);
  }
  if (probe.expectExit === "no-success" && observed.exit === "0") {
    mismatches.push("exited 0 with no reachable API");
  }
  if (probe.api !== "unreachable") {
    // Without this a CLI that rejects the command or the login before any
    // request would pass G and I on its exit code alone.
    if (!observed.apiRequests.includes(MESSAGES_REQUEST)) {
      mismatches.push(`expected ${MESSAGES_REQUEST} to the fake API, saw none`);
    } else if (!observed.usedOAuthLogin) {
      mismatches.push("the Messages request did not carry the fake OAuth access token");
    }
  }
  if (!observed.credentialFileUnchanged) mismatches.push("the fake credential file was rewritten");
  return mismatches;
}

/** A proxy that records each request's target and refuses every one. */
function refusingProxy(events: ProbeEvent[], startedAt: number): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let head = "";
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n");
      if (end === -1) {
        if (head.length > 8_192) socket.destroy();
        return;
      }
      const [method = "", target = ""] = head.slice(0, end).split(" ");
      const hostPort =
        method === "CONNECT"
          ? target
          : (() => {
              try {
                const url = new URL(target);
                return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
              } catch {
                return target;
              }
            })();
      events.push({ atMs: Date.now() - startedAt, kind: "connect", target: hostPort });
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.removeAllListeners("data");
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

function runClaude(
  binary: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<{ exit: string; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(binary, args, { env, cwd, stdio: ["ignore", "ignore", "ignore"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done({ exit: "spawn-error", elapsedMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({
        exit: timedOut ? "timeout" : code !== null ? String(code) : `signal ${signal}`,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

async function runCase(binary: string, probe: ProbeCase, timeoutMs: number): Promise<CaseResult> {
  const startedAt = Date.now();
  const events: ProbeEvent[] = [];
  const credentials = fakeCredentials(probe, startedAt);
  const proxy = await refusingProxy(events, startedAt);
  let bearerSeen = false;
  const api =
    probe.api === "unreachable"
      ? undefined
      : Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            const url = new URL(request.url);
            const target = `${request.method} ${url.pathname}`;
            events.push({ atMs: Date.now() - startedAt, kind: "api", target });
            if (
              target === MESSAGES_REQUEST &&
              request.headers.get("authorization") === `Bearer ${credentials.accessToken}`
            )
              bearerSeen = true;
            return probe.api === "401"
              ? Response.json(
                  {
                    type: "error",
                    error: { type: "authentication_error", message: "OAuth token is invalid" },
                  },
                  { status: 401 },
                )
              : Response.json(
                  {
                    type: "error",
                    error: { type: "not_found_error", message: "model: orkestrator-login-refresh" },
                  },
                  { status: 404 },
                );
          },
        });

  const root = mkdtempSync(join(tmpdir(), `claude-trigger-probe-${probe.name}-`));
  try {
    const home = join(root, "home");
    const config = join(root, "config");
    const work = join(root, "work");
    for (const dir of [home, config, work]) mkdirSync(dir, { mode: 0o700 });
    const credentialFile = join(config, ".credentials.json");
    writeFileSync(credentialFile, credentials.text, { mode: 0o600 });
    const debugFile = join(root, "debug.log");
    const address = proxy.address();
    const proxyUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      CLAUDE_CONFIG_DIR: config,
      ...CLAUDE_PINNED_RUNTIME_ENV,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ...(api ? { ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}` } : {}),
    };
    const run = await runClaude(
      binary,
      [...CLAUDE_HOST_REFRESH_ARGS, "--debug-file", debugFile],
      env,
      work,
      timeoutMs,
    );

    let debug = "";
    try {
      debug = readFileSync(debugFile, "utf8");
    } catch {
      // No debug file: reported as no lines.
    }
    const refreshDebugLines = debug
      .split("\n")
      .filter((line) =>
        /oauth refresh|refresh(?:ing)? (?:the )?(?:oauth )?token|token refresh/i.test(line),
      )
      .map(scrubLine)
      .slice(0, 12);
    const firstToken = events.find(
      (event) => event.kind === "connect" && TOKEN_HOSTS.has(hostOf(event.target)),
    );
    const firstApi = events.find(
      (event) =>
        event.kind === "api" || (event.kind === "connect" && hostOf(event.target) === API_HOST),
    );
    const observed = {
      tokenHostContacted: firstToken !== undefined,
      tokenHostBeforeApi: firstToken ? (firstApi ? firstToken.atMs <= firstApi.atMs : true) : null,
      exit: run.exit,
      credentialFileUnchanged: readFileSync(credentialFile, "utf8") === credentials.text,
      apiRequests: [
        ...new Set(events.filter((event) => event.kind === "api").map((event) => event.target)),
      ],
      usedOAuthLogin: bearerSeen,
    };
    const mismatches = judge(probe, observed);
    return {
      name: probe.name,
      hostsTried: [
        ...new Set(
          events.filter((event) => event.kind === "connect").map((event) => hostOf(event.target)),
        ),
      ],
      elapsedMs: run.elapsedMs,
      refreshDebugLines,
      matches: mismatches.length === 0,
      mismatches,
      ...observed,
    };
  } finally {
    await api?.stop(true);
    await new Promise((done) => proxy.close(() => done(undefined)));
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The cases a `--cases` list names, in table order; every case when there is
 * no list. An unknown name or an empty list throws, so a mistyped selection
 * cannot report a pass for cases that never ran.
 */
export function selectCases(requested: readonly string[] | undefined): ProbeCase[] {
  if (requested === undefined) return [...PROBE_CASES];
  const known = new Set(PROBE_CASES.map((probe) => probe.name));
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `--cases names unknown case${unknown.length === 1 ? "" : "s"} ${unknown.map((name) => JSON.stringify(name)).join(", ")}; known: ${[...known].join(",")}`,
    );
  }
  const selected = PROBE_CASES.filter((probe) => requested.includes(probe.name));
  if (selected.length === 0) throw new Error("--cases selects no case");
  return selected;
}

export function parseArgs(argv: string[]): {
  claude: string;
  json: boolean;
  cases: ProbeCase[];
  timeoutMs: number;
} {
  let claude: string | undefined;
  let json = false;
  let cases: string[] | undefined;
  let timeoutMs = CLAUDE_HOST_REFRESH_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (flag !== "--claude" && flag !== "--cases" && flag !== "--timeout-ms") {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
    const value = argv[index + 1];
    // `--cases ""` must not fall back to every case, so only a missing value is refused here.
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === "--claude") claude = resolve(value);
    else if (flag === "--cases")
      cases = value
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter((entry) => entry.length > 0);
    else timeoutMs = Number(value);
  }
  if (!claude) throw new Error("--claude <path to the pinned claude binary> is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("--timeout-ms must be positive");
  return { claude, json, cases: selectCases(cases), timeoutMs };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const version = await new Promise<string>((done) => {
    const child = spawn(options.claude, ["--version"], {
      env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...CLAUDE_PINNED_RUNTIME_ENV },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", () => done(output.trim()));
    child.on("error", () => done("unknown"));
  });
  const selected = options.cases;
  // Each case has its own proxy, API and directories, so they run together:
  // the unreachable-API cases otherwise cost the refresher's whole budget each.
  const results = await Promise.all(
    selected.map((probe) => runCase(options.claude, probe, options.timeoutMs)),
  );
  const allMatch = results.every((result) => result.matches);
  if (options.json) {
    console.log(JSON.stringify({ claude: version, allMatch, results }, null, 2));
  } else {
    console.log(`Claude Code ${version}`);
    for (const result of results) {
      const probe = PROBE_CASES.find((entry) => entry.name === result.name)!;
      console.log(
        [
          `\n[${result.name}] ${probe.refreshable ? "refreshable" : "access-only"}, ${Math.round(probe.expiresInMs / MINUTE_MS)} min to expiry, API ${probe.api}`,
          `  token host contacted: ${result.tokenHostContacted}${result.tokenHostContacted ? ` (before any API request: ${result.tokenHostBeforeApi})` : ""}`,
          `  hosts tried through the proxy: ${result.hostsTried.join(", ") || "(none)"}`,
          `  fake API requests: ${result.apiRequests.join(", ") || "(none)"}${result.apiRequests.length > 0 ? `; Messages request carried the fake bearer: ${result.usedOAuthLogin}` : ""}`,
          `  exit: ${result.exit} after ${(result.elapsedMs / 1000).toFixed(1)} s; credential file unchanged: ${result.credentialFileUnchanged}`,
          `  refresh debug lines: ${result.refreshDebugLines.join(" | ") || "(none)"}`,
          `  ${result.matches ? "as expected" : `MISMATCH: ${result.mismatches.join("; ")}`}`,
        ].join("\n"),
      );
    }
    console.log(
      `\n${allMatch ? "Every case matched." : "Some cases did not match; re-read refreshHostClaudeLogin."}`,
    );
  }
  if (!allMatch) process.exitCode = 1;
}

if (import.meta.main) await main();
