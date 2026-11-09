import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  judgeOpenCodeListener,
  listOpenCodeListenersScript,
  OPENCODE_LISTENER_RECORD,
  parseOpenCodeListeners,
  recordOpenCodeListenerScript,
  stopOpenCodeListenersScript,
} from "./opencode-listener-identity.js";

describe("judgeOpenCodeListener", () => {
  test("the recorded socket, alone on the port, is ours", () => {
    expect(judgeOpenCodeListener({ record: "4242", sockets: ["4242"] })).toBe("ours");
  });

  test("no record is an older image or an older backend's server", () => {
    expect(judgeOpenCodeListener({ record: null, sockets: ["4242"] })).toBe("unrecorded");
  });

  test.each([
    ["nothing listens", []],
    ["another socket listens", ["5151"]],
    ["a second socket shares the port", ["4242", "5151"]],
  ])("%s: replaced", (_name, sockets) => {
    expect(judgeOpenCodeListener({ record: "4242", sockets })).toBe("replaced");
  });
});

test("parses the root exec's lines and ignores anything malformed", () => {
  expect(
    parseOpenCodeListeners(
      ["record 4242", "socket 4242", "socket 0", "socket abc", "socket", "garbage 1"].join("\n"),
    ),
  ).toEqual({ record: "4242", sockets: ["4242"] });
  expect(parseOpenCodeListeners("record x").record).toBeNull();
});

describe.skipIf(process.platform !== "linux")("the scripts on a real socket", () => {
  const servers: Server[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function listen(port = 0): Promise<number> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  }

  const sh = (script: string) => Bun.spawnSync(["sh", "-c", script]).stdout.toString();

  test("records the port's only socket, and a new listener is judged replaced", async () => {
    const port = await listen();
    const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode-listener-"));
    directories.push(directory);
    const record = path.join(directory, "opencode-listener");
    await writeFile(record, "stale");
    const recordScript = recordOpenCodeListenerScript(port).replaceAll(
      OPENCODE_LISTENER_RECORD,
      record,
    );

    expect(sh(recordScript).trim()).toBe("recorded");
    const inode = (await readFile(record, "utf8")).trim();
    expect(inode).toMatch(/^\d+$/);
    const judge = () =>
      judgeOpenCodeListener(
        parseOpenCodeListeners(`record ${inode}\n${sh(listOpenCodeListenersScript(port))}`),
      );
    expect(judge()).toBe("ours");

    // The listener goes, and another takes the same port: a new socket.
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(judge()).toBe("replaced");
    await listen(port);
    expect(judge()).toBe("replaced");
  });

  test("refuses to record a port nobody listens on", async () => {
    const port = await listen();
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const directory = await mkdtemp(path.join(tmpdir(), "ork-opencode-listener-"));
    directories.push(directory);
    const record = path.join(directory, "opencode-listener");
    expect(
      sh(recordOpenCodeListenerScript(port).replaceAll(OPENCODE_LISTENER_RECORD, record)).trim(),
    ).toBe("refused");
    expect(await readFile(record, "utf8").catch(() => null)).toBeNull();
  });

  test("the stop script finds a same-uid listener by its socket", async () => {
    // A child that listens, so the script can stop it without stopping this test.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `require("node:net").createServer().listen(0, "127.0.0.1", function () { console.log(this.address().port); });`,
      ],
      { stdout: "pipe" },
    );
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const port = Number(new TextDecoder().decode(value).trim());
    expect(port).toBeGreaterThan(0);
    sh(stopOpenCodeListenersScript(port));
    expect(await child.exited).not.toBe(0);
  });
});
