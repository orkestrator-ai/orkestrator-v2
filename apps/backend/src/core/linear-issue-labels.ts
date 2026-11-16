/**
 * Adds a label to a Linear issue by name (docs/architecture/tickets.md,
 * "Linear", "Merged builds label their issue"). Used for the `merged` label a
 * Linear-sourced build's issue gets when its pull request merges.
 *
 * The label is matched case-insensitively among the labels the issue's team
 * can use: its own team labels first, then workspace labels. Group labels are
 * skipped, since Linear refuses to apply a group. When none matches, a team
 * label is created. `issueAddLabel` adds without replacing, so the issue's
 * other labels are kept, and an issue that already has the label is left
 * alone.
 */
import type { LinearMergedLabelOutcome } from "./storage-linear.js";
import { asString, isRecord, linearGraphql } from "./linear.js";

export type LinearIssueLabelResult = {
  outcome: LinearMergedLabelOutcome;
  labelId: string;
};

type LabelNode = { id: string; name: string; isGroup: boolean; teamId?: string };

function labelNodes(connection: unknown): LabelNode[] {
  const nodes = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
  return nodes.flatMap((node) => {
    if (!isRecord(node)) return [];
    const id = asString(node.id);
    const name = asString(node.name);
    if (!id || !name) return [];
    const team = isRecord(node.team) ? asString(node.team.id) : "";
    return [{ id, name, isGroup: node.isGroup === true, ...(team ? { teamId: team } : {}) }];
  });
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase("en-US") === b.trim().toLocaleLowerCase("en-US");
}

export async function addLinearIssueLabelByName(
  apiKey: string,
  issueId: string,
  name: string,
): Promise<LinearIssueLabelResult> {
  const issueData = await linearGraphql<{ issue?: unknown }>(
    apiKey,
    `query OrkestratorLinearIssueLabels($id: String!) {
      issue(id: $id) {
        id
        team { id }
        labels(first: 100) {
          nodes { id name }
        }
      }
    }`,
    { id: issueId },
  );
  const issue = isRecord(issueData.issue) ? issueData.issue : null;
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
  const present = labelNodes(issue.labels).find((label) => sameName(label.name, name));
  if (present) return { outcome: "already-present", labelId: present.id };
  const teamId = isRecord(issue.team) ? asString(issue.team.id) : "";
  if (!teamId) throw new Error("Linear issue has no team");
  // Linear's id for the issue, in case `issueId` was its identifier (ENG-12).
  const targetId = asString(issue.id) || issueId;

  const labelData = await linearGraphql<{ issueLabels?: unknown }>(
    apiKey,
    `query OrkestratorLinearLabelsByName($name: String!) {
      issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) {
        nodes { id name isGroup team { id } }
      }
    }`,
    { name },
  );
  const candidates = labelNodes(labelData.issueLabels).filter(
    (label) =>
      !label.isGroup && sameName(label.name, name) && (!label.teamId || label.teamId === teamId),
  );
  let labelId =
    candidates.find((label) => label.teamId === teamId)?.id ??
    candidates.find((label) => !label.teamId)?.id;
  let outcome: LinearMergedLabelOutcome = "added";

  if (!labelId) {
    const created = await linearGraphql<{
      issueLabelCreate?: { success?: boolean; issueLabel?: { id?: string } };
    }>(
      apiKey,
      `mutation OrkestratorLinearLabelCreate($name: String!, $teamId: String!) {
        issueLabelCreate(input: { name: $name, teamId: $teamId }) {
          success
          issueLabel { id }
        }
      }`,
      { name, teamId },
    );
    labelId = created.issueLabelCreate?.issueLabel?.id;
    if (!created.issueLabelCreate?.success || !labelId) {
      throw new Error("Linear did not confirm label creation");
    }
    outcome = "created";
  }

  const added = await linearGraphql<{ issueAddLabel?: { success?: boolean } }>(
    apiKey,
    `mutation OrkestratorLinearIssueAddLabel($id: String!, $labelId: String!) {
      issueAddLabel(id: $id, labelId: $labelId) {
        success
      }
    }`,
    { id: targetId, labelId },
  );
  if (!added.issueAddLabel?.success) throw new Error("Linear did not confirm the label was added");
  return { outcome, labelId };
}
