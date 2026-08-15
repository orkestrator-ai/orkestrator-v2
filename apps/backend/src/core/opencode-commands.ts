import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

const OPENCODE_BUILT_IN_SLASH_COMMANDS: readonly NativeAgentSlashCommand[] = [
  { name: "/compact", description: "Compact the current session" },
  { name: "/connect", description: "Add a provider" },
  { name: "/details", description: "Toggle tool execution details" },
  { name: "/editor", description: "Open an external editor" },
  { name: "/exit", description: "Exit OpenCode" },
  { name: "/export", description: "Export current conversation" },
  { name: "/help", description: "Show help" },
  { name: "/init", description: "Create or update AGENTS.md" },
  { name: "/models", description: "List available models" },
  { name: "/new", description: "Start a new session" },
  { name: "/redo", description: "Redo the previously undone message" },
  { name: "/sessions", description: "List and switch sessions" },
  { name: "/share", description: "Share current session" },
  { name: "/themes", description: "List available themes" },
  { name: "/thinking", description: "Toggle reasoning visibility" },
  { name: "/undo", description: "Undo the last message" },
  { name: "/unshare", description: "Unshare current session" },
];

export async function listOpenCodeSlashCommands(
  client: OpencodeClient,
  directory: string | undefined,
  requestOptions: () => { signal: AbortSignal },
): Promise<NativeAgentSlashCommand[]> {
  const responses = await Promise.allSettled([
    client.command.list({}, requestOptions()),
    client.command.list({ directory }, requestOptions()),
  ]);
  const commands = new Map<string, NativeAgentSlashCommand>(
    OPENCODE_BUILT_IN_SLASH_COMMANDS.map((command) => [command.name, command]),
  );
  for (const settled of responses) {
    if (settled.status !== "fulfilled" || !Array.isArray(settled.value.data)) continue;
    for (const candidate of settled.value.data.slice(0, 512)) {
      const command = asRecord(candidate);
      const rawName = nonEmptyString(command?.name);
      if (!rawName) continue;
      const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
      commands.set(name, {
        name,
        ...(typeof command?.description === "string"
          ? { description: command.description.slice(0, 1_000) }
          : {}),
        ...(Array.isArray(command?.hints) && typeof command.hints[0] === "string"
          ? { argumentHint: command.hints[0].slice(0, 512) }
          : {}),
      });
    }
  }
  return [...commands.values()].slice(0, 512);
}
