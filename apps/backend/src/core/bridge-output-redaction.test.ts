import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
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
    expect(written).toEqual(["x".repeat(20)]);
    forward.push("tail");
    expect(written).toHaveLength(1);
    forward.flush();
    expect(written).toEqual(["x".repeat(20), "tail"]);
    forward.flush();
    expect(written).toHaveLength(2);
  });

  test("a local bridge's stdout and stderr reach the console without a planted credential", async () => {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    const { output } = await captureOutput(async () => {
      forwardBridgeOutput(child as never, "[codex:env-1]");
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
