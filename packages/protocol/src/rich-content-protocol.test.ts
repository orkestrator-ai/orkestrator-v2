import { describe, expect, test } from "bun:test";
import { canonicalJson, parseStrictJson } from "./canonical-json";
import { scanCssResources } from "./css-resource-scan";
import {
  ARTIFACT_FRAME_CHANNEL,
  ARTIFACT_SHELL_DISPOSED,
  ArtifactFrameRateLimiter,
  artifactFrameRuntimeScript,
  clampArtifactFrameHeight,
  normalizeArtifactLink,
  parseArtifactFrameMessage,
  parseArtifactShellMessage,
} from "./artifact-frame-channel";
import { FRAME_CHANNEL_POLICY, INTERACTIVE_HTML_POLICY } from "./rich-content-policy";
import {
  csvField,
  markdownFenceFor,
  toCsv,
  toMarkdownFence,
  toMarkdownTable,
} from "./tabular-export";
import {
  orkestratorToolName,
  ARTIFACT_TOOL_NAMES,
  safeArtifactFilename,
} from "./transcript-artifacts";
import {
  readTranscriptArtifactRef,
  validateArtifactDraft,
  validatePreviewProfile,
} from "./transcript-artifacts-validation";
import {
  layoutWorkflowSnapshot,
  parseUtcTimestamp,
  validateWorkflowSnapshot,
  type WorkflowSnapshotV1,
} from "./workflow-snapshot";

describe("canonical JSON", () => {
  test("sorts keys, preserves arrays and normalizes -0", () => {
    expect(canonicalJson({ b: [3, 1], a: { d: -0, c: "x" } })).toBe(
      '{"a":{"c":"x","d":0},"b":[3,1]}',
    );
  });

  test("rejects undefined and non-finite values", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson([1, undefined])).toThrow();
  });

  test("strict reader rejects duplicate keys and bounds depth", () => {
    expect(parseStrictJson('{"a":1,"a":2}').ok).toBe(false);
    expect(parseStrictJson("[".repeat(40) + "]".repeat(40), 32).ok).toBe(false);
    const parsed = parseStrictJson('{"__proto__":{"x":1},"s":"\\u00e9\\n"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
      expect((parsed.value as Record<string, unknown>).s).toBe("é\n");
      expect(Object.keys(parsed.value as object)).toEqual(["__proto__", "s"]);
    }
  });
});

describe("CSS resource scanning", () => {
  const external = (css: string) =>
    scanCssResources(css).externalCount + scanCssResources(css).importCount;

  test("finds url() in all spellings", () => {
    expect(external("a{background:url(https://x.test/a.png)}")).toBe(1);
    expect(external("a{background:URL( 'http://x.test/a.png' )}")).toBe(1);
    expect(external("a{background:u\\72l(//x.test/a.png)}")).toBe(1);
    expect(external('a{background:image-set("https://x.test/a.png" 1x)}')).toBe(1);
    expect(external("a{background:image-set(url(//x.test/a.png) 1x)}")).toBe(1);
    expect(external("@import 'x.css';")).toBeGreaterThan(0);
    expect(external("@IMPORT url(x.css);")).toBeGreaterThan(0);
  });

  test("allows local data and fragment references and ignores comments/strings", () => {
    expect(external("a{background:url(data:image/png;base64,AAAA)}")).toBe(0);
    expect(external("path{marker-end:url(#arrow)}")).toBe(0);
    expect(external("/* url(https://x.test) */ a{content:'url(https://x.test)'}")).toBe(0);
  });
});

describe("artifact frame channel", () => {
  const identity = { artifactId: "art_abcdefgh", revision: 2, generation: "gen-1" };
  const message = (extra: Record<string, unknown>) => ({
    channel: ARTIFACT_FRAME_CHANNEL,
    v: 1,
    ...extra,
  });

  test("accepts the handshake before identity, then requires exact identity", () => {
    expect(
      parseArtifactFrameMessage(
        message({ type: "ready", protocolVersion: 1, nonce: "abcdefgh12" }),
        null,
      ).ok,
    ).toBe(true);
    expect(
      parseArtifactFrameMessage(message({ type: "size", height: 300, ...identity }), null).ok,
    ).toBe(false);
    expect(
      parseArtifactFrameMessage(message({ type: "size", height: 300, ...identity }), identity).ok,
    ).toBe(true);
    expect(
      parseArtifactFrameMessage(
        message({ type: "size", height: 300, ...identity, generation: "old" }),
        identity,
      ),
    ).toEqual({ ok: false, reason: "identity-mismatch" });
  });

  test("rejects unknown types, extra fields, huge and cyclic payloads", () => {
    expect(
      parseArtifactFrameMessage(message({ type: "invoke-tool", ...identity }), identity),
    ).toEqual({ ok: false, reason: "unknown-type" });
    expect(
      parseArtifactFrameMessage(
        message({ type: "size", height: 1, ...identity, extra: 1 }),
        identity,
      ),
    ).toEqual({ ok: false, reason: "bad-shape" });
    expect(
      parseArtifactFrameMessage(
        message({
          type: "link-request",
          url: "https://x.test",
          label: "y".repeat(FRAME_CHANNEL_POLICY.maxMessageBytes),
          ...identity,
        }),
        identity,
      ).ok,
    ).toBe(false);
    const cyclic: Record<string, unknown> = message({ type: "size", height: 1, ...identity });
    cyclic.self = cyclic;
    expect(parseArtifactFrameMessage(cyclic, identity).ok).toBe(false);
  });

  test("links: http(s) only, no credentials, no control or bidi characters", () => {
    expect(normalizeArtifactLink("https://example.com/a?b=1")?.hostname).toBe("example.com");
    expect(normalizeArtifactLink("javascript:alert(1)")).toBeNull();
    expect(normalizeArtifactLink("https://user:pw@example.com")).toBeNull();
    expect(normalizeArtifactLink(`https://exa${String.fromCharCode(0x202e)}mple.com`)).toBeNull();
    expect(normalizeArtifactLink("file:///etc/passwd")).toBeNull();
  });

  test("rate limiter bounds bursts and coalesces size updates", () => {
    let now = 0;
    const limiter = new ArtifactFrameRateLimiter(() => now);
    let admitted = 0;
    for (let i = 0; i < 100; i++) if (limiter.admit("link-request")) admitted++;
    expect(admitted).toBe(FRAME_CHANNEL_POLICY.burst);
    now += 10_000;
    expect(limiter.admit("size")).toBe(true);
    expect(limiter.admit("size")).toBe(false);
    now += 300;
    expect(limiter.admit("size")).toBe(true);
  });

  test("height is clamped and the runtime script embeds only identity", () => {
    expect(clampArtifactFrameHeight(1)).toBe(FRAME_CHANNEL_POLICY.minInlineHeight);
    expect(clampArtifactFrameHeight(1e9)).toBe(FRAME_CHANNEL_POLICY.maxInlineHeight);
    const script = artifactFrameRuntimeScript({
      artifactId: "art_abcdefgh",
      revision: 1,
      nonce: "abcdefgh12",
    });
    expect(script).not.toContain("</script");
    expect(script).toContain('"artifactId":"art_abcdefgh"');
  });

  test("the shell's dispose message: exact keys and a known reason, never a frame message", () => {
    const disposed = (extra: Record<string, unknown> = {}) =>
      message({ type: ARTIFACT_SHELL_DISPOSED, reason: "unexpected-load", ...extra });
    expect(parseArtifactShellMessage(disposed())).toEqual({
      ok: true,
      message: {
        channel: ARTIFACT_FRAME_CHANNEL,
        v: 1,
        type: ARTIFACT_SHELL_DISPOSED,
        reason: "unexpected-load",
      },
    });
    expect(parseArtifactShellMessage(disposed({ reason: "blocked-navigation" })).ok).toBe(true);
    expect(parseArtifactShellMessage(disposed({ reason: "other" })).ok).toBe(false);
    expect(parseArtifactShellMessage(disposed({ extra: 1 })).ok).toBe(false);
    expect(parseArtifactShellMessage(disposed({ v: 2 })).ok).toBe(false);
    expect(parseArtifactShellMessage(disposed({ channel: "other" })).ok).toBe(false);
    expect(parseArtifactShellMessage({ ...disposed(), reason: undefined }).ok).toBe(false);
    expect(parseArtifactShellMessage(null).ok).toBe(false);
    expect(parseArtifactShellMessage([disposed()]).ok).toBe(false);
    expect(parseArtifactShellMessage("shell-disposed").ok).toBe(false);
    // The frame channel never accepts it as a frame message.
    expect(parseArtifactFrameMessage(disposed(), identity)).toEqual({
      ok: false,
      reason: "unknown-type",
    });
  });
});

describe("tabular export", () => {
  test("RFC 4180 quoting with doubled quotes and embedded newlines", () => {
    expect(csvField('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(toCsv(["h"], [["x"], [null], [-3]])).toBe("h\r\nx\r\n\r\n-3\r\n");
  });

  test("spreadsheet-safe mode neutralizes formula text but keeps typed negatives", () => {
    expect(csvField("=HYPERLINK(1)", "spreadsheet-safe")).toBe("'=HYPERLINK(1)");
    expect(csvField("=HYPERLINK(1)", "exact")).toBe("=HYPERLINK(1)");
    expect(csvField(-5, "spreadsheet-safe")).toBe("-5");
    expect(csvField("-5", "spreadsheet-safe")).toBe("'-5");
  });

  test("markdown fences outrun embedded backticks; tables escape pipes", () => {
    expect(markdownFenceFor("a ```` b")).toBe("`````");
    expect(toMarkdownFence("const a = `x`;\n", "ts", 'Ti"tle')).toBe(
      '```ts title="Title"\nconst a = `x`;\n```',
    );
    expect(toMarkdownTable(["a|b"], [["c\nd"]], ["right"])).toBe("| a\\|b |\n| ---: |\n| c<br>d |");
  });
});

describe("artifact names, refs and drafts", () => {
  test("orkestratorToolName recognizes every provider spelling", () => {
    const tools = ARTIFACT_TOOL_NAMES;
    expect(orkestratorToolName("mcp__orkestrator__publish_artifact", tools)).toBe(
      "publish_artifact",
    );
    expect(orkestratorToolName("orkestrator__publish_artifact", tools)).toBe("publish_artifact");
    expect(orkestratorToolName("orkestrator_publish_artifact", tools)).toBe("publish_artifact");
    expect(
      orkestratorToolName("publish_artifact", tools, { toolTitle: "orkestrator:publish_artifact" }),
    ).toBe("publish_artifact");
    expect(
      orkestratorToolName("publish_artifact", tools, { toolTitle: "other:publish_artifact" }),
    ).toBeNull();
    expect(orkestratorToolName("mcp__other__publish_artifact", tools)).toBeNull();
    expect(orkestratorToolName("publish_artifact", tools, { mcpServerName: "evil" })).toBeNull();
  });

  test("the workflow turn's artifact-only server counts as Orkestrator's", () => {
    const tools = ARTIFACT_TOOL_NAMES;
    expect(orkestratorToolName("mcp__orkestrator-artifacts__publish_artifact", tools)).toBe(
      "publish_artifact",
    );
    expect(orkestratorToolName("orkestrator-artifacts_publish_artifact", tools)).toBe(
      "publish_artifact",
    );
    expect(
      orkestratorToolName("publish_artifact", tools, { mcpServerName: "orkestrator-artifacts" }),
    ).toBe("publish_artifact");
    expect(
      orkestratorToolName("publish_artifact", tools, {
        toolTitle: "orkestrator-artifacts:publish_artifact",
      }),
    ).toBe("publish_artifact");
    expect(orkestratorToolName("mcp__orkestrator-artifactsx__publish_artifact", tools)).toBeNull();
  });

  test("filenames never carry path separators or control characters", () => {
    expect(safeArtifactFilename("../../etc/passwd\r\nX: y", "html")).toBe("etc passwd X y.html");
    expect(safeArtifactFilename("", "../exe")).toBe("artifact.exe");
  });

  test("refs from newer formats or kinds become honest placeholders", () => {
    expect(
      readTranscriptArtifactRef({ schemaVersion: 2, title: "Future", summary: "s" }).status,
    ).toBe("unsupported");
    expect(
      readTranscriptArtifactRef({ schemaVersion: 1, kind: "spreadsheet", title: "x" }).status,
    ).toBe("unsupported");
    const ref = {
      schemaVersion: 1,
      artifactId: "art_abcdefgh",
      revision: 1,
      publicationId: "pub_abcdefgh",
      kind: "chart",
      title: "Chart",
      summary: "",
      provenance: { backendId: "b1", origin: "agent" },
    };
    expect(readTranscriptArtifactRef(ref).status).toBe("supported");
    expect(readTranscriptArtifactRef({ ...ref, revision: 0 }).status).toBe("invalid");
    expect(readTranscriptArtifactRef({ ...ref, extra: true }).status).toBe("invalid");
  });

  test("drafts: agents cannot author workflow snapshots; probes are declarative and bounded", () => {
    const snapshot = validateArtifactDraft({
      title: "Run",
      summary: "",
      payload: { kind: "workflow-snapshot", snapshot: { nodes: [] } },
    });
    expect(snapshot.ok).toBe(false);
    if (!snapshot.ok) expect(snapshot.errors[0]?.code).toBe("authoritative_source_required");
    const probes = validateArtifactDraft({
      title: "Calc",
      summary: "",
      payload: {
        kind: "html-interactive",
        html: "<p>x</p>",
        probes: [
          { op: "set-number", target: "tasks", value: 8 },
          { op: "expect-text", target: "total", equals: "96" },
          { op: "click", target: "body > div" },
          { op: "eval", target: "x", code: "alert(1)" },
        ],
      },
    });
    expect(probes.ok).toBe(false);
    if (!probes.ok) {
      expect(probes.errors.map((error) => error.path)).toEqual([
        "draft.payload.probes[2].target",
        "draft.payload.probes[3].op",
      ]);
    }
    const tooMany = Array.from({ length: INTERACTIVE_HTML_POLICY.maxProbeSteps + 1 }, () => ({
      op: "click",
      target: "a",
    }));
    expect(
      validateArtifactDraft({
        title: "x",
        summary: "",
        payload: { kind: "html-interactive", html: "x", probes: tooMany },
      }).ok,
    ).toBe(false);
  });

  test("preview profile defaults to light 960×640 and bounds custom viewports", () => {
    const profile = validatePreviewProfile(undefined);
    expect(profile.ok && profile.value).toEqual({
      theme: "light",
      viewport: { width: 960, height: 640, deviceScaleFactor: 1 },
    });
    expect(
      validatePreviewProfile({
        theme: "dark",
        viewport: { width: 4096, height: 4096, deviceScaleFactor: 1 },
      }).ok,
    ).toBe(false);
    expect(
      validatePreviewProfile({
        theme: "dark",
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      }).ok,
    ).toBe(false);
  });
});

describe("workflow snapshots", () => {
  const snapshot: WorkflowSnapshotV1 = {
    schemaVersion: 1,
    workflowId: "multi-review",
    runId: "run-1",
    sourceRevision: "7",
    capturedAt: "2026-10-20T10:00:00.000Z",
    title: "Review",
    description: "",
    status: "running",
    completeness: {
      mode: "complete",
      totalNodes: 2,
      totalEdges: 2,
      omittedNodes: 0,
      omittedEdges: 0,
    },
    nodes: [
      {
        id: "b",
        label: "Reviewer",
        role: "review",
        status: "unknown",
        rawStatus: "stalled-ish",
        links: [],
      },
      {
        id: "a",
        label: "Package",
        role: "input",
        status: "succeeded",
        startedAt: "2026-10-20T09:00:00Z",
        finishedAt: "2026-10-20T09:01:00Z",
        links: [{ relation: "transcript", targetRef: "mr:run-1:pkg", label: "Transcript" }],
      },
    ],
    edges: [
      { id: "e1", from: "a", to: "b", relation: "handoff" },
      { id: "e2", from: "b", to: "a", relation: "retry" },
    ],
  };

  test("accepts cycles via explicit retry edges and lays out deterministically", () => {
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    const layout = layoutWorkflowSnapshot(snapshot);
    expect(layout.nodes.map((node) => [node.id, node.column])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  test("rejects dangling edges, inconsistent totals, paths in refs and reversed times", () => {
    const bad = structuredClone(snapshot);
    bad.edges.push({ id: "e3", from: "a", to: "zzz", relation: "dependency" });
    bad.nodes[1]!.links[0]!.targetRef = "/Users/me/secret.txt";
    bad.nodes[1]!.finishedAt = "2026-10-20T08:00:00Z";
    const result = validateWorkflowSnapshot(bad);
    expect(result.ok).toBe(false);
    const codes = result.ok ? [] : result.errors.map((error) => error.code);
    expect(codes).toEqual(
      expect.arrayContaining(["dangling_edge", "pattern", "before_start", "inconsistent"]),
    );
  });

  test("timestamps must round-trip as UTC", () => {
    expect(parseUtcTimestamp("2026-10-20T10:00:00Z")).not.toBeNull();
    expect(parseUtcTimestamp("2026-02-30T10:00:00Z")).toBeNull();
    expect(parseUtcTimestamp("2026-10-20T10:00:00+01:00")).toBeNull();
  });
});
