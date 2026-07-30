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

  test("documents compression modes, precedence, the body default, and milestone history", async () => {
    const [guide, milestoneZero, milestoneTwo] = await Promise.all([
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-0.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-2.md"), "utf8"),
    ]);

    expect(guide).toContain("ORKESTRATOR_GATEWAY_COMPRESSION");
    expect(guide).toContain("--compression off|body|on");
    expect(guide).toContain("The standalone `--compression` CLI flag.");
    expect(guide).toContain("`ORKESTRATOR_GATEWAY_COMPRESSION`.");
    expect(guide).toContain("The default, `body`.");
    expect(guide).toContain("constructor option takes precedence");
    expect(guide).toContain("`off`: identity responses everywhere");
    expect(guide).toContain("`body`: Brotli (preferred) or gzip");
    expect(guide).toContain("`on`: everything in `body`, plus gzip server-sent events");
    expect(guide).toContain("Bodies smaller than 1 KiB remain identity");
    expect(guide).toContain("Accept-Encoding: identity");
    expect(guide).toContain("Already encoded upstream responses are passed through");
    expect(guide.replace(/\s+/g, " ")).toContain("`body` remains the default");

    expect(milestoneZero).toContain("CLI compression overrides the environment");
    expect(milestoneZero).toContain("defaults to `off`");
    expect(milestoneZero).toContain("`off`, `body`, and `on` do not add response compression");
    expect(milestoneZero).toContain("- [x] No production response path has changed encoding yet.");

    const normalizedMilestoneTwo = milestoneTwo.replace(/\s+/g, " ");
    expect(normalizedMilestoneTwo).toContain("Ship initially in `body` mode");
    expect(normalizedMilestoneTwo).toContain(
      "Reserve one of eight proxy-buffer slots and declared source bytes against a shared 64 MiB budget before buffering",
    );
    expect(normalizedMilestoneTwo).toContain(
      "Concurrent near-limit proxy responses remain within the eight-buffer and 64 MiB source-byte budgets",
    );
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
    const [guide, milestoneZero, milestoneTwo] = await Promise.all([
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-0.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-2.md"), "utf8"),
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

    expect(normalizedGuide).toContain("retained only when the backend registry actually contains");
    expect(normalizedGuide).toContain("collapsed to a fixed category");
    expect(normalizedGuide).toContain("Event counters are per delivery, not per emit");
    expect(normalizedGuide).toContain(
      "route-level `responseBytes` counter records the encoded chunks actually written",
    );
    expect(normalizedGuide).toContain(
      "`configuredMode` reports the configured browser-listener rollout mode",
    );
    expect(normalizedGuide).toContain(
      "fallbacks are recorded as identity rather than as the encoding that was merely negotiated",
    );

    expect(milestoneZero).toContain("Both metrics routes require authentication");
    expect(milestoneZero).toContain("Client metric reports are allowlisted and bounded");
    expect(milestoneZero).toContain(
      "The coordinated gateway/docs, backend option/standalone,",
    );
    expect(milestoneZero).toContain("- [x] Focused tests and typechecks pass.");
    expect(milestoneTwo).toContain("body and event-stream transfer reduction");
  });

  test("documents proxy transformation exclusions and pending manual evidence", async () => {
    const [guide, milestoneTwo] = await Promise.all([
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-2.md"), "utf8"),
    ]);
    const normalizedGuide = guide.replace(/\s+/g, " ");
    const normalizedMilestoneTwo = milestoneTwo.replace(/\s+/g, " ");

    expect(normalizedGuide).toContain(
      "does not transform responses to `HEAD`, bodyless status responses, `206 Partial Content` responses, or responses carrying `Content-Range`",
    );
    // The untransformed bodyless path keeps identity metadata and drops only the
    // two fields defined over content-coded bytes.
    expect(normalizedGuide).toContain(
      "keeps `Vary: Accept-Encoding` alongside the identity metadata its retained `Content-Length` already describes",
    );
    expect(normalizedGuide).toContain(
      "including the `ETag` that RFC 9110 requires a `304` to carry",
    );
    expect(normalizedGuide).toContain(
      "`Accept-Ranges`, which stays honest because ranged `GET`s are passed through untransformed",
    );
    expect(normalizedGuide).toContain(
      "Only `Content-MD5` and `Content-Digest` are dropped there",
    );
    expect(normalizedGuide).toContain(
      "Whenever preview rewriting or compression actually changes representation bytes",
    );
    for (const field of [
      "`ETag`",
      "`Content-MD5`",
      "`Content-Digest`",
      "`Repr-Digest`",
      "legacy `Digest`",
      "`Accept-Ranges`",
    ]) {
      expect(normalizedGuide).toContain(field);
    }

    expect(normalizedMilestoneTwo).toContain(
      "Proxy `HEAD`, `1xx`, `204`, `304`, `206`, and `Content-Range` responses preserve bodyless/range semantics",
    );
    expect(normalizedMilestoneTwo).toContain(
      "Untransformed bodyless responses retain `ETag` and `Accept-Ranges` and drop only the content-coded digests",
    );
    expect(normalizedMilestoneTwo).toContain(
      "Automated tests and simulator runs do not complete these manual items",
    );
    expect(milestoneTwo).toContain("- [ ] Test through raw tailnet HTTP and Tailscale Serve.");
    expect(milestoneTwo).toContain(
      "- [ ] Test iOS foreground, background, screen lock, and foreground recovery.",
    );
    expect(normalizedMilestoneTwo).toContain(
      "implementation evidence only and do not replace the unchecked tailnet and physical-device manual evidence",
    );
  });

  test("documents the stall timeout and the aggregate preview decode budget", async () => {
    const [guide, milestoneTwo] = await Promise.all([
      readFile(path.join(root, "docs", "remote-gateway.md"), "utf8"),
      readFile(path.join(root, "docs", "efficiency", "milestone-2.md"), "utf8"),
    ]);
    const normalizedGuide = guide.replace(/\s+/g, " ");
    const normalizedMilestoneTwo = milestoneTwo.replace(/\s+/g, " ");

    expect(normalizedGuide).toContain(
      "subject to a 30 second idle timeout, reset by every chunk received",
    );
    expect(normalizedGuide).toContain(
      "A slow upstream is fine; a silent one is aborted with `502`",
    );
    expect(normalizedGuide).toContain(
      "charged per chunk against a shared 64 MiB aggregate decode budget",
    );
    expect(normalizedGuide).toContain(
      "this bounds concurrency, which the per-request limit alone does not",
    );

    expect(normalizedMilestoneTwo).toContain(
      "Abort a buffered body whose upstream goes idle past the timeout",
    );
    expect(normalizedMilestoneTwo).toContain(
      "A stalled upstream is aborted at the idle timeout and returns its reservation, while a slow but progressing body outlives that timeout",
    );
    expect(normalizedMilestoneTwo).toContain(
      "Decoded preview bytes return to the shared aggregate budget after success, rewrite rejection, and upstream abort",
    );
  });
});
