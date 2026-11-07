/**
 * What the compact sidebar shows: one entry per top-level repository, and the
 * status its icon carries. Pure, so the list and its tests read the same rules.
 */

import type { CoordinatorActivityState } from "@orkestrator/protocol/coordinator-activity";
import type { MachineView } from "@/lib/federation/aggregate";
import {
  isMachineShown,
  mergedProjectView,
  repositoryIcon,
  repositoryLabel,
  repositoryOpenTarget,
  repositoryTileColor,
  type MergedProject,
} from "@/lib/federation/sidebar-layout";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { PortalLayout } from "@orkestrator/protocol/portal-layout";
import { projectHomeStatus } from "./ProjectHomeActivity";

/** A repository's project on one machine, or on this window when no machines are named. */
export interface CompactRepositoryMember {
  projectId: string;
  /** Absent in a window that does not name machines. */
  machine?: MachineView;
}

export interface CompactRepository {
  key: string;
  /** The tooltip and accessible name. */
  name: string;
  /** The house tile's outline: for a repository, `repositoryTileColor`. */
  colorToken: string | undefined;
  icon: string | null | undefined;
  /** The repository's identity; absent for a project that reports none. */
  repository?: string;
  /** What a click opens; the same member a repository heading opens. */
  opens: MergedProject | CompactRepositoryMember;
  members: readonly CompactRepositoryMember[];
}

function memberOf(item: MergedProject): CompactRepositoryMember {
  return { projectId: item.project.ref.projectId, machine: item.machine };
}

/**
 * Every connected machine's projects, one entry per repository, in the
 * repository list's order. The machine filter does not apply: its control is
 * not on screen in compact, so it could hide a repository with no way to tell.
 */
export function compactRepositories(
  machines: readonly MachineView[],
  layout: Pick<PortalLayout, "projectOrder" | "projectFolders" | "repositoryOrder">,
  commandNodeId: string | null,
): CompactRepository[] {
  const shownIds = new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId));
  const { tree } = mergedProjectView(machines, shownIds, "repository", layout, commandNodeId);
  const commandNode = machines.find((machine) => machine.backendId === commandNodeId);
  return tree.flatMap((entry): CompactRepository[] => {
    if (entry.kind === "project") {
      const item = entry.project;
      return [
        {
          key: item.id,
          name: item.name,
          colorToken: item.machine.colorToken,
          icon: item.project.icon,
          opens: item,
          members: [memberOf(item)],
        },
      ];
    }
    const opens = repositoryOpenTarget(entry.projects, commandNodeId);
    if (!opens) return [];
    return [
      {
        key: entry.key,
        name: repositoryLabel(entry.name),
        colorToken: repositoryTileColor(commandNode, entry.name, opens),
        icon: repositoryIcon(machines, commandNode, entry.name),
        repository: entry.name,
        opens,
        members: entry.projects.map(memberOf),
      },
    ];
  });
}

/** A window that does not name machines: its own projects, folders flattened away. */
export function compactLocalRepositories(
  projects: readonly { id: string; name: string; icon?: string | null }[],
): CompactRepository[] {
  return projects.map((project) => {
    const member = { projectId: project.id };
    return {
      key: project.id,
      name: project.name,
      colorToken: undefined,
      icon: project.icon,
      opens: member,
      members: [member],
    };
  });
}

/** One member's facts, gathered from this window's stores or another machine's summary. */
export interface CompactMemberFacts {
  coordinator: CoordinatorActivityState | null;
  home: {
    deleting: boolean;
    buildActive: boolean;
    activity: "idle" | "working" | "waiting";
    hasUnreadWork: boolean;
  } | null;
  working?: boolean;
  waiting?: boolean;
  /** An environment other than its home has work the user has not seen. */
  unreadWork: boolean;
  unreadMail: number;
  failedMail: boolean;
}

export interface CompactRepositoryStatus {
  ring: CoordinatorActivityState | null;
  badge: "attention" | "unread" | null;
  /** The status in words, for the tooltip and the accessible name. */
  labels: readonly string[];
}

/** The facts of another machine's project, by the rule its project row follows. */
export function remoteMemberFacts(
  environments: readonly FederatedEnvironment[],
): CompactMemberFacts {
  const home = environments.find(
    (environment) => environment.isProjectHome && !environment.deleting,
  );
  return {
    coordinator: null,
    working: environments.some(
      (environment) =>
        !environment.isProjectHome &&
        !environment.deleting &&
        (environment.activity === "working" || environment.buildActive === true),
    ),
    waiting: environments.some(
      (environment) =>
        !environment.isProjectHome && !environment.deleting && environment.activity === "waiting",
    ),
    home: home
      ? {
          deleting: home.deleting,
          buildActive: home.buildActive === true,
          activity: home.activity,
          hasUnreadWork: home.hasUnreadWork,
        }
      : null,
    unreadWork: environments.some(
      (environment) =>
        !environment.isProjectHome && !environment.deleting && environment.hasUnreadWork,
    ),
    unreadMail: environments.reduce(
      (total, environment) => total + (environment.agentMailUnread ?? 0),
      0,
    ),
    failedMail: environments.some((environment) => environment.agentMailFailed),
  };
}

/**
 * One repository's status across its members. A ring has one state, and as on
 * a project row the spinner wins while something also waits on the user, so
 * the badge then carries the wait. The badge is a dot: compact shows no text.
 */
export function compactRepositoryStatus(
  members: readonly CompactMemberFacts[],
): CompactRepositoryStatus {
  let working = false;
  let waiting = false;
  let unreadWork = false;
  let unreadMail = 0;
  let failedMail = false;
  for (const member of members) {
    const home = member.home ? projectHomeStatus(member.home) : null;
    working ||=
      member.working === true || member.coordinator === "working" || home?.working === true;
    waiting ||=
      member.waiting === true ||
      member.coordinator === "waiting" ||
      (member.home !== null && !member.home.deleting && member.home.activity === "waiting");
    unreadWork ||= member.unreadWork || (home !== null && member.home?.hasUnreadWork === true);
    unreadMail += member.unreadMail;
    failedMail ||= member.failedMail;
  }
  const attention = unreadWork || failedMail || (working && waiting);
  const labels: string[] = [];
  if (working) labels.push("Working");
  if (waiting) labels.push("Waiting for you");
  if (unreadWork) labels.push("Needs attention");
  if (unreadMail > 0) {
    labels.push(`${unreadMail} unread agent message${unreadMail === 1 ? "" : "s"}`);
  }
  if (failedMail) labels.push("Agent message delivery failed");
  return {
    ring: working ? "working" : waiting ? "waiting" : null,
    badge: attention ? "attention" : unreadMail > 0 ? "unread" : null,
    labels,
  };
}
