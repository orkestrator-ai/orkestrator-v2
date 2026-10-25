import { afterEach, expect, test } from "bun:test";
import { publicErrorEnvelope, publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(unsupported = false) {
  const box = await createSandbox();
  const gateway = await startFakeGateway((request) => {
    if (request.body.args.action !== "session.interaction.hold") return defaultResponder()(request);
    return envelope(
      unsupported
        ? publicErrorEnvelope("session.interaction.hold", {
            code: "capability-unavailable",
            message: "Provider cannot pause interactions",
          })
        : publicSuccessEnvelope("session.interaction.hold", {
            result: "applied",
            expiresAt: 1_900_000_000_000,
          }),
    );
  });
  cleanups.push(
    () => gateway.stop(),
    () => box.cleanup(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

for (const resume of [false, true]) {
  for (const json of [false, true]) {
    test(`interaction hold forwards positional IDs, request ID and held=${!resume} (${json ? "JSON" : "human"})`, async () => {
      const { box, gateway } = await fixture();
      const run = await box.run([
        "session",
        "interactions",
        "hold",
        "session-id",
        "interaction-id",
        "--request-id",
        "hold-command-1",
        ...(resume ? ["--resume"] : []),
        ...(json ? ["--json"] : []),
      ]);
      expect(run.code).toBe(0);
      expect(run.err).toBe("");
      const writes = gateway.requests.filter(
        (request) => request.body.args.action === "session.interaction.hold",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]!.body.args.input).toEqual({
        sessionId: "session-id",
        interactionId: "interaction-id",
        held: !resume,
      });
      expect(writes[0]!.body.args.request).toMatchObject({ requestId: "hold-command-1" });
      if (json)
        expect(JSON.parse(run.out)).toMatchObject({
          ok: true,
          action: "session.interaction.hold",
          result: { result: "applied", expiresAt: 1_900_000_000_000 },
        });
      else expect(run.out.trim()).toBe(resume ? "resumed" : "paused");
    });
  }
}

test("an unsupported provider preserves the error and exits 8", async () => {
  const { box } = await fixture(true);
  const run = await box.run(["session", "interactions", "hold", "s", "i", "--json"]);
  expect(run.code).toBe(8);
  expect(JSON.parse(run.out)).toMatchObject({
    ok: false,
    error: { code: "capability-unavailable" },
  });
});

test("missing positional IDs fail before contacting the backend", async () => {
  const { box, gateway } = await fixture();
  const before = gateway.requests.length;
  for (const ids of [[], ["s"]]) {
    const run = await box.run(["session", "interactions", "hold", ...ids]);
    expect(run.code).toBe(2);
  }
  expect(gateway.requests).toHaveLength(before);
});
