/**
 * Terminal size ownership through the real resize commands
 * (`terminal-size-ownership.ts`): one PTY shown by a wide desktop and a narrow
 * phone, where only the client that last interacted sets the PTY's size.
 */
import { describe, expect, test } from "bun:test";
import { createCommandFixtures } from "./command-fixtures";

const {
  createCommandRegistry,
  createContext,
  createEnvironment,
  createTempDir,
  ptyProcesses,
  terminalSessionResult,
} = await createCommandFixtures();

async function startLocalTerminal() {
  const worktreePath = await createTempDir("ork-terminal-size-ownership-");
  const environment = createEnvironment({ worktreePath });
  const { context } = createContext(environment);
  const commands = createCommandRegistry();
  const sessionId = terminalSessionResult(
    await commands.get("create_local_terminal_session")?.(
      { environmentId: environment.id, cols: 80, rows: 24 },
      context,
    ),
  ).sessionId;
  await commands.get("start_local_terminal_session")?.({ sessionId }, context);
  const pty = ptyProcesses.at(-1)!;
  const run = (command: string, args: Record<string, unknown>) =>
    commands.get(command)?.({ sessionId, ...args }, context);
  return { context, commands, sessionId, pty, run };
}

describe("terminal size ownership commands", () => {
  test("a passive update from another client leaves the owner's size alone", async () => {
    const { pty, run } = await startLocalTerminal();

    expect(run("local_terminal_resize", { cols: 200, rows: 50, clientId: "desktop" })).toEqual({
      delivered: true,
      applied: true,
      owned: true,
    });
    // The phone opens the same terminal and fits it to its narrow screen.
    expect(run("local_terminal_resize", { cols: 40, rows: 30, clientId: "phone" })).toEqual({
      delivered: true,
      applied: false,
      owned: false,
    });
    expect(pty.resize).toHaveBeenCalledTimes(1);
    expect(pty.resize).toHaveBeenLastCalledWith(200, 50);
  });

  test("a claim takes the size, and the previous owner's updates then stop applying", async () => {
    const { pty, run } = await startLocalTerminal();
    run("local_terminal_resize", { cols: 200, rows: 50, clientId: "desktop" });

    expect(run("claim_terminal_size", { cols: 40, rows: 30, clientId: "phone" })).toEqual({
      delivered: true,
      applied: true,
      owned: true,
    });
    expect(pty.resize).toHaveBeenLastCalledWith(40, 30);
    expect(
      run("local_terminal_resize", { cols: 210, rows: 50, clientId: "desktop" }),
    ).toMatchObject({ applied: false });
    expect(pty.resize).toHaveBeenLastCalledWith(40, 30);

    // Typing on the desktop claims it back.
    expect(run("claim_terminal_size", { cols: 200, rows: 50, clientId: "desktop" })).toEqual({
      delivered: true,
      applied: true,
      owned: true,
    });
    expect(pty.resize).toHaveBeenLastCalledWith(200, 50);
  });

  test("the owner repeating its claim at the same size does not resize the PTY again", async () => {
    const { pty, run } = await startLocalTerminal();
    run("claim_terminal_size", { cols: 120, rows: 40, clientId: "desktop" });
    run("claim_terminal_size", { cols: 120, rows: 40, clientId: "desktop" });
    run("claim_terminal_size", { cols: 120, rows: 40, clientId: "desktop" });
    expect(pty.resize).toHaveBeenCalledTimes(1);
  });

  test("releasing hands the size to the next client that resizes", async () => {
    const { pty, run } = await startLocalTerminal();
    run("claim_terminal_size", { cols: 40, rows: 30, clientId: "phone" });

    expect(run("release_terminal_size", { clientId: "desktop" })).toEqual({ released: 0 });
    expect(run("release_terminal_size", { clientId: "phone" })).toEqual({ released: 1 });
    expect(
      run("local_terminal_resize", { cols: 200, rows: 50, clientId: "desktop" }),
    ).toMatchObject({ applied: true, owned: true });
    expect(pty.resize).toHaveBeenLastCalledWith(200, 50);
  });

  test("an older client applies only while nobody owns the size", async () => {
    const { pty, run } = await startLocalTerminal();
    expect(run("local_terminal_resize", { cols: 100, rows: 30 })).toEqual({
      delivered: true,
      applied: true,
      owned: false,
    });
    run("claim_terminal_size", { cols: 200, rows: 50, clientId: "desktop" });
    expect(run("local_terminal_resize", { cols: 100, rows: 30 })).toMatchObject({
      applied: false,
    });
    // A malformed id reads as no id rather than refusing the call.
    expect(
      run("local_terminal_resize", { cols: 100, rows: 30, clientId: "not a valid id" }),
    ).toMatchObject({ delivered: true, applied: false });
    expect(pty.resize).toHaveBeenLastCalledWith(200, 50);
  });

  test("a container terminal resize follows the same owner", async () => {
    const { run, sessionId, context } = await startLocalTerminal();
    run("claim_terminal_size", { cols: 200, rows: 50, clientId: "desktop" });
    // `terminal_resize` and `local_terminal_resize` share the session's owner.
    expect(run("terminal_resize", { cols: 40, rows: 30, clientId: "phone" })).toMatchObject({
      applied: false,
    });
    expect(context.runtime.terminals.sizeOwnership.isOwner(sessionId, "desktop")).toBe(true);
  });

  test("a gone session answers not delivered and keeps no owner", async () => {
    const { commands, context } = await startLocalTerminal();
    expect(
      commands.get("claim_terminal_size")?.(
        { sessionId: "missing-session", cols: 80, rows: 24, clientId: "desktop" },
        context,
      ),
    ).toEqual({ delivered: false });
    expect(context.runtime.terminals.sizeOwnership.ownedSessionCount()).toBe(0);
  });

  test("a replacement PTY starts unowned", async () => {
    const { pty, run, sessionId, context } = await startLocalTerminal();
    run("claim_terminal_size", { cols: 200, rows: 50, clientId: "desktop" });
    pty.emitExit({ exitCode: 0 });
    expect(context.runtime.terminals.sizeOwnership.isOwner(sessionId, "desktop")).toBe(false);
  });
});
