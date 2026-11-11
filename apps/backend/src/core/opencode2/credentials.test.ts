import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import {
  exportOpenCode2Logins,
  exportOpenCode2Refreshes,
  keepActiveOpenCode2Credential,
  legacyLoginFromOpenCode2,
  openCode2AuthStatus,
  openCode2RefreshFingerprint,
  openCode2CredentialFromLegacy,
  removeOpenCode2Credentials,
  runningOpenCode2HostClient,
} from "./credentials.js";
import { openCode2ServerKey } from "./host-server-state.js";

// Fake values only; nothing here is a real credential.
const FAKE_KEY = "sk-fake-opencode2-store-key";

let server: FakeOpenCode2Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  server?.stop();
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function authFile(contents?: unknown): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "ork-oc2-auth-"));
  const file = path.join(dir, "opencode", "auth.json");
  await mkdir(path.dirname(file), { recursive: true });
  if (contents !== undefined) await writeFile(file, JSON.stringify(contents));
  return file;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function store(...entries: Array<[string, unknown, boolean?]>) {
  server = new FakeOpenCode2Server();
  entries.forEach(([integrationID, value, active], index) =>
    server!.credentials.push({
      id: `cred_${index}`,
      integrationID,
      label: "x",
      active: active ?? true,
      value,
    }),
  );
  return server;
}

describe("the two credential shapes", () => {
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

  test.each([
    { refresh: "", access: "a" },
    { refresh: "r", access: "" },
    { refresh: "", access: "" },
  ])("rejects empty OAuth secrets: %j", (secrets) => {
    expect(
      openCode2CredentialFromLegacy("openai", { type: "oauth", expires: 123, ...secrets }),
    ).toBeUndefined();
    expect(
      legacyLoginFromOpenCode2({ type: "oauth", methodID: "m", expires: 123, ...secrets }),
    ).toBeUndefined();
  });

  test("a 2.x credential becomes the auth.json entry 2.x would import back into it", () => {
    const key = { type: "key", key: FAKE_KEY, metadata: { resourceName: "res" } };
    expect(legacyLoginFromOpenCode2(key)).toEqual({
      type: "api",
      key: FAKE_KEY,
      metadata: { resourceName: "res" },
    });
    const oauth = {
      type: "oauth" as const,
      methodID: "device",
      refresh: "r",
      access: "a",
      expires: 9,
      metadata: { accountID: "acct", enterpriseUrl: "ghe.example", other: "x" },
    };
    const legacy = legacyLoginFromOpenCode2(oauth)!;
    expect(legacy).toEqual({
      type: "oauth",
      refresh: "r",
      access: "a",
      expires: 9,
      accountId: "acct",
      enterpriseUrl: "ghe.example",
    });
    expect(openCode2CredentialFromLegacy("github-copilot", legacy)).toEqual({
      ...oauth,
      metadata: { accountID: "acct", enterpriseUrl: "ghe.example" },
    });
    // An AWS profile names host configuration; auth.json has no shape for it.
    expect(legacyLoginFromOpenCode2({ type: "external", methodID: "aws-profile" })).toBeUndefined();
  });
});

describe("the host store", () => {
  test("keeps the active credential of a provider after a connect, and signs it out", async () => {
    const fake = store(
      ["opencode-go", { type: "key", key: "old" }, false],
      ["anthropic", { type: "key", key: "other" }],
      ["opencode-go", { type: "key", key: FAKE_KEY }],
    );
    await keepActiveOpenCode2Credential(fake.client(), "opencode-go");
    expect(fake.credentials.map((credential) => credential.id)).toEqual(["cred_1", "cred_2"]);
    expect(await removeOpenCode2Credentials(fake.client(), "opencode-go")).toBe(1);
    expect(await removeOpenCode2Credentials(fake.client(), "opencode-go")).toBe(0);
    expect(fake.credentials.map((credential) => credential.id)).toEqual(["cred_1"]);
    await expect(removeOpenCode2Credentials(fake.client(), "../x")).rejects.toThrow(
      "Invalid OpenCode provider id",
    );
  });

  test("with no active credential nothing is removed", async () => {
    const fake = store(["openai", { type: "key", key: "a" }, false]);
    await keepActiveOpenCode2Credential(fake.client(), "openai");
    expect(fake.credentials).toHaveLength(1);
  });

  test("the running host server is the first live one this backend owns", () => {
    const child = { exitCode: null, signalCode: null };
    const stale = { exitCode: null, signalCode: null };
    const records = [
      ["stale", { child: stale, port: 1, password: "p1", directory: "/a" }],
      ["env-1", { child, port: 4242, password: "p2", directory: "/work" }],
    ] as const;
    const localServers = {
      openCode2: { live: () => records },
      process: (key: string) => (key === openCode2ServerKey("env-1") ? child : undefined),
    };
    const client = runningOpenCode2HostClient(localServers as never);
    expect(client?.baseUrl).toBe("http://127.0.0.1:4242");
    expect(client?.directory).toBe("/work");
    expect(
      runningOpenCode2HostClient({
        openCode2: { live: () => [] },
        process: () => undefined,
      } as never),
    ).toBeUndefined();
  });
});

describe("the container hand-off file", () => {
  test("a sign-in change writes the provider's entry, replacing its old one; a sign-out removes it", async () => {
    const file = await authFile({
      "opencode-go/": { type: "api", key: "old" },
      pi: { type: "api", key: "untouched" },
    });
    const fake = store(["opencode-go", { type: "key", key: FAKE_KEY }]);
    await exportOpenCode2Logins(fake.client(), file, ["opencode-go"]);
    expect(await readJson(file)).toEqual({
      pi: { type: "api", key: "untouched" },
      "opencode-go": { type: "api", key: FAKE_KEY },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    fake.credentials.length = 0;
    await exportOpenCode2Logins(fake.client(), file, ["opencode-go"]);
    expect(await readJson(file)).toEqual({ pi: { type: "api", key: "untouched" } });
  });

  test("an unchanged login, an external one or a missing file with nothing to remove writes nothing", async () => {
    const file = await authFile({ openai: { type: "wellknown", key: "k", token: FAKE_KEY } });
    const before = (await stat(file)).mtimeMs;
    const fake = store(
      ["openai", { type: "key", key: FAKE_KEY }],
      ["amazon-bedrock", { type: "external", methodID: "aws-profile" }],
    );
    await exportOpenCode2Logins(fake.client(), file, ["openai", "amazon-bedrock"]);
    expect((await stat(file)).mtimeMs).toBe(before);
    expect(await readJson(file)).toEqual({
      openai: { type: "wellknown", key: "k", token: FAKE_KEY },
    });
    const absent = path.join(dir!, "elsewhere", "auth.json");
    await exportOpenCode2Logins(fake.client(), absent, ["anthropic"]);
    await expect(stat(absent)).rejects.toThrow();
  });

  test("a file that cannot be parsed is never replaced", async () => {
    const file = await authFile();
    await writeFile(file, "{broken");
    const fake = store(["openai", { type: "key", key: FAKE_KEY }]);
    await expect(exportOpenCode2Logins(fake.client(), file, ["openai"])).rejects.toThrow(
      "not valid JSON",
    );
    expect(await readFile(file, "utf8")).toBe("{broken");
  });

  test("only an OAuth login 2.x has refreshed moves the file forward", async () => {
    const file = await authFile({
      openai: { type: "oauth", refresh: "r1", access: "a1", expires: 100, accountId: "acct" },
      xai: { type: "oauth", refresh: "newer", access: "newer", expires: 900 },
      anthropic: { type: "api", key: "file-key" },
    });
    const fake = store(
      [
        "openai",
        // The same account's login, refreshed (and its refresh token rotated).
        {
          type: "oauth",
          methodID: "chatgpt-browser",
          refresh: "r2",
          access: "a2",
          expires: 200,
          metadata: { accountID: "acct" },
        },
      ],
      [
        "xai",
        { type: "oauth", methodID: "device", refresh: "older", access: "older", expires: 500 },
      ],
      // Keys never refresh, and a provider the file lacks is a sign-in's business.
      ["anthropic", { type: "key", key: FAKE_KEY }],
      [
        "github-copilot",
        { type: "oauth", methodID: "device", refresh: "g", access: "g", expires: 1 },
      ],
    );
    expect(await exportOpenCode2Refreshes(fake.client(), file)).toBe(1);
    expect(await readJson(file)).toEqual({
      openai: { type: "oauth", refresh: "r2", access: "a2", expires: 200, accountId: "acct" },
      xai: { type: "oauth", refresh: "newer", access: "newer", expires: 900 },
      anthropic: { type: "api", key: "file-key" },
    });
    const before = (await stat(file)).mtimeMs;
    expect(await exportOpenCode2Refreshes(fake.client(), file)).toBe(0);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  test("a refresh never replaces another account's login, whichever expires later", async () => {
    // Two profiles share auth.json: this one's store holds account A, the
    // file account B's newer sign-in from the other profile.
    const file = await authFile({
      openai: { type: "oauth", refresh: "rb", access: "ab", expires: 100, accountId: "acct-b" },
    });
    const fake = store([
      "openai",
      {
        type: "oauth",
        methodID: "chatgpt-browser",
        refresh: "ra",
        access: "aa",
        expires: 200,
        metadata: { accountID: "acct-a" },
      },
    ]);
    const lineageFile = path.join(dir!, "refresh-lineage.json");
    expect(await exportOpenCode2Refreshes(fake.client(), file, { lineageFile })).toBe(0);
    expect(await readJson(file)).toEqual({
      openai: { type: "oauth", refresh: "rb", access: "ab", expires: 100, accountId: "acct-b" },
    });

    // The same account refreshed in the store still moves the file forward.
    fake.credentials[0]!.value = {
      type: "oauth",
      methodID: "chatgpt-browser",
      refresh: "rb2",
      access: "ab2",
      expires: 300,
      metadata: { accountID: "acct-b" },
    };
    expect(await exportOpenCode2Refreshes(fake.client(), file, { lineageFile })).toBe(1);
    expect((await readJson(file)).openai).toEqual({
      type: "oauth",
      refresh: "rb2",
      access: "ab2",
      expires: 300,
      accountId: "acct-b",
    });
  });

  test("without an account, only a refresh token from this store's lineage proves the login", async () => {
    const lineageFile = path.join(await mkdtemp(path.join(tmpdir(), "ork-oc2-lineage-")), "l.json");
    const file = await authFile({
      // Another profile's login: a refresh token this store never held.
      anthropic: { type: "oauth", refresh: "other", access: "o", expires: 100 },
      xai: { type: "oauth", refresh: "x1", access: "x1", expires: 100 },
    });
    const fake = store(
      [
        "anthropic",
        { type: "oauth", methodID: "oauth", refresh: "mine", access: "m", expires: 900 },
      ],
      ["xai", { type: "oauth", methodID: "device", refresh: "x1", access: "x2", expires: 200 }],
    );
    // xai: the store refreshed the access token and kept the refresh token.
    expect(await exportOpenCode2Refreshes(fake.client(), file, { lineageFile })).toBe(1);
    expect((await readJson(file)).anthropic).toEqual({
      type: "oauth",
      refresh: "other",
      access: "o",
      expires: 100,
    });
    // xai rotates its refresh token: the file's x1 is still this store's lineage.
    fake.credentials[1]!.value = {
      type: "oauth",
      methodID: "device",
      refresh: "x3",
      access: "x3",
      expires: 300,
    };
    // A second store with no lineage (another profile) cannot prove it.
    expect(await exportOpenCode2Refreshes(fake.client(), file)).toBe(0);
    expect(await exportOpenCode2Refreshes(fake.client(), file, { lineageFile })).toBe(1);
    expect((await readJson(file)).xai).toEqual({
      type: "oauth",
      refresh: "x3",
      access: "x3",
      expires: 300,
    });
    // The lineage holds fingerprints, never the tokens.
    const lineage = await readFile(lineageFile, "utf8");
    for (const token of ["x1", "x3", "mine"]) {
      expect(lineage).toContain(openCode2RefreshFingerprint(token));
      expect(lineage).not.toContain(`"${token}"`);
    }
    expect((await stat(lineageFile)).mode & 0o777).toBe(0o600);
    await rm(path.dirname(lineageFile), { recursive: true, force: true });
  });

  test("a sign-in export records its login, so a later rotation is recognised", async () => {
    const lineageFile = path.join(await mkdtemp(path.join(tmpdir(), "ork-oc2-lineage-")), "l.json");
    const file = await authFile({});
    const fake = store([
      "anthropic",
      { type: "oauth", methodID: "oauth", refresh: "s1", access: "s1", expires: 100 },
    ]);
    await exportOpenCode2Logins(fake.client(), file, ["anthropic"], undefined, { lineageFile });
    // 2.x rotates the refresh token before the next pass sees s1.
    fake.credentials[0]!.value = {
      type: "oauth",
      methodID: "oauth",
      refresh: "s2",
      access: "s2",
      expires: 200,
    };
    expect(await exportOpenCode2Refreshes(fake.client(), file, { lineageFile })).toBe(1);
    expect((await readJson(file)).anthropic).toMatchObject({ refresh: "s2", expires: 200 });
    await rm(path.dirname(lineageFile), { recursive: true, force: true });
  });

  test("concurrent exports to one file are serialized, so neither change is lost", async () => {
    const file = await authFile({});
    const fake = store(
      ["openai", { type: "key", key: "k1" }],
      ["anthropic", { type: "key", key: "k2" }],
    );
    await Promise.all([
      exportOpenCode2Logins(fake.client(), file, ["openai"]),
      exportOpenCode2Logins(fake.client(), file, ["anthropic"]),
    ]);
    expect(Object.keys(await readJson(file)).sort()).toEqual(["anthropic", "openai"]);
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
