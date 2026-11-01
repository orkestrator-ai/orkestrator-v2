/**
 * The automatic-switching resend, end to end except for the provider's servers.
 *
 * Everything here is the shipped code: a real `OrkestratorBackend`, the real
 * local-bridge start and replacement, the bridges' built `dist`, and the pinned
 * Claude and Codex CLIs writing real transcripts into the shared directories.
 * Only the far side of the network is scripted: the model endpoint the CLI calls
 * and the two usage endpoints the backend reads. So it costs no billed turn, uses
 * no real login, and can show what a mocked provider cannot: a conversation
 * carried from one bridge process and account to the next.
 *
 * It says nothing about the provider's real words or real timing. Those stay in
 * docs/todo/agent-engines/1250-automatic-account-switching-live-checks.md.
 *
 * Run as its own process (`account-switch-resend-live.test.ts`), because it points
 * HOME at a throwaway directory and replaces the global `fetch`.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export type StackPlatform = "claude" | "codex";

export const STACK_ACCOUNT_NAMES = ["soonest", "later"] as const;
export type StackAccountName = (typeof STACK_ACCOUNT_NAMES)[number];

/** What the scripted provider does with a model call on this account. */
export type ModelBehavior = "refuse" | "reply";

export interface ModelCall {
  account: StackAccountName | "unknown";
  /** Every piece of user-authored text the CLI sent, in order. */
  userTexts: string[];
  refused: boolean;
}

export interface WeeklyReading {
  weeklyUsedPercent: number;
  fiveHourUsedPercent?: number;
}

export interface StackProvider {
  calls: ModelCall[];
  behavior: Record<StackAccountName, ModelBehavior>;
  readings: Record<StackAccountName, WeeklyReading>;
  /** Which limit a Claude refusal claims. The CLI words its error from this. */
  refusalClaim: "seven_day" | "five_hour";
  /** Applied the moment an account refuses, so no forced read can see the reading before it. */
  onRefusal?: (account: StackAccountName) => void;
  firstRefusalAt?: number;
  usageReads: Array<{ account: StackAccountName; at: number }>;
}

const WEEK_RESETS = {
  soonest: 2 * 24 * 3_600_000,
  later: 5 * 24 * 3_600_000,
} satisfies Record<StackAccountName, number>;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A fixed date far ahead, so a login and the map that recognises it hold the same token. */
const FIXTURE_TOKEN_EXPIRES_AT = Date.parse("2099-01-01T00:00:00Z");

/** An unsigned JWT: it only has to parse, because every server that reads it is scripted here. */
function fixtureCodexToken(name: StackAccountName): string {
  return `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url({
    exp: Math.floor(FIXTURE_TOKEN_EXPIRES_AT / 1000),
    email: `${name}@example.com`,
    "https://api.openai.com/auth": {
      chatgpt_account_id: `fixture-${name}`,
      chatgpt_plan_type: "pro",
    },
  })}.Zml4dHVyZQ`;
}

function claudeToken(name: StackAccountName): string {
  return `fixture-claude-${name}`;
}

export function fixtureToken(platform: StackPlatform, name: StackAccountName): string {
  return platform === "claude" ? claudeToken(name) : fixtureCodexToken(name);
}

function accountOfRequest(
  tokens: Map<string, StackAccountName>,
  request: Request,
): StackAccountName | "unknown" {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return tokens.get(bearer) ?? "unknown";
}

function claudeUserTexts(body: { messages?: unknown }): string[] {
  const texts: string[] = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user") continue;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
  }
  return texts;
}

function codexUserTexts(body: { input?: unknown }): string[] {
  const texts: string[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" || !Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
      if (block.type === "input_text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return texts;
}

const FIXTURE_REPLY = "Fixture reply.";

function sse(events: Array<{ type: string } & Record<string, unknown>>): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function claudeReply(id: number): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: FIXTURE_REPLY } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

/** The refusal the Anthropic API sends for a plan limit; the CLI words the user-facing text. */
function claudeRefusal(claim: StackProvider["refusalClaim"]): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Plan limit reached." },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(Math.floor((Date.now() + 86_400_000) / 1000)),
        "anthropic-ratelimit-unified-representative-claim": claim,
      },
    },
  );
}

/** The events of one Responses turn, over Codex's websocket. */
function codexReplyEvents(id: number): Array<{ type: string } & Record<string, unknown>> {
  return [
    { type: "response.created", response: { id: `resp_${id}` } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        content: [{ type: "output_text", text: FIXTURE_REPLY, annotations: [] }],
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

/** The refusal ChatGPT's Codex endpoint sends; Codex words the user-facing text. */
function codexRefusalFrame(): Record<string, unknown> {
  return {
    type: "error",
    status: 429,
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      plan_type: "pro",
      resets_at: Math.floor((Date.now() + 86_400_000) / 1000),
    },
  };
}

/**
 * The model endpoint. It answers every call, so a CLI's incidental calls (a title,
 * a token count, a warmup) cannot fail a turn; only calls carrying the conversation
 * count.
 */
export function startScriptedProvider(
  platform: StackPlatform,
  tokens: Map<string, StackAccountName>,
  provider: StackProvider,
  /** Whether this call is the conversation under test, not an incidental one. */
  isConversation: (texts: string[]) => boolean,
): { origin: string; stop(): void } {
  let sequence = 0;
  const modelCall = (account: StackAccountName | "unknown", userTexts: string[]) => {
    sequence += 1;
    const conversation = isConversation(userTexts);
    const known = account === "unknown" ? undefined : account;
    const refused = conversation && known !== undefined && provider.behavior[known] === "refuse";
    const call = { account, userTexts, refused } satisfies ModelCall;
    if (conversation) provider.calls.push(call);
    if (refused) provider.onRefusal?.(known!);
    return { refused, id: sequence };
  };
  const server = Bun.serve<{ account: StackAccountName | "unknown" }>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request, bun) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = bun.upgrade(request, {
          data: { account: accountOfRequest(tokens, request) },
        });
        if (upgraded) return undefined;
        return new Response("not served", { status: 400 });
      }
      if (request.method !== "POST") return Response.json({ models: [], data: [] });
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (platform !== "claude") return new Response("not served", { status: 400 });
      if (!url.pathname.endsWith("/messages")) return Response.json({ input_tokens: 1 });
      const { refused, id } = modelCall(accountOfRequest(tokens, request), claudeUserTexts(body));
      return refused ? claudeRefusal(provider.refusalClaim) : claudeReply(id);
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as {
          type?: string;
          generate?: boolean;
          input?: unknown;
        };
        if (frame.type !== "response.create") return;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        // A warmup only opens the connection: Codex sends it before each turn.
        if (frame.generate === false) {
          sequence += 1;
          send({ type: "response.created", response: { id: `resp_${sequence}` } });
          send({
            type: "response.completed",
            response: {
              id: `resp_${sequence}`,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          });
          return;
        }
        const { refused, id } = modelCall(socket.data.account, codexUserTexts(frame));
        if (refused) send(codexRefusalFrame());
        else for (const event of codexReplyEvents(id)) send(event);
      },
    },
  });
  return { origin: server.url.origin, stop: () => server.stop(true) };
}

/**
 * Answers the two usage endpoints from the scenario's readings, and refuses any
 * other host: a stray call to a real provider fails the scenario rather than
 * going out. Installed before the backend exists, because its reader captures
 * `fetch` when it is built.
 */
export function installScriptedUsage(
  tokens: Map<string, StackAccountName>,
  provider: StackProvider,
): void {
  const real = globalThis.fetch;
  const usageFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return real(input, init);
    const account = accountOfRequest(tokens, request);
    if (account === "unknown") {
      throw new Error(`The scenario made an unscripted request to ${url.origin}`);
    }
    provider.usageReads.push({ account, at: Date.now() });
    const { weeklyUsedPercent, fiveHourUsedPercent = 1 } = provider.readings[account];
    const weeklyReset = Date.now() + WEEK_RESETS[account];
    const fiveHourReset = Date.now() + 5 * 3_600_000;
    if (url.pathname === "/api/oauth/usage") {
      return Response.json({
        five_hour: {
          utilization: fiveHourUsedPercent,
          resets_at: new Date(fiveHourReset).toISOString(),
        },
        seven_day: {
          utilization: weeklyUsedPercent,
          resets_at: new Date(weeklyReset).toISOString(),
        },
      });
    }
    if (url.pathname === "/backend-api/codex/usage") {
      const window = (usedPercent: number, minutes: number, reset: number) => ({
        used_percent: usedPercent,
        limit_window_seconds: minutes * 60,
        reset_at: Math.floor(reset / 1000),
      });
      return Response.json({
        plan_type: "pro",
        rate_limit: {
          allowed: weeklyUsedPercent < 100,
          limit_reached: weeklyUsedPercent >= 100,
          primary_window: window(fiveHourUsedPercent, 300, fiveHourReset),
          secondary_window: window(weeklyUsedPercent, 10_080, weeklyReset),
        },
        credits: { has_credits: false, unlimited: false, balance: "0" },
      });
    }
    throw new Error(`The scenario made an unscripted request to ${url.href}`);
  };
  globalThis.fetch = Object.assign(usageFetch, { preconnect: real.preconnect }) as typeof fetch;
}

export const STACK_SCENARIOS = [
  "native-build",
  "native-plan-turn",
  "native-two-tabs",
  "native-other-limit",
  "native-all-out",
  "multi-review",
  "build-pipeline",
  "graph-run",
  "graph-panel",
] as const;
export type StackScenario = (typeof STACK_SCENARIOS)[number];

/** Marks the host's evidence line among the bridges' forwarded output. */
export const STACK_EVIDENCE_PREFIX = "ACCOUNT-STACK-EVIDENCE ";

/** What a scenario saw, as the host prints it. */
export interface StackEvidence {
  calls: Array<{
    account: StackAccountName | "unknown";
    refused: boolean;
    /** A turn sent by the resend, not one a workflow followed up with. */
    resendTurn: boolean;
    stoppedPromptCopies: number;
    plan: boolean;
  }>;
  usageReadsAfterRefusal: number;
  bridgePids: number[];
  active: string;
  lastSwitchReason?: string;
  pinned: boolean;
  loginsUnchanged: boolean;
  launches: Array<{ account: string; permissionMode?: string; resumed: boolean }>;
}

export interface StackPaths {
  root: string;
  home: string;
  dataDir: string;
  toolchainBin: string;
  worktree: string;
}

function stackPaths(root: string): StackPaths {
  return {
    root,
    home: path.join(root, "home"),
    dataDir: path.join(root, "data"),
    toolchainBin: path.join(root, "toolchain-bin"),
    worktree: path.join(root, "worktree"),
  };
}

/**
 * The host's paths, refusing to run on anything but a throwaway HOME: the backend's
 * startup sweeps and the CLIs all resolve real directories from it.
 */
export function stackPathsFromEnvironment(): StackPaths {
  const root = process.env.ORKESTRATOR_STACK_ROOT;
  if (!root) throw new Error("ORKESTRATOR_STACK_ROOT is not set");
  const paths = stackPaths(root);
  if (homedir() !== paths.home || process.env.HOME !== paths.home) {
    throw new Error("The account stack needs its own HOME");
  }
  if (process.env.ORKESTRATOR_WORKTREE_DIR !== path.join(root, "worktrees")) {
    throw new Error("The account stack needs its own worktree directory");
  }
  return paths;
}

/** The whole environment of the host process: nothing is inherited but PATH. */
export function stackEnvironment(paths: StackPaths): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.home,
    TMPDIR: path.join(paths.root, "tmp"),
    XDG_CONFIG_HOME: path.join(paths.root, "xdg-config"),
    XDG_DATA_HOME: path.join(paths.root, "xdg-data"),
    XDG_CACHE_HOME: path.join(paths.root, "xdg-cache"),
    XDG_STATE_HOME: path.join(paths.root, "xdg-state"),
    ORKESTRATOR_STACK_ROOT: paths.root,
    BUN_FOR_STACK_WRAPPER: process.execPath,
    ORKESTRATOR_WORKTREE_DIR: path.join(paths.root, "worktrees"),
    GIT_CONFIG_GLOBAL: path.join(paths.root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

/** A throwaway HOME, data directory, toolchain and Git worktree. */
export async function createStackPaths(platform: StackPlatform, cli: string): Promise<StackPaths> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "ork-account-stack-")));
  const paths = stackPaths(root);
  for (const directory of [
    paths.home,
    paths.dataDir,
    paths.toolchainBin,
    paths.worktree,
    path.join(root, "tmp"),
    path.join(root, "worktrees"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeCliWrapper(paths, platform, cli);
  return paths;
}

/**
 * The pinned CLI behind a script that records how it was launched: which account's
 * directory, and with what arguments. A running turn's mode is otherwise invisible
 * from the provider's side.
 */
function writeCliWrapper(paths: StackPaths, platform: StackPlatform, cli: string): void {
  const home = platform === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const log = path.join(paths.root, "cli-launches.log");
  const wrapper = path.join(paths.toolchainBin, platform);
  writeFileSync(
    wrapper,
    [
      "#!/bin/bash",
      `"$BUN_FOR_STACK_WRAPPER" -e 'console.log(JSON.stringify({home:process.env.${home}??"",args:process.argv.slice(1)}))' -- "$@" >> ${JSON.stringify(log)} 2>/dev/null`,
      `exec ${JSON.stringify(cli)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

export async function removeStackPaths(paths: StackPaths): Promise<void> {
  await rm(paths.root, { recursive: true, force: true, maxRetries: 3 });
}

export function writeFixtureLogin(
  platform: StackPlatform,
  home: string,
  name: StackAccountName,
): void {
  mkdirSync(home, { recursive: true });
  if (platform === "claude") {
    writeFileSync(
      path.join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: claudeToken(name),
          refreshToken: `fixture-refresh-${name}`,
          expiresAt: Date.now() + 7 * 24 * 3_600_000,
          scopes: ["user:inference", "user:profile"],
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        },
      }),
    );
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          emailAddress: `${name}@example.com`,
          accountUuid: `fixture-${name}`,
          organizationUuid: "fixture-org",
        },
      }),
    );
    return;
  }
  const token = fixtureCodexToken(name);
  writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: new Date().toISOString(),
      tokens: {
        id_token: token,
        access_token: token,
        refresh_token: `fixture-refresh-${name}`,
        account_id: `fixture-${name}`,
      },
    }),
  );
}
