import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { claudeConnection, codexConnection, httpProvider } from "./agent-provider-test-support.js";

const SESSION_ID = "private-session-id";
const QUALIFIED = () => Response.json({ dispatch: "unknown" });

describe("steer qualification logging", () => {
  let logs: LogCapture;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  const steerRecords = () => logs.records().filter((record) => record.area === "native-agent");

  test.each([
    [404, "http-404"],
    [401, "http-401"],
    [503, "http-503"],
  ])("warns with the agent and status when the bridge answers %i", async (status, kind) => {
    const { provider } = httpProvider(
      () => new Response(`body quoting ${SESSION_ID}`, { status }),
      codexConnection,
    );

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    expect(steerRecords()).toMatchObject([
      {
        level: "warn",
        event: "steer.qualification-failed",
        fields: { agent: "codex", status, kind },
      },
    ]);
  });

  test("warns with the error class, and no URL or message, when the request fails", async () => {
    const { provider } = httpProvider(() => {
      throw new Error(`socket closed for http://claude.test/session/${SESSION_ID}/steer/dispatch`);
    }, claudeConnection);

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    const [record, ...rest] = steerRecords();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      level: "warn",
      event: "steer.qualification-failed",
      fields: {
        agent: "claude",
        kind: "ProviderUnavailableError",
        error: { name: "ProviderUnavailableError", cause: { name: "Error" } },
      },
    });
    expect(JSON.stringify(record)).not.toContain("message");
    expect(JSON.stringify(record)).not.toContain("stack");
  });

  test("names a bridge that never connected", async () => {
    const { provider } = httpProvider(() => {
      throw Object.assign(new Error("connect failed"), { code: "ConnectionRefused" });
    }, claudeConnection);

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    expect(steerRecords()).toMatchObject([
      {
        fields: {
          kind: "ProviderUnreachableError",
          error: { name: "ProviderUnreachableError", cause: { code: "ConnectionRefused" } },
        },
      },
    ]);
  });

  test("names a bridge that stopped answering", async () => {
    const { provider } = httpProvider(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
      codexConnection,
    );

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    expect(steerRecords()).toMatchObject([
      {
        fields: {
          kind: "ProviderUnavailableError",
          error: { name: "ProviderUnavailableError", cause: { name: "TimeoutError" } },
        },
      },
    ]);
  });

  test("warns when a 200 answer is not a qualification", async () => {
    const { provider } = httpProvider(
      () => Response.json({ dispatch: "absent" }),
      claudeConnection,
    );

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    expect(steerRecords()).toMatchObject([
      {
        event: "steer.qualification-failed",
        fields: { agent: "claude", status: 200, kind: "unexpected-answer" },
      },
    ]);
  });

  test("warns the same way when a 200 body cannot be read", async () => {
    const { provider } = httpProvider(
      () => new Response(`not json ${SESSION_ID}`),
      claudeConnection,
    );

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    expect(steerRecords()).toMatchObject([
      {
        event: "steer.qualification-failed",
        fields: { agent: "claude", status: 200, kind: "unexpected-answer" },
      },
    ]);
  });

  test("never writes the session id or the response body on any line", async () => {
    let answer: () => Response = () => new Response(`body ${SESSION_ID}`, { status: 500 });
    const { provider } = httpProvider(() => answer(), claudeConnection);

    await provider.steerSupported!(SESSION_ID);
    answer = () => {
      throw new Error(`failed ${SESSION_ID}`);
    };
    await provider.steerSupported!(SESSION_ID);
    answer = () => new Response(`not json ${SESSION_ID}`);
    await provider.steerSupported!(SESSION_ID);
    answer = QUALIFIED;
    await provider.steerSupported!(SESSION_ID);

    expect(logs.lines.length).toBeGreaterThanOrEqual(4);
    expect(logs.lines.join("\n")).not.toContain(SESSION_ID);
  });

  test("writes one line while the same fault repeats", async () => {
    const { provider } = httpProvider(() => new Response(null, { status: 404 }), codexConnection);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);
    }

    expect(steerRecords().map((record) => record.event)).toEqual(["steer.qualification-failed"]);
  });

  test("a different status on the same bridge is written at once", async () => {
    let status = 404;
    const { provider } = httpProvider(() => new Response(null, { status }), codexConnection);

    await provider.steerSupported!(SESSION_ID);
    status = 502;
    await provider.steerSupported!(SESSION_ID);

    expect(steerRecords().map((record) => record.fields?.kind)).toEqual(["http-404", "http-502"]);
  });

  test("reports recovery once qualification succeeds, and nothing when it never failed", async () => {
    let healthy = true;
    const { provider } = httpProvider(
      () => (healthy ? QUALIFIED() : new Response(null, { status: 503 })),
      codexConnection,
    );

    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(true);
    expect(steerRecords()).toEqual([]);

    healthy = false;
    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(false);
    healthy = true;
    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(true);
    await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(true);

    expect(steerRecords()).toMatchObject([
      { event: "steer.qualification-failed" },
      { event: "throttle.recovered", fields: { site: "steer.qualification-failed", failures: 1 } },
    ]);
  });

  test("one bridge's success does not report a recovery for another's fault", async () => {
    const failing = httpProvider(() => new Response(null, { status: 503 }), codexConnection);
    const healthy = httpProvider(QUALIFIED, codexConnection);

    await expect(failing.provider.steerSupported!(SESSION_ID)).resolves.toBe(false);
    await expect(healthy.provider.steerSupported!(SESSION_ID)).resolves.toBe(true);
    await expect(failing.provider.steerSupported!(SESSION_ID)).resolves.toBe(false);

    expect(steerRecords().map((record) => record.event)).toEqual(["steer.qualification-failed"]);
  });

  test.each(["unknown", "dispatched"])(
    "still qualifies a bridge that answers %s, without logging",
    async (dispatch) => {
      const { provider } = httpProvider(() => Response.json({ dispatch }), codexConnection);

      await expect(provider.steerSupported!(SESSION_ID)).resolves.toBe(true);
      expect(steerRecords()).toEqual([]);
    },
  );
});
