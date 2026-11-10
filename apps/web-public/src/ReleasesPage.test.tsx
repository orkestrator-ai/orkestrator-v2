import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ReleasesPage, formatReleaseDate } from "./ReleasesPage";
import { RELEASES, releaseNotesUrl, type ReleaseSummary } from "./releases-data";
import { CONNECT_PATH, RELEASES_PATH, isReleasesPath, publicPageFor } from "./routes";

afterEach(() => {
  cleanup();
});

function releaseCards(): HTMLElement[] {
  const list = screen.getByRole("list", { name: "Recent releases, newest first" });
  return within(list).getAllByRole("article");
}

describe("ReleasesPage", () => {
  test("renders the five releases newest first with version, channel and date", () => {
    render(<ReleasesPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "What’s new in Orkestrator" }),
    ).toBeTruthy();
    const cards = releaseCards();
    expect(cards).toHaveLength(5);
    const versions = cards.map(
      (card) => within(card).getByRole("heading", { level: 2 }).textContent,
    );
    expect(versions).toEqual(RELEASES.map((release) => release.version));

    const [first] = cards;
    const [newest] = RELEASES;
    if (!first || !newest) throw new Error("expected a newest release");
    const time = first.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(newest.date);
    expect(time?.textContent).toBe(formatReleaseDate(newest.date));
  });

  test("shows New, Improved and Fixed groups in order and omits empty ones", () => {
    const sample: ReleaseSummary[] = [
      {
        version: "9.1.0",
        tag: "v9.1.0",
        date: "2027-01-02",
        channel: "stable",
        new: ["A new thing."],
        improved: [],
        fixed: ["A fixed thing.", "Another fixed thing."],
      },
      {
        version: "9.0.0",
        tag: "v9.0.0",
        date: "2027-01-01",
        channel: "beta",
        new: ["First."],
        improved: ["Better."],
        fixed: ["Mended."],
      },
    ];
    render(<ReleasesPage releases={sample} />);

    const [partial, full] = releaseCards();
    if (!partial || !full) throw new Error("expected two cards");
    const groupNames = (card: HTMLElement) =>
      within(card)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent);
    expect(groupNames(partial)).toEqual(["New", "Fixed"]);
    expect(groupNames(full)).toEqual(["New", "Improved", "Fixed"]);

    const fixed = within(partial).getByRole("region", { name: "Fixed in 9.1.0" });
    expect(
      within(fixed)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["A fixed thing.", "Another fixed thing."]);
    expect(within(partial).queryByRole("region", { name: "Improved in 9.1.0" })).toBeNull();
  });

  test("renders every curated item under its group for each release", () => {
    render(<ReleasesPage />);

    const cards = releaseCards();
    RELEASES.forEach((release, index) => {
      const card = cards[index];
      if (!card) throw new Error(`missing card for ${release.version}`);
      for (const [key, label] of [
        ["new", "New"],
        ["improved", "Improved"],
        ["fixed", "Fixed"],
      ] as const) {
        const region = within(card).queryByRole("region", {
          name: `${label} in ${release.version}`,
        });
        if (release[key].length === 0) {
          expect(region).toBeNull();
          continue;
        }
        if (!region) throw new Error(`missing ${label} group for ${release.version}`);
        expect(
          within(region)
            .getAllByRole("listitem")
            .map((item) => item.textContent),
        ).toEqual(release[key]);
      }
    });
  });

  test("links each release to its full GitHub release notes", () => {
    render(<ReleasesPage />);

    const cards = releaseCards();
    RELEASES.forEach((release, index) => {
      const card = cards[index];
      if (!card) throw new Error(`missing card for ${release.version}`);
      const link = within(card).getByRole("link", {
        name: `Full release notes for ${release.version}`,
      });
      expect(link.getAttribute("href")).toBe(
        `https://github.com/orkestrator-ai/orkestrator-v2/releases/tag/${release.tag}`,
      );
      expect(link.getAttribute("href")).toBe(releaseNotesUrl(release));
    });
    expect(
      screen.getByRole("link", { name: "See every release on GitHub" }).getAttribute("href"),
    ).toBe("https://github.com/orkestrator-ai/orkestrator-v2/releases");
  });

  test("keeps the site navigation and marks Releases as the current page", () => {
    render(<ReleasesPage />);

    const sections = screen.getByRole("navigation", { name: "Sections" });
    const current = within(sections).getByRole("link", { name: "Releases" });
    expect(current.getAttribute("href")).toBe(RELEASES_PATH);
    expect(current.getAttribute("aria-current")).toBe("page");
    // Section links lead back into the landing page rather than to missing anchors here.
    expect(within(sections).getByRole("link", { name: "Security" }).getAttribute("href")).toBe(
      "/#security",
    );
    expect(screen.getByRole("link", { name: "Log in" }).getAttribute("href")).toBe(CONNECT_PATH);
    for (const home of screen.getAllByRole("link", { name: "Orkestrator home" })) {
      expect(home.getAttribute("href")).toBe("/");
    }
    const footer = screen.getByRole("navigation", { name: "Footer" });
    expect(within(footer).getByRole("link", { name: "Releases" }).getAttribute("href")).toBe(
      RELEASES_PATH,
    );
  });
});

describe("curated release data", () => {
  test("holds exactly five releases, newest first, with unique versions", () => {
    expect(RELEASES).toHaveLength(5);
    const dates = RELEASES.map((release) => release.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(new Set(RELEASES.map((release) => release.version)).size).toBe(5);
    for (const release of RELEASES) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.tag).toBe(`v${release.version}`);
      expect(release.new.length + release.improved.length + release.fixed.length).toBeGreaterThan(
        0,
      );
    }
  });

  test("is written for users: no PR numbers, internal ids or file paths", () => {
    for (const release of RELEASES) {
      for (const item of [
        release.intro ?? "",
        ...release.new,
        ...release.improved,
        ...release.fixed,
      ]) {
        expect(item).not.toMatch(/#\d+/);
        expect(item).not.toMatch(/\bto-?do\s*\d+/i);
        expect(item).not.toMatch(/\bflake\s*\d+/i);
        expect(item).not.toMatch(/\b[\w-]+\/[\w./-]+\.(ts|tsx|js|md|json|sh)\b/);
        expect(item).not.toMatch(/\.(ts|tsx)\b/);
        expect(item).not.toContain("`");
      }
    }
  });

  test("is committed data the page renders without calling GitHub", () => {
    const source = readFileSync(new URL("./ReleasesPage.tsx", import.meta.url), "utf8");
    const data = readFileSync(new URL("./releases-data.ts", import.meta.url), "utf8");
    for (const text of [source, data]) {
      expect(text).not.toMatch(/\bfetch\(/);
      expect(text).not.toContain("api.github.com");
    }
    // The data file documents how to add the next release.
    expect(data).toContain("Adding the next release");
  });
});

describe("formatReleaseDate", () => {
  test("formats an ISO date the same way in every locale", () => {
    expect(formatReleaseDate("2026-11-10")).toBe("10 November 2026");
    expect(formatReleaseDate("2026-01-05")).toBe("5 January 2026");
    expect(formatReleaseDate("not a date")).toBe("not a date");
  });
});

describe("public page routes", () => {
  test("recognises the Releases page and keeps everything else on the landing page", () => {
    expect(isReleasesPath("/releases")).toBe(true);
    expect(isReleasesPath("/releases/")).toBe(true);
    expect(isReleasesPath("/release")).toBe(false);
    expect(publicPageFor("/releases")).toBe("releases");
    expect(publicPageFor("/connect")).toBe("connect");
    expect(publicPageFor("/")).toBe("landing");
    expect(publicPageFor("/anything-else")).toBe("landing");
  });
});
