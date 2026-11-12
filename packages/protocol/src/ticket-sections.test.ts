import { describe, expect, test } from "bun:test";
import { autoPipelineDraftPrompt } from "./auto-pipeline.js";
import {
  FEATURE_PLANNER_SYSTEM_PROMPT,
  FEATURE_PLANNER_TOOL_SYSTEM_PROMPT,
} from "./feature-planning.js";
import { PUBLIC_ACTION_INPUTS } from "./public-api-inputs.js";
import {
  ACCEPTANCE_CRITERIA_RULE,
  TICKET_SECTIONS_GUIDANCE,
  DELIVERY_POLICY_LABELS,
  deliveryPolicyChoices,
  effectiveDeliveryPolicy,
  applyTicketContentUpdate,
  canonicalTicketSections,
  normalizeTicketContent,
  parseAcceptanceCriteriaText,
  parseListItems,
  parseTicketMarkdown,
  parseTicketSectionsPatch,
  renderTicketMarkdown,
  sectionsFromTicketText,
  ticketContentFromSections,
  ticketMarkdownTemplate,
  ticketSectionsBasis,
  criterionCheckBasis,
  isAcceptanceCriterionCheck,
  isTicketSections,
  manualCheck,
  ticketCriteriaSummary,
  type AcceptanceCriterionCheck,
  type TicketSections,
} from "./ticket-sections";

const NOW = "2026-10-28T12:00:00.000Z";

const FULL: TicketSections = {
  summary: "Ship structured tickets.\n\nKeep the old text readable.",
  problem: "Tickets are one long blob.",
  context: "See `docs/research/ticket-schema`.\n\n### Evidence\n\n- 60% of kanban tickets have ACs",
  decisions: "Two kinds: feature ticket and work brief.",
  constraints: "Keep backward compatibility.",
  acceptanceCriteria: [
    { id: "ac-1", text: "Old tickets open unchanged." },
    { id: "ac-2", text: "Verify ticks each criterion.\nWith evidence on a second line." },
  ],
  checks: ["mise run format:check", "mise run lint"],
  delivery: { policy: "push-no-pr", note: "Mail the coordinator when pushed." },
  reporting: "Add a Decisions section.",
  outOfScope: "Steer messages.",
  custom: [{ title: "Rollout", body: "Behind no flag." }],
  notes: "```md\n## Not a heading\n```",
};

describe("ticket markdown round trip", () => {
  test.each(["Porting to C#", "Multiple##", "A # B#"])(
    "preserves hashes in heading %s",
    (title) => {
      const sections = parseTicketMarkdown(`## ${title}\n\nBody`);
      expect(sections.custom).toEqual([{ title, body: "Body" }]);
      expect(parseTicketMarkdown(renderTicketMarkdown(sections))).toEqual(sections);
      expect(parseTicketMarkdown(`## ${title} ###\n\nBody`)).toEqual(sections);
    },
  );

  test("sections → markdown → sections is the identity", () => {
    const markdown = renderTicketMarkdown(FULL);
    expect(parseTicketMarkdown(markdown, { previousCriteria: FULL.acceptanceCriteria })).toEqual(
      FULL,
    );
  });

  test("canonical markdown → sections → markdown is byte-identical", () => {
    const markdown = renderTicketMarkdown(FULL);
    expect(renderTicketMarkdown(parseTicketMarkdown(markdown))).toBe(markdown);
  });

  test("renders headings in a fixed order with the summary first and unheaded", () => {
    const markdown = renderTicketMarkdown(FULL);
    expect(markdown.startsWith("Ship structured tickets.")).toBe(true);
    // The last match is inside the notes' code fence, which this regex cannot see.
    const headings = markdown.match(/^## .+$/gm)?.slice(0, -1);
    expect(headings).toEqual([
      "## Problem",
      "## Context",
      "## Decisions",
      "## Constraints",
      "## Acceptance criteria",
      "## Checks",
      "## Delivery",
      "## Reporting",
      "## Out of scope",
      "## Rollout",
      "## Notes",
    ]);
  });

  test("unknown headings and freeform text survive", () => {
    const markdown = [
      "Intro paragraph.",
      "",
      "## Weird Heading!",
      "",
      "Keep me.",
      "",
      "## Background",
      "",
      "Aliased to context.",
      "",
      "## Empty custom",
    ].join("\n");
    const sections = parseTicketMarkdown(markdown);
    expect(sections).toEqual({
      summary: "Intro paragraph.",
      context: "Aliased to context.",
      custom: [
        { title: "Weird Heading!", body: "Keep me." },
        { title: "Empty custom", body: "" },
      ],
    });
    const again = parseTicketMarkdown(renderTicketMarkdown(sections));
    expect(again).toEqual(sections);
  });

  test("headings inside code fences and deeper headings stay in their section", () => {
    const markdown = "## Context\n\n```\n## Problem\n```\n\n### Sub\n\ntext";
    expect(parseTicketMarkdown(markdown)).toEqual({
      context: "```\n## Problem\n```\n\n### Sub\n\ntext",
    });
  });

  test("repeated known headings are joined, not dropped", () => {
    expect(parseTicketMarkdown("## Problem\n\nA\n\n## Problem\n\nB")).toEqual({
      problem: "A\n\nB",
    });
  });

  test("a description with no headings is the summary, verbatim", () => {
    const text = "Implement docs/todo/0700-x.md in full.\n**Problem:** bold lead-in stays.";
    expect(parseTicketMarkdown(text)).toEqual({ summary: text });
  });

  test("CRLF input parses like LF", () => {
    expect(parseTicketMarkdown("Intro\r\n\r\n## Problem\r\n\r\nBad")).toEqual({
      summary: "Intro",
      problem: "Bad",
    });
  });

  test("delivery policy line is parsed; an unknown policy stays as note text", () => {
    expect(parseTicketMarkdown("## Delivery\n\nPolicy: open-pr\n\nDon't merge.")).toEqual({
      delivery: { policy: "open-pr", note: "Don't merge." },
    });
    expect(parseTicketMarkdown("## Delivery\n\nPolicy: Commit, don't push")).toEqual({
      delivery: { policy: "commit-only" },
    });
    expect(parseTicketMarkdown("## Delivery\n\nPolicy: Push, no PR")).toEqual({
      delivery: { policy: "push-no-pr" },
    });
    // The label's earlier wording, which a ticket may still hold as text.
    expect(parseTicketMarkdown("## Delivery\n\nPolicy: Push, no PR (Multi Review next)")).toEqual({
      delivery: { policy: "push-no-pr" },
    });
    expect(parseTicketMarkdown("## Delivery\n\nPolicy: yolo")).toEqual({
      delivery: { note: "Policy: yolo" },
    });
  });

  test("canonical sections are a fixed point", () => {
    const messy: TicketSections = {
      summary: "  \nIntro\n\n## Problem\n\nSmuggled heading\n",
      acceptanceCriteria: [{ id: "ac-4", text: "One" }],
    };
    const canonical = canonicalTicketSections(messy);
    expect(canonical).toEqual({
      summary: "Intro",
      problem: "Smuggled heading",
      acceptanceCriteria: [{ id: "ac-4", text: "One" }],
    });
    expect(canonicalTicketSections(canonical)).toEqual(canonical);
  });
});

describe("acceptance criteria lists", () => {
  test("parses bullets, numbers, checkboxes and continuation lines", () => {
    expect(
      parseListItems("- one\n* two\n  more two\n1. three\n- [x] four\n- [ ] five\n  - nested"),
    ).toEqual([
      { text: "one", ticked: false },
      { text: "two\nmore two", ticked: false },
      { text: "three", ticked: false },
      { text: "four", ticked: true },
      { text: "five\n- nested", ticked: false },
    ]);
  });

  test("text with no list markers becomes one item per paragraph", () => {
    expect(
      parseListItems("Given a ticket\nWhen Verify runs\nThen it ticks.\n\nSecond one."),
    ).toEqual([
      { text: "Given a ticket\nWhen Verify runs\nThen it ticks.", ticked: false },
      { text: "Second one.", ticked: false },
    ]);
  });

  test("a preface before the first item is kept as an item", () => {
    expect(parseListItems("All of these:\n- a").map((item) => item.text)).toEqual([
      "All of these:",
      "a",
    ]);
  });

  test("unchanged items keep id and check; edited items get a new id and no check", () => {
    const previous = [
      {
        id: "ac-1",
        text: "Keeps",
        check: {
          status: "passed" as const,
          evidence: "bun test x",
          checkedAt: NOW,
          source: "verify" as const,
        },
      },
      {
        id: "ac-2",
        text: "Will change",
        check: {
          status: "failed" as const,
          evidence: "no",
          checkedAt: NOW,
          source: "verify" as const,
        },
      },
    ];
    const items = parseAcceptanceCriteriaText("- Changed\n- Keeps", {
      previousCriteria: previous,
      now: NOW,
    });
    expect(items).toEqual([{ id: "ac-3", text: "Changed" }, previous[0]!]);
  });

  test("a hand-ticked box records a manual pass; unticking does not clear a Verify result", () => {
    const [ticked] = parseAcceptanceCriteriaText("- [x] Done by hand", { now: NOW });
    expect(ticked!.check).toEqual({
      status: "passed",
      evidence: "Ticked by hand in the ticket text.",
      checkedAt: NOW,
      source: "manual",
    });
    const failed = {
      id: "ac-1",
      text: "Still failed",
      check: {
        status: "failed" as const,
        evidence: "x",
        checkedAt: NOW,
        source: "verify" as const,
      },
    };
    expect(
      parseAcceptanceCriteriaText("- [ ] Still failed", { previousCriteria: [failed] }),
    ).toEqual([failed]);
  });

  test("parsed text keeps every criterion, beyond the tool limit too", () => {
    const text = Array.from({ length: 120 }, (_, index) => `- Criterion ${index + 1}`).join("\n");
    const items = parseAcceptanceCriteriaText(text);
    expect(items).toHaveLength(120);
    expect(items.at(-1)).toEqual({ id: "ac-120", text: "Criterion 120" });
  });

  test("results never appear in markdown", () => {
    const markdown = renderTicketMarkdown({
      acceptanceCriteria: [
        {
          id: "ac-1",
          text: "Passed one",
          check: { status: "passed", evidence: "e", checkedAt: NOW, source: "verify" },
        },
      ],
    });
    expect(markdown).toBe("## Acceptance criteria\n\n- Passed one");
  });
});

describe("ticket content and migration", () => {
  test("a legacy ticket gets sections without its text being rewritten", () => {
    const legacy = {
      description: "Fix the login redirect.\n\n## Out of scope\n\nSSO.",
      acceptanceCriteria: "- Redirects to /home\n- [x] Has a test",
    };
    const content = normalizeTicketContent(legacy, { now: NOW });
    expect(content.kind).toBe("feature");
    expect(content.description).toBe(legacy.description);
    expect(content.acceptanceCriteria).toBe(legacy.acceptanceCriteria);
    expect(content.sections).toEqual({
      summary: "Fix the login redirect.",
      outOfScope: "SSO.",
      acceptanceCriteria: [
        { id: "ac-1", text: "Redirects to /home" },
        {
          id: "ac-2",
          text: "Has a test",
          check: {
            status: "passed",
            evidence: "Ticked by hand in the ticket text.",
            checkedAt: NOW,
            source: "manual",
          },
        },
      ],
    });
    expect(content.sectionsBasis).toBe(
      ticketSectionsBasis(legacy.description, legacy.acceptanceCriteria),
    );
  });

  test("criteria listed in a legacy description come before the field's", () => {
    expect(
      sectionsFromTicketText("## Acceptance criteria\n\n- From description", "- From field"),
    ).toEqual({
      acceptanceCriteria: [
        { id: "ac-1", text: "From description" },
        { id: "ac-2", text: "From field" },
      ],
    });
  });

  test("an empty legacy ticket has empty sections", () => {
    expect(normalizeTicketContent({ description: "", acceptanceCriteria: "" }).sections).toEqual(
      {},
    );
  });

  test("stored sections are trusted while the mirrors match", () => {
    const content = ticketContentFromSections("work-brief", FULL);
    const stored = { ...content };
    expect(normalizeTicketContent(stored)).toEqual(content);
  });

  test("a text-only edit by an older writer rebuilds sections and keeps unchanged results", () => {
    const content = ticketContentFromSections("feature", {
      summary: "Old",
      acceptanceCriteria: [
        {
          id: "ac-1",
          text: "Stays",
          check: { status: "passed", evidence: "e", checkedAt: NOW, source: "verify" },
        },
      ],
    });
    const edited = { ...content, description: "New summary\n\n## Problem\n\nP" };
    expect(normalizeTicketContent(edited).sections).toEqual({
      summary: "New summary",
      problem: "P",
      acceptanceCriteria: content.sections.acceptanceCriteria,
    });
  });

  test("markdown edits replace all sections and keep matching criteria results", () => {
    const start = ticketContentFromSections("feature", {
      summary: "S",
      acceptanceCriteria: [
        {
          id: "ac-1",
          text: "A",
          check: { status: "passed", evidence: "e", checkedAt: NOW, source: "verify" },
        },
      ],
    });
    const next = applyTicketContentUpdate(start, {
      markdown: "S2\n\n## Acceptance criteria\n\n- A\n- B",
    });
    expect(next.sections).toEqual({
      summary: "S2",
      acceptanceCriteria: [start.sections.acceptanceCriteria![0]!, { id: "ac-2", text: "B" }],
    });
    expect(next.description).toBe("S2");
    expect(next.acceptanceCriteria).toBe("- A\n- B");
  });

  test("a text-only update is stored verbatim and keeps unchanged criteria results", () => {
    const passed = {
      status: "passed" as const,
      evidence: "e",
      checkedAt: NOW,
      source: "verify" as const,
    };
    const start = ticketContentFromSections("work-brief", {
      summary: "S",
      acceptanceCriteria: [{ id: "ac-1", text: "A", check: passed }],
    });
    const next = applyTicketContentUpdate(start, { description: "## Background\n\nP" });
    expect(next.kind).toBe("work-brief");
    expect(next.description).toBe("## Background\n\nP");
    expect(next.acceptanceCriteria).toBe("- A");
    expect(next.sections).toEqual({
      context: "P",
      acceptanceCriteria: [{ id: "ac-1", text: "A", check: passed }],
    });
    expect(normalizeTicketContent(next)).toEqual(next);
  });

  test("a kind-only update leaves the text and sections alone", () => {
    const legacy = normalizeTicketContent({
      description: "## Background\n\nB",
      acceptanceCriteria: "",
    });
    const next = applyTicketContentUpdate(legacy, { kind: "work-brief" });
    expect(next).toEqual({ ...legacy, kind: "work-brief" });
  });

  test("a sections patch sets, keeps and clears per key", () => {
    const start = ticketContentFromSections("feature", { summary: "S", context: "C" });
    const next = applyTicketContentUpdate(start, {
      kind: "work-brief",
      sections: {
        context: null,
        delivery: { policy: "commit-only" },
        acceptanceCriteria: ["One", { text: "Two" }],
        checks: ["mise run lint"],
      },
    });
    expect(next.kind).toBe("work-brief");
    expect(next.sections).toEqual({
      summary: "S",
      acceptanceCriteria: [
        { id: "ac-1", text: "One" },
        { id: "ac-2", text: "Two" },
      ],
      checks: ["mise run lint"],
      delivery: { policy: "commit-only" },
    });
    expect(next.description).toBe(
      "S\n\n## Checks\n\n- mise run lint\n\n## Delivery\n\nPolicy: commit-only",
    );
  });

  test("an empty criteria list clears the section", () => {
    const start = ticketContentFromSections("feature", {
      acceptanceCriteria: [{ id: "ac-1", text: "A" }],
    });
    expect(applyTicketContentUpdate(start, { acceptanceCriteria: "" }).sections).toEqual({});
  });
});

describe("sections patch validation", () => {
  test("accepts every section and rejects unknown keys and bad shapes", () => {
    expect(
      parseTicketSectionsPatch({
        summary: "s",
        notes: null,
        acceptanceCriteria: ["a", { id: "ac-1", text: "b" }],
        delivery: { policy: "open-pr", note: "n" },
        custom: [{ title: " T ", body: "b" }],
      }),
    ).toEqual({
      summary: "s",
      notes: null,
      acceptanceCriteria: ["a", { id: "ac-1", text: "b" }],
      delivery: { policy: "open-pr", note: "n" },
      custom: [{ title: "T", body: "b" }],
    });
    expect(() => parseTicketSectionsPatch({ bogus: "x" })).toThrow("not a ticket section");
    expect(() => parseTicketSectionsPatch({ delivery: { policy: "merge" } })).toThrow(
      "sections.delivery",
    );
    expect(() => parseTicketSectionsPatch({ custom: [{ title: "a\nb", body: "" }] })).toThrow(
      "one-line titles",
    );
    expect(() => parseTicketSectionsPatch({ problem: 3 })).toThrow("sections.problem");
  });
});

test("templates list the sections each kind usually carries", () => {
  expect(ticketMarkdownTemplate("feature")).toBe(
    "## Context\n\n## Acceptance criteria\n\n## Out of scope",
  );
  expect(ticketMarkdownTemplate("work-brief").split("\n\n")).toContain("## Delivery");
});

describe("delivery policy choices", () => {
  test("no policy means open-pr", () => {
    expect(effectiveDeliveryPolicy(undefined)).toBe("open-pr");
    expect(effectiveDeliveryPolicy("commit-only")).toBe("commit-only");
  });

  test("commit-only is offered only to a ticket that already has it", () => {
    expect(deliveryPolicyChoices(undefined)).toEqual(["open-pr", "push-no-pr"]);
    expect(deliveryPolicyChoices("push-no-pr")).toEqual(["open-pr", "push-no-pr"]);
    expect(deliveryPolicyChoices("commit-only")).toEqual(["open-pr", "push-no-pr", "commit-only"]);
  });

  test("push-no-pr promises no Multi Review", () => {
    expect(DELIVERY_POLICY_LABELS["push-no-pr"]).toBe("Push, no PR");
  });
});

describe("the commit a criterion check judged", () => {
  const COMMIT = "abc1234" + "0".repeat(33);
  const LATER = "def5678" + "0".repeat(33);
  const verify = (extra: Partial<AcceptanceCriterionCheck> = {}): AcceptanceCriterionCheck => ({
    status: "passed",
    evidence: "bun test passes",
    checkedAt: "2026-11-08T00:00:00.000Z",
    source: "verify",
    pipelineId: "pipeline-1",
    ...extra,
  });

  test("the guard accepts a recorded commit and rejects a malformed one", () => {
    expect(isAcceptanceCriterionCheck(verify({ commit: COMMIT }))).toBe(true);
    expect(isAcceptanceCriterionCheck(verify({ commit: "f".repeat(64) }))).toBe(true);
    expect(isAcceptanceCriterionCheck(verify({ commit: COMMIT, uncommittedChanges: true }))).toBe(
      true,
    );
    // A check stored before the field existed is still valid.
    expect(isAcceptanceCriterionCheck(verify())).toBe(true);
    for (const commit of ["abc1234", COMMIT.toUpperCase(), `${COMMIT}0`, 42]) {
      expect(isAcceptanceCriterionCheck({ ...verify(), commit })).toBe(false);
    }
    expect(isAcceptanceCriterionCheck({ ...verify(), uncommittedChanges: "yes" })).toBe(false);
    expect(
      isTicketSections({
        acceptanceCriteria: [{ id: "ac-1", text: "One", check: verify({ commit: COMMIT }) }],
      }),
    ).toBe(true);
  });

  test("a check with no commit reads as not recorded, never as current", () => {
    expect(criterionCheckBasis(verify(), COMMIT)).toEqual({
      uncommittedChanges: false,
      moved: false,
      text: "commit not recorded",
    });
  });

  test("names the commit, uncommitted changes, and a branch that has moved", () => {
    expect(criterionCheckBasis(verify({ commit: COMMIT }))?.text).toBe("on abc1234");
    expect(criterionCheckBasis(verify({ commit: COMMIT }), COMMIT)).toMatchObject({
      moved: false,
      text: "on abc1234",
    });
    expect(criterionCheckBasis(verify({ commit: COMMIT }), LATER.toUpperCase())).toEqual({
      commit: COMMIT,
      uncommittedChanges: false,
      moved: true,
      text: "on abc1234; the branch has moved since",
    });
    expect(
      criterionCheckBasis(verify({ commit: COMMIT, uncommittedChanges: true }), LATER)?.text,
    ).toBe("on abc1234 with uncommitted changes; the branch has moved since");
    // An unreadable HEAD makes no claim either way.
    expect(criterionCheckBasis(verify({ commit: COMMIT }), "unknown")?.moved).toBe(false);
  });

  test("a hand tick judged no code", () => {
    expect(criterionCheckBasis(manualCheck("2026-11-08T00:00:00.000Z"), LATER)).toBeUndefined();
    expect(criterionCheckBasis(undefined)).toBeUndefined();
  });

  test("tool summaries carry the commit and the judged phrase", () => {
    const sections: TicketSections = {
      acceptanceCriteria: [
        { id: "ac-1", text: "One", check: verify({ commit: COMMIT, uncommittedChanges: true }) },
        { id: "ac-2", text: "Two", check: verify() },
        { id: "ac-3", text: "Three", check: manualCheck("2026-11-08T00:00:00.000Z") },
        { id: "ac-4", text: "Four" },
      ],
    };
    expect(ticketCriteriaSummary(sections, LATER)).toEqual([
      {
        id: "ac-1",
        text: "One",
        status: "passed",
        evidence: "bun test passes",
        commit: COMMIT,
        uncommittedChanges: true,
        judged: "on abc1234 with uncommitted changes; the branch has moved since",
      },
      {
        id: "ac-2",
        text: "Two",
        status: "passed",
        evidence: "bun test passes",
        judged: "commit not recorded",
      },
      {
        id: "ac-3",
        text: "Three",
        status: "passed",
        evidence: "Ticked by hand in the ticket text.",
      },
      { id: "ac-4", text: "Four" },
    ]);
  });
});

describe("what an acceptance criterion may say", () => {
  // Verify judges only the committed change. A criterion about how the work was
  // carried out once failed on what an earlier run had read on the host, and the
  // build looped through Rework, which no commit could satisfy. Every writer of
  // criteria carries the rule that keeps such rules in constraints.
  test("every prompt and tool that writes criteria states the rule", () => {
    expect(ACCEPTANCE_CRITERIA_RULE).toContain(
      "Verify judges each against the committed change alone",
    );
    const writers = {
      sectionsGuidance: TICKET_SECTIONS_GUIDANCE,
      autoPipelineDraft: autoPipelineDraftPrompt(),
      featurePlanner: FEATURE_PLANNER_SYSTEM_PROMPT,
      featurePlannerTool: FEATURE_PLANNER_TOOL_SYSTEM_PROMPT,
      cliCreateText:
        PUBLIC_ACTION_INPUTS["ticket.create"].input.properties.acceptanceCriteria?.description,
      cliUpdateText:
        PUBLIC_ACTION_INPUTS["ticket.update"].input.properties.acceptanceCriteria?.description,
      cliSectionsList:
        PUBLIC_ACTION_INPUTS["ticket.create"].input.properties.sections?.properties
          ?.acceptanceCriteria?.description,
    };
    for (const [writer, text] of Object.entries(writers)) {
      expect({ writer, states: text?.includes(ACCEPTANCE_CRITERIA_RULE) }).toEqual({
        writer,
        states: true,
      });
    }
  });
});
