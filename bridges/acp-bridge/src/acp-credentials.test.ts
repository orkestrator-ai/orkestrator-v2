import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acpReadiness,
  acpSignInMissing,
  assertAcpSignedIn,
  CredentialError,
  GROK_SIGN_IN_REQUIRED_MESSAGE,
} from "./acp-credentials.js";

const ENV_KEYS = [
  "GROK_HOME",
  "GROK_AUTH_FILE",
  "XAI_API_KEY",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_METHOD_ID",
] as const;

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  home = await mkdtemp(join(tmpdir(), "acp-credentials-"));
  process.env.GROK_HOME = home;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(home, { recursive: true, force: true });
});

describe("ACP sign-in check", () => {
  test("confirms a missing Grok login only when nothing could sign in", async () => {
    expect(await acpSignInMissing("grok", "GROK_AUTH_METHOD_ID")).toBe(true);
    expect(await acpReadiness("grok", "GROK_AUTH_METHOD_ID")).toEqual({
      state: "authentication-required",
      message: GROK_SIGN_IN_REQUIRED_MESSAGE,
      signIn: { kind: "terminal", hint: "Open a terminal and run grok login." },
    });
    await expect(assertAcpSignedIn("grok", "GROK_AUTH_METHOD_ID")).rejects.toBeInstanceOf(
      CredentialError,
    );
  });

  test("never claims another provider is signed out", async () => {
    expect(await acpSignInMissing("cursor", undefined)).toBe(false);
    expect(await acpReadiness("cursor", undefined)).toBeUndefined();
  });

  test.each([
    ["a stored login", async () => fs.writeFile(join(home, "auth.json"), "{}")],
    ["an API key fallback", async () => void (process.env.XAI_API_KEY = "xai-test")],
    [
      "an external auth provider in the environment",
      async () => void (process.env.GROK_AUTH_PROVIDER_COMMAND = "/bin/true"),
    ],
    [
      "an external auth provider in config.toml",
      async () =>
        fs.writeFile(join(home, "config.toml"), '[auth]\nauth_provider_command = "/bin/true"\n'),
    ],
    ["a configured auth method", async () => void (process.env.GROK_AUTH_METHOD_ID = "grok.com")],
  ])("leaves Grok to authenticate itself given %s", async (_name, arrange) => {
    await arrange();
    expect(await acpSignInMissing("grok", "GROK_AUTH_METHOD_ID")).toBe(false);
    expect(await acpReadiness("grok", "GROK_AUTH_METHOD_ID")).toBeUndefined();
    await assertAcpSignedIn("grok", "GROK_AUTH_METHOD_ID");
  });

  test.each([
    ["XAI_API_KEY", "xai-test"],
    ["GROK_AUTH_PROVIDER_COMMAND", "/bin/true"],
    ["GROK_AUTH_METHOD_ID", "grok.com"],
  ])("uses %s from the effective child environment", async (key, value) => {
    const env = { ...process.env, [key]: value };
    expect(await acpSignInMissing("grok", "GROK_AUTH_METHOD_ID", env)).toBe(false);
    expect(await acpReadiness("grok", "GROK_AUTH_METHOD_ID", env)).toBeUndefined();
    await assertAcpSignedIn("grok", "GROK_AUTH_METHOD_ID", env);
    expect(process.env[key]).toBeUndefined();
  });

  test.each(["auth.json", "config.toml"])(
    "resolves %s under the child's GROK_HOME",
    async (file) => {
      const relocated = join(home, "child");
      await fs.mkdir(relocated);
      await fs.writeFile(
        join(relocated, file),
        file === "auth.json" ? "{}" : 'auth_provider_command = "/bin/true"',
      );
      expect(await acpSignInMissing("grok", undefined)).toBe(true);
      expect(
        await acpSignInMissing("grok", undefined, { ...process.env, GROK_HOME: relocated }),
      ).toBe(false);
    },
  );

  test("resolves the default home and explicit auth file in the child's environment", async () => {
    await fs.mkdir(join(home, ".grok"));
    await fs.writeFile(join(home, ".grok", "auth.json"), "{}");
    expect(await acpSignInMissing("grok", undefined, { HOME: home })).toBe(false);
    expect(
      await acpSignInMissing("grok", undefined, {
        GROK_AUTH_FILE: join(home, ".grok", "auth.json"),
      }),
    ).toBe(false);
    expect(
      await acpSignInMissing("grok", undefined, {
        HOME: home,
        GROK_AUTH_FILE: join(home, "missing"),
      }),
    ).toBe(true);
  });

  test("reads an explicit credential path over GROK_HOME", async () => {
    await fs.writeFile(join(home, "auth.json"), "{}");
    process.env.GROK_AUTH_FILE = join(home, "elsewhere.json");
    expect(await acpSignInMissing("grok", undefined)).toBe(true);
  });
});
