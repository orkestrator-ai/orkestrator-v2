const grokPath = process.env.GROK_BIN ?? "/tmp/orkestrator-grok-1.0.10-probe/grok";
const child = Bun.spawn([grokPath, "--always-approve", "agent", "stdio"], {
  cwd: "/private/tmp",
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

let nextId = 1;
let buffered = "";
let sessionId;
let interjectSent = false;
const interjectPromises = [];
const pending = new Map();
const promptText = new Map();
const updateTypes = new Map();
const turnCompletions = [];
const queueSizes = [];
const interjectionBroadcasts = [];

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function recordUpdate(message) {
  const params = message.params ?? {};
  const update = params.update ?? {};
  const promptId = params._meta?.promptId ?? update.prompt_id ?? "none";
  const updateType = update.sessionUpdate ?? params._meta?.updateType ?? message.method;

  if (!updateTypes.has(promptId)) updateTypes.set(promptId, new Set());
  updateTypes.get(promptId).add(updateType);

  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    promptText.set(promptId, `${promptText.get(promptId) ?? ""}${update.content.text}`);
  }
  if (update.sessionUpdate === "turn_completed") {
    turnCompletions.push({ promptId: update.prompt_id, stopReason: update.stop_reason });
  }
}

function handleMessage(message) {
  if (message.id != null && ("result" in message || "error" in message)) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
    return;
  }

  if (message.method === "session/update" || message.method === "_x.ai/session_notification") {
    recordUpdate(message);
  }
  if (message.method === "_x.ai/queue/changed") {
    queueSizes.push(message.params?.entries?.length ?? null);
  }
  if (message.method?.includes("session/interjection")) {
    interjectionBroadcasts.push({
      method: message.method,
      interjectionId: message.params?.interjectionId,
      text: message.params?.text,
    });
  }

  const update = message.params?.update;
  const isInjectionPoint =
    message.method === "session/update" &&
    update?.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text";
  if (isInjectionPoint && !interjectSent && sessionId) {
    interjectSent = true;
    const params = {
      sessionId,
      text: "Reply with exactly GROK-STEERED and nothing else.",
      interjectionId: "probe-interjection-1",
    };
    interjectPromises.push(request("_x.ai/interject", params));
    if (process.env.GROK_PROBE_DUPLICATE === "1") {
      interjectPromises.push(request("_x.ai/interject", params));
    }
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
      if (!line) continue;
      handleMessage(JSON.parse(line));
    }
  }
}

async function drainStderr() {
  for await (const _chunk of child.stderr) {
    // Consume diagnostic output so the child can never block on stderr.
  }
}

void readStdout();
void drainStderr();

try {
  const initialized = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "orkestrator-steer-probe", title: "Steer Probe", version: "0.0.1" },
  });
  write({ jsonrpc: "2.0", method: "initialized", params: {} });

  const created = await request("session/new", { cwd: "/private/tmp", mcpServers: [] });
  sessionId = created.sessionId;

  const promptResult = await request("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Write a detailed 250-word essay about database indexing. End with exactly GROK-ORIGINAL.",
      },
    ],
  });
  const interjectResults = await Promise.all(interjectPromises);
  let staleInterject;
  try {
    staleInterject = {
      result: await request("_x.ai/interject", {
        sessionId,
        text: "Reply with exactly GROK-STALE and nothing else.",
        interjectionId: "probe-stale-1",
      }),
    };
  } catch (error) {
    staleInterject = { error: String(error) };
  }
  let followUpPromptResult;
  if (process.env.GROK_PROBE_STALE_NEXT === "1") {
    followUpPromptResult = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Reply with exactly GROK-FRESH and nothing else." }],
    });
  }

  const promptSummaries = Object.fromEntries(
    Array.from(promptText, ([promptId, value]) => [
      promptId,
      {
        length: value.length,
        originalCount: value.split("GROK-ORIGINAL").length - 1,
        steeredCount: value.split("GROK-STEERED").length - 1,
        staleCount: value.split("GROK-STALE").length - 1,
        tail: value.slice(-80),
      },
    ]),
  );

  console.log(
    JSON.stringify({
      protocolVersion: initialized.protocolVersion,
      sessionCapabilities: initialized.agentCapabilities?.sessionCapabilities,
      interjectSent,
      interjectResults,
      staleInterject,
      promptResult,
      followUpPromptResult,
      queueSizes,
      interjectionBroadcasts,
      turnCompletions,
      promptSummaries,
      updateTypes: Object.fromEntries(
        Array.from(updateTypes, ([promptId, values]) => [promptId, Array.from(values)]),
      ),
    }),
  );
} finally {
  child.kill("SIGTERM");
  await child.exited;
}
