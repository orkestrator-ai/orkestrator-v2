import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  configureLogger,
  createLogger,
  emitLogRecord,
  parseLogRecordLine,
  renderLogLine,
  type LogLevel,
} from "@orkestrator/protocol/logger";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import {
  AUTH_SECRET_CANARIES,
  CANARY_LOGIN_URL,
  captureOutput,
  expectNothingSecretLogged,
} from "../../../../tests/helpers/auth-secret-canaries.js";
import { createBridgeOutputForwarder, redactBridgeOutput } from "./bridge-output-redaction.js";
import { forwardBridgeOutput } from "./commands-servers.js";

/**
 * Every planted credential that has a recognisable shape. The bare OAuth code
 * has none; the guard for it is that no bridge logs one (the route canaries).
 */
const { oauthCode: _shapeless, ...SHAPED } = AUTH_SECRET_CANARIES;

function credentialLines(): string {
  return [
    `Authorization: Bearer ${SHAPED.accessToken}`,
    `ANTHROPIC_API_KEY=${SHAPED.anthropicApiKey}`,
    `token ${SHAPED.claudeOAuthToken} refreshed`,
    `{"apiKey":"${SHAPED.openAiApiKey}"}`,
    `refresh_token: ${SHAPED.refreshToken}`,
    `id ${SHAPED.idToken}`,
    `cursor key ${SHAPED.cursorApiKey}`,
    `xai ${SHAPED.xaiApiKey}`,
    `open ${CANARY_LOGIN_URL}`,
  ].join("\n");
}

describe("bridge output redaction", () => {
  test("scrubs every credential shape a bridge's provider could print", () => {
    const redacted = redactBridgeOutput(credentialLines());
    expectNothingSecretLogged(redacted, "redacted bridge output");
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("cursor key");
  });

  test("reassembles a token split across chunks before redacting it", () => {
    const written: string[] = [];
    const forward = createBridgeOutputForwarder((text) => written.push(text));
    const line = `starting with ${SHAPED.xaiApiKey} and ${SHAPED.accessToken}\n`;
    for (let index = 0; index < line.length; index += 7) forward.push(line.slice(index, index + 7));
    expect(written).toEqual(["starting with [redacted] and [redacted]"]);
  });

  test("bounds a line without a newline and flushes the remainder at the end", () => {
    const written: string[] = [];
    const forward = createBridgeOutputForwarder((text) => written.push(text), 16);
    forward.push("x".repeat(20));
    expect(written).toEqual(["x".repeat(16)]);
    forward.push("tail");
    expect(written).toHaveLength(1);
    forward.flush();
    expect(written).toEqual(["x".repeat(16), "xxxxtail"]);
    forward.flush();
    expect(written).toHaveLength(2);
  });

  test("keeps continuation state bounded across blank lines and flushes a final value", () => {
    const written: string[] = [];
    const forward = createBridgeOutputForwarder((text) => written.push(text), 64);
    forward.push("password:\n");
    for (let index = 0; index < 1000; index++) forward.push(" ".repeat(65) + "\n");
    forward.push("opaque-test-canary-12345");
    forward.flush();
    forward.flush();
    expect(written.at(-1)).toBe("[redacted]");
    expect(written.every((line) => line.length <= 64)).toBe(true);
    expect(written.join("\n")).not.toContain("opaque-test-canary-12345");
  });

  test("a local bridge's stdout and stderr reach the console without a planted credential", async () => {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    const { output } = await captureOutput(async () => {
      forwardBridgeOutput(child as never, "codex:env-1");
      const text = credentialLines();
      child.stdout.write(text.slice(0, 40));
      child.stdout.write(`${text.slice(40)}\n`);
      child.stderr.write(`error: ${SHAPED.anthropicApiKey}`);
      child.stdout.end();
      child.stderr.end();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(output).toContain("[codex:env-1] Authorization: Bearer [redacted]");
    expect(output).toContain("[codex:env-1] error: [redacted]");
    expectNothingSecretLogged(output, "forwarded bridge output");
  });
});

describe("bridge log levels across the hop", () => {
  let capture: LogCapture;
  afterEach(() => capture?.restore());

  /** What a local bridge writes: a logger entry as one JSON line. */
  function bridgeLine(level: LogLevel, fields?: Record<string, string>): string {
    configureLogger({ format: "json" });
    const line = renderLogLine(level, "bridge.codex", "app-server.exited", fields);
    configureLogger({ format: "text" });
    return line;
  }

  async function forward(write: (child: { stdout: PassThrough; stderr: PassThrough }) => void) {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    forwardBridgeOutput(child as never, "codex:env-1");
    write(child);
    child.stdout.end();
    child.stderr.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  test.each(["error", "warn", "info", "debug", "trace"] as const)(
    "a %s record keeps its level on stdout or stderr, and names its bridge",
    async (level) => {
      capture = captureLogs();
      await forward((child) => child.stdout.write(`${bridgeLine(level, { detail: "x" })}\n`));
      expect(capture.records()).toEqual([
        expect.objectContaining({
          level,
          area: "bridge.codex",
          event: "app-server.exited",
          fields: { source: "codex:env-1", detail: "x" },
        }),
      ]);
    },
  );

  test("a chunk mixing records with a crash splits per line; every line is captured", async () => {
    capture = captureLogs();
    await forward((child) => {
      child.stderr.write(
        [
          bridgeLine("warn"),
          "panic: index out of range",
          "  at frame",
          '{"not":"a record"}',
          bridgeLine("error"),
          "",
        ].join("\n"),
      );
    });
    expect(capture.records().map((record) => record.level)).toEqual(["warn", "error"]);
    expect(capture.outputs.filter((output) => !output.record).map((output) => output.line)).toEqual(
      [
        "[codex:env-1] panic: index out of range",
        "[codex:env-1]   at frame",
        '[codex:env-1] {"not":"a record"}',
      ],
    );
    expect(capture.outputs.find((output) => !output.record)?.method).toBe("error");
  });

  test("unstructured stdout stays captured, and an imitation cannot hide a line", async () => {
    capture = captureLogs();
    const unknownArea = '{"orklog":1,"ts":"t","level":"debug","area":"nope","event":"x"}';
    await forward((child) => child.stdout.write(`plain text\n${unknownArea}\n`));
    expect(capture.outputs.map((output) => [output.method, output.line])).toEqual([
      ["log", "[codex:env-1] plain text"],
      ["log", `[codex:env-1] ${unknownArea}`],
    ]);
  });

  test("a credential in a record's field is scrubbed before the record is re-emitted", async () => {
    capture = captureLogs();
    await forward((child) =>
      child.stdout.write(`${bridgeLine("warn", { detail: `open ${SHAPED.xaiApiKey}` })}\n`),
    );
    expect(capture.records()[0]?.fields?.detail).toBe("open [redacted]");
    expectNothingSecretLogged(capture.lines.join("\n"), "relayed record");
  });

  test("a bridge cannot claim another bridge's source", async () => {
    capture = captureLogs();
    await forward((child) =>
      child.stdout.write(`${bridgeLine("info", { source: "claude:other" })}\n`),
    );
    expect(capture.records()[0]?.fields).toEqual({ source: "codex:env-1" });
  });

  test.each([
    'api_key: "opaque-test-canary-12345"',
    'prefix\napi_key:\t"opaque-test-canary-12345"',
    "prefix\tBearer\topaque-test-canary-12345",
    "prefix\nBearer\nopaque-test-canary-12345",
  ])("redacts decoded credentials in %j through the full hop", async (path) => {
    capture = captureLogs();
    await forward((child) => {
      const line = `${bridgeLine("warn", { path })}\n`;
      // Include a chunk boundary inside JSON's escaped representation.
      child.stdout.write(line.slice(0, -20));
      child.stdout.write(line.slice(-20));
    });
    expect(capture.records()).toHaveLength(1);
    expect(capture.records()[0]?.fields?.path).toContain("[redacted]");
    expect(JSON.stringify(capture.records())).not.toContain("opaque-test-canary-12345");
    expect(capture.lines.join("\n")).not.toContain("opaque-test-canary-12345");
  });

  test.each(["password:", "Bearer"])(
    "raw %s value on the next line without a final newline",
    async (introducer) => {
      capture = captureLogs();
      await forward((child) => child.stdout.write(`${introducer}\nopaque-test-canary-12345`));
      expect(capture.lines.join("\n")).not.toContain("opaque-test-canary-12345");
      expect(capture.lines.join("\n")).toContain("[redacted]");
    },
  );

  for (const introducer of ["password:", "OPENAI_API_KEY=", "Bearer", "Basic"]) {
    for (const ending of ["\n", "\r\n", "\r"]) {
      for (const chunked of [false, true]) {
        test(`raw ${introducer} continuation, ${JSON.stringify(ending)}, chunked=${chunked}`, async () => {
          capture = captureLogs();
          await forward((child) => {
            for (const stream of [child.stdout, child.stderr]) {
              const wire = `${introducer}${ending}opaqueTestCanary12345${ending}safe diagnostic${ending}`;
              if (chunked) {
                for (const byte of Buffer.from(wire)) stream.write(Buffer.from([byte]));
              } else {
                stream.write(wire);
              }
            }
          });
          expect(capture.lines.join("\n")).not.toContain("opaqueTestCanary12345");
          expect(capture.lines.join("\n")).toContain("[redacted]");
          expect(capture.lines.join("\n")).toContain("safe diagnostic");
        });
      }
    }
  }

  test("redacts decoded formatted error strings, stack frames and nested causes", async () => {
    capture = captureLogs();
    await forward((child) => {
      const wire = JSON.stringify({
        ...JSON.parse(bridgeLine("error")),
        fields: {
          error: {
            name: "Error",
            message: `failed ${SHAPED.xaiApiKey}`,
            stack: [`at ${SHAPED.cursorApiKey} (fixture:1:1)`],
            cause: { name: "Error", message: `cause ${SHAPED.refreshToken}` },
          },
          count: 2,
          retryable: false,
          optional: null,
        },
      })
        .replaceAll("xai-", "\\u0078ai-")
        .replaceAll("key_", "\\u006bey_")
        .replaceAll("rt_", "\\u0072t_");
      child.stderr.write(`${wire}\n`);
    });
    expect(capture.records()[0]?.fields).toEqual({
      source: "codex:env-1",
      error: {
        name: "Error",
        message: "failed [redacted]",
        stack: ["at [redacted] (fixture:1:1)"],
        cause: { name: "Error", message: "cause [redacted]" },
      },
      count: 2,
      retryable: false,
      optional: null,
    });
    expectNothingSecretLogged(JSON.stringify(capture.records()), "decoded errors");
    expectNothingSecretLogged(capture.lines.join("\n"), "rendered errors");
  });

  test("a record reaches the desktop's file level through both relays, fields intact", async () => {
    // Backend, supervised: re-emits as JSON on its own stdio. Desktop: reads
    // that line and re-emits it at its level in the user's format.
    const backend = captureLogs();
    configureLogger({ format: "text" });
    capture = backend;
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    forwardBridgeOutput(child as never, "codex:env-1");
    const line = bridgeLine("warn", { detail: "x" });
    configureLogger({ format: "json" });
    child.stderr.write(`${line}\n`);
    child.stderr.end();
    child.stdout.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const relayed = backend.lines[0]!;
    expect(backend.outputs[0]?.method).toBe("warn");

    const desktop = captureLogs();
    configureLogger({ format: "text" });
    capture = desktop;
    emitLogRecord(parseLogRecordLine(relayed)!);
    expect(desktop.outputs.at(-1)).toMatchObject({
      method: "warn",
      line: "[bridge.codex] app-server.exited source=codex:env-1 detail=x",
    });
  });

  test("the source's threshold decides; the hop never filters", async () => {
    capture = captureLogs();
    const line = bridgeLine("debug");
    configureLogger({ level: "error" });
    await forward((child) => child.stdout.write(`${line}\n`));
    expect(capture.records().map((record) => record.level)).toEqual(["debug"]);
    createLogger("bridge.codex").debug("app-server.exited");
    expect(capture.records()).toHaveLength(1);
  });
});
