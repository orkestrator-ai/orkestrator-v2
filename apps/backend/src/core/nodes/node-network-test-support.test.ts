import { expect, spyOn, test } from "bun:test";
import { TestNodeNetwork } from "./node-network-test-support.js";

test("stop closes every portal, stream and service when a service rejects", async () => {
  const network = new TestNodeNetwork();
  const first = await network.add("first");
  const second = await network.add("second");
  const failure = new Error("service stop failed");
  const originalStop = first.service.stop.bind(first.service);
  const failedStop = spyOn(first.service, "stop").mockImplementation(async () => {
    await originalStop();
    throw failure;
  });
  const portal = spyOn(second.portal, "stop");
  const service = spyOn(second.service, "stop");
  const response = await network.fetch(`${second.origin}/__orkestrator/events`, {
    headers: { authorization: `Bearer ${second.token}` },
  });
  const reader = response.body!.getReader();
  try {
    await reader.read();
    const stopped = network.stop();
    expect(first.online).toBe(false);
    expect(second.online).toBe(false);
    await expect(stopped).rejects.toMatchObject({ errors: [failure] });
    expect(portal).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledTimes(1);
    expect(second.streams.size).toBe(0);
    await expect(reader.read()).rejects.toThrow("connection lost");
  } finally {
    failedStop.mockRestore();
    portal.mockRestore();
    service.mockRestore();
    reader.releaseLock();
    await network.stop();
  }
});
