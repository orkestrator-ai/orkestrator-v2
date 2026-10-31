/**
 * Mermaid rendering through the supervised worker (real Chromium), plus the
 * backend's independent SVG verification. Browser cases skip with a printed
 * reason when no Chromium executable is found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MERMAID_POLICY } from "@orkestrator/protocol/rich-content-policy";

import { resolveDesignChromiumPath } from "../design/index.js";
import { verifyMermaidSvg } from "./mermaid-svg.js";
import { isAlive, listProcesses } from "./preview-process-tree.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import type { WorkerResult } from "./preview-worker-protocol.js";
import { previewTestScratchRoot } from "./fixtures/preview-scratch-root.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn(
    "[mermaid-render.test] browser cases skipped: no Chromium executable (set ORKESTRATOR_DESIGN_CHROMIUM_PATH)",
  );
const browserTest = CHROMIUM ? test : test.skip;

const DIAGRAMS: Record<string, { source: string; type: RegExp }> = {
  flowchart: {
    source: "flowchart TD\n  A[Start] --> B{Choice}\n  B -- yes --> C[Done]\n  B -- no --> A",
    type: /flowchart/,
  },
  sequence: {
    source: "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi",
    type: /sequence/,
  },
  state: {
    source: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> [*]",
    type: /state/,
  },
  class: {
    source: "classDiagram\n  Animal <|-- Duck\n  Animal : +int age\n  Duck : +swim()",
    type: /class/,
  },
  er: {
    source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains",
    type: /er/i,
  },
  pie: { source: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85', type: /pie/ },
};

let runner: TranscriptPreviewRunner;
let operation = 0;
const scope = () => ({
  environmentId: `env-m${++operation}`,
  conversationKey: "conv",
  operationId: `op_mermaid${String(operation).padStart(8, "0")}`,
});
const run = (source: string, target = runner) =>
  target.run({ kind: "mermaid", source, theme: "light" }, scope(), new AbortController().signal);
// Element-level check on the raw bytes; attributes are checked structurally by verifyMermaidSvg
// (escaped label text such as `&lt;a href="…"&gt;` is inert text, not markup).
const UNSAFE = /<script|<foreignobject|<iframe|<a[\s>]|<image|<use|javascript:|@import/i;

const svgWithElements = (count: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg">${"<g></g>".repeat(count - 1)}</svg>`;

/**
 * Returns valid worker evidence selected by the source. The runner still owns
 * source validation and independently verifies the returned edge/SVG limits,
 * so exact policy classification does not depend on Chromium scheduling.
 */
function controlledPolicyRunner() {
  return new TranscriptPreviewRunner({
    isolation: "process",
    executablePath: () => "/bin/true",
    workerCommand: () => ({ command: "/bin/true", args: [] }),
    supervise: (_launch, pkg) => {
      const source = pkg.job.kind === "mermaid" ? pkg.job.source : "";
      const edges = Number(/^controlled-edges:(\d+)$/.exec(source)?.[1] ?? 0);
      const elements = Number(/^controlled-svg-elements:(\d+)$/.exec(source)?.[1] ?? 3);
      const result: WorkerResult = {
        ok: true,
        kind: "mermaid",
        browserBuild: "controlled/1",
        diagnostics: [],
        blockedRequests: {},
        captures: [],
        svg: svgWithElements(elements),
        diagramType: "flowchart",
        edges,
      };
      return {
        outcome: Promise.resolve({ type: "result" as const, result }),
        exited: Promise.resolve({ verified: true, pids: [], browserPid: null }),
        cancel: () => undefined,
        browserPid: () => null,
        workerPid: () => null,
        reap: async () => true,
        scratchDir: () => null,
      };
    },
  });
}

beforeAll(() => {
  runner = new TranscriptPreviewRunner({
    isolation: "process",
    scratchRoot: previewTestScratchRoot(),
  });
});
afterAll(async () => {
  await runner?.close();
});

describe("mermaid rendering", () => {
  test("classifies source, edge and SVG limits exactly at and over each boundary", async () => {
    const padded = (bytes: number) => "x".repeat(bytes);
    const controlled = controlledPolicyRunner();
    try {
      const atSource = await run(padded(MERMAID_POLICY.maxSourceBytes), controlled);
      const overSource = await run(padded(MERMAID_POLICY.maxSourceBytes + 1), controlled);
      expect(atSource.ok).toBe(true);
      expect(overSource.ok).toBe(false);
      if (!overSource.ok)
        expect(overSource.error).toMatchObject({
          code: "package_size_exceeded",
          resource: "source-bytes",
        });

      const atEdges = await run(`controlled-edges:${MERMAID_POLICY.maxEdges}`, controlled);
      const overEdges = await run(`controlled-edges:${MERMAID_POLICY.maxEdges + 1}`, controlled);
      expect(atEdges.ok).toBe(true);
      if (atEdges.ok && atEdges.kind === "mermaid")
        expect(atEdges.edges).toBe(MERMAID_POLICY.maxEdges);
      expect(overEdges.ok).toBe(false);
      if (!overEdges.ok)
        expect(overEdges.error).toMatchObject({
          code: "package_size_exceeded",
          resource: "edges",
        });

      const atSvg = await run(
        `controlled-svg-elements:${MERMAID_POLICY.maxSvgElements}`,
        controlled,
      );
      const overSvg = await run(
        `controlled-svg-elements:${MERMAID_POLICY.maxSvgElements + 1}`,
        controlled,
      );
      expect(atSvg.ok).toBe(true);
      if (atSvg.ok && atSvg.kind === "mermaid")
        expect(atSvg.svgElements).toBe(MERMAID_POLICY.maxSvgElements);
      expect(overSvg.ok).toBe(false);
      if (!overSvg.ok)
        expect(overSvg.error).toMatchObject({
          code: "package_size_exceeded",
          resource: "svg",
        });
    } finally {
      await controlled.close();
    }
  });

  for (const [name, { source, type }] of Object.entries(DIAGRAMS)) {
    browserTest(
      `renders a ${name} diagram to verified, sanitized SVG`,
      async () => {
        const result = await run(source);
        if (!result.ok) console.error(name, result.error, result.diagnostics);
        expect(result.ok).toBe(true);
        if (!result.ok || result.kind !== "mermaid") return;
        expect(result.diagramType).toMatch(type);
        expect(result.svg.startsWith("<svg")).toBe(true);
        expect(result.svg).not.toMatch(UNSAFE);
        expect(result.svgElements).toBeGreaterThan(3);
        expect(result.svgElements).toBeLessThanOrEqual(MERMAID_POLICY.maxSvgElements);
        expect(result.rendererBundleHash).toMatch(/^[0-9a-f]{64}$/);
        expect((await verifyMermaidSvg(result.svg)).ok).toBe(true);
        if (name === "flowchart") expect(result.svg).toContain('marker-end="url(#');
      },
      30_000,
    );
  }

  browserTest(
    "reports syntax errors with a concise message and location",
    async () => {
      const result = await run("flowchart TD\n  A[Start] --> B{Is it?\n  B -- Yes --> C[OK]\n");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("validation_failed");
      const diagnostic = result.diagnostics.find((entry) => entry.code === "mermaid_syntax");
      expect(diagnostic?.location).toMatch(/^line 3(:\d+)?$/);
      expect(diagnostic!.message.length).toBeLessThanOrEqual(400);
    },
    30_000,
  );

  browserTest(
    "strips script, foreignObject and external references; directives cannot relax policy",
    async () => {
      const source = [
        '%%{init: {"securityLevel": "loose", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "maxEdges": 100000, "themeCSS": "@import url(https://evil.example/x.css);"}}%%',
        "flowchart TD",
        '  A["<img src=x onerror=alert(1)><script>alert(1)</script>"] --> B',
        '  click A href "javascript:alert(1)"',
        '  click B "https://evil.example"',
        "  C[<a href='https://evil.example'>x</a>]",
      ].join("\n");
      const result = await run(source);
      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "mermaid") return;
      expect(result.svg).not.toMatch(UNSAFE);
      expect((await verifyMermaidSvg(result.svg)).ok).toBe(true);
      expect(result.svg).not.toMatch(/\son[a-z]+="/i);
      expect(result.svg).not.toContain("foreignObject");
      expect(result.svg).not.toContain("evil.example/x.css");
    },
    30_000,
  );

  browserTest(
    "enforces edge and SVG limits through the real browser at the policy boundary",
    async () => {
      const chain = (edges: number) =>
        `flowchart LR\n${Array.from({ length: edges }, (_, i) => `  A${i} --> A${i + 1}`).join("\n")}`;
      // Each pie slice adds three SVG elements, so 2,000 slices (~6,000 elements) exceed the
      // 5,000-element limit from ~27 KiB of source. Pie layout is cheap; a sequence diagram
      // of the same size can exceed the parse/layout deadline on a loaded host and fail with
      // render_timeout before the SVG check runs.
      const slices = `pie\n${Array.from({ length: 2_000 }, (_, i) => `  "s${i}" : 1`).join("\n")}`;
      // This integration exercises Mermaid rather than the runner's controlled
      // policy seam. Run it sequentially and allow for aggregate host contention;
      // production timeout behaviour has a separate watchdog test below.
      const integration = new TranscriptPreviewRunner({
        isolation: "process",
        scratchRoot: previewTestScratchRoot(),
        budgets: {
          mermaidRenderMs: 30_000,
          workerWallMs: 40_000,
          operationDeadlineMs: 45_000,
        },
      });
      try {
        const at250 = await run(chain(MERMAID_POLICY.maxEdges), integration);
        expect(at250.ok).toBe(true);
        if (at250.ok && at250.kind === "mermaid") expect(at250.edges).toBe(MERMAID_POLICY.maxEdges);

        const over250 = await run(chain(MERMAID_POLICY.maxEdges + 1), integration);
        expect(over250.ok).toBe(false);
        if (!over250.ok)
          expect(over250.error).toMatchObject({
            code: "package_size_exceeded",
            resource: "edges",
          });

        const tooMany = await run(slices, integration);
        expect(tooMany.ok).toBe(false);
        if (!tooMany.ok) {
          expect(tooMany.error).toMatchObject({
            code: "package_size_exceeded",
            resource: "svg",
          });
          expect(tooMany.diagnostics[0]!.message).toContain("elements");
        }
      } finally {
        await integration.close();
      }
    },
    150_000,
  );

  browserTest(
    "the external watchdog ends a blocked render after its deadline and the browser is gone",
    async () => {
      const RENDER_DEADLINE_MS = 1_000;
      const exits: Array<{
        verified: boolean;
        browserPid: number | null;
        workerPid: number | null;
      }> = [];
      const blocking = new TranscriptPreviewRunner({
        isolation: "process",
        scratchRoot: previewTestScratchRoot(),
        testing: { blockMermaidRender: true },
        // A shorter render deadline than the production one: the watchdog is
        // the same, only the wait for it is shorter.
        budgets: { mermaidRenderMs: RENDER_DEADLINE_MS },
        onWorkerExit: (report) => exits.push(report),
      });
      try {
        const started = Date.now();
        const result = await run(DIAGRAMS.flowchart!.source, blocking);
        const elapsed = Date.now() - started;
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error).toMatchObject({
            code: "render_timeout",
            resource: "mermaid-render",
          });
        // The spin never yields, so only the external render deadline can
        // produce this result. Total wall time also includes Chromium startup,
        // which is intentionally not bounded by the render-phase deadline.
        expect(elapsed).toBeGreaterThanOrEqual(RENDER_DEADLINE_MS);
        const deadline = Date.now() + 10_000;
        while (blocking.stats().running > 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        expect(blocking.stats().running).toBe(0);
        expect(exits).toHaveLength(1);
        expect(exits[0]!.verified).toBe(true);
        const processes = await listProcesses();
        expect(isAlive(exits[0]!.browserPid!, processes)).toBe(false);
        expect(isAlive(exits[0]!.workerPid!, processes)).toBe(false);
      } finally {
        await blocking.close();
      }
    },
    60_000,
  );
});

describe("mermaid SVG verification", () => {
  const ok =
    '<svg xmlns="http://www.w3.org/2000/svg"><style>#a > g{fill:red}</style><g><path marker-end="url(#m)" d="M0 0"/></g></svg>';
  test("accepts local references and decoded style text", async () => {
    expect((await verifyMermaidSvg(ok)).ok).toBe(true);
    expect((await verifyMermaidSvg(ok.replace(" > ", " &gt; "))).ok).toBe(true);
  });

  test("rejects scripts, foreign HTML, event attributes and external references", async () => {
    const cases = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g onclick="x()"></g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.example"><text>x</text></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/a.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css);</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>g{background:u&#114;l(https://evil.example/a.png)}</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g style="fill:url(https://evil.example/#a)"></g></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g fill="url(https://evil.example/#a)"></g></svg>',
      "<div>not svg</div>",
    ];
    for (const svg of cases) expect((await verifyMermaidSvg(svg)).ok).toBe(false);
  });

  test("enforces byte and element limits at and over the boundary", async () => {
    expect((await verifyMermaidSvg(svgWithElements(MERMAID_POLICY.maxSvgElements))).ok).toBe(true);
    expect((await verifyMermaidSvg(svgWithElements(MERMAID_POLICY.maxSvgElements + 1))).ok).toBe(
      false,
    );
    const shell = '<svg xmlns="http://www.w3.org/2000/svg"><!----></svg>';
    const withBytes = (bytes: number) =>
      shell.replace("<!---->", `<!--${" ".repeat(bytes - Buffer.byteLength(shell))}-->`);
    expect((await verifyMermaidSvg(withBytes(MERMAID_POLICY.maxSvgBytes))).ok).toBe(true);
    expect((await verifyMermaidSvg(withBytes(MERMAID_POLICY.maxSvgBytes + 1))).ok).toBe(false);
  });
});
