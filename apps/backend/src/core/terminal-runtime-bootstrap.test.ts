import { afterEach, expect, mock, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import type { PtyProcess } from "./pty.js";
import { TerminalRuntime } from "./terminal-runtime.js";

const runtimes: TerminalRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown();
});

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.each(["resolve", "reject"])(
  "an old preparation cannot release a replacement's pending claim: %s",
  async (outcome) => {
    const runtime = new TerminalRuntime();
    runtimes.push(runtime);
    const context = {} as CommandContext;
    runtime.rememberStableSession(
      "tab",
      {
        kind: "local",
        environmentId: "env",
        cols: 80,
        rows: 24,
      },
      "local\0env\0tab",
    );
    const oldWrite = mock(() => undefined);
    runtime.registerProcess("tab", { write: oldWrite } as unknown as PtyProcess);
    const oldGate = deferred();
    const old = Promise.allSettled([
      runtime.bootstrapSession("tab", "old", () => oldGate.promise, context),
      runtime.bootstrapSession(
        "tab",
        "old",
        () => {
          throw new Error("must not prepare twice");
        },
        context,
      ),
    ]);
    runtime.cleanupSession("tab");
    const write = mock(() => undefined);
    runtime.registerProcess("tab", { write } as unknown as PtyProcess);
    const gate = deferred();
    const replacement = runtime.bootstrapSession("tab", "new", () => gate.promise, context);
    if (outcome === "reject") oldGate.reject(new Error("Old preparation failed"));
    else oldGate.resolve("old command\n");
    const oldResults = await old;
    expect(oldResults.map((result) => result.status)).toEqual(
      outcome === "reject" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
    );
    const duplicate = runtime.bootstrapSession(
      "tab",
      "new",
      () => {
        throw new Error("replacement claim was lost");
      },
      context,
    );
    expect(runtime.isBootstrapped("tab")).toBe(false);
    expect(oldWrite).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    gate.resolve("new command\n");
    expect(await replacement).toMatchObject({ delivered: true, bootstrapped: true });
    expect(await duplicate).toMatchObject({ duplicate: true, matchesExisting: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("new command\n");
  },
);

test("shutdown invalidates pending preparation before it can write", async () => {
  const runtime = new TerminalRuntime();
  runtimes.push(runtime);
  runtime.rememberSession("tab", { kind: "local", environmentId: "env", cols: 80, rows: 24 });
  const write = mock(() => undefined);
  runtime.registerProcess("tab", { write } as unknown as PtyProcess);
  const gate = deferred();
  const pending = runtime.bootstrapSession("tab", "hash", () => gate.promise, {} as CommandContext);
  runtime.shutdown();
  gate.resolve("command\n");
  expect(await pending).toMatchObject({ delivered: false, bootstrapped: false });
  expect(write).not.toHaveBeenCalled();
});
