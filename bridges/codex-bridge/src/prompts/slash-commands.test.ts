import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPromptInput,
  extractFrontmatter,
  parseCodexSteerCommand,
  resolveConversationMode,
  summarizePromptTemplate,
  wrapPromptForConversationMode,
} from "./slash-commands.js";
import {
  expandTemplateArguments,
  SHELL_TEMPLATE_MESSAGE,
  templateMetadata,
  templateRequiresShell,
} from "./template-format.js";
import {
  clearTemplateMetadataCacheForTesting,
  loadTemplateBody,
  scanPromptTemplates,
  TEMPLATE_LIMITS,
  templateBindingRevision,
  templateCommandId,
  templateRoots,
  type TemplateOrigin,
} from "./template-discovery.js";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  clearTemplateMetadataCacheForTesting();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ork-slash-commands-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function singleRoot(origin: TemplateOrigin = "project") {
  const dir = await temporaryDirectory();
  return { dir, roots: [{ origin, dir }] };
}

describe("steer parsing and prompt shaping", () => {
  test("parses only an exact /steer token with single-line or multiline text", () => {
    expect(parseCodexSteerCommand(" /STEER  check the tests ")).toEqual({
      args: "check the tests",
    });
    expect(parseCodexSteerCommand("/steer\ncheck the API\nthen the UI")).toEqual({
      args: "check the API\nthen the UI",
    });
    expect(parseCodexSteerCommand("/steer\tcheck the API")).toEqual({
      args: "check the API",
    });
    expect(parseCodexSteerCommand("/steer  \n ")).toEqual({ args: "" });
    for (const value of [
      "/steering elsewhere",
      "/steerx elsewhere",
      "/steer-now",
      "please /steer this",
      "first line\n/steer second line",
    ]) {
      expect(parseCodexSteerCommand(value)).toBeNull();
    }
  });

  test("resolves build and plan modes and wraps only plan prompts", () => {
    expect(resolveConversationMode({ mode: "plan" })).toBe("plan");
    expect(resolveConversationMode({ mode: "build" })).toBe("build");
    expect(resolveConversationMode({ mode: "PLAN" })).toBe("build");
    expect(resolveConversationMode({})).toBe("build");

    expect(wrapPromptForConversationMode("Do it", "build")).toBe("Do it");
    const planned = wrapPromptForConversationMode("Plan it", "plan");
    expect(planned).toContain("<system-reminder>");
    expect(planned).toEndWith("\n\nPlan it");
  });

  test("builds bare text or ordered text-and-image user input", () => {
    expect(buildPromptInput("hello", [])).toBe("hello");
    expect(
      buildPromptInput("hello", [
        { type: "image", path: "/tmp/one.png", filename: "one.png" },
        { type: "image", path: "/tmp/two.png", dataUrl: "data:image/png;base64,x" },
      ]),
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "local_image", path: "/tmp/one.png" },
      { type: "local_image", path: "/tmp/two.png" },
    ]);
    expect(buildPromptInput("", [{ type: "image", path: "/tmp/only.png" }])).toEqual([
      { type: "local_image", path: "/tmp/only.png" },
    ]);
  });
});

describe("template frontmatter", () => {
  test("reads single-line fields and strips only matching quotes", () => {
    expect(
      extractFrontmatter(
        [
          "---",
          'description: "Review this change"',
          "argument_hint: '<path:line>'",
          "# a comment",
          "title: it's fine",
          "---",
          "Template body",
        ].join("\n"),
      ),
    ).toEqual({
      body: "Template body",
      fields: { description: "Review this change", argument_hint: "<path:line>" },
    });
    expect(extractFrontmatter("No frontmatter")).toEqual({ body: "No frontmatter", fields: {} });
  });

  test("accepts CRLF line endings and a byte-order mark", () => {
    const byteOrderMark = String.fromCharCode(0xfeff);
    expect(
      extractFrontmatter(`${byteOrderMark}---\r\ndescription: Windows\r\n---\r\nBody`),
    ).toEqual({
      body: "Body",
      fields: { description: "Windows" },
    });
  });

  test("ignores indented lists under keys it does not use", () => {
    const parsed = extractFrontmatter(
      ["---", "allowed-tools:", "  - Bash", "  - Read", "description: Ok", "---", "Body"].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({ body: "Body", fields: { description: "Ok" } });
  });

  test("rejects malformed metadata predictably instead of guessing YAML", () => {
    expect(extractFrontmatter("---\ndescription: never closed\nBody").error).toContain(
      "not closed",
    );
    expect(extractFrontmatter("---\njust a sentence\n---\nBody").error).toContain("key: value");
    expect(extractFrontmatter("---\ndescription: |\n  multi\n  line\n---\nBody").error).toContain(
      "YAML block",
    );
    expect(extractFrontmatter("---\ndescription: one\n  continued\n---\nBody").error).toContain(
      "spans several lines",
    );
  });

  test("argument-hint takes precedence over the legacy spellings", () => {
    const hint = (fields: string[]) =>
      templateMetadata(extractFrontmatter(["---", ...fields, "---", "Body"].join("\n")), "x")
        .argumentHint;
    expect(hint(["arguments: <c>", "argument_hint: <b>", "argument-hint: <a>"])).toBe("<a>");
    expect(hint(["arguments: <c>", "argument_hint: <b>"])).toBe("<b>");
    expect(hint(["arguments: <c>"])).toBe("<c>");
    expect(hint([])).toBeUndefined();
  });

  test("summarizes the task section and returns undefined for placeholder-only content", () => {
    expect(
      summarizePromptTemplate(
        [
          "# Heading",
          "Preamble",
          "## Your Task",
          "- Current branch: main",
          "Review the selected change carefully.",
        ].join("\n"),
      ),
    ).toBe("Review the selected change carefully.");
    expect(summarizePromptTemplate("# Heading\n$ARGUMENTS\n- Current branch: x")).toBeUndefined();
  });
});

describe("template expansion", () => {
  test("preserves multiline, tab, quoted and replacement-pattern arguments verbatim", () => {
    const args = "first line\n\tindented \"quoted\" 'single'\n$& $1 $$ trailing  ";
    expect(expandTemplateArguments("Do: $ARGUMENTS!", args, 1024)).toEqual({
      ok: true,
      text: `Do: ${args}!`,
    });
    expect(expandTemplateArguments("No substitution", "unused", 1024)).toEqual({
      ok: true,
      text: "No substitution",
    });
  });

  test("argument text containing shell syntax is only ever text", async () => {
    const dir = await temporaryDirectory();
    const marker = join(dir, "should-not-exist");
    const args = `!\`touch ${marker}\` and $(touch ${marker})`;
    const expanded = expandTemplateArguments("Review $ARGUMENTS", args, 4096);
    expect(expanded).toEqual({ ok: true, text: `Review ${args}` });
    // Detection runs on the original template, so the argument cannot create a span.
    expect(templateRequiresShell("Review $ARGUMENTS")).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("a template with executable spans is refused, never half-expanded", () => {
    expect(templateRequiresShell("Branch: !`git branch --show-current`")).toBe(true);
    expect(expandTemplateArguments("Branch: !`git status` $ARGUMENTS", "x", 4096)).toEqual({
      ok: false,
      message: SHELL_TEMPLATE_MESSAGE,
    });
  });

  test("the expanded size is bounded in UTF-8 bytes before the string is built", () => {
    const body = "$ARGUMENTS ".repeat(100);
    const outcome = expandTemplateArguments(body, "é".repeat(600), 100 * 1024);
    // 100 × 1,200 bytes of arguments: over 100 KiB although only 60,000 characters.
    expect(outcome.ok).toBe(false);
    expect(expandTemplateArguments("$ARGUMENTS", "é".repeat(10), 20)).toEqual({
      ok: true,
      text: "é".repeat(10),
    });
    expect(expandTemplateArguments("$ARGUMENTS", "é".repeat(11), 20).ok).toBe(false);
  });
});

describe("bounded template discovery", () => {
  test("walks nested Markdown prompts, applies metadata fallbacks, and skips unusable files", async () => {
    const { dir, roots } = await singleRoot();
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(
      join(dir, "nested", "review.md"),
      ["---", "short_description: Review a change", "arguments: <path>", "---", "Review."].join(
        "\n",
      ),
    );
    await writeFile(join(dir, "summary.MD"), "## Your Task\nSummarize this repository.");
    await writeFile(join(dir, "fallback.md"), "# Heading\n$ARGUMENTS");
    await writeFile(join(dir, "empty.md"), "");
    await writeFile(join(dir, "has space.md"), "Unaddressable");
    await writeFile(join(dir, "ignored.txt"), "ignored");

    const scan = await scanPromptTemplates(roots);
    expect(
      scan.effective
        .map((entry) => ({
          name: entry.name,
          description: entry.description,
          argumentHint: entry.argumentHint,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: "/fallback", description: "Run fallback prompt", argumentHint: undefined },
      { name: "/nested/review", description: "Review a change", argumentHint: "<path>" },
      { name: "/summary", description: "Summarize this repository.", argumentHint: undefined },
    ]);
    // Metadata only: no body is retained anywhere in the scan result.
    expect(JSON.stringify(scan)).not.toContain("Summarize this repository.\n");
    expect(scan.skipped).toBeGreaterThanOrEqual(1);
    expect(
      (await scanPromptTemplates([{ origin: "user", dir: join(dir, "missing") }])).effective,
    ).toEqual([]);
  });

  test("ids and revisions are derived from origin and relative path, never content", async () => {
    const { dir, roots } = await singleRoot("user");
    await writeFile(join(dir, "deploy.md"), "Deploy $ARGUMENTS");
    const [entry] = (await scanPromptTemplates(roots)).effective;
    expect(entry!.id).toBe(templateCommandId("user", "deploy.md"));
    expect(entry!.id.startsWith("codex-template:")).toBe(true);
    expect(entry!.id).not.toContain("deploy");
    expect(entry!.bindingRevision).toBe(templateBindingRevision("user", "deploy.md"));

    await writeFile(join(dir, "deploy.md"), "Deploy carefully $ARGUMENTS");
    const [edited] = (await scanPromptTemplates(roots)).effective;
    expect(edited!.bindingRevision).toBe(entry!.bindingRevision);
    expect(edited!.fingerprint).not.toBe(entry!.fingerprint);
  });

  test("project prompts shadow user prompts, and shadowed rows stay private", async () => {
    const cwd = await temporaryDirectory();
    const codexHome = await temporaryDirectory();
    const roots = templateRoots(cwd, codexHome);
    await mkdir(roots[0]!.dir, { recursive: true });
    await mkdir(roots[1]!.dir, { recursive: true });
    await writeFile(join(roots[0]!.dir, "shared.md"), "Project shared");
    await writeFile(join(roots[1]!.dir, "SHARED.md"), "User shared");
    await writeFile(join(roots[1]!.dir, "home-only.md"), "Home only");

    const scan = await scanPromptTemplates(roots);
    expect(scan.effective.map((entry) => [entry.name, entry.origin])).toEqual([
      ["/shared", "project"],
      ["/home-only", "user"],
    ]);
    expect(scan.shadowed.map((entry) => [entry.name, entry.origin])).toEqual([["/SHARED", "user"]]);
  });

  test("reserved names are listed under a non-colliding name as unavailable", async () => {
    const { dir, roots } = await singleRoot();
    for (const name of ["help", "Models", "steer", "compact", "skill:deploy"]) {
      await writeFile(join(dir, `${name}.md`), `Template ${name}`);
    }
    const scan = await scanPromptTemplates(roots);
    const byName = new Map(scan.effective.map((entry) => [entry.name, entry]));
    for (const name of ["/help", "/Models", "/steer", "/compact", "/skill:deploy"]) {
      const entry = byName.get(name)!;
      expect(entry.displayName).toBe(`/prompts:${name.slice(1)}`);
      expect(entry.problem).toMatchObject({ reason: "reserved-name" });
      expect(entry.problem!.message).toContain("Rename");
    }
  });

  test("shell and malformed templates are listed as unavailable with a reason", async () => {
    const { dir, roots } = await singleRoot();
    await writeFile(join(dir, "branch.md"), "Current branch: !`git branch --show-current`");
    await writeFile(join(dir, "broken.md"), "---\ndescription: never closed\nBody");
    const scan = await scanPromptTemplates(roots);
    const byName = new Map(scan.effective.map((entry) => [entry.name, entry]));
    expect(byName.get("/branch")!.problem).toEqual({
      reason: "requires-shell-execution",
      message: SHELL_TEMPLATE_MESSAGE,
    });
    expect(byName.get("/broken")!.problem).toMatchObject({ reason: "unsupported" });
  });

  test("oversized files are listed unavailable without reading their body", async () => {
    const { dir, roots } = await singleRoot();
    await writeFile(join(dir, "huge.md"), "x".repeat(2_048));
    await writeFile(join(dir, "small.md"), "small");
    const scan = await scanPromptTemplates(roots, { ...TEMPLATE_LIMITS, maxTemplateBytes: 1_024 });
    const huge = scan.effective.find((entry) => entry.name === "/huge")!;
    expect(huge.fingerprint).toBeNull();
    expect(huge.problem).toMatchObject({ reason: "unsupported" });
    expect(scan.truncated).toBe(true);
    expect((await loadTemplateBody(huge)).ok).toBe(false);
  });

  test("depth, entry count, template count and aggregate bytes are bounded deterministically", async () => {
    const { dir, roots } = await singleRoot();
    let deep = dir;
    for (let level = 1; level <= 4; level += 1) {
      deep = join(deep, `d${level}`);
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, `level${level}.md`), `Level ${level}`);
    }
    const depthLimited = await scanPromptTemplates(roots, { ...TEMPLATE_LIMITS, maxDepth: 2 });
    expect(depthLimited.effective.map((entry) => entry.name)).toEqual([
      "/d1/d2/level2",
      "/d1/level1",
    ]);
    expect(depthLimited.truncated).toBe(true);

    const flat = await temporaryDirectory();
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(flat, `t${String(index).padStart(2, "0")}.md`), "12345678");
    }
    const flatRoots = [{ origin: "project" as const, dir: flat }];
    const byCount = await scanPromptTemplates(flatRoots, { ...TEMPLATE_LIMITS, maxTemplates: 5 });
    expect(byCount.effective.map((entry) => entry.name)).toEqual([
      "/t00",
      "/t01",
      "/t02",
      "/t03",
      "/t04",
    ]);
    expect(byCount.truncated).toBe(true);
    const byEntries = await scanPromptTemplates(flatRoots, {
      ...TEMPLATE_LIMITS,
      maxVisitedEntries: 3,
    });
    expect(byEntries.effective).toHaveLength(3);
    expect(byEntries.truncated).toBe(true);
    const byBytes = await scanPromptTemplates(flatRoots, { ...TEMPLATE_LIMITS, maxScanBytes: 20 });
    expect(byBytes.effective).toHaveLength(2);
    expect(byBytes.truncated).toBe(true);
    // Same tree, same answer.
    expect(
      (await scanPromptTemplates(flatRoots, { ...TEMPLATE_LIMITS, maxScanBytes: 20 })).effective,
    ).toEqual(byBytes.effective);
  });

  test("directory symlinks are not followed; file symlinks are", async () => {
    const { dir, roots } = await singleRoot();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "escaped.md"), "Outside the root");
    await symlink(outside, join(dir, "linked-dir"));
    // A loop would recurse forever if directory links were followed.
    await symlink(dir, join(dir, "loop"));
    await symlink(join(outside, "escaped.md"), join(dir, "linked-file.md"));
    const scan = await scanPromptTemplates(roots);
    expect(scan.effective.map((entry) => entry.name)).toEqual(["/linked-file"]);
  });

  test("loading a body verifies the listed fingerprint and handles removal", async () => {
    const { dir, roots } = await singleRoot();
    await writeFile(join(dir, "fix.md"), "---\ndescription: Fix\n---\nFix $ARGUMENTS");
    const [entry] = (await scanPromptTemplates(roots)).effective;
    expect(await loadTemplateBody(entry!)).toEqual({ ok: true, body: "Fix $ARGUMENTS" });

    await writeFile(join(dir, "fix.md"), "Fix something else $ARGUMENTS");
    const changed = await loadTemplateBody(entry!);
    expect(changed.ok).toBe(false);
    expect(!changed.ok && changed.message).toContain("changed after it was listed");

    await rm(join(dir, "fix.md"));
    const removed = await loadTemplateBody(entry!);
    expect(!removed.ok && removed.message).toContain("no longer exists");
  });

  test("Unicode names and sizes are measured in bytes", async () => {
    const { dir, roots } = await singleRoot();
    // 300 three-byte characters: 900 bytes, over a 600-byte limit.
    await writeFile(join(dir, "wide.md"), "語".repeat(300));
    await writeFile(join(dir, "ünï.md"), "fine");
    const scan = await scanPromptTemplates(roots, { ...TEMPLATE_LIMITS, maxTemplateBytes: 600 });
    const byName = new Map(scan.effective.map((entry) => [entry.name, entry]));
    expect(byName.get("/wide")!.problem).toMatchObject({ reason: "unsupported" });
    expect(byName.get("/ünï")!.problem).toBeUndefined();
  });
});
