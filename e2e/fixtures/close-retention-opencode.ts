/**
 * An OpenCode server for the close-retention browser host.
 *
 * The OpenCode 2 fake the provider suites use (`FakeOpenCode2Server`), served
 * over real HTTP so the real `OpenCodeEnvironmentProvider` and
 * `OpenCode2Provider` drive it. A prompt that starts a run is answered after
 * the dispatch returns, as a real server answers. Deleting a conversation
 * would remove it, so a close that sent `DELETE /api/session/:id` would fail
 * the spec. Like OpenCode, a session keeps its title until it is updated; the
 * fake never derives one from the first prompt.
 *
 * Prompts containing `HOLD` stay running until interrupted.
 */
import {
  FakeOpenCode2Server,
  fakeOpenCode2Model,
} from "../../apps/backend/src/core/opencode2/fake-server.test-support";
import type { OpenCode2ServerConnection } from "../../apps/backend/src/core/opencode2/environment-provider";

export type OpenCodeVendorView = {
  sessions: Array<{ id: string; title: string; prompts: string[]; replies: string[] }>;
  deleted: string[];
  /** Every session an interrupt reached, in order; a retaining close interrupts. */
  aborted: string[];
};

export function createOpenCodeEngine(directory: string) {
  const server = new FakeOpenCode2Server();
  // A provider in the default allowlist, so the picker offers it and the
  // sign-in status reads signed in.
  server.models = [fakeOpenCode2Model("opencode", "fake")];
  server.providers = [{ id: "opencode", name: "OpenCode", activation: "enabled" }];
  server.onRunStarted = (sessionId, text) => {
    if (text.includes("HOLD")) return;
    // Answered after the dispatch returns.
    setTimeout(() => {
      if (server.sessions.get(sessionId)?.running) {
        server.finishRun(sessionId, "succeeded", `Answer to: ${text}`);
      }
    }, 0);
  };

  const connection: OpenCode2ServerConnection = {
    baseUrl: server.baseUrl,
    password: "pw",
    directory,
    generation: "close-retention",
  };

  const textOf = (row: Record<string, unknown>): string => {
    if (typeof row.text === "string") return row.text;
    const content = Array.isArray(row.content) ? row.content : [];
    return content
      .filter((part): part is { type: string; text: string } => part?.type === "text")
      .map((part) => part.text)
      .join("");
  };

  return {
    connection,
    stop: () => server.stop(),
    view(): OpenCodeVendorView {
      return {
        sessions: [...server.sessions.values()].map((session) => ({
          id: session.id,
          title: session.title ?? "",
          prompts: session.rows.filter((row) => row.type === "user").map(textOf),
          replies: session.rows
            .filter((row) => row.type === "assistant")
            .map(textOf)
            .filter(Boolean),
        })),
        deleted: [...server.deletions],
        aborted: [...server.interrupts],
      };
    },
  };
}
