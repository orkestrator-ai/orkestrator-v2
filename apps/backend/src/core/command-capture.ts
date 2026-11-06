import { setCommandCaptureMetrics } from "@orkestrator/protocol/node/command-capture";
import { recurringWorkMetrics, spawnWorkUnit } from "./recurring-work-metrics.js";

/**
 * The capture itself lives in protocol, where the bridges share it. Every
 * backend importer comes through here, so this process's captures, protocol's
 * own included, are charged to the recurring job that caused them.
 */
setCommandCaptureMetrics({
  started: (command, args) => recurringWorkMetrics.work(spawnWorkUnit(command, args)),
  capturedBytes: (count) => recurringWorkMetrics.bytes(count),
});

export {
  CommandFailedError,
  commandInvocationCount,
  GitRemoteTimeoutError,
  observeCommandInvocations,
  nonInteractiveGitEnv,
  runCommand,
  runCommandBuffer,
  type ExecBufferResult,
  type ExecResult,
} from "@orkestrator/protocol/node/command-capture";
