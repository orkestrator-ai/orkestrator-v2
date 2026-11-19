/**
 * Load producer for the terminal latency benchmark. Runs inside a real PTY that
 * `apps/backend/scripts/terminal-latency.ts` spawns, so its output takes the same
 * path as a build or a tool: kernel PTY, Bun's terminal reader, coalescing,
 * `TerminalRuntime`, durable history and the gateway.
 *
 *   producer.ts build <bytesPerSecond>      coloured build-style lines, paced
 *   producer.ts tool <burstBytes> <everyMs> a large block at once, then quiet
 *
 * Output is deterministic for a given seed position and contains carriage
 * returns, SGR colour and the odd progress line, which is what makes headless
 * parsing cost more than raw bytes would suggest.
 */

const [mode, first, second] = process.argv.slice(2);

const TICK_MS = 10;
const COLOURS = [31, 32, 33, 34, 35, 36];
const PATHS = [
  "src/components/terminal/TerminalContainer.tsx",
  "apps/backend/src/core/terminal-history.ts",
  "packages/protocol/src/terminal-websocket.ts",
  "bridges/codex-bridge/src/app-server-runtime.ts",
];

let line = 0;

function buildLine(): string {
  line += 1;
  const colour = COLOURS[line % COLOURS.length]!;
  const path = PATHS[line % PATHS.length]!;
  if (line % 40 === 0) {
    // A progress bar redrawn in place, as bundlers and test runners print.
    const done = line % 400;
    return `\r\x1b[2K\x1b[1m[${"#".repeat(done / 20)}${" ".repeat(20 - done / 20)}]\x1b[0m ${done}/400\r\n`;
  }
  return `\x1b[${colour}m${String(line).padStart(7, "0")}\x1b[0m ${path}:${line % 977}:${line % 61} \x1b[2mcompiled ${line % 13} modules in ${line % 97}ms\x1b[0m\r\n`;
}

function toolBlock(bytes: number): string {
  const rows: string[] = [];
  let size = 0;
  while (size < bytes) {
    const row =
      line % 3 === 0
        ? `\x1b[32m+  const value${line} = compute(${line}, "${PATHS[line % PATHS.length]}");\x1b[0m\r\n`
        : `   ${JSON.stringify({ id: line, path: PATHS[line % PATHS.length], ok: line % 7 !== 0 })}\r\n`;
    line += 1;
    rows.push(row);
    size += row.length;
  }
  return rows.join("");
}

async function write(text: string): Promise<void> {
  if (process.stdout.write(text)) return;
  await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBuild(bytesPerSecond: number): Promise<never> {
  const perTick = Math.max(1, Math.round((bytesPerSecond * TICK_MS) / 1000));
  let next = performance.now();
  for (;;) {
    let chunk = "";
    while (chunk.length < perTick) chunk += buildLine();
    await write(chunk);
    next += TICK_MS;
    await sleep(Math.max(0, next - performance.now()));
  }
}

async function runTool(burstBytes: number, everyMs: number): Promise<never> {
  // Stagger terminals so their bursts do not always coincide.
  await sleep(Math.floor(Math.random() * everyMs));
  for (;;) {
    await write(toolBlock(burstBytes));
    await sleep(everyMs);
  }
}

if (mode === "build") await runBuild(Number(first));
else if (mode === "tool") await runTool(Number(first), Number(second));
else {
  process.stderr.write("usage: producer.ts build <bytesPerSecond> | tool <burstBytes> <everyMs>\n");
  process.exit(2);
}
