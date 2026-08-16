import {
  closeInput,
  grokConfig,
  provider,
  write,
  type JsonObject,
} from "./fake-agent-context.js";

export function handlePromptSetup(message: JsonObject): boolean {
  if (message.method === "session/prompt" && typeof message.params === "object") {
    const text = (message.params as { prompt?: Array<{ text?: unknown }> }).prompt?.[0]?.text;
    // Exit without answering, so the bridge observes its child dying mid-turn.
    if (typeof text === "string" && text.startsWith("CRASH")) process.exit(9);
    // Emitted on prompt rather than on session/new: the bridge only binds its
    // vendor handler once session/new has returned, so a catalogue update
    // racing that return would be dropped by the bridge, not by the transport.
    if (provider === "grok" && (
      process.env.FAKE_ACP_EMIT_MODEL_UPDATE === "1"
      || process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE
    )) {
      grokConfig.models.availableModels.push({
        modelId: "grok-next",
        name: "Grok Next",
      });
      write({
        jsonrpc: "2.0",
        // The same payload in the request form some vendor extensions use. The
        // bridge must apply it and answer, not reject it as unimplemented.
        ...(process.env.FAKE_ACP_VENDOR_MODEL_REQUEST_FILE ? { id: 902 } : {}),
        method: "x.ai/models/update",
        params: {
          sessionId: "fake-session",
          currentModelId: "grok-next",
          models: grokConfig.models.availableModels,
        },
      });
    }
    // Answer, then close the read end of the pipe while staying alive. The
    // bridge's next write then fails with EPIPE against a child it still
    // believes is running — the exact race an unhandled stream error would
    // turn into an uncaught exception.
    if (typeof text === "string" && text.startsWith("CLOSESTDIN") && typeof message.id === "number") {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      setInterval(() => {}, 1_000);
      closeInput();
      return true;
    }
  }

  return false;
}

