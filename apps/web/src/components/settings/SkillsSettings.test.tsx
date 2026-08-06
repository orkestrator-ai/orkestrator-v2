import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockToastError } from "../../../../../tests/mocks/sonner";

/**
 * `@/lib/native/backend` is mocked globally in tests/setup.ts with an invoke
 * that resolves undefined. This suite needs per-command payloads, so it installs
 * its own dispatching invoke and restores the setup.ts shape in afterAll —
 * `--parallel` isolates module registries per file, but the restore keeps a
 * sequential run honest too.
 */
const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let skillScans: Record<string, unknown> = {};
let skillFiles: Record<string, unknown> = {};
let failReadWith: string | null = null;
let failRevealWith: string | null = null;
let listOverride: ((provider: string) => Promise<unknown>) | null = null;
let readOverride: ((provider: string, filePath: string) => Promise<unknown>) | null = null;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args });
    if (command === "list_agent_skills") {
      if (listOverride) return listOverride(String(args?.provider));
      return Promise.resolve(skillScans[String(args?.provider)] ?? emptyScan(String(args?.provider)));
    }
    if (command === "read_agent_skill") {
      if (failReadWith) return Promise.reject(new Error(failReadWith));
      if (readOverride) return readOverride(String(args?.provider), String(args?.filePath));
      return Promise.resolve(
        skillFiles[String(args?.filePath)] ?? { path: args?.filePath, content: "", truncated: false },
      );
    }
    if (command === "reveal_in_file_manager" && failRevealWith) {
      return Promise.reject(new Error(failRevealWith));
    }
    return Promise.resolve();
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { SkillsSettings, stripFrontmatter } = await import("./SkillsSettings");

const clipboardDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
const writeText = mock(async (_text: string) => undefined);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("stripFrontmatter", () => {
  test("removes a YAML block that remark would otherwise render as a heading", () => {
    expect(stripFrontmatter("---\nname: a\ndescription: b\n---\n\n# Body"))
      .toBe("\n# Body");
  });

  test("leaves a document without frontmatter untouched", () => {
    expect(stripFrontmatter("# Body\n\n---\n\nA rule.")).toBe("# Body\n\n---\n\nA rule.");
  });

  test("does not eat a horizontal rule further down the document", () => {
    expect(stripFrontmatter("---\nname: a\n---\n\nOne\n\n---\n\nTwo"))
      .toBe("\nOne\n\n---\n\nTwo");
  });

  test("supports a BOM, CRLF line endings, and the YAML document-end marker", () => {
    expect(stripFrontmatter("﻿---\r\nname: a\r\n...\r\n# Body"))
      .toBe("# Body");
  });

  test("tolerates trailing whitespace on the opening fence", () => {
    // `--- ` is a thematic break and the closing `---` then makes the metadata a
    // setext H2 — the exact rendering this function exists to prevent.
    expect(stripFrontmatter("--- \nname: a\n---\n# Body")).toBe("# Body");
  });

  test("treats an empty block as frontmatter, as the backend parser does", () => {
    expect(stripFrontmatter("---\n---\n# Body")).toBe("# Body");
  });
});

function emptyScan(provider: string) {
  return { provider, roots: [], skills: [], errors: [] };
}

function skill(overrides: Record<string, unknown>) {
  return {
    id: String(overrides.filePath),
    name: "skill",
    description: "",
    filePath: "/home/me/.claude/skills/skill/SKILL.md",
    location: "~/.claude/skills/skill",
    scope: "user",
    shadowed: false,
    ...overrides,
  };
}

beforeEach(() => {
  invokeCalls.length = 0;
  failReadWith = null;
  failRevealWith = null;
  listOverride = null;
  readOverride = null;
  skillScans = {};
  skillFiles = {};
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  mockToastError.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  delete (navigator as unknown as Record<string, unknown>).clipboard;
  if (clipboardDescriptor) {
    Object.defineProperty(Navigator.prototype, "clipboard", clipboardDescriptor);
  }
});

/** Radix activates a tab from mousedown/focus, not from a bare click. */
function clickTab(name: string | RegExp) {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
}

/** The skill name also appears in the detail header, so list assertions scope here. */
function list() {
  return within(screen.getByRole("list", { name: "Skills" }));
}

/**
 * The visible list as one string. A failed matcher on a happy-dom node
 * serializes the entire tree, so list assertions compare text, not nodes.
 */
function listText() {
  return screen.queryByRole("list", { name: "Skills" })?.textContent ?? "";
}

/**
 * The list footer carries no role; it is the only leaf node reporting totals.
 * Reported as a plain string rather than through `expect`, because a failed
 * matcher on a happy-dom node serializes the whole tree.
 */
function footerText() {
  const nodes = Array.from(document.querySelectorAll("div")).filter((node) =>
    node.childElementCount === 0
    && /directories present|Scanning…|Scan failed/.test(node.textContent ?? ""));
  if (nodes.length !== 1) return `<${nodes.length} footer nodes>`;
  return nodes[0]!.textContent!.replace(/\s+/g, " ").trim();
}

describe("SkillsSettings", () => {
  test("lists the agent's skills with name and location, and renders the first one", async () => {
    skillScans.claude = {
      provider: "claude",
      roots: [{ path: "/home/me/.claude/skills", label: "~/.claude/skills", scope: "user", exists: true, skillCount: 2 }],
      skills: [
        skill({ name: "alpha", location: "~/.claude/skills/alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "zeta", location: "~/.agents/skills/zeta", filePath: "/z/SKILL.md", scope: "shared" }),
      ],
      errors: [],
    };
    skillFiles["/a/SKILL.md"] = { path: "/a/SKILL.md", content: "Alpha body paragraph", truncated: false };

    render(<SkillsSettings />);

    await waitFor(() => expect(list().getByText("alpha")).toBeTruthy());
    expect(list().getByText("~/.claude/skills/alpha")).toBeTruthy();
    expect(list().getByText("zeta")).toBeTruthy();
    expect(list().getByText("~/.agents/skills/zeta")).toBeTruthy();

    // The first skill is auto-selected so the detail pane is never blank.
    await waitFor(() => expect(screen.getByText("Alpha body paragraph")).toBeTruthy());
    expect(invokeCalls.some((call) =>
      call.command === "read_agent_skill" && call.args?.filePath === "/a/SKILL.md")).toBe(true);
  });

  test("selecting a skill loads that skill's markdown", async () => {
    skillScans.claude = {
      provider: "claude",
      roots: [],
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
      errors: [],
    };
    skillFiles["/a/SKILL.md"] = { path: "/a/SKILL.md", content: "Alpha body paragraph", truncated: false };
    skillFiles["/b/SKILL.md"] = { path: "/b/SKILL.md", content: "Beta body paragraph", truncated: false };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText("Alpha body paragraph")).toBeTruthy());
    fireEvent.click(list().getByText("beta"));
    await waitFor(() => expect(screen.getByText("Beta body paragraph")).toBeTruthy());
  });

  test("switching tabs scans that agent's skills", async () => {
    skillScans.claude = { ...emptyScan("claude"), skills: [skill({ name: "claude-only", filePath: "/c/SKILL.md" })] };
    skillScans.codex = { ...emptyScan("codex"), skills: [skill({ name: "codex-only", filePath: "/x/SKILL.md" })] };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("claude-only")).toBeTruthy());

    clickTab(/Codex/);

    await waitFor(() => expect(list().getByText("codex-only")).toBeTruthy());
    expect(list().queryByText("claude-only")).toBeNull();
    expect(invokeCalls.filter((call) => call.command === "list_agent_skills").map((call) => call.args?.provider))
      .toEqual(["claude", "codex"]);
  });

  test("the raw toggle shows the file source instead of rendered markdown", async () => {
    skillScans.claude = { ...emptyScan("claude"), skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })] };
    skillFiles["/a/SKILL.md"] = {
      path: "/a/SKILL.md",
      content: "# Alpha heading",
      truncated: false,
    };

    render(<SkillsSettings />);

    // Rendered: the "#" is consumed by the heading, so only the text survives.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alpha heading" })).toBeTruthy());
    expect(screen.queryByText("# Alpha heading")).toBeNull();

    clickTab("Raw");

    // Raw: the markdown source is shown verbatim, "#" and all.
    await waitFor(() => expect(screen.getByText("# Alpha heading")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Alpha heading" })).toBeNull();
  });

  test("filters the list by name, location, and description, then shows no-match state", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      // The needles below are chosen so each one can only match through a single
      // field: "alph" is name-only, "agents" location-only, "deploy"
      // description-only.
      skills: [
        skill({
          name: "alpha",
          description: "Deploy the application",
          location: "~/.claude/skills/one",
          filePath: "/a/SKILL.md",
        }),
        skill({
          name: "beta",
          description: "Runs the tests",
          location: "~/.agents/skills/two",
          filePath: "/b/SKILL.md",
        }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "alph" } });
    await waitFor(() => expect(listText()).not.toContain("beta"));
    expect(listText()).toContain("alpha");

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "agents" } });
    await waitFor(() => expect(listText()).not.toContain("alpha"));
    expect(listText()).toContain("beta");

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "deploy" } });
    await waitFor(() => expect(listText()).not.toContain("beta"));
    expect(listText()).toContain("alpha");

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "missing" } });
    await waitFor(() => expect(screen.getByText("No skills match this filter.")).toBeTruthy());
  });

  test("keeps the input responsive while the list waits for typing to pause", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());

    const input = screen.getByLabelText("Filter skills") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });

    // The value lands immediately; the list is still the unfiltered one.
    expect(input.value).toBe("alpha");
    expect(listText()).toContain("beta");

    await waitFor(() => expect(listText()).not.toContain("beta"));
  });

  test("renders personal, managed, shared, built-in, and plugin labels", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "personal-skill", filePath: "/personal/SKILL.md", scope: "user" }),
        skill({ name: "managed-skill", filePath: "/managed/SKILL.md", scope: "admin" }),
        skill({ name: "shared-skill", filePath: "/shared/SKILL.md", scope: "shared" }),
        skill({ name: "system-skill", filePath: "/system/SKILL.md", scope: "system" }),
        skill({ name: "plugin-skill", filePath: "/plugin/SKILL.md", scope: "plugin", plugin: "tools" }),
      ],
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());
    for (const [name, label] of [
      ["managed-skill", "Managed"],
      ["shared-skill", "Shared"],
      ["system-skill", "Built-in"],
      ["plugin-skill", "Plugin · tools"],
    ] as const) {
      fireEvent.click(list().getByText(name));
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
    }
  });

  test("marks a shadowed skill so the user knows it is not the one that loads", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "dup", filePath: "/d/SKILL.md", shadowed: true })],
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(list().getByText("Shadowed")).toBeTruthy());
  });

  test("surfaces a scan failure rather than showing an empty list", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      errors: [{ path: "~/.claude/skills", message: "EACCES: permission denied" }],
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText(/EACCES: permission denied/)).toBeTruthy());
  });

  test("surfaces a rejected list request", async () => {
    listOverride = async () => {
      throw new Error("bridge unavailable");
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText("bridge unavailable")).toBeTruthy());
    expect(screen.queryByRole("list", { name: "Skills" })).toBeNull();
  });

  test("surfaces a read failure in the detail pane", async () => {
    skillScans.claude = { ...emptyScan("claude"), skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })] };
    failReadWith = "Refusing to read a file outside the agent skill directories";

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText(/Refusing to read a file/)).toBeTruthy());
  });

  test("shows an empty state when the agent has no skills anywhere", async () => {
    render(<SkillsSettings />);

    await waitFor(() =>
      expect(screen.getByText(/No skills found in any of this agent's skill directories/)).toBeTruthy());
    expect(screen.getByText("Select a skill to read its SKILL.md.")).toBeTruthy();
  });

  test("rescans and reloads a selected file even when its path is unchanged", async () => {
    const scan = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };
    let readCount = 0;
    listOverride = async () => scan;
    readOverride = async (_provider, filePath) => ({
      path: filePath,
      content: ++readCount === 1 ? "Old body" : "Fresh body",
      truncated: false,
    });

    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Old body")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Rescan skill directories" }));

    await waitFor(() => expect(screen.getByText("Fresh body")).toBeTruthy());
    expect(invokeCalls.filter((call) => call.command === "list_agent_skills")).toHaveLength(2);
    expect(invokeCalls.filter((call) => call.command === "read_agent_skill")).toHaveLength(2);
  });

  test("keeps the previous scan visible and reports a refresh rejection", async () => {
    const scan = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };
    let scanCount = 0;
    listOverride = async () => {
      if (++scanCount === 1) return scan;
      throw new Error("rescan unavailable");
    };
    skillFiles["/a/SKILL.md"] = {
      path: "/a/SKILL.md",
      content: "Existing body",
      truncated: false,
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText("Existing body")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Rescan skill directories" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("rescan unavailable"));
    expect(list().getByText("alpha")).toBeTruthy();
    expect(screen.getByText("Existing body")).toBeTruthy();
  });

  test("ignores an older scan response after revisiting a provider", async () => {
    const oldScan = deferred<unknown>();
    const freshScan = deferred<unknown>();
    let claudeCalls = 0;
    listOverride = (target) => {
      if (target === "codex") return Promise.resolve(emptyScan("codex"));
      return ++claudeCalls === 1 ? oldScan.promise : freshScan.promise;
    };

    render(<SkillsSettings />);
    clickTab(/Codex/);
    await waitFor(() => expect(screen.getByText(/No skills found/)).toBeTruthy());
    clickTab(/Claude/);

    await act(async () => {
      freshScan.resolve({
        ...emptyScan("claude"),
        skills: [skill({ name: "fresh", filePath: "/fresh/SKILL.md" })],
      });
    });
    await waitFor(() => expect(list().getByText("fresh")).toBeTruthy());

    await act(async () => {
      oldScan.resolve({
        ...emptyScan("claude"),
        skills: [skill({ name: "stale", filePath: "/stale/SKILL.md" })],
      });
    });
    expect(list().getByText("fresh")).toBeTruthy();
    expect(list().queryByText("stale")).toBeNull();
  });

  test("ignores an older file response after selecting another skill", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
    };
    const alphaFile = deferred<unknown>();
    const betaFile = deferred<unknown>();
    readOverride = (_provider, path) => path === "/a/SKILL.md" ? alphaFile.promise : betaFile.promise;

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());
    fireEvent.click(list().getByText("beta"));

    await act(async () => {
      betaFile.resolve({ path: "/b/SKILL.md", content: "Beta body", truncated: false });
    });
    await waitFor(() => expect(screen.getByText("Beta body")).toBeTruthy());

    await act(async () => {
      alphaFile.resolve({ path: "/a/SKILL.md", content: "Stale alpha body", truncated: false });
    });
    expect(screen.getByText("Beta body")).toBeTruthy();
    expect(screen.queryByText("Stale alpha body")).toBeNull();
  });

  test("warns when the displayed skill file was truncated", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };
    skillFiles["/a/SKILL.md"] = {
      path: "/a/SKILL.md",
      content: "Partial body",
      truncated: true,
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText(/truncated for display/)).toBeTruthy());
  });

  test("copies the selected path and reports clipboard failures", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };

    render(<SkillsSettings />);
    const copyButton = await screen.findByRole("button", { name: "Copy skill path" });
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/a/SKILL.md"));
    expect(screen.getByRole("button", { name: "Skill path copied" })).toBeTruthy();
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Copy skill path" })).toBeTruthy(),
      { timeout: 2_000 },
    );

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Copy skill path" }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Could not copy the path to the clipboard",
    ));
  });

  test("reveals the selected path and reports reveal failures", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };

    render(<SkillsSettings />);
    const revealButton = await screen.findByRole("button", { name: "Reveal skill in file manager" });
    fireEvent.click(revealButton);
    await waitFor(() => expect(invokeCalls.some((call) =>
      call.command === "reveal_in_file_manager" && call.args?.path === "/a/SKILL.md")).toBe(true));

    failRevealWith = "file manager unavailable";
    fireEvent.click(revealButton);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      "Could not reveal the skill in the file manager",
    ));
  });

  test("remembers a selection per provider across tab switches", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "zeta", filePath: "/z/SKILL.md" }),
      ],
    };
    skillScans.codex = {
      ...emptyScan("codex"),
      skills: [
        skill({ name: "codex-first", filePath: "/x/SKILL.md" }),
        skill({ name: "codex-second", filePath: "/y/SKILL.md" }),
      ],
    };
    skillFiles["/a/SKILL.md"] = { path: "/a/SKILL.md", content: "Alpha body", truncated: false };
    skillFiles["/z/SKILL.md"] = { path: "/z/SKILL.md", content: "Zeta body", truncated: false };
    skillFiles["/y/SKILL.md"] = { path: "/y/SKILL.md", content: "Codex second body", truncated: false };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("zeta")).toBeTruthy());
    fireEvent.click(list().getByText("zeta"));
    await waitFor(() => expect(screen.getByText("Zeta body")).toBeTruthy());

    // Selecting in the second tab too: one shared selection would lose Claude's.
    clickTab(/Codex/);
    await waitFor(() => expect(list().getByText("codex-second")).toBeTruthy());
    fireEvent.click(list().getByText("codex-second"));
    await waitFor(() => expect(screen.getByText("Codex second body")).toBeTruthy());

    clickTab(/Claude/);

    // Not the first skill: a lost selection would fall back to alpha.
    await waitFor(() => expect(screen.getByText("Zeta body")).toBeTruthy());
    expect(screen.queryByText("Alpha body")).toBeNull();
  });

  test("marks the selected list entry and shows its description in the detail header", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", description: "Runs the deploy", filePath: "/b/SKILL.md" }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());

    const entries = list().getAllByRole("button");
    expect(entries[0]!.getAttribute("aria-current")).toBe("true");
    expect(entries[1]!.getAttribute("aria-current")).toBeNull();

    fireEvent.click(list().getByText("beta"));

    await waitFor(() => expect(list().getAllByRole("button")[1]!.getAttribute("aria-current"))
      .toBe("true"));
    expect(list().getAllByRole("button")[0]!.getAttribute("aria-current")).toBeNull();
    // Rendered mode strips the frontmatter, so the header is the only place the
    // description survives.
    expect(screen.getByText("Runs the deploy")).toBeTruthy();
  });

  test("keeps an explicit selection when a filter excludes it, without re-reading", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
    };
    skillFiles["/a/SKILL.md"] = { path: "/a/SKILL.md", content: "Alpha body", truncated: false };
    skillFiles["/b/SKILL.md"] = { path: "/b/SKILL.md", content: "Beta body", truncated: false };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());
    fireEvent.click(list().getByText("beta"));
    await waitFor(() => expect(screen.getByText("Beta body")).toBeTruthy());
    const readsBeforeFilter = invokeCalls.filter((call) => call.command === "read_agent_skill").length;

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "alpha" } });
    await waitFor(() => expect(listText()).not.toContain("beta"));

    expect(screen.getByText("Beta body")).toBeTruthy();
    expect(screen.queryByText("Alpha body")).toBeNull();
    expect(invokeCalls.filter((call) => call.command === "read_agent_skill"))
      .toHaveLength(readsBeforeFilter);
  });

  test("hides frontmatter from the rendered view but keeps it in raw mode", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", description: "", filePath: "/a/SKILL.md" })],
    };
    skillFiles["/a/SKILL.md"] = {
      path: "/a/SKILL.md",
      content: "---\nname: alpha\ndescription: metadata only\n---\n\n# Alpha heading\n",
      truncated: false,
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Alpha heading" })).toBeTruthy());
    expect(screen.queryByText(/description: metadata only/)).toBeNull();

    clickTab("Raw");

    await waitFor(() => expect(screen.getByText(/description: metadata only/)).toBeTruthy());
  });

  test("blocks remote images in a skill document but renders local ones", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };
    skillFiles["/a/SKILL.md"] = {
      path: "/a/SKILL.md",
      content: "![Tracker](https://attacker.example/px.png)\n\n![Diagram](./diagram.png)\n",
      truncated: false,
    };

    const { container } = render(<SkillsSettings />);

    // A skill can come from a plugin or marketplace, so fetching a remote image
    // would leak the viewer's IP and the fact that they opened this skill.
    await waitFor(() => expect(screen.getByText(/remote image blocked/)).toBeTruthy());
    expect(container.querySelector('img[src="https://attacker.example/px.png"]')).toBeNull();
    expect(screen.getByText(/Tracker/)).toBeTruthy();
    expect(screen.getByAltText("Diagram").getAttribute("src")).toBe("./diagram.png");
  });

  test("retries a failed skill read on demand", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
    };
    let reads = 0;
    readOverride = async (_provider, filePath) => {
      if (++reads === 1) throw new Error("EACCES: permission denied");
      return { path: filePath, content: "Recovered body", truncated: false };
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText(/EACCES: permission denied/)).toBeTruthy());

    // Re-selecting the same skill changes nothing the read effect watches, so
    // this button is the only recovery.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("Recovered body")).toBeTruthy());
    expect(screen.queryByText(/EACCES: permission denied/)).toBeNull();
  });

  test("drops a pending copy confirmation when the selection changes", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Copy skill path" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Skill path copied" })).toBeTruthy());

    // Well inside the 1.5s confirmation window: the button belongs to the pane,
    // not to the skill that was copied.
    fireEvent.click(list().getByText("beta"));

    expect(screen.getByRole("button", { name: "Copy skill path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skill path copied" })).toBeNull();
  });

  test("reports scan progress and failure in the footer instead of zero counts", async () => {
    const pending = deferred<unknown>();
    listOverride = () => pending.promise;

    render(<SkillsSettings />);

    // Before the first scan lands there is nothing to count, and "0 skills · 0
    // of 0 directories present" would read as a definitive answer.
    await waitFor(() => expect(footerText()).toBe("Scanning…"));
    expect(screen.getByRole("button", { name: "Rescan skill directories" })
      .hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("list", { name: "Skills" })).toBeNull();
    expect(screen.queryByText(/No skills found/)).toBeNull();

    await act(async () => {
      pending.resolve({
        ...emptyScan("claude"),
        roots: [
          { path: "/present", label: "~/present", scope: "user", exists: true, skillCount: 1 },
          { path: "/missing", label: "~/missing", scope: "shared", exists: false, skillCount: 0 },
        ],
        skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })],
      });
    });

    await waitFor(() => expect(footerText()).toBe("1 skill · 1 of 2 directories present"));
    expect(screen.getByRole("button", { name: "Rescan skill directories" })
      .hasAttribute("disabled")).toBe(false);
  });

  test("says so in the footer when the first scan fails", async () => {
    listOverride = async () => {
      throw new Error("bridge unavailable");
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(footerText()).toBe("Scan failed"));
  });

  test("counts the filtered subset against the scanned total while filtering", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      roots: [{ path: "/present", label: "~/present", scope: "user", exists: true, skillCount: 2 }],
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(footerText()).toBe("2 skills · 1 of 1 directories present"));

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "alpha" } });

    // The list is filtered, so an unqualified total next to it would be a lie.
    await waitFor(() => expect(footerText()).toBe("1 of 2 skills · 1 of 1 directories present"));
  });
});
