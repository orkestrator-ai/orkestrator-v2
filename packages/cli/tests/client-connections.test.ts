import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureIo,
  createSandbox,
  startFakeGateway,
  TOKEN,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sandbox(): Promise<ClientSandbox> {
  const box = await createSandbox();
  cleanups.push(() => box.cleanup());
  return box;
}

async function gateway(): Promise<FakeGateway> {
  const created = await startFakeGateway();
  cleanups.push(() => created.stop());
  return created;
}

async function writeProfile(
  box: ClientSandbox,
  name: string,
  status: Record<string, unknown>,
): Promise<string> {
  const runtime = path.join(box.env.ORKESTRATOR_DEV_ROOT!, "profiles", name, "runtime");
  await mkdir(runtime, { recursive: true });
  const statusPath = path.join(runtime, "status.json");
  await writeFile(
    statusPath,
    JSON.stringify({
      version: 1,
      profile: name,
      flavor: "agent-test",
      electronTitle: "x",
      rendererUrl: "http://127.0.0.1:1",
      logDir: runtime,
      statusPath,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      processStartTimes: {},
      ...status,
    }),
  );
  return statusPath;
}

describe("backend selection", () => {
  test("with no selector and no saved default, nothing is contacted", async () => {
    const box = await sandbox();
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.code).toBe("connection-not-configured");
  });

  test("an explicit connection wins over the saved default", async () => {
    const box = await sandbox();
    const first = await gateway();
    const second = await gateway();
    await box.run([
      "connection",
      "add",
      "one",
      "--data-dir",
      await box.publishDescriptor(first),
      "--default",
    ]);
    await box.run(["connection", "add", "two", "--data-dir", await box.publishDescriptor(second)]);
    first.requests.length = 0;
    second.requests.length = 0;
    expect((await box.run(["project", "list"])).code).toBe(0);
    expect(first.requests.length).toBeGreaterThan(0);
    expect((await box.run(["--connection", "two", "project", "list"])).code).toBe(0);
    expect(second.requests.length).toBeGreaterThan(0);
  });

  test("a missing, stale or unready profile fails without falling back to the default", async () => {
    const box = await sandbox();
    const fallback = await gateway();
    await box.run([
      "connection",
      "add",
      "prod",
      "--data-dir",
      await box.publishDescriptor(fallback),
      "--default",
    ]);
    fallback.requests.length = 0;

    const missing = await box.run(["--json", "--profile", "qa", "project", "list"]);
    expect(JSON.parse(missing.out).error.code).toBe("profile-unavailable");

    await writeProfile(box, "starting", { status: "starting", dataDir: box.root, pids: {} });
    const starting = await box.run(["--json", "--profile", "starting", "project", "list"]);
    expect(JSON.parse(starting.out).error.code).toBe("profile-unavailable");

    await writeProfile(box, "stale", {
      status: "ready",
      dataDir: box.root,
      pids: { backend: 2 ** 22 + 12345 },
    });
    const stale = await box.run(["--json", "--profile", "stale", "project", "list"]);
    expect(JSON.parse(stale.out).error.message).toContain("stale");

    expect(fallback.requests).toHaveLength(0);
  });

  test("a ready profile resolves through its backend's instance descriptor", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    await writeProfile(box, "qa-1", { status: "ready", dataDir, pids: { backend: process.pid } });
    const result = await box.run(["--json", "--profile", "QA 1", "project", "list"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).connection).toMatchObject({ kind: "profile", name: "qa-1" });
    expect(backend.requests.length).toBeGreaterThan(0);
  });

  test("a stale descriptor is refused rather than connecting to whatever owns the port", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend, { pid: 2 ** 22 + 54321 });
    const added = await box.run(["--json", "connection", "add", "local", "--data-dir", dataDir]);
    expect(added.code).toBe(4);
    expect(JSON.parse(added.out).error.message).toContain("stale");
  });
});

describe("saved connections", () => {
  test("remote connections take tokens from private files or stdin, never arguments", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const tokenFile = path.join(box.root, "token.txt");
    await writeFile(tokenFile, `${TOKEN}\n`);
    await chmod(tokenFile, 0o644);
    const loose = await box.run([
      "--json",
      "connection",
      "add",
      "remote",
      "--url",
      backend.url,
      "--credential-file",
      tokenFile,
    ]);
    expect(JSON.parse(loose.out).error.message).toContain("chmod 600");
    await chmod(tokenFile, 0o600);
    const saved = await box.run([
      "connection",
      "add",
      "remote",
      "--url",
      backend.url,
      "--credential-file",
      tokenFile,
    ]);
    expect(saved.code).toBe(0);
    expect(backend.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);

    const io = captureIo(box.env, box.root);
    io.stdinBytes = new TextEncoder().encode(`${TOKEN}\n`);
    const fromStdin = await box.run(
      ["connection", "add", "piped", "--url", backend.url, "--token-stdin"],
      io,
    );
    expect(fromStdin.code).toBe(0);
    const stored = path.join(box.configDir, "credentials", "piped.json");
    expect((await stat(stored)).mode & 0o077).toBe(0);

    for (const argv of [
      ["connection", "list", "--json"],
      ["connection", "show", "piped", "--json"],
      ["connection", "check", "piped", "--json"],
    ]) {
      const result = await box.run(argv);
      expect(result.out + result.err).not.toContain(TOKEN);
    }
    expect(await readFile(path.join(box.configDir, "connections.json"), "utf8")).not.toContain(
      TOKEN,
    );
  });

  test("rejects URLs with embedded credentials and plain http to non-private hosts", async () => {
    const box = await sandbox();
    const embedded = await box.run([
      "--json",
      "connection",
      "add",
      "x",
      "--url",
      "https://user:pass@host.example",
      "--token-stdin",
    ]);
    expect(JSON.parse(embedded.out).error.message).not.toContain("pass@");
    expect(embedded.code).toBe(2);
    const plain = await box.run([
      "--json",
      "connection",
      "add",
      "y",
      "--url",
      "http://example.com",
      "--token-stdin",
    ]);
    expect(plain.code).toBe(2);
  });

  test("a group- or world-writable config file is refused", async () => {
    const box = await sandbox();
    const backend = await gateway();
    await box.run([
      "connection",
      "add",
      "local",
      "--data-dir",
      await box.publishDescriptor(backend),
      "--default",
    ]);
    await chmod(path.join(box.configDir, "connections.json"), 0o666);
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("chmod 600");
  });

  test("a malformed config file is reported without dumping its contents", async () => {
    const box = await sandbox();
    await mkdir(box.configDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(box.configDir, "connections.json"), "{ secret-ish garbage", {
      mode: 0o600,
    });
    const result = await box.run(["--json", "connection", "list"]);
    expect(result.code).toBe(4);
    expect(result.out).not.toContain("garbage");
  });

  test("default can be set, shown and cleared; removal forgets the default", async () => {
    const box = await sandbox();
    const backend = await gateway();
    await box.run([
      "connection",
      "add",
      "local",
      "--data-dir",
      await box.publishDescriptor(backend),
      "--no-check",
    ]);
    expect((await box.run(["connection", "default", "local"])).code).toBe(0);
    expect(
      JSON.parse((await box.run(["--json", "connection", "list"])).out).result.defaultConnection,
    ).toBe("local");
    expect((await box.run(["connection", "remove", "local"])).code).toBe(0);
    expect(
      JSON.parse((await box.run(["--json", "connection", "list"])).out).result.defaultConnection,
    ).toBeNull();
  });
});
