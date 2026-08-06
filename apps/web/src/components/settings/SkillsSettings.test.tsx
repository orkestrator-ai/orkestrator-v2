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
      skills: [
        skill({
          name: "alpha",
          description: "Deploy the application",
          location: "~/.claude/skills/alpha",
          filePath: "/a/SKILL.md",
        }),
        skill({ name: "beta", location: "~/.agents/skills/beta", filePath: "/b/SKILL.md" }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "agents" } });

    expect(list().queryByText("alpha")).toBeNull();
    expect(list().getByText("beta")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "deploy" } });
    await waitFor(() => expect(list().getByText("alpha")).toBeTruthy());
    expect(list().queryByText("beta")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "missing" } });
    await waitFor(() => expect(screen.getByText("No skills match this filter.")).toBeTruthy());
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

  test("uses a stacked mobile layout and switches to side-by-side panes at md", async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByText(/No skills found/)).toBeTruthy());

    expect(screen.getByTestId("skills-panes").className)
      .toContain("flex-col");
    expect(screen.getByTestId("skills-panes").className)
      .toContain("md:flex-row");
    expect(screen.getByTestId("skills-list-pane").className)
      .toContain("w-full");
    expect(screen.getByTestId("skills-list-pane").className)
      .toContain("md:w-[17rem]");
  });
});
