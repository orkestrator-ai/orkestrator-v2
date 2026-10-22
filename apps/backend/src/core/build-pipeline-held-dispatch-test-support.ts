/** Subprocess fault boundary: the parent SIGKILLs this owner after the durable
 * prompt attempt commits, while send is held before provider acceptance.
 * No sleeps, provider credentials, or production-only test hooks are involved. */
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { BuildPipelineService } from "./build-pipeline-service.js";
import { StorageService } from "./storage.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";

installFatalRejectionGuard({ label: "[held-dispatch fixture]" });

const [dataDir, pipelineId] = process.argv.slice(2);
if (!dataDir || !pipelineId)
  throw new Error("held-dispatch fixture requires data directory and pipeline id");
const storage = new StorageService(dataDir);
await storage.init();
const provider: BuildPipelineProvider = {
  agent: "claude",
  registerSession() {},
  async createSession() {
    return "held-build-session";
  },
  async send(_sessionId, _prompt, options) {
    const record = await storage.getBuildPipeline(pipelineId);
    const pending = (record?.snapshot as { pendingPromptAttempt?: { requestId: string } })
      ?.pendingPromptAttempt;
    if (pending?.requestId !== options.requestId)
      throw new Error("send reached before durable admission");
    process.stdout.write("dispatch-held\n");
    // The parent kills this process here; acceptance is unreachable.
    await new Promise<void>(() => {});
    throw new Error("held dispatch unexpectedly released");
  },
  async status() {
    return "idle";
  },
  async messages() {
    return [];
  },
  async structured() {
    return null;
  },
  async abort() {},
  async dispose() {},
};
const service = new BuildPipelineService(storage, async () => undefined as never, {
  autoAdvance: false,
  provider: async () => provider,
});
await service.init();
// An unresolved promise alone does not keep Bun's process alive.
const keepAlive = setInterval(() => {}, 1_000);
try {
  await service.advanceNow(pipelineId);
  throw new Error("fixture did not reach the dispatch boundary");
} finally {
  clearInterval(keepAlive);
  await service.shutdown();
}
