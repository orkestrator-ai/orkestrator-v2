/**
 * Child process for `acp-request-rearm.test.ts`: drives one real `AcpProcess`
 * request against an agent that never answers, moves its timeout with the
 * `onTimeoutArmed` hook, and prints what happened as one JSON line.
 *
 * Its own process, because `acp-context.ts` reads the provider configuration
 * at module scope and a silent agent needs a configuration of its own.
 */
process.env.ACP_PROVIDER = "silent";
process.env.ACP_PROVIDER_CONFIG = JSON.stringify({
  id: "silent",
  name: "Silent agent",
  executable: process.execPath,
  argv: ["-e", "process.stdin.resume(); setInterval(() => {}, 1 << 30);"],
  env: {},
  requiresAuthenticate: false,
  modeMap: {},
  extensionPrefixes: [],
  acknowledgedExtensionMethods: [],
  modelUpdateMethods: [],
  sessionUpdateMethods: [],
});

const { AcpProcess } = await import("../acp-context.js");

async function attempt(moves: number[]): Promise<{ outcome: string; elapsedMs: number }> {
  const child = new AcpProcess();
  const startedAt = Date.now();
  let rearm: ((timeoutAt: number) => void) | undefined;
  const request = child.request("probe/never", {}, 60_000, undefined, (move) => {
    rearm = move;
  });
  // Each move is relative to the start: a later one replaces an earlier one.
  for (const offset of moves) rearm!(startedAt + offset);
  const outcome = await request.then(
    () => "answered",
    (error: Error) => error.message,
  );
  const elapsedMs = Date.now() - startedAt;
  // A move after settling must not throw or arm anything.
  rearm!(Date.now() + 10);
  await child.close();
  return { outcome, elapsedMs };
}

const sooner = await attempt([150]);
const later = await attempt([150, 600]);
process.stdout.write(JSON.stringify({ sooner, later }) + "\n");
process.exit(0);
