import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCoordinatorCodexHome } from "./commands-servers.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-codex-handoff-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("coordinator gets access-only auth; its writes cannot rotate the source account", async () => {
  const source = path.join(root, "account");
  const destination = path.join(root, "coordinator");
  await fs.mkdir(source);
  const original = JSON.stringify({
    tokens: {
      access_token: "access",
      id_token: "identity",
      refresh_token: "private-refresh-sentinel",
      account_id: "account",
    },
    last_refresh: "2020-01-01T00:00:00Z",
  });
  await fs.writeFile(path.join(source, "auth.json"), original);
  await prepareCoordinatorCodexHome(destination, source);
  const handedOver = await fs.readFile(path.join(destination, "auth.json"), "utf8");
  expect(handedOver).not.toContain("private-refresh-sentinel");
  expect(JSON.parse(handedOver).tokens).toEqual({
    access_token: "access",
    id_token: "identity",
    refresh_token: "",
    account_id: "account",
  });
  expect((await fs.stat(path.join(destination, "auth.json"))).mode & 0o777).toBe(0o600);
  // A failed refresh or other coordinator auth write has no path back to the owner.
  await fs.writeFile(path.join(destination, "auth.json"), '{"tokens":null}');
  expect(await fs.readFile(path.join(source, "auth.json"), "utf8")).toBe(original);
});

test("an expired login clears an earlier coordinator's auth", async () => {
  const source = path.join(root, "account");
  const destination = path.join(root, "coordinator");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  await fs.writeFile(
    path.join(source, "auth.json"),
    JSON.stringify({
      tokens: { access_token: expired, refresh_token: "private-refresh-sentinel" },
    }),
  );
  await fs.writeFile(path.join(destination, "auth.json"), "old-login");
  await prepareCoordinatorCodexHome(destination, source);
  expect(await fs.stat(path.join(destination, "auth.json")).catch(() => null)).toBeNull();
});
