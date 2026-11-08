import { Cause, Effect, Exit, Fiber, Scope } from "effect";
import type { OrkestratorGateway } from "./gateway.js";
import type { ManagedWebClient, ManagedWebClientOwnershipStore } from "./managed-web-client.js";
import { startStandaloneTailscaleServe, type TailscaleServeManager } from "./tailscale-serve.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("gateway.tailscale");
const backendLog = createLogger("backend");

type Gateway = Pick<OrkestratorGateway, "start" | "stop">;
type Serve = Pick<TailscaleServeManager, "start" | "stop">;

/** One step of stopping a startup stage. */
export interface StopStep {
  /** Names the step in `shutdown.step-failed`. */
  readonly step: string;
  readonly run: () => unknown;
  /** A failure makes the process exit non-zero; any other step is best-effort. */
  readonly fatal?: boolean;
}

/**
 * The backend process's lifetime from before `init()` to exit
 * (`docs/development/effect-usage.md`). Startup is an Effect program of
 * stages on one `Scope`; stopping interrupts it and closes the scope.
 */
export interface BackendLifetime {
  /**
   * One startup stage. `release` is added to the lifetime's scope before
   * `acquire` starts, so it runs on stop even after an acquire that failed part
   * way; each step must tolerate a resource that was never acquired. Stages
   * release in reverse order, their steps in the order given, each step
   * running even if an earlier one failed.
   *
   * The stage is uninterruptible: a stop that arrives while it runs waits for
   * it to settle, then interrupts startup before the next stage. A release
   * therefore never races its own acquire (`init()` resumes bridges that a
   * concurrent `shutdown()` would already have stopped).
   */
  stage<A>(acquire: () => A | Promise<A>, release?: readonly StopStep[]): Effect.Effect<A, unknown>;
  /**
   * Runs `startup` to completion. Resolves `true` once it succeeded. A failed
   * startup is logged and stopped, releasing what it acquired, with exit code
   * 1; this, or a stop before or during startup, resolves `false` after that
   * stop finished.
   */
  start(startup: Effect.Effect<void, unknown>): Promise<boolean>;
  /** Idempotent: stops startup, releases every stage and calls `exit` once. */
  stop(signal: NodeJS.Signals): Promise<void>;
}

/**
 * Exit codes: 1 after a failed startup or a failed fatal step, else 130 for
 * SIGINT and 0. The process should install `stop` as its signal handler before
 * any stage starts (AGENTS.md invariant 16).
 */
export function createBackendLifetime(deps: { exit: (code: number) => unknown }): BackendLifetime {
  const scope = Scope.makeUnsafe("sequential");
  let startup: Fiber.Fiber<void, unknown> | null = null;
  let stopping: Promise<void> | null = null;
  let fatalFailures = 0;

  const stopStep = ({ step, run, fatal }: StopStep) =>
    Effect.tryPromise({
      try: async () => {
        await run();
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.sync(() => {
          if (fatal) fatalFailures += 1;
          backendLog.warn("shutdown.step-failed", { step, error: formatLogError(error) });
        }),
      ),
    );

  const finish = (signal: NodeJS.Signals | null): Promise<void> => {
    stopping ??= (async () => {
      // Without this a clean quit cannot be told apart from the backend being killed.
      if (signal) backendLog.info("shutdown.signal-received", { signal });
      let startupFailed = false;
      if (startup) {
        // Waits for an uninterruptible stage in flight; a no-op once startup ended.
        await Effect.runPromise(Fiber.interrupt(startup));
        const exit = await Effect.runPromise(Fiber.await(startup));
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          startupFailed = true;
          backendLog.error("startup.failed", { error: formatLogError(Cause.squash(exit.cause)) });
        }
      }
      await Effect.runPromise(Scope.close(scope, Exit.void));
      const code = startupFailed || fatalFailures > 0 ? 1 : signal === "SIGINT" ? 130 : 0;
      backendLog.info("shutdown.finished", { code });
      await deps.exit(code);
    })();
    return stopping;
  };

  return {
    stage: (acquire, release = []) =>
      Scope.addFinalizer(scope, Effect.forEach(release, stopStep, { discard: true })).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: async () => acquire(),
            catch: (error) => error,
          }),
        ),
        Effect.uninterruptible,
      ),
    async start(program) {
      if (stopping) {
        await stopping;
        return false;
      }
      startup = Effect.runFork(program);
      const exit = await Effect.runPromise(Fiber.await(startup));
      if (Exit.isSuccess(exit)) return true;
      // A failure starts the stop; an interruption joins the stop that caused it.
      await finish(null);
      return false;
    },
    stop: (signal) => finish(signal),
  };
}

export interface GatewayStartupDependencies {
  createGateway: () => Gateway;
  reservePorts: (ports: number[]) => void;
  loadWebClientEnabled: () => Promise<boolean>;
  managedWebClient: Pick<
    ManagedWebClient,
    "setBrowserListenerUrl" | "setEnabled" | "shutdown"
  > | null;
  tailscaleServe: boolean;
  tailscaleServePort: number;
  standaloneServeOwnership?: ManagedWebClientOwnershipStore;
  createTailscaleServe: () => Serve;
}

/**
 * Starts the gateway and its public access. It does not unwind a partial
 * start itself: run it as `gatewayServicesStage`, whose release does.
 */
export async function startGatewayServices(deps: GatewayStartupDependencies) {
  const gateway = deps.createGateway();
  const gatewayInfo = await gateway.start();
  if (!gatewayInfo) {
    throw new Error(
      "No Tailscale address was found. Pass --host with a Tailscale address, or use --host 127.0.0.1 --allow-non-tailscale-bind for local development.",
    );
  }
  deps.reservePorts(
    [
      gatewayInfo.port,
      gatewayInfo.browserUrl ? Number(new URL(gatewayInfo.browserUrl).port) : 0,
      gatewayInfo.loopbackClientUrl ? Number(new URL(gatewayInfo.loopbackClientUrl).port) : 0,
    ].filter((port) => port > 0),
  );
  let info = gatewayInfo;
  let tailscaleServe: Serve | null = null;
  if (deps.managedWebClient) {
    deps.managedWebClient.setBrowserListenerUrl(gatewayInfo.browserUrl);
    const enabled = await deps.loadWebClientEnabled();
    void deps.managedWebClient.setEnabled(enabled).catch((error: unknown) => {
      log.error("startup.init-failed", { error: formatLogError(error) });
    });
    // The managed client owns the public URL; this listener is loopback-only.
    info = { ...gatewayInfo, browserUrl: undefined, browserError: undefined };
  } else if (deps.tailscaleServe) {
    if (!gatewayInfo.browserUrl) {
      throw new Error("Tailscale Serve requires an available browser listener");
    }
    tailscaleServe = deps.createTailscaleServe();
    const tailscaleUrl = await startStandaloneTailscaleServe(
      tailscaleServe,
      gatewayInfo.browserUrl,
      deps.tailscaleServePort,
      deps.standaloneServeOwnership,
    );
    log.info("available", { url: tailscaleUrl });
    info = { ...gatewayInfo, browserUrl: tailscaleUrl };
  }
  return { gatewayInfo, info, tailscaleServe };
}

/**
 * `startGatewayServices` as a lifetime stage. Its release stops whatever was
 * created, even by a start that failed part way: Tailscale Serve and the
 * managed web client best-effort, then the gateway, whose failure is fatal.
 */
export function gatewayServicesStage(lifetime: BackendLifetime, deps: GatewayStartupDependencies) {
  let gateway: Gateway | undefined;
  let tailscaleServe: Serve | undefined;
  return lifetime.stage(
    () =>
      startGatewayServices({
        ...deps,
        createGateway: () => (gateway = deps.createGateway()),
        createTailscaleServe: () => (tailscaleServe = deps.createTailscaleServe()),
      }),
    [
      { step: "tailscale-serve", run: () => tailscaleServe?.stop() },
      { step: "managed-web-client", run: () => deps.managedWebClient?.shutdown() },
      { step: "gateway", run: () => gateway?.stop(), fatal: true },
    ],
  );
}
