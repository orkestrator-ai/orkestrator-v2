import { query } from "../../../../bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

const [sessionId, uuid] = process.argv.slice(2);
if (!sessionId || !uuid) throw new Error("usage: claude-retry-probe.mjs SESSION_ID UUID");

async function* input() {
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "Replace the requested final answer. After the current tool completes, reply with exactly STEERED-next and nothing else.",
    },
    parent_tool_use_id: null,
    uuid,
    priority: "next",
  };
}

const events = [];
const response = query({
  prompt: input(),
  options: {
    cwd: "/private/tmp",
    resume: sessionId,
    model: "haiku",
    maxTurns: 2,
    tools: [],
    allowedTools: [],
    permissionMode: "bypassPermissions",
    settingSources: [],
    extraArgs: { "replay-user-messages": null },
  },
});

for await (const message of response) {
  if (message.type === "user") events.push({ type: "user", uuid: message.uuid });
  if (message.type === "assistant") {
    events.push({
      type: "assistant",
      text: message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    });
  }
  if (message.type === "result") {
    events.push({ type: "result", subtype: message.subtype, result: message.result });
  }
}

console.log(JSON.stringify({ sessionId, uuid, events }));
