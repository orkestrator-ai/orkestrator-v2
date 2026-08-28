import { randomUUID } from "node:crypto";
import { query } from "../../../../bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

class PushableInput {
  #items = [];
  #waiters = [];
  #closed = false;

  push(item) {
    if (this.#closed) throw new Error("input is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function userMessage(text, uuid, priority) {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid,
    ...(priority ? { priority } : {}),
  };
}

function assistantSummary(message) {
  if (message.type !== "assistant") return undefined;
  return message.message.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use") return { type: "tool_use", name: block.name };
    return { type: block.type };
  });
}

async function runVariant(priority) {
  const label = priority ?? "bare";
  const mode = process.env.STEER_PROBE_MODE === "token" ? "token" : "tool";
  const initialUuid = randomUUID();
  const steerUuid = randomUUID();
  const input = new PushableInput();
  const events = [];
  let sessionId;
  let injected = false;

  const inject = () => {
    if (injected) return;
    injected = true;
    const message = userMessage(
      mode === "tool"
        ? `Replace the requested final answer. After the current tool completes, reply with exactly STEERED-${label} and nothing else.`
        : `Stop the long response. Reply with exactly STEERED-${label} and nothing else.`,
      steerUuid,
      priority,
    );
    input.push(message);
    if (process.env.STEER_PROBE_DUPLICATE === "1") input.push(message);
    input.close();
  };

  input.push(
    userMessage(
      mode === "tool"
        ? `Use the Bash tool exactly once to run sleep 6. After it completes, reply with exactly ORIGINAL-${label} and nothing else.`
        : `Write at least 1200 words about data structures, then end with exactly ORIGINAL-${label}.`,
      initialUuid,
    ),
  );

  const response = query({
    prompt: input,
    options: {
      cwd: "/private/tmp",
      model: "haiku",
      maxTurns: 5,
      tools: mode === "tool" ? ["Bash"] : [],
      allowedTools: mode === "tool" ? ["Bash"] : [],
      permissionMode: "bypassPermissions",
      settingSources: [],
      includePartialMessages: mode === "token",
      extraArgs: { "replay-user-messages": null },
    },
  });

  const injectTimer = setTimeout(inject, 12_000);

  try {
    for await (const message of response) {
      if ("session_id" in message && message.session_id) sessionId = message.session_id;
      const summary = assistantSummary(message);
      if (summary) {
        events.push({ type: "assistant", content: summary });
        if (summary.some((block) => block.type === "tool_use")) inject();
      } else if (
        mode === "token" &&
        message.type === "stream_event" &&
        message.event?.type === "content_block_delta"
      ) {
        inject();
      }
      else if (message.type === "user") {
        events.push({ type: "user", uuid: message.uuid, replay: message.isReplay === true });
      } else if (message.type === "result") {
        events.push({ type: "result", subtype: message.subtype, result: message.result });
      } else if (message.type === "system") {
        events.push({ type: "system", subtype: message.subtype });
      }
    }
  } finally {
    clearTimeout(injectTimer);
    input.close();
  }

  return { label, mode, initialUuid, steerUuid, sessionId, events };
}

const requested = process.argv.slice(2);
const variants = requested.length > 0 ? requested : ["bare", "now", "next", "later"];
for (const variant of variants) {
  const priority = variant === "bare" ? undefined : variant;
  const result = await runVariant(priority);
  console.log(JSON.stringify(result));
}
