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
      "Drafting an Auto-pipeline shows its progress, can be cancelled, and tells you how the confirmation went.",
      "Read-only reviewers can run on Linux machines where the command sandbox is unavailable.",
      "Restoring a large set of file changes is faster.",
    ],
    fixed: [
      "Cleaning up an environment or merging its pull request only deletes branches that environment created.",
      "Spinners and progress bars in command output show their latest frame instead of every frame.",
      "A cancelled Auto-pipeline draft no longer reappears, and saved model choices are kept when launching a build.",
      "A finished pipeline opens its Notes once, even when no window was watching it finish.",
      "The MCP panel refreshes straight after you act on a server.",
      "Commands that keep running after an agent's turn ends are shown as left running instead of stuck.",
      "File watching keeps working when a worktree contains folders it cannot read, and deleting an environment is quicker.",
      "Projects whose checkout is on another machine show the right status, and new environments are created on the right machine.",
    ],
  },
  {
    version: "2.37.3-beta",
    tag: "v2.37.3-beta",
    date: "2026-11-09",
    channel: "beta",
    intro: "Changes since 2.37.1-beta.",
    new: [
      "Each project has a Scheduling tab where you create, edit and reuse schedules, including ones that run on another machine.",
      "An opt-in setting runs new OpenCode sessions on OpenCode 2, alongside the current version, on your computer and in containers.",
      "Queued messages keep their attachments when they are sent after a turn, and keep them when you edit the message.",
      "A signed-out agent account can be signed in again right where it is listed.",
    ],
    improved: [
      "The coordinator's Actions panel can be collapsed and remembers that per project, the chat moves aside when the panel is docked, and the composer explains the @ and ! shortcuts.",
      "Review views adapt to the window size and keep your reading position when the layout changes.",
      "Jumping to an item in a transcript briefly highlights it.",
    ],
    fixed: [
      "When a local environment cannot reach its Git remote over SSH, Orkestrator offers to switch it to HTTPS.",
      "On Linux, file watching recovers after a folder is deleted and recreated.",
      "Notices at the bottom of the chat no longer cover the end of the transcript.",
      "Auto-pipeline launches are more reliable, keep your draft edits and open agent tabs in the right environment.",
    ],
  },
  {
    version: "2.37.1-beta",
    tag: "v2.37.1-beta",
    date: "2026-11-09",
    channel: "beta",
    intro: "Brings the 2.37.0 preview to the Beta channel, with more fixes on top.",
    new: [
      "Work across several machines from one window, with each machine keeping its own state. The window also starts faster.",
      "Updated Claude Code, Codex, Cursor, Pi and Grok Build. Every agent now shows when its sign-in ends, flags prompts you must answer yourself, labels MCP tools as read-only or destructive and shows estimated costs.",
      "Hand interactive work over to an Auto-pipeline review in one step.",
      "The coordinator gains an Actions panel with cards for pull requests and questions, suggests saving instructions you keep repeating, and hears back when a build finishes.",
      "Talk to agents by voice, including interrupting the project coordinator.",
      "Label Kanban tickets, with labels synced across machines.",
      "Update several machines at once, delete the focused environment with Cmd/Ctrl+Backspace, and rewind a Pi conversation to an earlier message.",
    ],
    improved: [
      "Automatic account switching uses fresh usage data and explains why no account is available.",
      'Pipeline Notes open with a collapsible "Needs a look" section, and prompts waiting for you are easier to spot.',
      "Transcripts redraw less and keep your place while tools stream, with less background polling.",
      "Storage housekeeping no longer holds up saving on a busy disk, and change history keeps 30 days of archived content.",
    ],
    fixed: [
      "Claude sign-in recovery and switching accounts across agent tabs are more reliable.",
      "Container terminals recover better, and closing one also closes its shell.",
      "OpenCode no longer fails on an incompatible database left on the computer.",
      "Kanban tickets move to Done when their pull request merges, and auto-merge re-checks a pull request when it wakes and says what it is waiting for.",
      "Question notifications play their sound and show a desktop notification again, and their settings work.",
      "Host update errors explain what went wrong, and falling back to the Stable update works.",
      "Security advisories in third-party dependencies are resolved.",
    ],
  },
];
