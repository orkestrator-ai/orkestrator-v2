import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isExternalLink,
  linesOutsideFences,
  relativeLinkProblem,
} from "../../helpers/markdown-links";

/**
 * Agent instructions, READMEs and the living docs they route agents to must not
 * point at files that no longer exist (root `AGENTS.md`, "Keep references
 * current"). Changes that retired to-dos and plans repeatedly left these files
 * naming the deleted ones, because a ticket barred edits to them; this makes
 * the stale reference a test failure in the change that creates it.
 */

// `git ls-files` is a real subprocess; give it room under aggregate load.
setDefaultTimeout(30_000);

const root = path.resolve(import.meta.dir, "../../..");

/** Agent instruction files and READMEs, wherever they are. */
const INSTRUCTION_FILE = /(^|\/)(AGENTS|CLAUDE|README)\.md$/;
/** Living docs that `AGENTS.md` sends agents to read before changing an area. */
const LIVING_DOC = /^docs\/(architecture|development)\/[^/]+\.md$/;

/** An inline Markdown link or image: `[text](target)` or `[text](<target> "title")`. */
const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;

/**
 * A repository path to a Markdown file written out in prose or code, such as
 * `docs/todo/<area>/NNNN-name.md`. The lookbehind skips a path that is part of
 * a longer one, a URL, or a `git show <commit>:<path>` citation of a retired
 * file, which names it at a commit where it still exists.
 */
const REPOSITORY_MARKDOWN_PATH =
  /(?<![\w./@:~$-])((?:apps|bridges|docker|docs|e2e|packages|plans|scripts|tests)\/[\w./-]+\.md)(?![\w/-])/g;
/** Template paths name no real file. */
const PLACEHOLDER = /NNNN/;

interface ReferenceProblem {
  file: string;
  reference: string;
  problem: string;
}

/**
 * The relative Markdown links in `file` (relative to `repositoryRoot`) that do
 * not resolve. Links in code spans and fences are examples, not links; external
 * URLs and absolute paths are not checked. A repeated heading's bare anchor is
 * accepted: it lands on the first, which is what the writer usually meant.
 */
function brokenMarkdownLinks(repositoryRoot: string, file: string): ReferenceProblem[] {
  const absolute = path.join(repositoryRoot, file);
  const prose = linesOutsideFences(readFileSync(absolute, "utf8"))
    .join("\n")
    .replace(CODE_SPAN, "");
  const problems: ReferenceProblem[] = [];
  for (const match of prose.matchAll(MARKDOWN_LINK)) {
    const link = match[1]!;
    if (isExternalLink(link) || link.startsWith("/")) continue;
    const problem = relativeLinkProblem(absolute, link, { allowRepeatedAnchors: true });
    if (problem) problems.push({ file, reference: link, problem });
  }
  return problems;
}

/**
 * The repository Markdown paths `file` names, in prose or in code spans, that
 * exist neither from the repository root nor from the file's own directory.
 * Fenced blocks are skipped: they hold commands and sample output.
 */
function missingMarkdownPaths(repositoryRoot: string, file: string): ReferenceProblem[] {
  const text = linesOutsideFences(readFileSync(path.join(repositoryRoot, file), "utf8")).join("\n");
  const problems: ReferenceProblem[] = [];
  for (const match of text.matchAll(REPOSITORY_MARKDOWN_PATH)) {
    const named = match[1]!;
    if (PLACEHOLDER.test(named)) continue;
    if (existsSync(path.join(repositoryRoot, named))) continue;
    if (existsSync(path.join(repositoryRoot, path.dirname(file), named))) continue;
    problems.push({ file, reference: named, problem: "no such file" });
  }
  return problems;
}

function trackedMarkdownFiles(): string[] {
  const listing = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"], { cwd: root });
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  return (
    listing.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      // A file deleted in the working tree but not yet staged is not content.
      .filter((file) => existsSync(path.join(root, file)))
  );
}

function render(problems: ReferenceProblem[]): string[] {
  return problems.map(({ file, reference, problem }) => `${file}: ${reference} (${problem})`);
}

describe("references in agent instructions and living docs", () => {
  const tracked = trackedMarkdownFiles();
  const instructionFiles = tracked.filter((file) => INSTRUCTION_FILE.test(file));
  const livingDocs = tracked.filter((file) => LIVING_DOC.test(file));

  test("finds the files it checks", () => {
    expect(instructionFiles).toContain("AGENTS.md");
    expect(instructionFiles).toContain("docs/README.md");
    expect(livingDocs).toContain("docs/architecture/goals.md");
  });

  test("every relative link in AGENTS.md, CLAUDE.md, READMEs and living docs resolves", () => {
    const problems = [...instructionFiles, ...livingDocs].flatMap((file) =>
      brokenMarkdownLinks(root, file),
    );
    expect(render(problems)).toEqual([]);
  });

  test("every repository Markdown path AGENTS.md, CLAUDE.md and READMEs name exists", () => {
    const problems = instructionFiles.flatMap((file) => missingMarkdownPaths(root, file));
    expect(render(problems)).toEqual([]);
  });
});

describe("reference scanners", () => {
  const fixtures: string[] = [];
  afterEach(() => {
    for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), "instruction-links-"));
    fixtures.push(directory);
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), body);
    }
    return directory;
  }

  test("reports a link to a deleted file and an anchor no heading has", () => {
    const repository = fixture({
      "docs/guide.md": "# Guide\n\n## Steps\n",
      "AGENTS.md": [
        "See [the guide](docs/guide.md#steps) and [the old to-do](docs/todo/0241-gone.md).",
        "Also [a renamed section](docs/guide.md#old-steps).",
        "",
      ].join("\n"),
    });
    expect(render(brokenMarkdownLinks(repository, "AGENTS.md"))).toEqual([
      "AGENTS.md: docs/todo/0241-gone.md (the target does not exist)",
      "AGENTS.md: docs/guide.md#old-steps (no heading has this anchor)",
    ]);
  });

  test("ignores external, absolute and example links", () => {
    const repository = fixture({
      "README.md": [
        "[site](https://example.com/missing.md) and ![shot](/abs/path/shot.png)",
        "Write `[label](missing.md)` in a code span.",
        "```md",
        "[label](also-missing.md)",
        "```",
        "",
      ].join("\n"),
    });
    expect(brokenMarkdownLinks(repository, "README.md")).toEqual([]);
  });

  test("accepts the bare anchor of a repeated heading", () => {
    const repository = fixture({
      "docs/list.md": "# List\n\n## Area\n\n## Area\n",
      "README.md": "[first area](docs/list.md#area)\n",
    });
    expect(brokenMarkdownLinks(repository, "README.md")).toEqual([]);
  });

  test("reports a named Markdown path that no longer exists", () => {
    const repository = fixture({
      "docs/todo/7500-live.md": "# Live\n",
      "AGENTS.md": [
        "- When unsure, copy the layout of docs/todo/0241-gone.md.",
        "- Or `docs/todo/7500-live.md`, which is live.",
        "",
      ].join("\n"),
    });
    expect(render(missingMarkdownPaths(repository, "AGENTS.md"))).toEqual([
      "AGENTS.md: docs/todo/0241-gone.md (no such file)",
    ]);
  });

  test("accepts retired-file citations, placeholders and paths relative to the file", () => {
    const repository = fixture({
      "bridges/demo/tests/notes.md": "# Notes\n",
      "bridges/demo/AGENTS.md": [
        "Read it with `git show 53340356c:docs/todo/0241-gone.md`.",
        "A new file is `docs/todo/NNNN-name.md`.",
        "Local notes: tests/notes.md.",
        "```bash",
        "cat docs/never-there.md",
        "```",
        "",
      ].join("\n"),
    });
    expect(missingMarkdownPaths(repository, "bridges/demo/AGENTS.md")).toEqual([]);
  });
});
