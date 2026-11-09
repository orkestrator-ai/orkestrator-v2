import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import {
  legacyOpenCodeAuthFile,
  mirrorOpenCode2Credential,
  openCode2AuthStatus,
  openCode2CredentialFromLegacy,
  readLegacyOpenCodeCredential,
} from "./credentials.js";

// Fake values only; nothing here is a real credential.
const FAKE_KEY = "sk-fake-opencode2-mirror-key";

let server: FakeOpenCode2Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  server?.stop();
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("openCode2CredentialFromLegacy", () => {
  test("maps auth.json entries the way 2.x's own import does", () => {
    expect(
      openCode2CredentialFromLegacy("opencode-go", {
        type: "api",
        key: FAKE_KEY,
        metadata: { region: "eu", ignored: 3 },
      }),
    ).toEqual({ type: "key", key: FAKE_KEY, metadata: { region: "eu" } });
    expect(openCode2CredentialFromLegacy("x", { type: "wellknown", key: "k", token: "t" })).toEqual(
      { type: "key", key: "t" },
    );
    const oauth = { type: "oauth", refresh: "r", access: "a", expires: 5, accountId: "acct" };
    expect(openCode2CredentialFromLegacy("openai", oauth)).toEqual({
      type: "oauth",
      methodID: "chatgpt-browser",
      refresh: "r",
      access: "a",
      expires: 5,
      metadata: { accountID: "acct" },
    });
    expect(openCode2CredentialFromLegacy("github-copilot", oauth)).toMatchObject({
      methodID: "device",
    });
    expect(openCode2CredentialFromLegacy("gitlab", oauth)).toMatchObject({ methodID: "oauth" });
    expect(openCode2CredentialFromLegacy("x", { type: "api" })).toBeUndefined();
    expect(openCode2CredentialFromLegacy("x", { type: "oauth", refresh: "r" })).toBeUndefined();
  });
});

describe("readLegacyOpenCodeCredential", () => {
  test("reads one provider's entry; a missing store is signed out, a broken one throws", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ork-oc2-auth-"));
    const file = path.join(dir, "auth.json");
    expect(await readLegacyOpenCodeCredential(file, "opencode-go")).toBeUndefined();
    await writeFile(
      file,
      JSON.stringify({ "opencode-go": { type: "api", key: FAKE_KEY }, "openai/": { type: "x" } }),
    );
    expect(await readLegacyOpenCodeCredential(file, "opencode-go")).toEqual({
      type: "key",
      key: FAKE_KEY,
    });
    expect(await readLegacyOpenCodeCredential(file, "openai")).toBeUndefined();
    await writeFile(file, "{not json");
    await expect(readLegacyOpenCodeCredential(file, "opencode-go")).rejects.toThrow(
      "not valid JSON",
    );
  });

  test("the store path follows XDG_DATA_HOME", () => {
    expect(legacyOpenCodeAuthFile({ HOME: "/h" })).toBe("/h/.local/share/opencode/auth.json");
    expect(legacyOpenCodeAuthFile({ HOME: "/h", XDG_DATA_HOME: "/x" })).toBe(
      "/x/opencode/auth.json",
    );
  });
});

describe("mirrorOpenCode2Credential", () => {
  test("replaces the provider's credentials with the new one, then removes them all", async () => {
    server = new FakeOpenCode2Server();
    const client = server.client();
    server.credentials.push(
      { id: "cred_old", integrationID: "opencode-go", label: "API key", active: true, value: {} },
      { id: "cred_other", integrationID: "anthropic", label: "API key", active: true, value: {} },
    );
    expect(
      await mirrorOpenCode2Credential(client, "opencode-go", { type: "key", key: FAKE_KEY }),
    ).toBe("written");
    expect(server.credentials.map((credential) => credential.integrationID).sort()).toEqual([
      "anthropic",
      "opencode-go",
    ]);
    const written = server.credentials.find((c) => c.integrationID === "opencode-go")!;
    expect(written).toMatchObject({ active: true, value: { type: "key", key: FAKE_KEY } });
    expect(written.id).not.toBe("cred_old");
    expect(await mirrorOpenCode2Credential(client, "opencode-go", undefined)).toBe("removed");
    expect(await mirrorOpenCode2Credential(client, "opencode-go", undefined)).toBe("unchanged");
    expect(server.credentials.map((credential) => credential.id)).toEqual(["cred_other"]);
    await expect(mirrorOpenCode2Credential(client, "../x", undefined)).rejects.toThrow(
      "Invalid OpenCode provider id",
    );
  });
});

describe("openCode2AuthStatus", () => {
  test("listed providers are signed in; the allowlist decides the state", () => {
    const providers = [
      { id: "fixture", name: "Fixture", activation: "enabled", settings: { apiKey: FAKE_KEY } },
      { id: "opencode", name: "OpenCode", activation: "auto" },
      { id: "off", name: "Off", activation: "disabled" },
    ];
    const status = openCode2AuthStatus(providers, ["opencode"], "hint");
    expect(status.state).toBe("signed-in");
    expect(status.providers?.map((provider) => provider.id)).toEqual(["opencode", "fixture"]);
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
    expect(openCode2AuthStatus(providers, ["anthropic"], "hint").state).toBe("needs-auth");
  });
});
