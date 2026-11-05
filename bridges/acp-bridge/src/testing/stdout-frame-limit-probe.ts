/**
 * Child process for `acp-jsonl-framer.test.ts`: drives one real `AcpProcess` per
 * case against an agent that writes a frame of an exact size down its real
 * stdout pipe, and prints what the bridge did with each as one JSON line.
 *
 * Its own process, because `acp-context.ts` reads the provider configuration at
 * module scope and this agent needs a configuration of its own.
 */
const agent = `
  const PIECE_BYTES = 64 * 1024;
  const TAIL_BYTES = 1024;
  const wrote = (bytes) => new Promise((resolve) => process.stdout.write(bytes, resolve));
  const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
  let input = "";
  process.stdin.on("data", async (data) => {
    input += data;
    const newline = input.indexOf("\\n");
    if (newline < 0) return;
    const { id, params } = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    const head = '{"jsonrpc":"2.0","id":' + id + ',"result":{"text":"';
    const tail = '"}}';
    const padding = params.bytes - head.length - tail.length;
    const frame = Buffer.from(head + "x".repeat(padding) + tail);
    const bodyEnd = frame.length - TAIL_BYTES;
    for (let at = 0; at < bodyEnd; at += PIECE_BYTES) {
      await wrote(frame.subarray(at, Math.min(at + PIECE_BYTES, bodyEnd)));
    }
    await pause();
    // One write under PIPE_BUF, so these bytes and a joined newline arrive together.
    const last = frame.subarray(bodyEnd);
    await wrote(params.newline === "joined" ? Buffer.concat([last, Buffer.from("\\n")]) : last);
    if (params.newline === "late") {
      await pause();
      await wrote("\\n");
    }
  });
  setInterval(() => {}, 1 << 30);
`;

process.env.ACP_PROVIDER = "framing";
process.env.ACP_PROVIDER_CONFIG = JSON.stringify({
  id: "framing",
  name: "Framing agent",
  executable: process.execPath,
  argv: ["-e", agent],
  env: {},
  requiresAuthenticate: false,
  modeMap: {},
  extensionPrefixes: [],
  acknowledgedExtensionMethods: [],
  modelUpdateMethods: [],
  sessionUpdateMethods: [],
});

const { AcpProcess, MAX_LINE_BYTES } = await import("../acp-context.js");

type CaseResult = { answeredBytes?: number; error?: string; closedAfter: boolean };

async function run(bytes: number, newline: "joined" | "late" | "none"): Promise<CaseResult> {
  const child = new AcpProcess();
  const result: CaseResult = { closedAfter: false };
  try {
    const answer = (await child.request("probe/frame", { bytes, newline })) as { text: string };
    result.answeredBytes = answer.text.length;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    // A closed connection refuses the next request rather than sending it.
    result.closedAfter = await child.request("probe/after", {}, 2_000).then(
      () => false,
      () => true,
    );
  }
  await child.close();
  return result;
}

const results = {
  limit: MAX_LINE_BYTES,
  terminatedAtLimit: await run(MAX_LINE_BYTES, "joined"),
  newlineAfterLimit: await run(MAX_LINE_BYTES, "late"),
  terminatedOverLimit: await run(MAX_LINE_BYTES + 1, "joined"),
  unterminatedOverLimit: await run(MAX_LINE_BYTES + 1, "none"),
};
process.stdout.write(JSON.stringify(results) + "\n");
process.exit(0);
