#!/usr/bin/env bun
/**
 * The real Pi bridge over pi-ai's faux model provider, as a standalone process.
 *
 * Browser specs drive a native Pi tab through the real backend and this bridge
 * without a credential or a network call. Only the model is fake: the SDK's
 * `ModelRuntime`, `AgentSession` and `SessionManager` are real, so turns land
 * in real JSONL session files under `PI_SESSION_DIR`, a closed conversation is
 * listed because its file is still there, and a resumed one is reloaded from
 * that file. Nothing in the production path knows this file exists.
 *
 * Every model call appends one line to `FAKE_PI_CALLS`: the user prompts the
 * model was given as context, in order, and whether the request's abort
 * signal had already fired (a real provider sends nothing then). That is the
 * vendor's truth for "the next prompt continued the same conversation": the
 * call after a resume sees the earlier prompt once, followed by the new one.
 *
 * Every prompt is answered `Answer to: <prompt>`.
 *
 * Startup: while the file `FAKE_PI_STARTUP_GATE` exists, `AgentSession.prompt`
 * does not reach Pi, standing in for a prompt Pi has not accepted yet (its
 * input handlers and auth check, before the run starts). Each held prompt
 * appends `held`, then `released`, to `FAKE_PI_STARTUP_LOG`.
 *
 * Environment: the bridge's own (`PORT`, `HOSTNAME`, `CWD`, `PI_BRIDGE_TOKEN`,
 * `PI_BRIDGE_STATE_DIR`, `PI_SESSION_DIR`, `PI_AGENT_DIR`) plus
 * `FAKE_PI_CALLS`, and optionally `FAKE_PI_STARTUP_GATE` with
 * `FAKE_PI_STARTUP_LOG`.
 */
import { appendFileSync, existsSync } from "node:fs";

process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
// No catalogue refresh may leave the process.
process.env.PI_OFFLINE = "1";

const callsPath = process.env.FAKE_PI_CALLS;
const agentDirectory = process.env.PI_AGENT_DIR;
if (!callsPath || !agentDirectory) throw new Error("FAKE_PI_CALLS and PI_AGENT_DIR are required");

const { AgentSession, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider } = await import("@earendil-works/pi-ai");
type FauxResponseFactory = import("@earendil-works/pi-ai").FauxResponseFactory;
const bridge = await import("../index.js");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
const respond: FauxResponseFactory = (context, options) => {
  // One scripted step per call; queue the next before answering this one.
  faux.appendResponses([respond]);
  const prompts = context.messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
  const aborted = options?.signal?.aborted === true;
  appendFileSync(callsPath, `${JSON.stringify({ prompts, aborted })}\n`);
  return fauxAssistantMessage(`Answer to: ${prompts.at(-1) ?? ""}`);
};
faux.setResponses([respond]);

const runtime = await ModelRuntime.create({
  authPath: `${agentDirectory}/auth.json`,
  modelsPath: `${agentDirectory}/models.json`,
  allowModelNetwork: false,
});
runtime.registerNativeProvider(faux.provider);
await runtime.setRuntimeApiKey("faux", "fake-engine-no-provider-requests");
bridge.setModelRuntimeFactoryForTests(async () => runtime);

const startupGate = process.env.FAKE_PI_STARTUP_GATE;
const startupLog = process.env.FAKE_PI_STARTUP_LOG;
if (startupGate && startupLog) {
  // The SDK class the bridge drives, held at its entry: the bridge sees a
  // prompt that Pi has not accepted, exactly as during Pi's own preflight.
  const prompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = async function heldPrompt(
    this: InstanceType<typeof AgentSession>,
    ...args: Parameters<typeof prompt>
  ) {
    if (existsSync(startupGate)) {
      appendFileSync(startupLog, "held\n");
      while (existsSync(startupGate)) await Bun.sleep(20);
      appendFileSync(startupLog, "released\n");
    }
    return prompt.apply(this, args);
  };
}
await bridge.start();
