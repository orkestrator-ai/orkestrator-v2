import { afterEach, expect, test } from "bun:test";
import { publicErrorEnvelope, publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
} from "./support/client-harness.js";

/**
 * `session interactions resolve` (7202 task 1): `--action answer` with no
 * `--choose` or `--text` approves an approval that has no questions. The CLI
 * leaves the "does an empty answer fit?" check to the backend, which knows the
 * interaction's questions, and relays its refusal unchanged.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(refuse = false) {
  const box = await createSandbox();
  const gateway = await startFakeGateway((request) => {
    if (request.body.args.action !== "session.interaction.resolve")
      return defaultResponder()(request);
    return envelope(
      refuse
        ? publicErrorEnvelope("session.interaction.resolve", {
            code: "invalid-input",
            message: "The answer does not match the interaction's questions or options",
          })
        : publicSuccessEnvelope("session.interaction.resolve", {
            interactionId: "interaction-id",
            result: "applied",
          }),
    );
  });
  cleanups.push(
    () => gateway.stop(),
    () => box.cleanup(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  const writes = () =>
    gateway.requests.filter(
      (request) => request.body.args.action === "session.interaction.resolve",
    );
  return { box, writes };
}

const RESOLVE = ["session", "interactions", "resolve", "session-id", "interaction-id"];

test("--action answer with no answers sends an approval without answers", async () => {
  const { box, writes } = await fixture();
  const run = await box.run([...RESOLVE, "--revision", "2", "--action", "answer", "--json"]);
  expect(run.code).toBe(0);
  expect(writes()).toHaveLength(1);
  expect(writes()[0]!.body.args.input).toEqual({
    sessionId: "session-id",
    interactionId: "interaction-id",
    expectedRevision: 2,
    action: "answer",
  });
  expect(JSON.parse(run.out)).toMatchObject({ ok: true, result: { result: "applied" } });
});

test("the backend's refusal of an empty answer to a question is relayed (exit 2)", async () => {
  const { box, writes } = await fixture(true);
  const run = await box.run([...RESOLVE, "--revision", "2", "--action", "answer", "--json"]);
  expect(run.code).toBe(2);
  expect(writes()).toHaveLength(1);
  expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: { code: "invalid-input" } });
});

test("answers still go with --action answer, and only with it", async () => {
  const { box, writes } = await fixture();
  const answered = await box.run([
    ...RESOLVE,
    "--revision",
    "2",
    "--action",
    "answer",
    "--choose",
    "db=pg",
    "--json",
  ]);
  expect(answered.code).toBe(0);
  expect(writes()[0]!.body.args.input).toMatchObject({
    action: "answer",
    answers: [{ questionId: "db", optionIds: ["pg"] }],
  });

  const denied = await box.run([
    ...RESOLVE,
    "--revision",
    "2",
    "--action",
    "deny",
    "--choose",
    "db=pg",
    "--json",
  ]);
  expect(denied.code).toBe(2);
  expect(writes()).toHaveLength(1);
});
