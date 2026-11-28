import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { openRecordedSession, runOptionalReconnect } from "./agent-tab-requests-support";

const DISCOVERY = "get_native_agent_discovery_update";
const STATE = "get_native_agent_session_state_update";
const SESSION = "fixture-session";
const SENTINEL = "private-fixture-value-🧪";

function finishedRequest({
  command = DISCOVERY,
  args = { logicalSessionKey: SESSION },
  text,
  responseBytes,
}: {
  command?: string;
  args?: { logicalSessionKey: string; knownToken?: string; forceSnapshot?: boolean };
  text: () => Promise<string>;
  responseBytes: number;
}) {
  return {
    url: () => "http://fixture.test/__orkestrator/invoke",
    postDataJSON: () => ({ command, args }),
    sizes: async () => ({
      requestHeadersSize: 10,
      requestBodySize: 20,
      responseHeadersSize: 30,
      responseBodySize: responseBytes,
    }),
    response: async () => ({ text }),
  };
}

function fixtureRequest(
  body: unknown,
  options: Omit<Parameters<typeof finishedRequest>[0], "text" | "responseBytes"> = {},
) {
  const text = JSON.stringify(body);
  return finishedRequest({
    ...options,
    text: async () => text,
    responseBytes: Buffer.byteLength(text),
  });
}

test("captures immediate mount replies and drains only the requests before the cutoff", async () => {
  const page = new EventEmitter();
  const collecting = Promise.withResolvers<void>();
  const body = Promise.withResolvers<string>();
  const afterCutoff = Promise.withResolvers<string>();
  let at = 90;
  const recorder = await openRecordedSession(
    page,
    SESSION,
    async () => {
      page.emit("requestfinished", fixtureRequest({ result: { status: "snapshot" } }));
    },
    () => at,
  );

  at = 110;
  page.emit(
    "requestfinished",
    finishedRequest({
      text: () => {
        collecting.resolve();
        return body.promise;
      },
      responseBytes: 35,
    }),
  );
  await collecting.promise;
  at = 120;
  page.emit("requestfinished", fixtureRequest({ result: {} }, { command: STATE }));
  page.emit(
    "requestfinished",
    fixtureRequest(
      { result: { status: "snapshot" } },
      { args: { logicalSessionKey: "different-session" } },
    ),
  );

  at = 200;
  page.emit(
    "requestfinished",
    finishedRequest({
      text: () => afterCutoff.promise,
      responseBytes: 35,
    }),
  );
  const measurement = recorder.measure(100, 200);
  try {
    expect(recorder.completedSince(100).some((request) => request.command === DISCOVERY)).toBe(
      false,
    );
    at = 210;
    page.emit("requestfinished", fixtureRequest({ result: { status: "snapshot" } }));
    body.resolve(JSON.stringify({ result: { status: "unchanged" } }));

    const { summary, timeline } = await measurement;
    expect(summary).toMatchObject({
      requests: 2,
      rounds: 1,
      byCommand: { [DISCOVERY]: 1, [STATE]: 1 },
    });
    expect(timeline.map(({ atMs, inWindow, status }) => ({ atMs, inWindow, status }))).toEqual([
      { atMs: -10, inWindow: false, status: "snapshot" },
      { atMs: 10, inWindow: true, status: "unchanged" },
    ]);
    expect(await recorder.measure(100, 200)).toEqual({ summary, timeline });
    expect(recorder.completedSince(110)[0]?.at).toBe(110);
  } finally {
    afterCutoff.resolve("");
  }
});

test("reports section sizes, array counts and drift while hashing provider values", async () => {
  const page = new EventEmitter();
  const commands = {
    availability: "ready",
    revision: 2,
    value: [{ name: SENTINEL }],
    catalogue: { error: SENTINEL },
    error: SENTINEL,
  };
  const summary = { state: SENTINEL, drift: { unknownEvents: 3, unknownKinds: [SENTINEL] } };
  const snapshot = {
    result: {
      status: "snapshot",
      resetReason: "forced",
      token: SENTINEL,
      value: {
        identity: { logicalSessionKey: SESSION },
        sections: { commands, runtime: { availability: "ready", revision: 3, value: { summary } } },
      },
    },
  };
  const recorder = await openRecordedSession(
    page,
    SESSION,
    async () => {
      page.emit(
        "requestfinished",
        fixtureRequest(snapshot, {
          args: { logicalSessionKey: SESSION, knownToken: SENTINEL, forceSnapshot: true },
        }),
      );
    },
    () => 110,
  );

  const measurement = await recorder.measure(100, 200);
  const [answer] = measurement.timeline;
  expect(answer).toMatchObject({
    status: "snapshot",
    resetReason: "forced",
    responseBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    forceSnapshot: true,
    sections: {
      commands: {
        availability: "ready",
        revision: 2,
        bytes: Buffer.byteLength(JSON.stringify(commands)),
        entries: 1,
        error: true,
        valueHash: expect.stringMatching(/^[a-f0-9]{10}$/),
        catalogueHash: expect.stringMatching(/^[a-f0-9]{10}$/),
      },
      runtime: {
        unknownEvents: 3,
        summary: {
          state: expect.stringMatching(/^[a-f0-9]{10}$/),
          drift: expect.stringMatching(/^[a-f0-9]{10}$/),
        },
      },
    },
  });
  expect(answer?.token).toMatch(/^[a-f0-9]{10}$/);
  expect(answer?.sentToken).toBe(answer?.token);
  expect(JSON.stringify(measurement)).not.toContain(SENTINEL);
  expect(JSON.stringify(measurement)).not.toContain(SESSION);
});

test("records gateway errors and unreadable bodies without spilling body content or inventing tokens", async () => {
  const page = new EventEmitter();
  const error = { error: SENTINEL, code: "gateway-unavailable" };
  const recorder = await openRecordedSession(
    page,
    SESSION,
    async () => {
      page.emit("requestfinished", fixtureRequest(error));
      page.emit(
        "requestfinished",
        finishedRequest({
          text: async () => SENTINEL,
          responseBytes: Buffer.byteLength(SENTINEL),
        }),
      );
      page.emit(
        "requestfinished",
        finishedRequest({
          text: async () => {
            throw new Error(SENTINEL);
          },
          responseBytes: 25,
        }),
      );
      page.emit("requestfinished", fixtureRequest({ result: { status: "missing" } }));
    },
    () => 110,
  );

  const measurement = await recorder.measure(100, 200);
  expect(measurement.summary.byCommand).toEqual({ [DISCOVERY]: 4 });
  const { timeline } = measurement;
  expect(
    timeline.map(({ status, token, responseBytes }) => ({ status, token, responseBytes })),
  ).toEqual([
    {
      status: "gateway-error",
      token: null,
      responseBytes: Buffer.byteLength(JSON.stringify(error)),
    },
    { status: "unreadable", token: null, responseBytes: Buffer.byteLength(SENTINEL) },
    { status: "unreadable", token: null, responseBytes: 0 },
    {
      status: "missing",
      token: null,
      responseBytes: Buffer.byteLength('{"result":{"status":"missing"}}'),
    },
  ]);
  expect(timeline[2]?.wireBytes).toBe(85);
  expect(JSON.stringify(measurement)).not.toContain(SENTINEL);
});

test("runs the reconnect turn by default and skips it when the opt-out flag is set", async () => {
  const key = "ORKESTRATOR_AGENT_TEST_TAB_REQUESTS_SKIP_RECONNECT";
  const previous = process.env[key];
  let runs = 0;
  const reconnect = async () => {
    runs += 1;
  };
  try {
    delete process.env[key];
    await runOptionalReconnect(reconnect);
    process.env[key] = "1";
    await runOptionalReconnect(reconnect);
    expect(runs).toBe(1);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
