import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "../../../../bridges/pi-bridge/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const directory = mkdtempSync(join(tmpdir(), "pi-steer-probe-"));
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("openai-codex", "gpt-5.6-luna");
if (!model) throw new Error("probe model was not found");

const resourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "Follow the user's instructions exactly and keep final answers brief.",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

const { session } = await createAgentSession({
  cwd: directory,
  agentDir: join(directory, "agent"),
  modelRuntime,
  model,
  thinkingLevel: "off",
  resourceLoader,
  tools: ["bash"],
  sessionManager: SessionManager.create(directory, join(directory, "sessions")),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
});

const events = [];
let steerRequested = false;
let steerPromise;

function textOf(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const unsubscribe = session.subscribe((event) => {
  if (event.type === "queue_update") {
    events.push({ type: event.type, steering: [...event.steering], followUp: [...event.followUp] });
  } else if (event.type === "message_start" || event.type === "message_end") {
    events.push({ type: event.type, role: event.message.role, text: textOf(event.message) });
  } else if (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "agent_settled" ||
    event.type === "turn_start" ||
    event.type === "turn_end" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end"
  ) {
    events.push({ type: event.type });
  }

  if (event.type === "tool_execution_start" && !steerRequested) {
    steerRequested = true;
    steerPromise = session.steer("Reply with exactly PI-STEERED after the active tool finishes.");
    if (process.env.PI_PROBE_DUPLICATE === "1") {
      void session.steer("Reply with exactly PI-STEERED after the active tool finishes.");
    }
  }
});

try {
  await session.prompt(
    "Use the bash tool exactly once to run sleep 5. After it finishes, reply with exactly PI-ORIGINAL.",
  );
  await steerPromise;

  const persisted = readFileSync(session.sessionFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message")
    .map((entry) => ({
      entryId: entry.id,
      role: entry.message?.role,
      text: textOf(entry.message),
      messageTimestamp: entry.message?.timestamp,
    }));

  console.log(JSON.stringify({ sessionFile: session.sessionFile, events, persisted }));
} finally {
  unsubscribe();
  session.dispose();
}
