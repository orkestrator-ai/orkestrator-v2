/**
 * Hosts a real design service and command registry for the component design
 * specs. Run with Bun: the specs run under Node, which has no `bun:sqlite`,
 * and the service's storage needs it. Start it through
 * `startDesignServiceHost` in `design-service-client.ts`.
 *
 *   bun e2e/design-service-host.ts <dataDir> <worktree>
 *
 * Each request is one JSON line on stdin. Each reply is one stdout line that
 * starts with `REPLY_PREFIX`, so anything else the backend prints is ignored.
 */
import { createInterface } from "node:readline";
import {
  registerDesignCommandHandlers,
  type DesignCommandContext,
} from "../apps/backend/src/core/design/commands";
import { DesignService } from "../apps/backend/src/core/design/service";
import { runDesignAction } from "../apps/backend/src/core/design/tools";
import {
  DESIGN_FIXTURE_ENVIRONMENT,
  DESIGN_SERVICE_METHODS,
  REPLY_PREFIX,
  type DesignHostRequest,
} from "./design-service-protocol";

type Handler = (args: Record<string, unknown>, context: DesignCommandContext) => unknown;

const [dataDir, worktree] = process.argv.slice(2);
if (!dataDir || !worktree) throw new Error("usage: design-service-host.ts <dataDir> <worktree>");

const service = new DesignService(dataDir, () => {});
const handlers = new Map<string, Handler>();
registerDesignCommandHandlers((name, handler) => handlers.set(name, handler));
const context = {
  design: service,
  storage: {
    getEnvironment: async (id: string) =>
      id === DESIGN_FIXTURE_ENVIRONMENT
        ? { id, environmentType: "local", worktreePath: worktree }
        : undefined,
  },
} as unknown as DesignCommandContext;

let closing: Promise<void> | undefined;
const close = () => (closing ??= service.close());

async function handle(request: DesignHostRequest): Promise<unknown> {
  switch (request.kind) {
    case "invoke": {
      const handler = handlers.get(request.name);
      if (!handler) throw new Error(`Unknown backend command: ${request.name}`);
      return handler(request.args[0] as Record<string, unknown>, context);
    }
    case "service": {
      if (!(DESIGN_SERVICE_METHODS as readonly string[]).includes(request.name)) {
        throw new Error(`Unsupported design service method: ${request.name}`);
      }
      const method = (service as unknown as Record<string, (...args: unknown[]) => unknown>)[
        request.name
      ]!;
      return method.apply(service, request.args);
    }
    case "action":
      return runDesignAction(
        service,
        DESIGN_FIXTURE_ENVIRONMENT,
        request.name,
        request.args[0] as Record<string, unknown>,
      );
    case "close":
      await close();
      return null;
  }
}

const reply = (message: object) =>
  process.stdout.write(`${REPLY_PREFIX}${JSON.stringify(message)}\n`);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line) as DesignHostRequest;
  void handle(request).then(
    (result) => reply({ id: request.id, ok: true, result: result ?? null }),
    (error: unknown) =>
      reply({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
// The owning spec closed its end (or died): release the store and exit.
lines.on("close", () => {
  void close().finally(() => process.exit(0));
});
