/**
 * What the faux model in `fake-engine-server.ts` answers, as a pure function
 * of the context Pi sends it.
 *
 * - The last message is a tool result: `Tool result: <its text>`, ending the
 *   turn.
 * - The last user prompt has a line `BASH: <command>`: a call to Pi's own
 *   `bash` tool with that command. Pi runs it for real, under the session's
 *   approval gate, wherever the bridge runs (in a container, behind its
 *   firewall), and the next call sees its result.
 * - Anything else: `Answer to: <prompt>`.
 */
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

type FauxHelpers = Pick<
  typeof import("@earendil-works/pi-ai"),
  "fauxAssistantMessage" | "fauxToolCall"
>;

const BASH_LINE = /^BASH: (.+)$/m;

export function textOf(content: unknown): string {
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

/** The user prompts the model was given, in order. */
export function userPrompts(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
}

export function fakePiResponse(
  context: { readonly messages: readonly Message[] },
  { fauxAssistantMessage, fauxToolCall }: FauxHelpers,
): AssistantMessage {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage(`Tool result: ${textOf(last.content)}`);
  }
  const prompt = userPrompts(context.messages).at(-1) ?? "";
  const command = BASH_LINE.exec(prompt)?.[1];
  if (command) {
    return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage(`Answer to: ${prompt}`);
}
