import { describe, expect, test } from "bun:test";
import { compile } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import { graphTemplateExportText } from "./library.js";
import { graphTemplateDigest } from "./plan.js";
import {
  GRAPH_BUNDLE_FORMAT,
  GRAPH_SHARING_BOUNDS,
  createGraphTemplateBundle,
  decodeGraphBase64Url,
  encodeGraphBase64Url,
  graphBundleAuthorIssue,
  graphBundleSigningPayload,
  graphSharingFingerprint,
  graphSharingKeyId,
  graphTemplateBundleFileName,
  graphTemplateBundleText,
  graphTemplateCapabilitySummary,
  graphTemplateContentDigest,
  parseGraphShareText,
} from "./sharing.js";

const EXPORTED_AT = "2026-10-29T12:00:00.000Z";
const PUBLIC_KEY = encodeGraphBase64Url(new Uint8Array(32).map((_, index) => index + 1));

function bundleText(mutate?: (bundle: Record<string, unknown>) => void): string {
  const bundle = createGraphTemplateBundle(graphTemplateExample("multi-review"), {
    exportedAt: EXPORTED_AT,
    author: "Ada",
  }) as unknown as Record<string, unknown>;
  mutate?.(bundle);
  return JSON.stringify(bundle);
}

describe("bundle format", () => {
  test("round trips through canonical text with both digests", () => {
    const template = graphTemplateExample("multi-review");
    const bundle = createGraphTemplateBundle(template, { exportedAt: EXPORTED_AT });
    expect(bundle.format).toBe(GRAPH_BUNDLE_FORMAT);
    expect(bundle.digest).toBe(graphTemplateDigest(template));
    expect(bundle.contentDigest).toBe(graphTemplateContentDigest(template));
    const text = graphTemplateBundleText(bundle);
    expect(text.endsWith("}\n")).toBe(true);
    // Canonical: the same bundle always writes the same bytes.
    expect(graphTemplateBundleText(JSON.parse(text))).toBe(text);
    const parsed = parseGraphShareText(text);
    expect(parsed.ok && parsed.kind === "bundle" && parsed.bundle.digest).toBe(bundle.digest);
    expect(graphTemplateBundleFileName(template)).toBe(`${template.id}.graph-bundle.json`);
  });

  test("custom types travel inside the template", () => {
    const template = graphTemplateExample("design-bake-off");
    const parsed = parseGraphShareText(
      graphTemplateBundleText(createGraphTemplateBundle(template, { exportedAt: EXPORTED_AT })),
    );
    expect(parsed.ok && parsed.kind === "bundle" && parsed.bundle.template.types).toEqual(
      template.types,
    );
  });

  test("a tampered template is refused by its digest", () => {
    const parsed = parseGraphShareText(
      bundleText((bundle) => {
        (bundle.template as { name: string }).name = "Something else";
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.refused).toBe("digest-mismatch");
  });

  test("a layout-only change is refused by the content digest", () => {
    const parsed = parseGraphShareText(
      bundleText((bundle) => {
        const template = bundle.template as { nodes: Array<{ id: string }>; layout?: unknown };
        template.layout = { [template.nodes[0]!.id]: { x: 12345, y: 678 } };
      }),
    );
    expect(!parsed.ok && parsed.refused).toBe("content-digest-mismatch");
  });

  test("a signature whose key id is not its key's is refused", () => {
    const parsed = parseGraphShareText(
      bundleText((bundle) => {
        bundle.signature = {
          algorithm: "ed25519",
          publicKey: PUBLIC_KEY,
          keyId: "0".repeat(32),
          value: encodeGraphBase64Url(new Uint8Array(64)),
        };
      }),
    );
    expect(!parsed.ok && parsed.refused).toBe("signature-invalid");
  });

  test("malformed bundles are refused with paths", () => {
    const cases: Array<[(bundle: Record<string, unknown>) => void, string]> = [
      [(bundle) => (bundle.extra = 1), "extra"],
      [(bundle) => (bundle.formatVersion = 2), "formatVersion"],
      [(bundle) => (bundle.digest = "abc"), "digest"],
      [(bundle) => (bundle.exportedAt = "yesterday"), "exportedAt"],
      [(bundle) => (bundle.author = "two\nlines"), "author"],
      [(bundle) => (bundle.signature = { algorithm: "rsa" }), "signature.algorithm"],
    ];
    for (const [mutate, path] of cases) {
      const parsed = parseGraphShareText(bundleText(mutate));
      expect(!parsed.ok && parsed.refused).toBe("invalid-bundle");
      expect(!parsed.ok && parsed.errors.map((error) => error.path)).toContain(path);
    }
    const duplicate = parseGraphShareText(
      `{"format":"${GRAPH_BUNDLE_FORMAT}","format":"${GRAPH_BUNDLE_FORMAT}"}`,
    );
    expect(!duplicate.ok && duplicate.errors[0]!.code).toBe("invalid_json");
    const huge = parseGraphShareText(" ".repeat(GRAPH_SHARING_BOUNDS.maxBundleBytes + 1));
    expect(!huge.ok && huge.errors[0]!.code).toBe("too_large");
  });

  test("an invalid template inside a bundle is refused with template paths", () => {
    const parsed = parseGraphShareText(
      bundleText((bundle) => {
        (bundle.template as { nodes: unknown }).nodes = "nope";
      }),
    );
    expect(!parsed.ok && parsed.refused).toBe("invalid-template");
    expect(!parsed.ok && parsed.errors[0]!.path.startsWith("template")).toBe(true);
  });

  test("plain template text is accepted as a template without digests", () => {
    const parsed = parseGraphShareText(
      graphTemplateExportText(graphTemplateExample("multi-review")),
    );
    expect(parsed.ok && parsed.kind).toBe("template");
  });

  test("author bounds", () => {
    expect(graphBundleAuthorIssue("Ada Lovelace")).toBeNull();
    expect(graphBundleAuthorIssue(" ")).not.toBeNull();
    expect(graphBundleAuthorIssue("x".repeat(GRAPH_SHARING_BOUNDS.maxAuthorChars + 1))).not.toBe(
      null,
    );
    expect(graphBundleAuthorIssue("tab\there")).not.toBeNull();
  });
});

describe("keys and signing payload", () => {
  test("base64url round trips and refuses non-canonical text", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 64]) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37) & 0xff);
      expect([...decodeGraphBase64Url(encodeGraphBase64Url(bytes))!]).toEqual([...bytes]);
    }
    expect(decodeGraphBase64Url("a")).toBeNull();
    expect(decodeGraphBase64Url("ab+/")).toBeNull();
    // Non-zero padding bits: a second encoding of the same byte.
    expect(decodeGraphBase64Url("AB")).toBeNull();
  });

  test("key ids are stable 32-hex fingerprints", () => {
    const keyId = graphSharingKeyId(PUBLIC_KEY);
    expect(keyId).toMatch(/^[0-9a-f]{32}$/);
    expect(graphSharingKeyId(PUBLIC_KEY)).toBe(keyId);
    expect(graphSharingFingerprint(keyId).split(" ")).toHaveLength(8);
    expect(() => graphSharingKeyId("short")).toThrow();
  });

  test("the signing payload binds both digests, the metadata and the key", () => {
    const bundle = createGraphTemplateBundle(graphTemplateExample("multi-review"), {
      exportedAt: EXPORTED_AT,
    });
    const payload = graphBundleSigningPayload(bundle, "a".repeat(32));
    expect(payload.startsWith("orkestrator.graph-bundle/1\n")).toBe(true);
    expect(payload).toContain(bundle.digest);
    expect(payload).toContain(bundle.contentDigest);
    expect(graphBundleSigningPayload({ ...bundle, author: "Ada" }, "a".repeat(32))).not.toBe(
      payload,
    );
    expect(graphBundleSigningPayload(bundle, "b".repeat(32))).not.toBe(payload);
  });
});

describe("capability summary", () => {
  test("lists profiles, writers, system actions and side effects", () => {
    const template = graphTemplateExample("build-pipeline-loop");
    const result = compile(template);
    const summary = graphTemplateCapabilitySummary(template, result);
    expect(summary.compiled).toBe(result.plan !== null);
    expect(summary.agentNodes).toBe(template.nodes.filter((node) => node.kind === "agent").length);
    const profiled = summary.profiles.reduce((sum, entry) => sum + entry.nodes.length, 0);
    expect(profiled).toBe(summary.agentNodes);
    const systemNodes = template.nodes.filter((node) => node.kind === "system");
    expect(summary.systemActions.reduce((sum, entry) => sum + entry.nodes.length, 0)).toBe(
      systemNodes.length,
    );
    for (const entry of summary.systemActions) expect(typeof entry.sideEffect).toBe("boolean");
    if (template.nodes.some((node) => node.kind === "agent" && node.workspaceAccess === "write")) {
      expect(summary.workspaceWriters.nodes.length).toBeGreaterThan(0);
    }
  });

  test("works without a plan and bounds node lists", () => {
    const base = graphTemplateExample("multi-review");
    const agent = base.nodes.find((node) => node.kind === "agent")!;
    const many = Array.from({ length: GRAPH_SHARING_BOUNDS.maxListedNodes + 5 }, (_, index) => ({
      ...agent,
      id: `writer-${String(index).padStart(2, "0")}`,
      workspaceAccess: "write" as const,
      capabilities: { profile: "builder" as const, allow: ["git.push" as const] },
    }));
    const template = { ...base, nodes: [...base.nodes, ...many] };
    const summary = graphTemplateCapabilitySummary(template, { plan: null, diagnostics: [] });
    expect(summary.compiled).toBe(false);
    expect(summary.networkNodes).toBeNull();
    const writers = template.nodes.filter(
      (node) => node.kind === "agent" && node.workspaceAccess === "write",
    ).length;
    expect(summary.workspaceWriters.nodes).toHaveLength(GRAPH_SHARING_BOUNDS.maxListedNodes);
    expect(summary.workspaceWriters.more).toBe(writers - GRAPH_SHARING_BOUNDS.maxListedNodes);
    expect(summary.remoteWriteRequests.nodes.length + summary.remoteWriteRequests.more).toBe(
      many.length,
    );
  });
});
