import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function waitFor(check: () => boolean, description: string) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

async function withHeldServer(
  run: (fixture: {
    release: () => void;
    send: () => void;
    closeInput: () => void;
    output: () => string;
    exited: () => boolean;
    events: () => { event: string; reason?: string }[];
  }) => Promise<void>,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "mcp-probe-hold-"));
  const hold = path.join(directory, "hold");
  const log = path.join(directory, "events.jsonl");
  writeFileSync(hold, "");
  const child = spawn(
    "node",
    [path.join(import.meta.dir, "mcp-probe-server.mjs"), "--hold-file", hold, "--log", log],
    { stdio: "pipe" },
  );
  let output = "";
  let stderr = "";
  let failure: Error | undefined;
  let exited = false;
  child.on("error", (error) => {
    failure = error;
  });
  child.stdin.on("error", (error) => {
    failure = error;
  });
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<void>((resolve) =>
    child.on("close", () => {
      exited = true;
      resolve();
    }),
  );
  const events = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  try {
    await waitFor(
      () => Boolean(failure) || events().some((event) => event.event === "start"),
      "server start",
    );
    if (failure) throw failure;
    await run({
      release: () => rmSync(hold),
      send: () => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
      },
      closeInput: () => child.stdin.end(),
      output: () => output,
      exited: () => exited,
      events,
    });
    if (failure) throw failure;
    expect(stderr).toBe("");
  } finally {
    if (!exited) child.kill("SIGKILL");
    await done;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("held stdio is silent, then answers buffered input after release", async () => {
  await withHeldServer(async (fixture) => {
    fixture.send();
    // More than two hold polls, after the child has recorded its start.
    await Bun.sleep(250);
    expect(fixture.output()).toBe("");
    expect(fixture.exited()).toBe(false);
    fixture.release();
    await waitFor(() => fixture.output().includes("\n"), "buffered ping response");
    expect(JSON.parse(fixture.output())).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    fixture.closeInput();
    await waitFor(fixture.exited, "EOF after release");
    expect(fixture.events().at(-1)).toMatchObject({ event: "exit", reason: "stdin-closed" });
  });
});

test.each([false, true])("held stdio exits on EOF with buffered input=%s", async (buffered) => {
  await withHeldServer(async (fixture) => {
    if (buffered) fixture.send();
    fixture.closeInput();
    await waitFor(fixture.exited, "EOF while held");
    expect(fixture.output()).toBe("");
    expect(fixture.events().at(-1)).toMatchObject({ event: "exit", reason: "stdin-closed" });
  });
});
