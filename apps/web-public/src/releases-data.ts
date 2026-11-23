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
  {
    version: "2.37.6-beta",
    tag: "v2.37.6-beta",
    date: "2026-11-11",
    channel: "beta",
    intro: "Changes since 2.37.5-beta.",
    new: [
      "One Merge PR button offers merge, resolve and auto-merge, including Auto-merge & Cleanup from a ticket.",
      "Find in a transcript also searches documents you have not scrolled to yet.",
    ],
    improved: [
      "Claude's tmux mode is now an experimental setting, off by default. New Claude tabs use the standard agent view, and tmux tabs already open keep running.",
      "Local desktop windows connect to the backend directly by default. You can turn this off in Settings.",
      "Large transcripts open faster, and an environment's network panel keeps its blocked-connection counts up to date.",
      "Idle environments use less background work, and the database stalls less while it tidies up after a deletion.",
    ],
    fixed: [
      "Auto-merge no longer stays stuck when conflicts remain after a Resolve tab finishes; it sends Resolve again.",
      "Transcripts keep your reading place when you resize split panes or switch between pipeline steps.",
      "Read-only Claude sessions, such as reviewers, use the model connection set in your Claude settings.",
      "Signing out of Claude on your computer also signs out the containers that were given that login.",
      "Containers on rootless Docker no longer fail to start because of port clashes after a Docker restart.",
      "On macOS, file changes are no longer missed while watches start and stop. On Linux, large ignored folders are left out of watching.",
      "A preview loading in a background tab no longer takes keyboard focus.",
      "OpenCode 2 sessions recover when their event stream goes quiet.",
    ],
  },
  {
    version: "2.37.5-beta",
    tag: "v2.37.5-beta",
    date: "2026-11-11",
    channel: "beta",
    intro: "Changes since 2.37.4-beta.",
    new: [
      "Tickets open in a wide tabbed view, with a Notes tab showing the linked build's notes, pull request state and Merge.",
      "Review an Auto-pipeline draft in its own tab, which keeps your unsaved edits.",
      "Search every action in a coordinator conversation from the Actions panel.",
      "A Releases page on the website summarises recent releases.",
    ],
    improved: [
      'Messages about environments name the machine they run on instead of saying "the host".',
      "Unread bells on environments are drawn in amber.",
    ],
    fixed: [
      "A build's ticket follows its pull request, returning to the backlog when the pull request closes or the environment is deleted.",
      "Environment setup reports when it has finished, and retrying setup no longer starts a second run alongside the first.",
      "The window no longer goes blank after an unexpected scroll.",
      "A browser preview is hidden behind dialogs and menus that cover it.",
      "Ticket sync works again with machines on older versions.",
      "The backend stays responsive while the self-improvement scan runs.",
    ],
  },
  {
    version: "2.37.4-beta",
    tag: "v2.37.4-beta",
    date: "2026-11-10",
    channel: "beta",
    intro: "Changes since 2.37.3-beta.",
    new: [
      "Rewind an agent conversation to an earlier message and switch between the branches that creates.",
      "The OpenCode 2 preview can resume and archive conversations, and runs inside containers too.",
      "Kanban tickets, including their images, stay in sync across all your machines, and conflicting edits are shown rather than lost.",
      "Usage readings for each signed-in account are shared between machines, with a note of how fresh each reading is.",
      "Claude approval cards say whether an MCP tool only reads or can make changes.",
      "Transcript timestamps include the date for messages from earlier days.",
      "Diagnostics exports can include agent restarts, optional container logs and how much space each part of the database uses.",
      "An experimental self-improvement loop reads recent agent conversations and turns repeated friction into tracked tickets.",
    ],
    improved: [
      "Agent chat is easier to read and to tap: clearer change summaries, tidier tool details and larger touch targets.",
      "Drafting an Auto-pipeline shows its progress, can be canceled, and tells you how the confirmation went.",
      "Read-only reviewers can run on Linux machines where the command sandbox is unavailable.",
      "Restoring a large set of file changes is faster.",
    ],
    fixed: [
      "Cleaning up an environment or merging its pull request only deletes branches that environment created.",
      "Spinners and progress bars in command output show their latest frame instead of every frame.",
      "A canceled Auto-pipeline draft no longer reappears, and saved model choices are kept when launching a build.",
      "A finished pipeline opens its Notes once, even when no window was watching it finish.",
      "The MCP panel refreshes straight after you act on a server.",
      "Commands that keep running after an agent's turn ends are shown as left running instead of stuck.",
      "File watching keeps working when a worktree contains folders it cannot read, and deleting an environment is quicker.",
      "Projects whose checkout is on another machine show the right status, and new environments are created on the right machine.",
    ],
  },
];
