/**
 * Runs a provider CLI for the plugin adapters (`claude-plugins.ts`,
 * `codex-plugins.ts`).
 *
 * A non-zero exit or a timeout is not an error here: the adapters settle
 * every write by reading the provider's own list back, so they need whatever
 * the command printed, never a thrown exception that hides it. A missing
 * binary is the one hard failure.
 */
import { CommandFailedError, runCommand } from "../../command-capture.js";
import { CapabilityError } from "../security.js";

/** One run of a provider CLI. A failed run still answers with its stdout. */
export interface ProviderCliResult {
  stdout: string;
  exitCode: number | null;
  timedOut?: boolean;
}
export type ProviderCli = (args: string[]) => Promise<ProviderCliResult>;

export const PROVIDER_PLUGIN_CLI_TIMEOUT_MS = 120_000;

export function providerCli(options: {
  label: string;
  binary: () => string;
  cwd: () => string;
  env: () => NodeJS.ProcessEnv;
  timeoutMs?: number;
  run?: typeof runCommand;
}): ProviderCli {
  const run = options.run ?? runCommand;
  return async (args): Promise<ProviderCliResult> => {
    try {
      // Stdin is closed, so a prompt can never wait for input.
      const { stdout } = await run(options.binary(), args, {
        cwd: options.cwd(),
        env: { ...options.env(), NO_COLOR: "1" },
        timeoutMs: options.timeoutMs ?? PROVIDER_PLUGIN_CLI_TIMEOUT_MS,
      });
      return { stdout, exitCode: 0 };
    } catch (error) {
      if (error instanceof CommandFailedError) {
        if (error.executableMissing) {
          throw new CapabilityError(
            "unsupported",
            `${options.label} is not installed on this machine.`,
          );
        }
        return {
          stdout: error.stdout,
          exitCode: error.exitCode,
          ...(error.timedOut ? { timedOut: true } : {}),
        };
      }
      throw error;
    }
  };
}
