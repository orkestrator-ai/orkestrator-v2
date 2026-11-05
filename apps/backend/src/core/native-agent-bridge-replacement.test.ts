import { expect, mock, test } from "bun:test";
import { NativeAgentService } from "./native-agent-service.js";

const input = { environmentId: "env", agent: "claude" as const, logicalSessionKey: "tab" };
// Exercise the real service methods with only external collaborators replaced.
function harness(environment: object = { id: "env", environmentType: "local" }) {
  const service = Object.create(NativeAgentService.prototype);
  Object.assign(service, {
    bridgeReplacements: new Set(),
    bridgeAdmissions: new Map(),
    hasObservedLiveWork: mock(async () => false),
    assertEnvironmentLive: mock(async () => environment),
    invoke: mock(async () => undefined),
    provider: mock(async () => ({})),
  });
  return service;
}
test("replacement blocks dispatch admission through lookup, stop and restart", async () => {
  const service = harness();
  let proceed!: () => void;
  service.assertEnvironmentLive = async () => {
    await new Promise<void>((r) => {
      proceed = r;
    });
    return { id: "env", environmentType: "local" };
  };
  const replacement = service.replaceBridgeForWiderPolicy(input);
  await Promise.resolve();
  expect(() => service.beginBridgeWork(input)).toThrow("replacement in progress");
  const rejected = await service.dispatchIntent({ ...input, prompt: "test" });
  expect(rejected.outcome).toBe("rejected");
  await expect(service.dispatchPrompt({ ...input, prompt: "test" })).rejects.toThrow(
    "replacement in progress",
  );
  service.invoke = mock(async () => {
    expect(() => service.beginBridgeWork(input)).toThrow();
  });
  service.provider = mock(async () => {
    expect(() => service.beginBridgeWork(input)).toThrow();
  });
  proceed();
  await replacement;
  service.beginBridgeWork(input)();
  expect(service.provider).toHaveBeenCalledTimes(1);
});
test("admitted and observed work prevent stopping", async () => {
  const service = harness();
  const release = service.beginBridgeWork(input);
  await expect(service.replaceBridgeForWiderPolicy(input)).rejects.toThrow("admitted work");
  release();
  service.hasObservedLiveWork = async () => true;
  await expect(service.replaceBridgeForWiderPolicy(input)).rejects.toThrow("turn is running");
  expect(service.invoke).not.toHaveBeenCalled();
});
test.each(["claude", "codex", "cursor", "grok", "pi"] as const)(
  "container stop selection for %s",
  async (agent) => {
    const service = harness({ id: "env", containerId: "container" });
    await service.replaceBridgeForWiderPolicy({ ...input, agent });
    expect(service.invoke).toHaveBeenCalledWith(`stop_${agent}_server`, {
      containerId: "container",
    });
  },
);
test("missing container refuses and releases the fence", async () => {
  const service = harness({ id: "env" });
  await expect(service.replaceBridgeForWiderPolicy(input)).rejects.toThrow(
    "container is unavailable",
  );
  expect(service.invoke).not.toHaveBeenCalled();
  service.beginBridgeWork(input)();
});

test("local replacement selects the local stop command and releases on stop failure", async () => {
  const service = harness();
  service.invoke = mock(async () => {
    throw new Error("stop failed");
  });
  await expect(service.replaceBridgeForWiderPolicy(input)).rejects.toThrow("stop failed");
  expect(service.invoke).toHaveBeenCalledWith("stop_local_claude_server_cmd", {
    environmentId: "env",
  });
  service.beginBridgeWork(input)();
});
