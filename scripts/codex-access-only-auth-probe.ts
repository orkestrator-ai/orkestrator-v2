/**
 * Offline check: what a pinned Codex does with the access-only `auth.json` a
 * coordinator home receives (docs/todo/agent-engines/0722-per-machine-agent-accounts.md,
 * "Needs verification"). Rerun it after a Codex bump.
 *
 * The login is synthetic: unsigned JWTs and a made-up refresh token, reduced
 * by the product's own `restrictCodexAuthSnapshot` (refresh token blanked,
 * `last_refresh` set to now). No real account, token or OpenAI endpoint is
 * involved: `chatgpt_base_url` and `CODEX_REFRESH_TOKEN_URL_OVERRIDE` point at
 * a local server that records each request's method and path, whether it
 * carried the synthetic access token, and whether a refresh sent a refresh
 * token. Every backend path answers 404 (401 in `rejected`) and a refresh
 * answers `invalid_grant`, so no turn runs; Codex stops at its workspace
 * routing discovery, after it has read and, if it wants to, refreshed the
 * login.
 *
 * Cases:
 * - `fresh`: the coordinator's form, the access token three days from expiry.
 * - `stale-stamp`: the same with `last_refresh` nine days old.
 * - `near-expiry`: the access token three minutes from expiry, inside Codex's
 *   own proactive window. The positive control: a refresh is expected here.
 * - `rejected`: the fresh form with every backend path answering 401.
 *
 *   bun scripts/codex-access-only-auth-probe.ts --codex <binary> [--json]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { restrictCodexAuthSnapshot } from "../packages/protocol/src/login-snapshots";

const CASES = ["fresh", "stale-stamp", "near-expiry", "rejected"] as const;
type CaseName = (typeof CASES)[number];

interface RecordedRequest {
  method: string;
  path: string;
  bearerIsAccessToken: boolean;
  refreshTokenSent?: "empty" | "present";
}

interface CaseResult {
  name: CaseName;
  loginStatus: string;
  requests: RecordedRequest[];
  refreshRequests: number;
  refreshTokenSent: "empty" | "present" | "none";
  /** Backend paths whose requests carried the synthetic access token. */
  authenticatedPaths: string[];
  authFileUnchanged: boolean;
  refreshTokenAfter: "empty" | "present" | "missing";
  execExit: number | null;
  execTailHint: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseArgs(argv: string[]): { codex: string; json: boolean } {
  let codex: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--codex" && value) {
      codex = resolve(value);
      index += 1;
    } else if (argv[index] === "--json") json = true;
  }
  if (!codex) throw new Error("--codex <path to the pinned codex binary> is required");
  return { codex, json };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function syntheticJwt(claims: Record<string, unknown>): string {
  return `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url(claims)}.c3ludGhldGlj`;
}

/** A complete ChatGPT login as `codex login` writes it, every value made up. */
function syntheticLogin(nowMs: number, expiresInMs: number) {
  const exp = Math.floor((nowMs + expiresInMs) / 1000);
  const auth = {
    chatgpt_plan_type: "plus",
    chatgpt_account_id: "00000000-0000-4000-8000-000000000000",
    chatgpt_user_id: "user-synthetic",
  };
  const accessToken = syntheticJwt({ exp, "https://api.openai.com/auth": auth });
  const idToken = syntheticJwt({
    exp,
    email: "probe@example.invalid",
    "https://api.openai.com/auth": auth,
  });
  const text = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: "synthetic-refresh-token",
      account_id: auth.chatgpt_account_id,
    },
    last_refresh: new Date(nowMs - 9 * DAY_MS).toISOString(),
  });
  return { text, accessToken };
}

/** The coordinator's `auth.json` for one case, built by the product's own reduction. */
function caseAuth(name: CaseName, nowMs: number) {
  const login = syntheticLogin(nowMs, name === "near-expiry" ? 3 * MINUTE_MS : 3 * DAY_MS);
  const restricted = restrictCodexAuthSnapshot(login.text, nowMs);
  if (!("text" in restricted)) throw new Error(`withheld: ${restricted.withheld}`);
  let text = restricted.text;
  if (name === "stale-stamp") {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    parsed.last_refresh = new Date(nowMs - 9 * DAY_MS).toISOString();
    text = JSON.stringify(parsed);
  }
  return { text, accessToken: login.accessToken };
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

/** A short, credential-free hint of how the run ended. */
function tailHint(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /error|refresh|sign in|log in|login|401|unauthor/i.test(line));
  return (lines.at(-1) ?? "").replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "<jwt>").slice(0, 240);
}

function refreshTokenIn(body: string): unknown {
  try {
    return (JSON.parse(body) as { refresh_token?: unknown }).refresh_token;
  } catch {
    return new URLSearchParams(body).get("refresh_token");
  }
}

async function runCase(codex: string, name: CaseName): Promise<CaseResult> {
  const auth = caseAuth(name, Date.now());
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: RecordedRequest = {
        method: request.method,
        path: url.pathname,
        bearerIsAccessToken: request.headers.get("authorization") === `Bearer ${auth.accessToken}`,
      };
      requests.push(record);
      if (url.pathname === "/oauth/token") {
        const token = refreshTokenIn(await request.text());
        record.refreshTokenSent = typeof token === "string" && token !== "" ? "present" : "empty";
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (name === "rejected") {
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });

  const home = mkdtempSync(join(tmpdir(), "codex-access-only-"));
  const work = mkdtempSync(join(tmpdir(), "codex-access-only-work-"));
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    writeFileSync(join(home, "auth.json"), auth.text, { mode: 0o600 });
    writeFileSync(
      join(home, "config.toml"),
      [
        `chatgpt_base_url = "${origin}/backend-api/"`,
        `cli_auth_credentials_store = "file"`,
        `[analytics]`,
        `enabled = false`,
        ``,
      ].join("\n"),
    );
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      CODEX_HOME: home,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${origin}/oauth/token`,
      NO_COLOR: "1",
    };
    const status = await run(codex, ["login", "status"], env, 20_000);
    const exec = await run(
      codex,
      ["exec", "--skip-git-repo-check", "--cd", work, "--ephemeral", "Reply with OK."],
      env,
      45_000,
    );
    const after = readFileSync(join(home, "auth.json"), "utf8");
    let refreshTokenAfter: CaseResult["refreshTokenAfter"] = "missing";
    try {
      const token = (JSON.parse(after) as { tokens?: { refresh_token?: unknown } }).tokens
        ?.refresh_token;
      if (typeof token === "string") refreshTokenAfter = token === "" ? "empty" : "present";
    } catch {
      // Reported as missing.
    }
    const refreshes = requests.filter((entry) => entry.path === "/oauth/token");
    return {
      name,
      loginStatus: status.output.trim().split("\n").at(-1)?.slice(0, 120) ?? "",
      requests,
      refreshRequests: refreshes.length,
      refreshTokenSent: refreshes.some((entry) => entry.refreshTokenSent === "present")
        ? "present"
        : refreshes.length > 0
          ? "empty"
          : "none",
      authenticatedPaths: [
        ...new Set(
          requests
            .filter((entry) => entry.path.startsWith("/backend-api/") && entry.bearerIsAccessToken)
            .map((entry) => entry.path),
        ),
      ],
      authFileUnchanged: after === auth.text,
      refreshTokenAfter,
      execExit: exec.code,
      execTailHint: tailHint(exec.output),
    };
  } finally {
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
const version = await run(options.codex, ["--version"], { PATH: process.env.PATH ?? "" }, 10_000);
const results: CaseResult[] = [];
for (const name of CASES) results.push(await runCase(options.codex, name));
if (options.json) {
  console.log(JSON.stringify({ codex: version.output.trim(), results }, null, 2));
} else {
  console.log(version.output.trim());
  for (const result of results) {
    const paths = [...new Set(result.requests.map((entry) => `${entry.method} ${entry.path}`))];
    console.log(
      [
        `\n[${result.name}] login status: ${result.loginStatus}`,
        `  refresh requests: ${result.refreshRequests} (refresh token sent: ${result.refreshTokenSent})`,
        `  sent with the access token: ${result.authenticatedPaths.join(", ") || "(none)"}`,
        `  auth.json unchanged: ${result.authFileUnchanged}; refresh_token after: ${result.refreshTokenAfter}`,
        `  exec exit: ${result.execExit}; last error line: ${result.execTailHint || "(none)"}`,
        `  endpoints: ${paths.join(", ") || "(none)"}`,
      ].join("\n"),
    );
  }
}
