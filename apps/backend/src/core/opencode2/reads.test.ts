import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderTranscriptSnapshot } from "../agent-provider-contract.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import { openCode2EventSessionId } from "./reads.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

async function until(check: () => boolean | Promise<boolean>, ms = 2_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met");
    await Bun.sleep(5);
  }
}

describe("openCode2EventSessionId", () => {
  test("durable aggregate first, then the data's session", () => {
    expect(
      openCode2EventSessionId({
        type: "x",
        data: { sessionID: "b" },
        durable: { aggregateID: "a", seq: 1 },
      }),
    ).toBe("a");
    expect(openCode2EventSessionId({ type: "x", data: { sessionID: "b" } })).toBe("b");
    expect(openCode2EventSessionId({ type: "x", data: null })).toBeUndefined();
  });
});

describe("OpenCode2Provider live hints", () => {
  test("a window is unchanged until an event for its session arrives, ephemeral ones included", async () => {
    server = new FakeOpenCode2Server();
    provider = new OpenCode2Provider(server.client(), { monitorRetryMs: 5 });
    const id = await provider.createSession("build", "x");
    server.pushRow(id, { type: "user", text: "hi" });
    const options = { limit: 10, targetBytes: 1e6 };
    let first = (await provider.transcriptSnapshot(id, options)) as ProviderTranscriptSnapshot;
    // The stream connects after the provider starts; settle on a token minted while live.
    await until(async () => {
      first = (await provider!.transcriptSnapshot(id, options)) as ProviderTranscriptSnapshot;
      const again = await provider!.transcriptSnapshot(id, {
        ...options,
        knownSourceToken: first.sourceToken,
      });
      return "unchanged" in again;
    });
    server.emitEvent(id, "session.text.delta", { assistantMessageID: "msg_x", delta: "…" }, false);
    await until(async () => {
      const next = await provider!.transcriptSnapshot(id, {
        ...options,
        knownSourceToken: first.sourceToken,
      });
      return !("unchanged" in next);
    });
    // Another session's event does not disturb this one.
    const second = (await provider.transcriptSnapshot(id, options)) as ProviderTranscriptSnapshot;
    server.emitEvent("ses_other", "session.text.delta", {}, false);
    await Bun.sleep(30);
    expect(
      await provider.transcriptSnapshot(id, { ...options, knownSourceToken: second.sourceToken }),
    ).toEqual({
      unchanged: true,
      sourceToken: second.sourceToken!,
    });
  });

  test("without a live stream a window is always re-read", async () => {
    server = new FakeOpenCode2Server();
    provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
    const id = await provider.createSession("build", "x");
    const first = (await provider.transcriptSnapshot(id, {
      limit: 5,
      targetBytes: 1e6,
    })) as ProviderTranscriptSnapshot;
    const again = await provider.transcriptSnapshot(id, {
      limit: 5,
      targetBytes: 1e6,
      knownSourceToken: first.sourceToken,
    });
    expect("messages" in again).toBe(true);
  });
});
