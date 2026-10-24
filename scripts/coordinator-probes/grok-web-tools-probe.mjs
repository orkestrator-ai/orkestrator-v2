// Which web tools a Grok ACP child offers under a given launch, read live.
//
//   GROK_BIN=/path/to/grok bun scripts/coordinator-probes/grok-web-tools-probe.mjs <variant>
//
// Variants mirror the coordinator launches the ACP bridge can make:
//   disable-flag   --disable-web-search (research off)
//   fetch-off      no flag, GROK_WEB_FETCH=0 and web_fetch in the profile (search only)
//   env-only       no flag, GROK_WEB_FETCH=0, profile without web_fetch
//   profile-only   no flag, web_fetch in the profile, no env
//   baseline       no flag, no env, profile without web_fetch
//   no-open-page   no flag, GROK_WEB_FETCH=0, profile also removes open_page,
//                  open_page_with_find and the x_* tools
//   disable-no-x   --disable-web-search, profile also removes the x_* tools
//   flag-search    --disallowed-tools for web_fetch, open_page, open_page_with_find
//                  and the x_* tools, GROK_WEB_FETCH=0, search left on
//   flag-disable   --disable-web-search plus --disallowed-tools for the x_* tools
//   coordinator    the bridge's coordinator launch: --disable-web-search and the
//                  read-only profile, which also removes the monitor waiting tool
//
// Every variant uses the bridge's read-only profile, `--no-leader` and no
// `--always-approve`; permission requests are cancelled as the bridge's deny
// policy does. Prints one JSON object: the tool names the agent listed, the
// tool calls it made, and its replies to a fetch and a search request.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const variant = process.argv[2] ?? "fetch-off";
const grokPath = process.env.GROK_BIN ?? "grok";
const X_TOOLS = ["x_user_search", "x_semantic_search", "x_keyword_search", "x_thread_fetch"];
const VARIANTS = {
  "disable-flag": { leading: ["--disable-web-search"], env: {}, profileFetch: false },
  "fetch-off": { leading: [], env: { GROK_WEB_FETCH: "0" }, profileFetch: true },
  "env-only": { leading: [], env: { GROK_WEB_FETCH: "0" }, profileFetch: false },
  "profile-only": { leading: [], env: {}, profileFetch: true },
  baseline: { leading: [], env: {}, profileFetch: false },
  "no-open-page": {
    leading: [],
    env: { GROK_WEB_FETCH: "0" },
    profileFetch: true,
    extra: ["open_page", "open_page_with_find", ...X_TOOLS],
  },
  "flag-search": {
    leading: [
      "--disallowed-tools",
      ["web_fetch", "open_page", "open_page_with_find", ...X_TOOLS].join(","),
    ],
    env: { GROK_WEB_FETCH: "0" },
    profileFetch: true,
  },
  "flag-disable": {
    leading: ["--disable-web-search", "--disallowed-tools", X_TOOLS.join(",")],
    env: {},
    profileFetch: false,
  },
  coordinator: {
    leading: ["--disable-web-search"],
    env: {},
    profileFetch: false,
    extra: ["monitor"],
  },
  "disable-no-x": {
    leading: ["--disable-web-search"],
    env: {},
    profileFetch: false,
    extra: X_TOOLS,
  },
};
const chosen = VARIANTS[variant];
if (!chosen) throw new Error(`unknown variant ${variant}`);

const directory = mkdtempSync(join(tmpdir(), "orkestrator-grok-web-probe-"));
const workspace = join(directory, "work");
const profilePath = join(directory, "read-only.md");
Bun.spawnSync(["mkdir", "-p", workspace]);
writeFileSync(
  profilePath,
  [
    "---",
    "name: orkestrator-read-only",
    "description: Read-only Orkestrator session",
    "promptMode: extend",
    "disallowedTools:",
    "  - write",
    "  - search_replace",
    "  - run_terminal_cmd",
    "  - Agent",
    ...(chosen.profileFetch ? ["  - web_fetch"] : []),
    ...(chosen.extra ?? []).map((tool) => `  - ${tool}`),
    "---",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

const child = Bun.spawn(
  [grokPath, ...chosen.leading, "agent", "--no-leader", "--agent-profile", profilePath, "stdio"],
  {
    cwd: workspace,
    env: { ...process.env, GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "false", ...chosen.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
);

let nextId = 1;
let buffered = "";
const pending = new Map();
let text = "";
const toolCalls = [];
const permissionRequests = [];

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function handleMessage(message) {
  if (message.id != null && ("result" in message || "error" in message) && !message.method) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
    return;
  }
  if (message.method === "session/request_permission") {
    permissionRequests.push(message.params?.toolCall?.title ?? null);
    write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
    return;
  }
  if (message.id != null && message.method) {
    // Any other client request: refuse rather than hang the child.
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
    return;
  }
  const update = message.params?.update;
  if (message.method !== "session/update" || !update) return;
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    text += update.content.text;
  }
  if (update.sessionUpdate === "tool_call") {
    toolCalls.push({ title: update.title ?? null, kind: update.kind ?? null });
  }
}

async function readStdout() {
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) handleMessage(JSON.parse(line));
    }
  }
}

async function drainStderr() {
  for await (const _chunk of child.stderr) {
    // Never print: stderr may carry prompts.
  }
}

async function ask(sessionId, prompt) {
  text = "";
  await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  return text.trim();
}

void readStdout();
void drainStderr();
const timer = setTimeout(() => {
  console.error("probe timed out");
  child.kill();
  process.exit(2);
}, 240_000);

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "orkestrator-web-tools-probe", title: "Web tools probe", version: "0.0.1" },
  });
  write({ jsonrpc: "2.0", method: "initialized", params: {} });
  const { sessionId } = await request("session/new", { cwd: workspace, mcpServers: [] });
  const tools = await ask(
    sessionId,
    "Without calling any tool, list the exact internal names of every tool you can call, one per line, and nothing else.",
  );
  const before = toolCalls.length;
  const fetchReply = await ask(
    sessionId,
    "Open https://example.com with a web page fetch tool and reply with the page title only. If you have no tool that fetches a URL, reply exactly NO-FETCH and call nothing.",
  );
  const fetchCalls = toolCalls.slice(before);
  const middle = toolCalls.length;
  const searchReply = await ask(
    sessionId,
    "Use a web search tool to find the latest released version of the Bun JavaScript runtime and reply with the version only. If you have no web search tool, reply exactly NO-SEARCH and call nothing.",
  );
  const searchCalls = toolCalls.slice(middle);
  const version = Bun.spawnSync([grokPath, "--version"]).stdout.toString().trim();
  console.log(
    JSON.stringify(
      {
        variant,
        version,
        tools: tools
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        fetch: { reply: fetchReply.slice(0, 200), calls: fetchCalls },
        search: { reply: searchReply.slice(0, 200), calls: searchCalls },
        permissionRequests,
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
  child.kill();
  rmSync(directory, { recursive: true, force: true });
}
