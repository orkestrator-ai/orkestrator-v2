/**
 * OpenCode's sign-in status is built from its server's provider list
 * (`openCode2AuthStatus`), which carries each provider's options and can
 * carry its key. Nothing but ids, labels and states may reach the answer, and
 * nothing may be logged (`tests/helpers/auth-secret-canaries.ts`).
 */
import { expect, test } from "bun:test";
import {
  AUTH_SECRET_CANARIES,
  captureOutput,
  expectAuthStatusShape,
  expectNoCanary,
  expectNothingSecretLogged,
} from "../../../../../tests/helpers/auth-secret-canaries.js";
import { openCode2AuthStatus } from "./credentials.js";

test("the OpenCode sign-in status carries no credential from the provider list", async () => {
  const providers = [
    {
      id: "openai",
      name: "OpenAI",
      key: AUTH_SECRET_CANARIES.openAiApiKey,
      options: { apiKey: AUTH_SECRET_CANARIES.openAiApiKey },
    },
    {
      id: "opencode",
      name: "OpenCode Zen",
      options: { apiKey: AUTH_SECRET_CANARIES.openCodeZenApiKey },
      credential: { access: AUTH_SECRET_CANARIES.accessToken },
    },
  ];
  const { result, output } = await captureOutput(() =>
    openCode2AuthStatus(providers, ["opencode"], "Run /login"),
  );
  expectAuthStatusShape(result);
  expectNoCanary(result, "OpenCode sign-in status");
  expectNothingSecretLogged(output, "OpenCode sign-in status");
  expect(result.state).toBe("signed-in");
});
