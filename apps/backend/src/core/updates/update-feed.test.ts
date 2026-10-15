import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeReleaseRequirements } from "@orkestrator/protocol/release-requirements";
import { createUpdateFeed, resolveFeedBaseUrl, type FeedFetch } from "./update-feed.js";
import { MAX_AUDIT_FILE_BYTES, UpdateFiles } from "./update-files.js";
import { entryFor, manifestFor } from "./update-test-support.js";

const BASE = "https://github.com/orkestrator-ai/orkestrator-v2/releases/download";

type Reply = { body: string | Uint8Array; status?: number; url?: string };

function respond(
  body: string | Uint8Array,
  options: { status?: number; url?: string } = {},
): Reply {
  return { body, ...options };
}

/** A real Response whose `url` (where redirects ended) the test chooses. */
function asResponse(reply: Reply, requested: string): Response {
  const response = new Response(reply.body as BodyInit, { status: reply.status ?? 200 });
  const url = reply.url ?? requested;
  return new Proxy(response, {
    get(target, property) {
      if (property === "url") return url;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function routes(table: Record<string, () => Reply>): { fetch: FeedFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const handler = table[url];
      return asResponse(handler ? handler() : respond("missing", { status: 404 }), url);
    },
  };
}

function index(channels: Record<string, unknown>) {
  return JSON.stringify({
    schema: "orkestrator-release-channels",
    schemaVersion: 1,
    repository: "orkestrator-ai/orkestrator-v2",
    generatedAt: "2026-10-15T00:00:00Z",
    channels,
  });
}

describe("feed base URL", () => {
  test("defaults to the GitHub release downloads and accepts safe overrides", () => {
    expect(resolveFeedBaseUrl({})).toBe(BASE);
    expect(
      resolveFeedBaseUrl({ ORKESTRATOR_UPDATE_FEED_URL: "https://staging.example/feed/" }),
    ).toBe("https://staging.example/feed");
    expect(resolveFeedBaseUrl({ ORKESTRATOR_UPDATE_FEED_URL: "http://127.0.0.1:8080/feed" })).toBe(
      "http://127.0.0.1:8080/feed",
    );
  });

  test.each([
    "http://example.com/feed",
    "ftp://example.com",
    "https://user:pw@example.com",
    "nope",
  ])("refuses %s", (value) =>
    expect(() => resolveFeedBaseUrl({ ORKESTRATOR_UPDATE_FEED_URL: value })).toThrow(),
  );
});

describe("reading the feed", () => {
  test("parses the channel index and verifies the manifest checksum", async () => {
    const manifest = manifestFor("2.22.0");
    const entry = await entryFor(manifest);
    const { fetch, calls } = routes({
      [`${BASE}/update-channels/channels.json`]: () => respond(index({ stable: entry })),
      [`${BASE}/v2.22.0/release-requirements.json`]: () =>
        // GitHub redirects release downloads to its asset CDN.
        respond(serializeReleaseRequirements(manifest), {
          url: "https://release-assets.githubusercontent.com/github-production-release-asset/1",
        }),
    });
    const feed = createUpdateFeed({ fetch });
    expect((await feed.fetchIndex()).channels.stable).toEqual(entry);
    expect((await feed.fetchRequirements(entry)).manifest).toEqual(manifest);
    expect(calls).toEqual([
      `${BASE}/update-channels/channels.json`,
      `${BASE}/v2.22.0/release-requirements.json`,
    ]);
  });

  test("names a missing index, refuses an invalid one, and refuses untrusted redirects", async () => {
    await expect(createUpdateFeed({ fetch: routes({}).fetch }).fetchIndex()).rejects.toMatchObject({
      code: "channel-index-unavailable",
    });
    const invalid = routes({ [`${BASE}/update-channels/channels.json`]: () => respond("{}") });
    await expect(createUpdateFeed({ fetch: invalid.fetch }).fetchIndex()).rejects.toMatchObject({
      code: "invalid-channel-index",
    });
    const redirected = routes({
      [`${BASE}/update-channels/channels.json`]: () =>
        respond(index({}), { url: "https://evil.example/channels.json" }),
    });
    await expect(createUpdateFeed({ fetch: redirected.fetch }).fetchIndex()).rejects.toMatchObject({
      code: "untrusted-host",
    });
    const offline = createUpdateFeed({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND github.com");
      },
    });
    await expect(offline.fetchIndex()).rejects.toMatchObject({ code: "network" });
  });

  test("refuses oversized responses before reading them whole", async () => {
    const huge = routes({
      [`${BASE}/update-channels/channels.json`]: () => respond(new Uint8Array(64 * 1024 + 1)),
    });
    await expect(createUpdateFeed({ fetch: huge.fetch }).fetchIndex()).rejects.toMatchObject({
      code: "too-large",
    });
  });

  test("refuses a manifest whose bytes or version do not match the index", async () => {
    const manifest = manifestFor("2.22.0");
    const entry = await entryFor(manifest);
    const tampered = routes({
      [`${BASE}/v2.22.0/release-requirements.json`]: () =>
        respond(
          serializeReleaseRequirements({
            ...manifest,
            permissions: { macos: [] },
            commit: "f".repeat(40),
          }),
        ),
    });
    await expect(
      createUpdateFeed({ fetch: tampered.fetch }).fetchRequirements(entry),
    ).rejects.toMatchObject({
      code: "requirements-mismatch",
    });
    const other = manifestFor("2.21.0");
    const otherEntry = { ...(await entryFor(other)), version: "2.22.0", tag: "v2.22.0" };
    const wrongVersion = routes({
      [`${BASE}/v2.22.0/release-requirements.json`]: () =>
        respond(serializeReleaseRequirements(other)),
    });
    await expect(
      createUpdateFeed({ fetch: wrongVersion.fetch }).fetchRequirements(otherEntry),
    ).rejects.toMatchObject({ code: "requirements-mismatch" });
  });

  test("requires a valid signature once signing keys are embedded", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const key = Buffer.from(
      publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    ).toString("base64");
    const manifest = manifestFor("2.22.0");
    const bytes = serializeReleaseRequirements(manifest);
    const entry = await entryFor(manifest);
    const asset = `${BASE}/v2.22.0/release-requirements.json`;
    const unsigned = routes({ [asset]: () => respond(bytes) });
    await expect(
      createUpdateFeed({ fetch: unsigned.fetch, signingKeys: [key] }).fetchRequirements(entry),
    ).rejects.toMatchObject({ code: "signature-missing" });
    const forged = routes({
      [asset]: () => respond(bytes),
      [`${asset}.sig`]: () =>
        respond(sign(null, Buffer.from("other"), privateKey).toString("base64")),
    });
    await expect(
      createUpdateFeed({ fetch: forged.fetch, signingKeys: [key] }).fetchRequirements(entry),
    ).rejects.toMatchObject({ code: "signature-invalid" });
    const signed = routes({
      [asset]: () => respond(bytes),
      [`${asset}.sig`]: () =>
        respond(sign(null, Buffer.from(bytes), privateKey).toString("base64")),
    });
    await expect(
      createUpdateFeed({ fetch: signed.fetch, signingKeys: [key] }).fetchRequirements(entry),
    ).resolves.toMatchObject({ manifest: { version: "2.22.0" } });
  });
});

describe("update files", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  function files() {
    const directory = mkdtempSync(path.join(os.tmpdir(), "update-files-"));
    directories.push(directory);
    return new UpdateFiles(directory);
  }

  test("a fresh install has no job; a written state reads back private", () => {
    const store = files();
    expect(store.readState()).toEqual({ version: 1, job: null, notices: [] });
    store.writeState({ version: 1, job: null, notices: [] });
    expect(statSync(store.statePath).mode & 0o777).toBe(0o600);
  });

  test("a damaged state file is set aside, never trusted", () => {
    const store = files();
    store.writeState({ version: 1, job: null, notices: [] });
    writeFileSync(store.statePath, JSON.stringify({ version: 1, job: { id: 1 } }));
    expect(store.readState().job).toBeNull();
    expect(() => readFileSync(store.statePath)).toThrow();
  });

  test("the audit log reads newest first, rotates, and bounds each entry", () => {
    const store = files();
    const entry = (index: number) => ({
      at: `2026-10-15T00:00:${String(index % 60).padStart(2, "0")}Z`,
      action: "set-channel" as const,
      jobId: null,
      fromVersion: "2.21.0",
      toVersion: null,
      channel: "stable" as const,
      requester: null,
      detail: String(index),
    });
    for (let index = 0; index < 3; index += 1) store.appendAudit(entry(index));
    expect(store.readAudit(2).map((item) => item.detail)).toEqual(["2", "1"]);
    store.appendAudit({ ...entry(9), detail: "x".repeat(10_000) });
    expect(store.readAudit(1)[0]?.detail).toBe("truncated");
    writeFileSync(store.auditPath, `${"x".repeat(MAX_AUDIT_FILE_BYTES + 1)}\n`);
    store.appendAudit(entry(42));
    expect(statSync(store.auditPath).size).toBeLessThan(4096);
    expect(statSync(store.auditPath).mode & 0o777).toBe(0o600);
    expect(store.readAudit(5)[0]?.detail).toBe("42");
  });
});
