import { expect, test } from "./browser-test";
import { randomUUID } from "node:crypto";
import { containerName, fixtureEnvironment, inContainer, invoke } from "./container-wiring-support";

// Backend calls use the disposable profile's token; never capture requests.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("Docker fixture bridge relaunch retains its previous log for backend retrieval", async () => {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  test.setTimeout(180_000);
  const environment = await fixtureEnvironment(containerName);
  const containerId = environment.containerId;
  if (!containerId) throw new Error("Docker fixture has no container");
  const args = { containerId };
  const marker = `previous-log-${randomUUID()}`;
  const start = () => invoke("start_codex_server", args);
  const stop = () => invoke("stop_codex_server", args);
  const log = (previous = false) => invoke<string>("get_codex_server_log", { ...args, previous });

  try {
    await start();
    expect(inContainer(containerId, "test -s /tmp/codex-bridge.log && echo ready").trim()).toBe(
      "ready",
    );
    // A harmless diagnostic marker identifies the first real bridge's log.
    // No provider turn, prompt, credential or session content is captured.
    inContainer(containerId, `printf '%s\\n' '${marker}' >> /tmp/codex-bridge.log`);
    expect(await log()).toContain(marker);
    await stop();
    await start();
    expect(await log(true)).toContain(marker);
    expect(await log()).not.toContain(marker);
    expect(inContainer(containerId, "stat -c '%a' /tmp/codex-bridge.prev.log").trim()).toBe("600");
  } finally {
    await stop();
  }
});
