// Codex sub-agent stacks for `CodexSubagentCards.spec.ts`: a fake app-server,
// the real codex-bridge process and the real backend projection
// (`apps/backend/tests/codex-subagent-stack.ts`). The browser reads projections
// through `/__codex-subagents/*`, which the spec routes here. This process never
// launches Codex or reads provider credentials.
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import {
  startSubagentStack,
  type SubagentStack,
} from "../../apps/backend/tests/codex-subagent-stack";

installFatalRejectionGuard({ label: "[codex-subagent-browser-fixture]" });

const stacks = new Map<string, SubagentStack>();

const actions: Record<string, (stack: SubagentStack) => Promise<unknown>> = {
  prompt: (stack) => stack.prompt(),
  finish: (stack) => stack.finishChildren(),
  reopen: (stack) => stack.reopenBackend(),
  restart: async (stack) => {
    await stack.restart();
    return { bridgeGeneration: stack.bridgeGeneration };
  },
  projection: (stack) => stack.projection(),
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A cold restart replays the turn from disk; the default 10 s is too tight
  // on a loaded host.
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);
    try {
      if (action === "start") {
        const id = crypto.randomUUID();
        stacks.set(id, await startSubagentStack());
        return Response.json({ stack: id });
      }
      const id = url.searchParams.get("stack") ?? "";
      const stack = stacks.get(id);
      if (!stack) return Response.json({ error: "unknown stack" }, { status: 404 });
      if (action === "close") {
        stacks.delete(id);
        await stack.close();
        return Response.json({});
      }
      const run = actions[action];
      if (!run) return Response.json({ error: `unknown action ${action}` }, { status: 404 });
      return Response.json((await run(stack)) ?? {});
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
});

async function shutdown(): Promise<never> {
  await Promise.allSettled([...stacks.values()].map((stack) => stack.close()));
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

console.log(`CODEX_SUBAGENT_FIXTURE_READY:${server.port}`);
