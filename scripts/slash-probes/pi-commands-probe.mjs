// Live Pi slash-command qualification through the real Pi bridge.
//
// Starts `bridges/pi-bridge` with a disposable agent directory, session
// directory, bridge state and git repository. Only the host's Pi credential is
// shared, by path (`PI_BRIDGE_AUTH_FILE`), never copied: an OAuth refresh made
// here must be the one the host's own `pi` reads next. Command files live only
// in the disposable repository's `.pi/`. Proof that a command ran is a random
// nonce that exists only in the command file or a marker file the extension
// writes, never a model's claim.
//
//   PI_PROBE_MODEL=openai/gpt-5.5 bun scripts/slash-probes/pi-commands-probe.mjs
//
// PI_PROBE_LIST_MODELS=1 lists the models the signed-in providers offer.
// Prints content-free JSON: probe command names, outcomes, timings and booleans.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const authFile = process.env.PI_PROBE_AUTH_FILE ?? join(homedir(), ".pi", "agent", "auth.json");
if (!existsSync(authFile)) throw new Error("No Pi auth.json; sign in with `pi` /login first");
const model = process.env.PI_PROBE_MODEL ?? "openai/gpt-5.5";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-commands-probe-")));
const repo = join(root, "repo");
const agentDir = join(root, "agent");
const markers = join(root, "markers");
for (const dir of [repo, agentDir, markers, join(root, "sessions"), join(root, "state")]) {
  mkdirSync(dir, { recursive: true });
}
spawnSync("git", ["init", "-q", repo]);

const nonce = (label) => `${label}-${randomBytes(6).toString("hex")}`;
const NONCE = {
  template: nonce("TPL"),
  shadowTemplate: nonce("SHADOW-TPL"),
  extension: nonce("EXT"),
  shadowExtension: nonce("SHADOW-EXT"),
  added: nonce("ADDED"),
};

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

write(
  join(repo, ".pi", "prompts", "probe-tpl.md"),
  `---\ndescription: Probe template\n---\nReply with exactly ${NONCE.template}:$ARGUMENTS and nothing else.\n`,
);
write(
  join(repo, ".pi", "prompts", "probe-shadow.md"),
  `---\ndescription: Probe shadowed template\n---\nReply with exactly ${NONCE.shadowTemplate} and nothing else.\n`,
);
write(
  join(repo, ".pi", "prompts", "probe-slow.md"),
  "---\ndescription: Probe slow template\n---\nUse the bash tool to run `sleep 12`, then reply with exactly SLOW-DONE.\n",
);
// Extension commands: one that completes headless, one that shadows a
// template of the same name, and one that needs a UI answer.
write(
  join(repo, ".pi", "extensions", "probe.ts"),
  `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("probe-ext", {
    description: "Probe extension",
    handler: async (args, ctx) => {
      writeFileSync(${JSON.stringify(join(markers, "ext"))}, ${JSON.stringify(NONCE.extension)} + ":" + args, { flag: "a" });
      ctx.ui.notify("probe-ext ran", "info");
      pi.sendMessage({ customType: "probe", content: ${JSON.stringify(NONCE.extension)}, display: true });
    },
  });
  pi.registerCommand("probe-shadow", {
    description: "Probe extension shadowing a template",
    handler: async (args) => {
      writeFileSync(${JSON.stringify(join(markers, "shadow"))}, ${JSON.stringify(NONCE.shadowExtension)}, { flag: "a" });
    },
  });
  pi.registerCommand("probe-ui", {
    description: "Probe extension that asks the user",
    handler: async (args, ctx) => {
      let answer;
      try {
        answer = await ctx.ui.confirm("Probe", "Proceed?");
        writeFileSync(${JSON.stringify(join(markers, "ui"))}, JSON.stringify({ hasUI: ctx.hasUI, answer: answer ?? null }));
      } catch (error) {
        writeFileSync(${JSON.stringify(join(markers, "ui"))}, JSON.stringify({ hasUI: ctx.hasUI, threw: true }));
        throw error;
      }
    },
  });
}
`,
);

const token = randomBytes(24).toString("base64url");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const bridge = spawn("bun", [join(repoRoot, "bridges", "pi-bridge", "src", "index.ts")], {
  cwd: join(repoRoot, "bridges", "pi-bridge"),
  env: {
    ...process.env,
    PORT: String(port),
    CWD: repo,
    PI_BRIDGE_TOKEN: token,
    PI_AGENT_DIR: agentDir,
    PI_BRIDGE_AUTH_FILE: authFile,
    PI_SESSION_DIR: join(root, "sessions"),
    PI_BRIDGE_STATE_DIR: join(root, "state"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let bridgeErr = "";
bridge.stderr.on("data", (chunk) => {
  bridgeErr = (bridgeErr + chunk).slice(-4000);
});

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}
const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(500);
  }
}

const probeRow = (row) => String(row.name ?? "").includes("probe-");
const summarizeRows = (rows) =>
  rows.filter(probeRow).map((row) => ({
    name: row.name,
    executionKind: row.executionKind,
    source: row.source,
    available: row.availability?.state ?? "available",
    reason: row.availability?.reason,
    busy: row.inputPolicy?.busy,
  }));

let lastStatus;
async function idle(id) {
  return waitFor(
    async () => {
      const { body } = await call(`/session/${id}/status`);
      lastStatus = body;
      return body?.status && body.status !== "running" ? body : undefined;
    },
    180_000,
    "idle",
  );
}

async function transcriptText(id) {
  const { body } = await call(`/session/${id}/messages`);
  return JSON.stringify(body);
}

function selection(rows, name, args) {
  const row = rows.find((candidate) => candidate.name === name);
  if (!row) throw new Error(`${name} is not listed`);
  return {
    id: row.id,
    name: row.name,
    executionKind: row.executionKind,
    ...(row.bindingRevision ? { bindingRevision: row.bindingRevision } : {}),
    arguments: args,
  };
}

const readMarker = (name) =>
  existsSync(join(markers, name)) ? readFileSync(join(markers, name), "utf8") : "";

const result = { model, pins: {} };
try {
  result.pins.piSdk = JSON.parse(
    readFileSync(
      join(repoRoot, "bridges/pi-bridge/node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    ),
  ).version;
  await waitFor(
    () =>
      fetch(`${base}/global/health`)
        .then((response) => response.ok)
        .catch(() => false),
    30_000,
    "bridge health",
  );

  const policy = {
    id: "interactive-host",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
  };
  const created = await post("/session/create", {
    clientSessionKey: `probe-${randomBytes(4).toString("hex")}`,
    model,
    policy,
  });
  if (created.status !== 201)
    throw new Error(`create: ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.id;
  if (process.env.PI_PROBE_LIST_MODELS === "1") {
    await post(`/session/${id}/attach`, {});
    const config = await call(`/session/${id}/config`);
    result.models = (config.body?.models ?? config.body?.availableModels ?? [])
      .map((entry) => entry.id ?? entry)
      .filter((entry) => typeof entry === "string");
    result.configKeys = Object.keys(config.body ?? {});
    throw new Error("listed models only");
  }

  // 1. Discovery before any turn. The backend attaches before it reads, so
  // the cold read here does too; the catalogue read itself never attaches.
  result.unattachedCommands = (await call(`/session/${id}/commands`)).body?.status;
  let started = Date.now();
  const attached = await post(`/session/${id}/attach`, {});
  if (attached.status !== 200)
    throw new Error(`attach: ${attached.status} ${JSON.stringify(attached.body)}`);
  result.attachMs = Date.now() - started;
  started = Date.now();
  const listed = await call(`/session/${id}/commands`);
  result.discovery = {
    http: listed.status,
    status: listed.body?.status,
    ms: Date.now() - started,
    total: listed.body?.commands?.length,
    probeRows: summarizeRows(listed.body?.commands ?? []),
  };
  const rows = listed.body?.commands ?? [];

  // 2. Precedence: `probe-shadow` is both a template and an extension command.
  result.precedence = {
    rowsNamedProbeShadow: rows.filter((row) => row.name === "/probe-shadow").length,
    kind: rows.find((row) => row.name === "/probe-shadow")?.executionKind,
  };
  let sent = await post(`/session/${id}/prompt`, {
    prompt: "/probe-shadow",
    requestId: "probe-shadow-1",
    command: selection(rows, "/probe-shadow", ""),
  });
  await idle(id);
  result.precedence.dispatch = sent.status;
  result.precedence.extensionRan = readMarker("shadow").includes(NONCE.shadowExtension);
  result.precedence.templateReachedModel = (await transcriptText(id)).includes(
    NONCE.shadowTemplate,
  );

  // 3. Headless extension completion, selected with arguments.
  started = Date.now();
  sent = await post(`/session/${id}/prompt`, {
    prompt: "/probe-ext alpha beta",
    requestId: "probe-ext-1",
    command: selection(rows, "/probe-ext", "alpha beta"),
  });
  await idle(id);
  result.extension = {
    dispatch: sent.status,
    local: sent.body?.local === true,
    ms: Date.now() - started,
    ranWithArguments: readMarker("ext") === `${NONCE.extension}:alpha beta`,
    outputInTranscript: (await transcriptText(id)).includes(NONCE.extension),
  };

  // 4. An extension command that needs a UI answer.
  sent = await post(`/session/${id}/prompt`, {
    prompt: "/probe-ui",
    requestId: "probe-ui-1",
    command: selection(rows, "/probe-ui", ""),
  });
  await idle(id);
  result.uiExtension = {
    dispatch: sent.status,
    error: typeof sent.body?.error === "string" ? sent.body.error.slice(0, 200) : undefined,
    marker: readMarker("ui") ? JSON.parse(readMarker("ui")) : null,
  };

  // 5. A template with arguments runs a model turn.
  started = Date.now();
  sent = await post(`/session/${id}/prompt`, {
    prompt: "/probe-tpl zeta",
    requestId: "probe-tpl-1",
    command: selection(rows, "/probe-tpl", "zeta"),
  });
  await idle(id);
  result.template = {
    dispatch: sent.status,
    ms: Date.now() - started,
    nonceWithArgumentInReply: (await transcriptText(id)).includes(`${NONCE.template}:zeta`),
  };

  // 6. Literal opt-out, in a fresh session so the model has never seen the
  // template's text: neither the extension nor the template may run. Tool
  // calls are denied there: with tools the model reads `.pi/` itself and
  // imitates the command, which would leak the nonce without any expansion.
  const noTools = { ...policy, approvals: "deny" };
  const literalSession = await post("/session/create", {
    clientSessionKey: `probe-literal-${randomBytes(4).toString("hex")}`,
    model,
    policy: noTools,
  });
  const literalId = literalSession.body.id;
  await post(`/session/${literalId}/attach`, {});
  const extBefore = readMarker("ext");
  sent = await post(`/session/${literalId}/prompt`, {
    prompt: "/probe-ext literal-arg",
    requestId: "probe-literal-ext",
    allowProviderCommands: false,
  });
  await idle(literalId);
  const literalExtensionRan = readMarker("ext") !== extBefore;
  sent = await post(`/session/${literalId}/prompt`, {
    prompt: "/probe-tpl omega",
    requestId: "probe-literal-tpl",
    allowProviderCommands: false,
  });
  await idle(literalId);
  const literalTranscript = JSON.parse(await transcriptText(literalId));
  result.literal = {
    dispatch: sent.status,
    extensionRan: literalExtensionRan,
    templateExpanded: JSON.stringify(literalTranscript).includes(NONCE.template),
    // An extension command is handled without a model turn; literal text is
    // a model turn of its own.
    assistantRows: (literalTranscript.messages ?? []).filter((row) => row.role === "assistant")
      .length,
  };
  // Control: the same typed text, interpreted, does expand in a fresh session.
  const controlSession = await post("/session/create", {
    clientSessionKey: `probe-control-${randomBytes(4).toString("hex")}`,
    model,
    policy: noTools,
  });
  const controlId = controlSession.body.id;
  await post(`/session/${controlId}/attach`, {});
  await post(`/session/${controlId}/prompt`, {
    prompt: "/probe-tpl omega",
    requestId: "probe-control-tpl",
  });
  await idle(controlId);
  result.literal.typedInterpretedControlExpanded = (await transcriptText(controlId)).includes(
    `${NONCE.template}:omega`,
  );

  // 7. Refresh while a turn runs, with a command added on disk meanwhile.
  sent = await post(`/session/${id}/prompt`, {
    prompt: "/probe-slow",
    requestId: "probe-slow-1",
    command: selection(rows, "/probe-slow", ""),
  });
  await waitFor(
    async () => (await call(`/session/${id}/status`)).body?.status === "running",
    30_000,
    "running",
  );
  write(
    join(repo, ".pi", "prompts", "probe-added.md"),
    `---\ndescription: Probe added template\n---\nReply with exactly ${NONCE.added}.\n`,
  );
  const midTurn = await post(`/session/${id}/commands/refresh`);
  const midTurnList = await call(`/session/${id}/commands`);
  await idle(id);
  const afterTurn = await waitFor(
    async () => {
      const read = await call(`/session/${id}/commands`);
      return (read.body?.commands ?? []).some((row) => row.name === "/probe-added")
        ? read
        : undefined;
    },
    60_000,
    "added command after the turn",
  ).catch(() => null);
  result.refreshMidTurn = {
    refresh: midTurn.body?.outcome ?? midTurn.body,
    listStatusDuringTurn: midTurnList.body?.status,
    addedListedDuringTurn: (midTurnList.body?.commands ?? []).some(
      (row) => row.name === "/probe-added",
    ),
    turnCompleted: (await transcriptText(id)).includes("SLOW-DONE"),
    addedListedAfterTurn: Boolean(afterTurn),
    statusAfterTurn: afterTurn?.body?.status,
  };

  // 8. Idle refresh after removing a template.
  rmSync(join(repo, ".pi", "prompts", "probe-tpl.md"));
  const idleRefresh = await post(`/session/${id}/commands/refresh`);
  const afterRemoval = await call(`/session/${id}/commands`);
  result.refreshIdle = {
    refresh: idleRefresh.body?.outcome ?? idleRefresh.body,
    removedStillListed: (afterRemoval.body?.commands ?? []).some(
      (row) => row.name === "/probe-tpl",
    ),
  };
  // A selection of the removed command is refused, nothing sent.
  sent = await post(`/session/${id}/prompt`, {
    prompt: "/probe-tpl stale",
    requestId: "probe-stale",
    command: selection(rows, "/probe-tpl", "stale"),
  });
  result.staleSelection = { dispatch: sent.status, kind: sent.body?.kind };
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.lastStatus = lastStatus && {
    status: lastStatus.status,
    dispatching: lastStatus.dispatching,
    error: typeof lastStatus.error === "string" ? lastStatus.error.slice(0, 300) : undefined,
    keys: Object.keys(lastStatus),
  };
  result.bridgeStderrTail = bridgeErr.slice(-1500);
} finally {
  bridge.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
