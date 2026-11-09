import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import {
  buildScrubOpenCode2ContainerCredentials,
  buildSyncOpenCode2ContainerCredentials,
  openCode2ContainerCredentialPayload,
} from "./container-credentials.js";

// These cases start real Bun processes and open SQLite files under aggregate load.
setDefaultTimeout(30_000);

let root: string | undefined;
let server: FakeOpenCode2Server | undefined;
afterEach(async () => {
  server?.stop();
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
async function run(command: string, input = "") {
  const child = Bun.spawn(["sh", "-c", command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

test("a renewed access-only login replaces the database credential, also after server restart", async () => {
  root = await mkdtemp(join(tmpdir(), "oc2-container-renew-"));
  const tokenFile = join(root, "token");
  await writeFile(tokenFile, "pw");
  server = new FakeOpenCode2Server();
  const payload = (access: string) =>
    openCode2ContainerCredentialPayload(
      JSON.stringify({
        logins: { openai: { type: "oauth", refresh: "", access, expires: 123456 } },
        accessOnly: ["openai"],
      }),
    );
  const sync = () =>
    buildSyncOpenCode2ContainerCredentials({
      tokenFile,
      baseUrl: server!.baseUrl,
      bunPath: process.execPath,
    });
  expect((await run(sync(), payload("old-access"))).code).toBe(0);
  expect(server.credentials).toMatchObject([{ value: { access: "old-access", refresh: "" } }]);
  expect((await run(sync(), payload("renewed-access"))).code).toBe(0);
  expect(server.credentials).toHaveLength(1);
  expect(server.credentials).toMatchObject([{ value: { access: "renewed-access", refresh: "" } }]);
  // Recreate the process with the persisted database inventory.
  const stored = [...server.credentials];
  server.stop();
  server = new FakeOpenCode2Server();
  server.credentials.push(...stored);
  expect((await run(sync(), payload("restart-access"))).code).toBe(0);
  expect(server.credentials).toHaveLength(1);
  expect(server.credentials).toMatchObject([{ value: { access: "restart-access", refresh: "" } }]);
  expect(
    (
      await run(
        sync(),
        openCode2ContainerCredentialPayload(JSON.stringify({ logins: {}, accessOnly: ["openai"] })),
      )
    ).code,
  ).toBe(0);
  expect(server.credentials).toEqual([]);
});

test("revocation scrubs both persistent credential databases and retains conversations after reopen", async () => {
  root = await mkdtemp(join(tmpdir(), "oc2-container-revoke-"));
  const paths = [join(root, "persistent.db"), join(root, "legacy.db")];
  for (const file of paths) {
    const db = new Database(file);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE credential (id TEXT, value TEXT); CREATE TABLE session (id TEXT); INSERT INTO credential VALUES ('key', 'fake-secret'); INSERT INTO session VALUES ('conversation')",
    );
    db.close();
  }
  expect((await run(buildScrubOpenCode2ContainerCredentials(paths, process.execPath))).code).toBe(
    0,
  );
  for (const file of paths) {
    const db = new Database(file);
    expect(db.query("SELECT * FROM credential").all()).toEqual([]);
    expect(db.query("SELECT * FROM session").all()).toEqual([{ id: "conversation" }]);
    db.close();
  }
  const bad = join(root, "corrupt.db");
  await writeFile(bad, "not a database");
  const result = await run(buildScrubOpenCode2ContainerCredentials([bad], process.execPath));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toBe("OpenCode 2 credential cleanup failed\n");
});
