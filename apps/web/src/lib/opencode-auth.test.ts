import { describe, expect, test } from "bun:test";
import { openCodeCredentialFailureProvider } from "./opencode-auth";

const EXPIRED =
  "Model request failed (HTTP 401): This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.";

function row(content: string, overrides: { id?: string; modelId?: string } = {}) {
  return {
    id: overrides.id ?? "error-opencode-msg-1",
    content,
    modelId: "modelId" in overrides ? overrides.modelId : "opencode-go/deepseek-v4-pro",
  };
}

describe("openCodeCredentialFailureProvider", () => {
  test("names the provider of a request refused with HTTP 401", () => {
    expect(openCodeCredentialFailureProvider(row(EXPIRED))).toBe("opencode-go");
    expect(
      openCodeCredentialFailureProvider(row("Model request failed (HTTP 401): Unauthorized")),
    ).toBe("opencode-go");
  });

  test("needs credential wording for a 403, an unknown status or OpenCode's own auth error", () => {
    expect(
      openCodeCredentialFailureProvider(row("Model request failed (HTTP 403): Invalid API key")),
    ).toBe("opencode-go");
    expect(
      openCodeCredentialFailureProvider(row("Model request failed (HTTP 403): Region blocked")),
    ).toBeUndefined();
    expect(openCodeCredentialFailureProvider(row("Invalid API key"))).toBe("opencode-go");
    expect(openCodeCredentialFailureProvider(row("OpenCode session failed"))).toBeUndefined();
  });

  test("ignores other statuses even when they mention a key", () => {
    expect(
      openCodeCredentialFailureProvider(
        row("Model request failed (HTTP 429): Rate limit reached for this API key"),
      ),
    ).toBeUndefined();
    expect(
      openCodeCredentialFailureProvider(
        row("Model request failed (HTTP 500): API key service down"),
      ),
    ).toBeUndefined();
  });

  test("ignores anything but an error row naming its provider", () => {
    expect(openCodeCredentialFailureProvider(row(EXPIRED, { id: "msg-1" }))).toBeUndefined();
    expect(openCodeCredentialFailureProvider(row(EXPIRED, { modelId: undefined }))).toBeUndefined();
    expect(
      openCodeCredentialFailureProvider(row(EXPIRED, { modelId: "deepseek-v4-pro" })),
    ).toBeUndefined();
  });
});
