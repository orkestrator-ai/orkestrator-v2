/**
 * OpenCode 2.x slash commands: the catalogue (`GET /api/command`) and their
 * dispatch (`POST /api/session/:id/command`), following
 * docs/architecture/native-agent-commands.md (build plan phase 5).
 *
 * The 1.x rules carry over unchanged, so the 1.x registry and resolver are
 * reused rather than copied (`opencode-commands.ts`):
 *
 * - **Nothing is seeded.** The rows are exactly what the server lists for the
 *   session's directory; an empty list stays empty and a failed read is an
 *   error, never `ready: []`.
 * - **A selected command never becomes a prompt.** A selection is checked
 *   against this list (one forced re-read when it is missing) and its binding
 *   revision; anything else is refused before a request is made. A command
 *   the server no longer has answers 404 `CommandNotFoundError`, which is a
 *   refusal too.
 * - **Private bindings stay private.** 2.x lists only `{ name, description }`;
 *   templates are expanded by the server and never read here.
 *
 * Facts from 2.2.6: `Command.Info` is `{ name, description? }` (built-ins
 * `init`, `review`, `goal`, plus config templates and `server:prompt` MCP
 * prompts); names are exact keys; the route answers 204 once the command's
 * prompt is admitted (2 ms observed), not when its turn ends. The command's
 * user row carries the expanded template and no metadata, so a command has no
 * request-id evidence: an ambiguous dispatch reads `unknown` afterwards and is
 * never re-sent.
 */
import {
  AmbiguousPromptDispatchError,
  PromptRejectedError,
  ProviderUnavailableError,
  type ProviderSendOptions,
} from "../agent-provider-contract.js";
import {
  OpenCodeCommandRegistry,
  normalizeOpenCodeCommandList,
  resolveOpenCodeCommandDispatch,
  type OpenCodeCommandDispatch,
  type OpenCodeCommandInventory,
} from "../opencode-commands.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import type { OpenCode2FileInput } from "./types.js";

/** Read the 2.x command list for the client's directory. */
export async function readOpenCode2CommandInventory(
  client: Pick<OpenCode2Client, "api">,
): Promise<OpenCodeCommandInventory> {
  let data: unknown;
  try {
    data = await client.api("GET", "/api/command", "OpenCode command list", {});
  } catch (error) {
    if (error instanceof OpenCode2RequestError) {
      throw Object.assign(new ProviderUnavailableError("OpenCode command list failed"), {
        catalogueErrorCode: "provider-error",
      });
    }
    throw new ProviderUnavailableError("OpenCode command list is unavailable", { cause: error });
  }
  return normalizeOpenCodeCommandList(data);
}

/** One registry per 2.x server generation: the picker and the executor read the same list. */
export function createOpenCode2CommandRegistry(
  client: Pick<OpenCode2Client, "api">,
  now: () => number = Date.now,
): OpenCodeCommandRegistry {
  return new OpenCodeCommandRegistry(() => readOpenCode2CommandInventory(client), now);
}

/** Whether this send runs a command, refusing a selection that no longer matches. */
export function resolveOpenCode2CommandDispatch(
  registry: OpenCodeCommandRegistry,
  prompt: string,
  options: Pick<ProviderSendOptions, "command" | "allowProviderCommands" | "schema" | "readOnly">,
): Promise<OpenCodeCommandDispatch | null> {
  // No coordinator agent here: a coordinator's 2.x provider refuses every
  // selected command before this runs (`coordinator.ts`).
  return resolveOpenCodeCommandDispatch(registry, prompt, options, undefined);
}

/**
 * Send one command. A 4xx is a definitive refusal (nothing was admitted);
 * anything else is ambiguous, because the server may have admitted the
 * command's prompt before the answer was lost.
 */
export async function dispatchOpenCode2Command(
  client: Pick<OpenCode2Client, "api">,
  sessionId: string,
  command: OpenCodeCommandDispatch,
  files: OpenCode2FileInput[] | undefined,
): Promise<void> {
  const label = `/${command.binding.name}`;
  try {
    await client.api(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/command`,
      "OpenCode command",
      {
        body: {
          // The exact server key, without the slash.
          name: command.binding.name,
          // Arguments exactly as typed; the server expands the template.
          text: command.arguments,
          ...(files ? { files } : {}),
          // As a prompt does: after a run in progress, never into it.
          delivery: "queue",
        },
      },
    );
  } catch (error) {
    if (error instanceof OpenCode2RequestError) {
      if (error.status === 404 && error.tag === "CommandNotFoundError") {
        throw new PromptRejectedError(
          `${label} is no longer available in OpenCode. Choose it again from the menu. Nothing was sent.`,
        );
      }
      throw new PromptRejectedError(`OpenCode refused ${label}: ${error.message}`);
    }
    throw new AmbiguousPromptDispatchError(`OpenCode 2.x did not confirm ${label}`, {
      cause: error,
    });
  }
}
