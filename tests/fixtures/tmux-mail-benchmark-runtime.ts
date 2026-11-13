import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { __testing, gatewayFor } from "../../scripts/tmux-mail-inject-live";

/** Drives the real orchestration and file restoration without a backend or provider. */
export function mailBenchmarkFixture(root: string, response?: () => Response) {
  const dataDir = path.join(root, "profiles", "fixture", "data");
  const claudeDir = path.join(dataDir, "agent-credentials", "claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "settings.json"), '{"original":true}\n');
  writeFileSync(
    path.join(dataDir, "..", "profile.json"),
    JSON.stringify({
      id: "fixture",
      flavor: "agent-test",
      dataDir,
      credentialSources: [],
    }),
  );
  const authFile = path.join(root, "auth.json");
  writeFileSync(authFile, JSON.stringify({ token: "fixture-only" }), { mode: 0o600 });
  const status = { status: "ready", dataDir, authFile, browserUrl: "http://127.0.0.1:1" };
  const events: string[] = [];
  const record = (event: string) => {
    events.push(event);
    appendFileSync(path.join(root, "events"), `${event}\n`);
  };
  let draft = false;
  let counter = 10;
  let origin = "";
  const runtime = {
    ...__testing.mailRuntime,
    profileStatus: () => status,
    gatewayFor: (_status: Parameters<typeof gatewayFor>[0], signal?: AbortSignal) => ({
      async invoke<T>(
        command: string,
        args: Record<string, unknown> = {},
        cleanup = false,
      ): Promise<T> {
        if (!cleanup) signal?.throwIfAborted();
        if (command === "claude_tmux_stop") record(`stop:${args.tabId}:${cleanup}`);
        if (command === "enqueue_prompt_queue_message") record("prompt-enqueued");
        if (command === "launch_terminal_job") record(`launch:${args.tabId}`);
        if (command === "save_compose_draft") draft = true;
        if (command === "delete_compose_draft") draft = false;
        const result =
          command === "get_projects"
            ? [{ id: "project" }]
            : command === "get_environments"
              ? [{ id: "environment", environmentType: "local", worktreePath: root }]
              : command === "claude_tmux_status"
                ? { running: true, busy: false }
                : command === "send_agent_mail"
                  ? { id: "message" }
                  : command === "get_agent_mail_status"
                    ? { injectedAt: draft ? undefined : "now" }
                    : {};
        return result as T;
      },
      kinds: gatewayFor(status, signal, async () =>
        response
          ? response()
          : Response.json({
              recurringWork: {
                metrics: {
                  kinds: {
                    "mail-injection": {
                      started: ++counter,
                      changed: 0,
                      failed: 0,
                      bytes: counter,
                      workUnits: { "storage-read": counter * 2 },
                    },
                  },
                },
              },
            }),
      ).kinds,
    }),
    async startFakeAnthropicModel() {
      const fake = await __testing.mailRuntime.startFakeAnthropicModel();
      origin = fake.origin;
      return {
        ...fake,
        callsWith: (marker: string) =>
          marker.endsWith("-held") && draft
            ? []
            : [
                {
                  index: 1,
                  prompt: marker,
                  userPrompts: 1,
                  context: [],
                  receivedAt: 0,
                  images: 0,
                  tools: [],
                },
              ],
        stop: async () => {
          await fake.stop();
          record("server-stopped");
        },
      };
    },
    claudeFixture: (...args: Parameters<typeof __testing.mailRuntime.claudeFixture>) => {
      const restore = __testing.mailRuntime.claudeFixture(...args);
      record("configured");
      return () => {
        restore();
        record("restored");
      };
    },
    sleep: async (_ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
    },
  };
  return { runtime, dataDir, claudeDir, events, origin: () => origin };
}
