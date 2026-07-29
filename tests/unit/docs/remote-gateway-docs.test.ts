import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

describe("remote gateway documentation", () => {
  test("keeps README and detailed docs aligned with the managed Electron workflow", async () => {
    const [readme, guide] = await Promise.all([
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
    ]);

    for (const document of [readme, guide]) {
      expect(document).toContain("Settings > Web client");
      expect(document).toContain("Allow web access");
      expect(document).toContain("Tailscale Serve");
      expect(document).toContain("www.orkestrator.dev");
    }
    expect(readme).toContain("bun run start:web-public");
    expect(guide).toContain("--tailscale-serve");
    expect(guide).toContain("Disabling the setting removes that Serve endpoint");
  });

  test("references an existing standalone command and syntactically valid HTTPS links", async () => {
    const [manifest, readme, guide] = await Promise.all([
      Bun.file(path.join(root, "package.json")).json() as Promise<{ scripts?: Record<string, string> }>,
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
    ]);

    expect(manifest.scripts?.["start:web-public"]).toBeTruthy();
    for (const document of [readme, guide]) {
      for (const match of document.matchAll(/\]\((https:\/\/[^)]+)\)/g)) {
        expect(() => new URL(match[1])).not.toThrow();
      }
    }
  });

  test("documents compression modes, precedence, defaults, and milestone-zero behavior", async () => {
    const [guide, milestone] = await Promise.all([
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-0.md"), "utf8"),
    ]);

    expect(guide).toContain("ORKESTRATOR_GATEWAY_COMPRESSION");
    expect(guide).toContain("--compression off|body|on");
    expect(guide).toContain("The standalone `--compression` CLI flag.");
    expect(guide).toContain("`ORKESTRATOR_GATEWAY_COMPRESSION`.");
    expect(guide).toContain("The default, `off`.");
    expect(guide).toContain("constructor option takes precedence");
    expect(guide).toContain("All three modes are intentionally no-op rollout controls");
    expect(guide).toContain("does not add response compression in `off`, `body`, or `on`");
    expect(guide).toContain("`off` is the immediate rollback mode");

    expect(milestone).toContain("CLI compression overrides the environment");
    expect(milestone).toContain("defaults to `off`");
    expect(milestone).toContain("`off`, `body`, and `on` do not add response compression");
    expect(milestone).toContain("- [x] No production response path has changed encoding yet.");
  });

  test("documents listener-role compression semantics independently of bind address", async () => {
    const guide = await readFile(path.join(root, "docs", "remote-gateway.md"), "utf8");

    expect(guide).toContain("Compression policy follows the listener's role, not its bind address.");
    expect(guide).toMatch(/browser\s+listener remains a `browser` listener/);
    expect(guide).toContain("`--tailscale-serve` binds it to");
    expect(guide).toContain("`127.0.0.1`");
    expect(guide).toContain("`control` listener always resolves to `off`");
    expect(guide).toContain("never adds response compression on desktop IPC/control traffic");
  });

  test("documents authenticated metrics methods, bounds, and privacy exclusions", async () => {
    const [guide, milestone] = await Promise.all([
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-0.md"), "utf8"),
    ]);
    const normalizedGuide = guide.replace(/\s+/g, " ");

    expect(normalizedGuide).toContain("`GET /__orkestrator/metrics`");
    expect(normalizedGuide).toContain("`POST /__orkestrator/client-metrics`");
    expect(normalizedGuide).toContain("Both metrics routes require the same gateway authentication");
    expect(normalizedGuide).toContain("methods other than `GET` are");
    expect(normalizedGuide).toContain("methods other than `POST`, malformed JSON, and oversized bodies are rejected");
    expect(normalizedGuide).toContain("keeps only an allowlist");
    expect(normalizedGuide).toContain("recent samples are kept in a bounded in-memory ring");
    expect(normalizedGuide).toContain("unknown commands and uncommon response encodings are grouped");

    for (const excludedContent of [
      "prompts",
      "terminal contents or output",
      "file contents",
      "attachment data",
      "credentials",
      "tokens",
      "resource URLs",
      "request/response payloads",
    ]) {
      expect(normalizedGuide).toContain(excludedContent);
    }

    expect(milestone).toContain("Both metrics routes require authentication");
    expect(milestone).toContain("Client metric reports are allowlisted and bounded");
    expect(milestone).toContain(
      "The coordinated gateway/docs, backend option/standalone,",
    );
    expect(milestone).toContain("- [x] Focused tests and typechecks pass.");
  });
});
