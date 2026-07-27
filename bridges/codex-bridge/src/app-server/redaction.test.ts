import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redaction.js";

describe("redactSecrets", () => {
  test("removes an Authorization bearer token but keeps the header name", () => {
    const redacted = redactSecrets("Authorization: Bearer ghp_0123456789abcdefghij");
    expect(redacted).not.toContain("ghp_0123456789abcdefghij");
    // The shape of the failure has to stay diagnosable.
    expect(redacted).toContain("Bearer");
  });

  test("removes basic auth credentials", () => {
    const redacted = redactSecrets("Authorization: Basic dXNlcjpodW50ZXIy");
    expect(redacted).not.toContain("dXNlcjpodW50ZXIy");
    expect(redacted).toContain("Basic [redacted]");
  });

  test.each([
    ["OpenAI style", "key sk-live-0123456789abcdefgh here", "sk-live-0123456789abcdefgh"],
    ["GitHub PAT", "token ghp_0123456789abcdefghij", "ghp_0123456789abcdefghij"],
    ["GitHub fine-grained", "github_pat_11ABCDEFG0abcdefghijklmnop", "github_pat_11ABCDEFG0abcdefghijklmnop"],
    ["Slack", "xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["AWS", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["Google", "AIzaSyA0123456789abcdefghijklmnopqrs", "AIzaSyA0123456789abcdefghijklmnopqrs"],
    [
      "JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ],
  ])("removes a %s token", (_label, input, secret) => {
    expect(redactSecrets(input)).not.toContain(secret);
  });

  test("removes URL userinfo, keeping the host so the error still identifies the server", () => {
    const redacted = redactSecrets("connect https://svc:hunter2@api.test/v1 failed");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("svc:");
    expect(redacted).toContain("api.test/v1");
  });

  test("removes query-string credentials without eating the rest of the URL", () => {
    const redacted = redactSecrets(
      "GET https://api.test/v1?region=eu&api_key=abcdef123456&page=2",
    );
    expect(redacted).not.toContain("abcdef123456");
    expect(redacted).toContain("region=eu");
    expect(redacted).toContain("page=2");
  });

  test.each(["access_token", "refresh_token", "token", "secret", "password", "signature"])(
    "removes a %s query parameter",
    (parameter) => {
      const redacted = redactSecrets(`https://api.test/cb?${parameter}=zzzz9999abcd`);
      expect(redacted).not.toContain("zzzz9999abcd");
    },
  );

  test("removes assignment-style credentials in prose or a config dump", () => {
    for (const line of [
      'api_key: "abcdef123456789"',
      "OPENAI_API_KEY=abcdef123456789",
      "client_secret = abcdef123456789",
      "password: abcdef123456789",
    ]) {
      expect(redactSecrets(line)).not.toContain("abcdef123456789");
    }
  });

  test("leaves ordinary text and short values alone", () => {
    const message = "MCP server deploy failed to start: exit code 1 (timeout after 30s)";
    expect(redactSecrets(message)).toBe(message);
  });

  test("is stateless across calls despite the /g patterns", () => {
    // A shared /g RegExp carries lastIndex between calls, which would silently
    // skip a token on every other invocation.
    const input = "Bearer ghp_0123456789abcdefghij";
    expect(redactSecrets(input)).toBe(redactSecrets(input));
    expect(redactSecrets(input)).not.toContain("ghp_0123456789abcdefghij");
  });
});
