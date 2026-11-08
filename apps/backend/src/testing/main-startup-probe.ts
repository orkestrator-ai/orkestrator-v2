/** Run the real main.ts composition in a private process with no host services. */
import { mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standaloneLayout } from "@orkestrator/protocol/node/standalone-service";

const directory = await mkdtemp(join(tmpdir(), "main-stage-probe-"));
const scenario = process.argv[2] ?? "success";
const events: string[] = [];
const exited = Promise.withResolvers<void>();
const stub = (relative: string, exports: Record<string, unknown>) =>
  mock.module(new URL(relative, import.meta.url).pathname, () => exports);
const event = (name: string) => {
  events.push(name);
};
const info = {
  bindAddress: "127.0.0.1",
  port: 0,
  url: "http://127.0.0.1:0",
  browserUrl: "http://127.0.0.1:1",
  authFile: join(directory, "auth"),
  token: "fixture",
};

stub("../options.ts", {
  assertSupportedPlatform: () => {},
  parseOptions: () => ({
    dataDir: directory,
    runtimeFlavor: "agent-test",
    credentialSources: [],
    standaloneUpdaterDir: standaloneLayout(directory).root,
  }),
});
stub("../bounded-console.ts", { installBoundedConsole: () => ({ flush: async () => {} }) });
stub("../standalone-logging.ts", {
  installStandaloneBackendLogging: () => null,
  stopStandaloneBackendLogging: () => {},
});
stub("../shutdown.ts", {
  createBackendExitHandler: () => (code: number) => {
    event(`exit:${code}`);
    exited.resolve();
  },
});
stub("../core/fix-path.ts", { fixPath: () => {} });
stub("../core/agent-tools.ts", { dropInheritedAgentToolConnection: () => {} });
stub("../gateway-port-policy.ts", { logGatewayPortPolicy: async () => {} });
stub("../ssh-agent-socket.ts", { configureSshAgentSocketEnvironment: async () => null });
mock.module("@orkestrator/toolchain/manager", () => ({
  leaseActivatedToolchainSet: async () => {},
}));
mock.module("@orkestrator/protocol/parent-watchdog", () => ({
  startReparentWatchdog: () => event("watchdog:armed"),
}));
mock.module("@orkestrator/protocol/event-loop-stall-monitor", () => ({
  startEventLoopStallMonitor: () => {},
  addEventLoopStallContext: () => {},
}));
stub("../core/index.ts", {
  OrkestratorBackend: class {
    previews = { reservePorts: () => {} };
    hostMaintenance = { markReady: () => event("maintenance:ready") };
    async init() {
      event("backend:init");
      if (scenario === "init-fails") throw new Error("fixture init failure");
    }
    async shutdown() {
      event("backend:shutdown");
    }
    nodeGateway() {
      return undefined;
    }
    setPortalOriginsSource() {}
    setSelfAccessSource() {}
    setTranscriptArtifactApplicationOrigins() {}
    onControlMcpStateChange() {
      return () => {};
    }
    getControlMcpEndpointState() {
      return null;
    }
    getControlMcpInfo() {
      return null;
    }
    async invoke() {
      event("descriptor:identity");
      return { result: { backend: { installationId: "fixture", generation: "fixture" } } };
    }
  },
});
stub("../gateway.ts", {
  OrkestratorGateway: class {
    async start() {
      event("gateway:start");
      if (scenario === "gateway-fails") throw new Error("fixture gateway failure");
      return info;
    }
    async stop() {
      event("gateway:stop");
    }
  },
});
stub("../preview-publication.ts", {
  PreviewPublicationManager: class {
    async start() {
      event("preview:start");
      if (scenario === "stop-preview") process.emit("SIGTERM");
    }
    async dispose() {
      event("preview:dispose");
    }
  },
});
stub("../instance-descriptor-publication.ts", {
  createInstanceDescriptorPublication: () => ({
    published: scenario !== "descriptor-fails",
    async refresh() {
      event("descriptor:publish");
      if (scenario === "descriptor-fails") throw new Error("fixture descriptor failure");
    },
    async close() {
      event("descriptor:close");
    },
  }),
});
stub("../host-standalone-updater.ts", {
  createStandaloneUpdater: () => ({ start: () => event("updater:start") }),
});

// Observe the real machine-readable announcement without putting even fixture
// connection data into the test's output. Leave logger writes alone.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array) => {
  if (String(chunk).includes('"type":"orkestrator-backend-ready"')) {
    event("stdout:ready");
    return true;
  }
  return write(chunk);
}) as typeof process.stdout.write;
try {
  await import("../main.js");
  process.emit("SIGTERM");
  await exited.promise;
  write(JSON.stringify({ events }) + "\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
