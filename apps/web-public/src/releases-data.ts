/**
 * Plain-language summaries of recent Orkestrator releases, shown on the
 * website's Releases page (`/releases`). The page renders this file as-is and
 * never calls the GitHub API.
 *
 * Adding the next release
 * -----------------------
 * 1. Read the published notes: `gh release list --limit 6` for the tag and
 *    date, then `gh release view <tag>`. When the notes are empty or thin,
 *    read the history instead: `git log --oneline <previous-tag>..<tag>` and
 *    `gh pr view <number>` for the changes users would notice.
 * 2. Add an entry at the TOP of `RELEASES` (newest first) and delete the last
 *    one, so the list keeps exactly five releases.
 * 3. Write for users, not developers. Sort each change into `new`, `improved`
 *    or `fixed`; leave a group empty (`[]`) when nothing fits and the page
 *    omits it. Merge related changes into one line. Never include pull
 *    request numbers (`#1234`), internal to-do or flake ids, file paths,
 *    function names or test-only and CI-only work.
 * 4. `date` is the GitHub publish date (UTC, `YYYY-MM-DD`). `channel` follows
 *    the release kind: a release marked Latest is `stable`, a `-beta` tag is
 *    `beta`, an `-alpha` tag is `unstable`.
 * 5. Run `bun test src/ReleasesPage.test.tsx` from `apps/web-public`; it checks
 *    the order, the count, the links and the wording rules above.
 *
 * The same steps are in docs/development/releasing.md ("Website release
 * summaries").
 */

export type ReleaseChannel = "stable" | "beta" | "unstable";

export interface ReleaseSummary {
  /** Version without the leading `v`, as GitHub names the release. */
  version: string;
  /** Git tag the release was published from. */
  tag: string;
  /** GitHub publish date, UTC, `YYYY-MM-DD`. */
  date: string;
  channel: ReleaseChannel;
  /** One optional sentence of context shown under the version. */
  intro?: string;
  new: string[];
  improved: string[];
  fixed: string[];
}

export const RELEASES_REPOSITORY_URL = "https://github.com/orkestrator-ai/orkestrator-v2";

export function releaseNotesUrl(release: Pick<ReleaseSummary, "tag">): string {
  return `${RELEASES_REPOSITORY_URL}/releases/tag/${release.tag}`;
}

export const RELEASES: readonly ReleaseSummary[] = [
  {
    version: "2.39.15-beta",
    tag: "v2.39.15-beta",
    date: "2026-11-27",
    channel: "beta",
    intro: "Changes since 2.39.14-beta.",
    new: [
      "Right-click a ticket on the Kanban board, or a card or row on the Linear board, to open, build or delete it. Deleting a Linear issue moves it to Linear's trash, where it can be restored for 30 days.",
      "An opt-in Review setting lets Address Findings also fix test failures that were already on the base branch, each in its own labelled commit.",
      "Skills given to a single session now reach Pi sessions too.",
    ],
    improved: [
      "Pressing Retry on a failed coordinator turn shows the new turn straight away. A retry that is declined or fails leaves the original turn as it was.",
    ],
    fixed: [
      "Agent sessions start much faster: launching no longer waits on agent plugin lists, which could add 20 to 40 seconds on some machines.",
    ],
  },
  {
    version: "2.39.14-beta",
    tag: "v2.39.14-beta",
    date: "2026-11-25",
    channel: "beta",
    intro: "Changes since 2.39.13-beta.",
    new: [],
    improved: [
      "Choosing another machine in the New Environment dialog keeps the same dialog and your form open; only the new environment is created on that machine.",
      "Opening the New Environment dialog for a project on another machine no longer moves the window.",
    ],
    fixed: [
      "Builds of Linear issues on a machine without its own Linear key still get their merged label and completion comment: your command node writes them with its own key. Comments that cannot be posted straight away are retried.",
      "A build whose pull request merges while its conflicts are being resolved now completes.",
      "Rebuilding a container no longer risks an unexpected failure while it copies a large workspace.",
      "Dragging a card on the Linear board keeps scrolling at the edge while the pointer is over a gap between cards.",
      "A project you have just opened no longer closes when an older list of environments arrives late.",
      "Installing a project's system packages in a restricted container tries again when Debian's package archive cannot be reached.",
    ],
  },
  {
    version: "2.39.13-beta",
    tag: "v2.39.13-beta",
    date: "2026-11-24",
    channel: "beta",
    intro: "Changes since 2.39.12-beta.",
    new: [
      "The Linear tab shows the files attached to an issue and lets you download them. A build started from a Linear issue downloads its files into the environment before the agent starts.",
    ],
    improved: [
      "A prompt you send to a coordinator appears in the conversation straight away, while Orkestrator checks the project before sending it.",
    ],
    fixed: [
      "A coordinator prompt stays visible while it is being sent, and a send you stop puts your draft back in the composer.",
    ],
  },
  {
    version: "2.39.12-beta",
    tag: "v2.39.12-beta",
    date: "2026-11-23",
    channel: "beta",
    intro: "Changes since 2.39.11-beta.",
    new: [
      "Antigravity joins the agent platforms you can chat with in an environment.",
      "Build pipeline stages can hand slow checks to the pipeline, so long test suites finish instead of being cut off by the stage's time limit.",
      "Dropping a folder onto the files panel copies the whole folder.",
    ],
    improved: [
      "Address Findings in Multi Review also fixes failed validation.",
      "Review marks a failing test as pre-existing when it also fails on the branch your work started from.",
      "A build pipeline never opens a pull request that conflicts with its base branch; it merges and resolves the conflicts first.",
      "An environment created with an opening prompt shows its agent tab straight away while setup runs.",
      "Cmd/Ctrl+Enter submits the Design workspace dialog.",
    ],
    fixed: [
      "Claude sessions no longer refuse every prompt after you sign in to GitHub again while background work is running.",
      "Agent results with a stray closing bracket are repaired instead of refused.",
      "Repository headings in the sidebar line up with their environment rows.",
      "Health reports tell a computer restart apart from a backend crash, and record why the backend stopped unexpectedly.",
    ],
  },
  {
    version: "2.39.11-beta",
    tag: "v2.39.11-beta",
    date: "2026-11-20",
    channel: "beta",
    intro: "Changes since 2.39.10-beta.",
    new: [],
    improved: [
      "Sidebar search sits on the header line, and the command node switcher moves to the title bar.",
      "A machine with an update available shows a green up arrow on its sidebar tile, and the tooltip names the versions.",
      "The sidebar no longer adds a separate line for an unread result; the bell marks it, and opening the row takes you to the tab with that result.",
      "The composer's session tools now offer the deliverables panel and demonstration recording only; the context tray and point-and-talk buttons are gone.",
    ],
    fixed: [
      "A project on another machine reads its icon, Git remote and settings from that machine, and the folder picker says which machine it is browsing.",
    ],
  },
];
