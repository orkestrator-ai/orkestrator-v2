import { AskpassBroker, type SshAskpassHandler } from "./askpass.js";
import type { SshAdapterContext } from "./context.js";
import { ensureOwnedKnownHostsDir } from "./host-trust.js";
import { MAX_PORT_ALLOCATION_ATTEMPTS } from "./port-allocation.js";
import { buildTunnelArgs, type ValidatedSshRoute } from "./ssh-command.js";
import {
  assertTunnelSafeConfig,
  inspectSshConfig,
  type SshConfigWarning,
  type SshEffectiveConfig,
} from "./ssh-config-inspection.js";
import { nonInteractiveSshEnv } from "./ssh-env.js";
import {
  classifySshStderr,
  isForwardingDeniedLine,
  redactSshDiagnostic,
  type SshStderrClassification,
} from "./stderr-classification.js";
import { OwnedSshChild, TUNNEL_TERMINATE_GRACE_MS } from "./tunnel-child.js";
import { SshTunnelError } from "./tunnel-failures.js";
import { TUNNEL_READY_TIMEOUT_MS, waitForTunnelReady } from "./tunnel-readiness.js";

export type TunnelTimings = {
  readyTimeoutMs: number;
  terminateGraceMs: number;
  maxPortAttempts: number;
};

export const DEFAULT_TUNNEL_TIMINGS: TunnelTimings = {
  readyTimeoutMs: TUNNEL_READY_TIMEOUT_MS,
  terminateGraceMs: TUNNEL_TERMINATE_GRACE_MS,
  maxPortAttempts: MAX_PORT_ALLOCATION_ATTEMPTS,
};

export type StartedTunnel = {
  child: OwnedSshChild;
  localPort: number;
  interactive: boolean;
  config: SshEffectiveConfig;
  warnings: SshConfigWarning[];
};

export type StartTunnelOptions = {
  interactive: boolean;
  prompt: SshAskpassHandler | undefined;
  signal: AbortSignal;
  timings: TunnelTimings;
};

/**
 * Bring up one owned forwarding child for a validated route: locate OpenSSH,
 * enforce the configuration policy, set up prompting (interactive only), then
 * spawn and wait for readiness, retrying on a lost local port race.
 */
export async function startSshTunnel(
  context: SshAdapterContext,
  route: ValidatedSshRoute,
  options: StartTunnelOptions,
): Promise<StartedTunnel> {
  const lookup = await context.locateBinaries();
  if (!lookup.ok) {
    throw SshTunnelError.of(
      "ssh-unavailable",
      lookup.reason === "unsupported-platform"
        ? { message: "SSH routes are not qualified on Windows yet." }
        : {},
    );
  }
  throwIfAborted(options.signal);
  const config = await inspectSshConfig(context, lookup.binaries, route, options.signal);
  const warnings = assertTunnelSafeConfig(config);
  if (config.usesProxyJump || warnings.length > 0) {
    context.logger.info("ssh tunnel configuration notes", {
      routeId: route.routeId,
      proxyJump: config.usesProxyJump,
      permitLocalCommand: warnings.includes("permit-local-command"),
    });
  }
  await ensureOwnedKnownHostsDir(context);
  throwIfAborted(options.signal);

  const interactive = options.interactive && options.prompt !== undefined;
  const broker =
    interactive && options.prompt ? await AskpassBroker.open(context, options.prompt) : null;
  try {
    const env = broker ? { ...context.env, ...broker.env() } : nonInteractiveSshEnv(context.env);
    const knownHostsFiles = [...config.userKnownHostsFiles, context.knownHostsFile];
    const sensitive = [config.user, context.homedir];

    for (let attempt = 1; attempt <= options.timings.maxPortAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      const localPort = await context.allocatePort();
      const args = buildTunnelArgs({
        route,
        localPort,
        batchMode: !interactive,
        knownHostsFiles,
        ...(context.configFile ? { configFile: context.configFile } : {}),
      });
      const child = new OwnedSshChild(
        context,
        context.spawn(lookup.binaries.ssh, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env,
          shell: false,
          detached: false,
          windowsHide: true,
        }),
      );
      context.logger.info("ssh tunnel starting", {
        routeId: route.routeId,
        attempt,
        pid: child.pid ?? -1,
        interactive,
      });
      const outcome = await waitForTunnelReady(context, child, {
        localPort,
        timeoutMs: options.timings.readyTimeoutMs,
        signal: options.signal,
        promptActive: () => (broker?.activePrompts ?? 0) > 0,
      });
      if (outcome.ready) {
        // Authentication is complete; invalidate the prompt channel now rather
        // than keeping it open for the tunnel's lifetime.
        await broker?.dispose();
        return { child, localPort, interactive, config, warnings };
      }

      await child.terminate(options.timings.terminateGraceMs);
      if (outcome.reason === "cancelled") throw SshTunnelError.of("cancelled");
      const exit = await child.exited;
      if (exit.spawnFailed) throw SshTunnelError.of("ssh-unavailable");

      const classified: SshStderrClassification | null =
        outcome.reason === "forwarding-denied"
          ? {
              code: "forwarding-denied",
              line: child.stderr.split(/\r?\n/).find(isForwardingDeniedLine) ?? "",
            }
          : classifySshStderr(child.stderr, {
              interactive,
              promptCancelled: (broker?.promptsCancelled ?? 0) > 0,
            });
      if (classified?.code === "port-collision") {
        context.logger.warn("ssh tunnel local port was taken; retrying", {
          routeId: route.routeId,
          attempt,
        });
        continue;
      }
      const detail = classified?.line ? redactSshDiagnostic(classified.line, sensitive) : undefined;
      const code =
        classified?.code ?? (outcome.reason === "timeout" ? "connect-failed" : "tunnel-exited");
      context.logger.warn("ssh tunnel failed to start", { routeId: route.routeId, code });
      throw SshTunnelError.of(code, {
        ...(detail ? { detail } : {}),
        ...(outcome.reason === "timeout" && !classified
          ? { message: "Timed out waiting for the SSH tunnel to come up." }
          : {}),
      });
    }
    throw SshTunnelError.of("port-collision-exhausted");
  } catch (error) {
    await broker?.dispose();
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw SshTunnelError.of("cancelled");
}
