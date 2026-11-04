/**
 * Child process for `acp-jsonl-framer.test.ts`: answers one real `AcpProcess`
 * request with a frame written in many separate pieces, counts what the bridge
 * copies while reassembling it, and prints the result as one JSON line.
 *
 * Its own process, because `acp-context.ts` reads the provider configuration at
 * module scope and this agent needs a configuration of its own.
 */
const FRAME_PIECES = 32;
const PIECE_BYTES = 64 * 1024;
const answerText = "x".repeat(FRAME_PIECES * PIECE_BYTES);

const agent = `
  const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(${answerText.length}) } }) + "\\n");
  process.stdin.once("data", async () => {
    for (let at = 0; at < frame.length; at += ${PIECE_BYTES}) {
      process.stdout.write(frame.subarray(at, at + ${PIECE_BYTES}));
      await new Promise((resolve) => setTimeout(resolve, 2));
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

const { AcpProcess } = await import("../acp-context.js");

let copiedBytes = 0;
const concat = Buffer.concat;
Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
  const joined = concat(list, totalLength);
  copiedBytes += joined.length;
  return joined;
}) as typeof Buffer.concat;

const child = new AcpProcess();
let chunks = 0;
child.child.stdout.on("data", () => {
  chunks += 1;
});
const answer = (await child.request("probe/large", {})) as { text: string };
const frameBytes = answer.text.length;
Buffer.concat = concat;
await child.close();
process.stdout.write(
  JSON.stringify({ matches: answer.text === answerText, frameBytes, chunks, copiedBytes }) + "\n",
);
process.exit(0);
