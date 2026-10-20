/**
 * Test double for the preview worker process, used to exercise admission,
 * fairness and deadlines without Chromium. A mermaid job's source selects the
 * behaviour: `sleep:<ms>` answers after a delay, `hang` never answers,
 * `spawn-child` starts a grandchild that ignores SIGTERM and then hangs,
 * `env-report` answers with its environment, cwd, and the contents of
 * `$HOME/canary.txt` if readable (the supervisor's scrubbing is observed
 * from inside the worker it launched).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
const pkg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  job: { kind: string; source?: string };
};
const source = pkg.job.source ?? "";

let childPid: number | null = null;
if (source === "spawn-child") {
  const child = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore" });
  childPid = child.pid ?? null;
}
process.stdout.write(
  `${JSON.stringify({ t: "launched", browserPid: childPid, browserBuild: "fake/1" })}\n`,
);

if (source === "split-utf8") {
  const bytes = Buffer.from(
    JSON.stringify({
      t: "result",
      result: { ok: true, kind: "html-static", effectiveHtml: "<p>漢字 😀</p>" },
    }) + "\n",
  );
  const boundary = bytes.indexOf(Buffer.from("漢")) + 1;
  process.stdout.write(bytes.subarray(0, boundary));
  setTimeout(() => process.stdout.write(bytes.subarray(boundary), () => process.exit(0)), 20);
} else if (source === "malformed") {
  process.stdout.write("{invalid json}\n");
  setInterval(() => undefined, 1000);
} else if (source === "output-limit") {
  const bytes = Buffer.alloc(1024 * 1024, 32);
  for (let i = 0; i < 50; i++) process.stdout.write(bytes);
  setInterval(() => undefined, 1000);
} else if (source === "env-report") {
  let file: string | null = null;
  try {
    file = readFileSync(path.join(process.env.HOME ?? "/nonexistent", "canary.txt"), "utf8");
  } catch {
    file = null;
  }
  const report = JSON.stringify({ env: process.env, cwd: process.cwd(), file });
  const result = {
    ok: true,
    kind: pkg.job.kind,
    browserBuild: "fake/1",
    diagnostics: [{ severity: "info", code: "env-report", message: report }],
    blockedRequests: {},
    captures: [],
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>',
    diagramType: "flowchart",
    svgElements: 3,
    edges: 0,
  };
  process.stdout.write(`${JSON.stringify({ t: "result", result })}\n`, () => process.exit(0));
} else if (source === "hang" || source === "spawn-child") {
  setInterval(() => undefined, 1_000);
} else {
  const delay = Number(/^sleep:(\d+)$/.exec(source)?.[1] ?? 0);
  setTimeout(() => {
    const result = {
      ok: true,
      kind: pkg.job.kind,
      browserBuild: "fake/1",
      diagnostics: [],
      blockedRequests: {},
      captures: [],
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1" height="1"/></g></svg>',
      diagramType: "flowchart",
      svgElements: 3,
      edges: 0,
    };
    process.stdout.write(`${JSON.stringify({ t: "result", result })}\n`, () => process.exit(0));
  }, delay);
}
