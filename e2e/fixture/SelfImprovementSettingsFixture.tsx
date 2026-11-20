import { useState } from "react";
import type {
  SelfImprovementProgress,
  SelfImprovementRunSummary,
  SelfImprovementStatus,
} from "@orkestrator/protocol/self-improvement";
import { FullscreenSettingsLayout } from "../../apps/web/src/components/settings/FullscreenSettingsLayout";
import {
  SelfImprovementSettings,
  type SelfImprovementSettingsProps,
} from "../../apps/web/src/components/settings/SelfImprovementSettings";
import type { AppConfig } from "../../apps/web/src/types";

/**
 * Settings → Self-improvement inside the real fullscreen settings layer, with a
 * run that is part-way through reading conversations. The progress window must
 * open above that layer (it portals to the body, where the shadcn default z-50
 * would sit behind it). `?quiet` is a run with no sign of life for five minutes,
 * `?old` a backend that sends no progress at all, `?review-off` a run that
 * started with the conversation review off after which the switch was turned
 * on, and `?preview` a preview that has listed the parts it would read.
 * `?finished` shows no run in progress and a finished run on a machine with no
 * leaves; `?leaves` the same run on a command node that also read its
 * connected leaf nodes, one of them failing and one needing an update.
 */
const params = new URLSearchParams(window.location.search);
const quiet = params.has("quiet");
const old = params.has("old");
const reviewOff = params.has("review-off");
const preview = params.has("preview");
const leaves = params.has("leaves");
const failedLeaves = params.has("failed-leaves");
const finished = leaves || params.has("finished");

const menuItems = [{ id: "self-improvement", label: "Self-improvement", icon: null }];
const startedAt = Date.now() - 95_000;

function progress(now: number): SelfImprovementProgress {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  if (reviewOff) {
    return {
      observedAt: at(0),
      lastActivityAt: at(2),
      stages: [
        { step: "exporting", state: "done", startedAt: at(95), finishedAt: at(90) },
        { step: "board", state: "running", startedAt: at(90) },
        { step: "reading-conversations", state: "skipped", skipReason: "review-off" },
        { step: "grouping-themes", state: "skipped", skipReason: "review-off" },
        { step: "digesting", state: "pending" },
        { step: "filing", state: "pending" },
      ],
      modelCalls: { inFlight: 0, oldestStartedAt: null, timeoutMs: 600_000 },
    };
  }
  if (preview) {
    return {
      observedAt: at(0),
      lastActivityAt: at(2),
      stages: [
        { step: "exporting", state: "done", startedAt: at(95), finishedAt: at(90) },
        { step: "board", state: "done", startedAt: at(90), finishedAt: at(89) },
        {
          step: "reading-conversations",
          state: "done",
          startedAt: at(89),
          finishedAt: at(80),
        },
        { step: "grouping-themes", state: "skipped", skipReason: "no-notes" },
        { step: "digesting", state: "running", startedAt: at(80) },
        { step: "filing", state: "skipped", skipReason: "preview" },
      ],
      conversations: {
        filesChecked: 3146,
        files: 3146,
        parts: 30,
        read: 0,
        failed: 0,
        notesAdded: 0,
        waiting: 2,
      },
      modelCalls: { inFlight: 0, oldestStartedAt: null, timeoutMs: 600_000 },
    };
  }
  return {
    observedAt: at(0),
    lastActivityAt: at(quiet ? 300 : 2),
    stages: [
      { step: "exporting", state: "done", startedAt: at(95), finishedAt: at(90) },
      { step: "board", state: "done", startedAt: at(90), finishedAt: at(89) },
      { step: "reading-conversations", state: "running", startedAt: at(89) },
      { step: "grouping-themes", state: "pending" },
      { step: "digesting", state: "pending" },
      { step: "filing", state: "pending" },
    ],
    conversations: {
      filesChecked: 3146,
      files: 3146,
      parts: 30,
      read: 4,
      failed: 0,
      notesAdded: 7,
      waiting: 2,
    },
    modelCalls: quiet
      ? { inFlight: 0, oldestStartedAt: null, timeoutMs: 600_000 }
      : { inFlight: 3, oldestStartedAt: at(21), timeoutMs: 600_000 },
  };
}

const LAST_RUN: SelfImprovementRunSummary = {
  digestId: "20261120T080000Z-0f1e2d3c",
  trigger: preview ? "dry-run" : "manual",
  startedAt: new Date(startedAt - 3_600_000).toISOString(),
  finishedAt: new Date(startedAt - 3_300_000).toISOString(),
  outcome: "succeeded",
  created: [
    {
      ticket: "421",
      signature: "storage:snapshot.failed:ENOSPC",
      title: "storage snapshot.failed: ENOSPC",
    },
  ],
  linked: [],
  verified: [],
  fixFailed: [],
  partly: [],
  markedFixed: [],
  reopenedFromBoard: [],
  ignoredDeleted: [],
  wouldCreate: [],
  heldForTomorrow: 0,
  belowBar: 6,
  ...(leaves
    ? {
        machines: [
          {
            nodeId: "bk_vps",
            name: "build-vps",
            diagnostics: failedLeaves ? "failed" : "read",
            ...(failedLeaves ? {} : { appVersion: "2.41.0" }),
            conversations: failedLeaves ? "failed" : "read",
            conversationParts: failedLeaves ? 0 : 9,
          },
          {
            nodeId: "bk_laptop",
            name: "travel-laptop",
            diagnostics: failedLeaves ? "failed" : "read",
            ...(failedLeaves ? {} : { appVersion: "2.40.2" }),
            conversations: "failed",
            conversationParts: 0,
          },
          {
            nodeId: "bk_old",
            name: "old-mini",
            diagnostics: "needs-update",
            conversations: "needs-update",
            conversationParts: 0,
          },
        ],
      }
    : {}),
  conversations: {
    enabled: true,
    read: leaves ? 30 : 21,
    waiting: 0,
    notesAdded: preview ? 0 : 14,
    themes: 4,
    costUsd: preview ? 0 : 0.62,
    heldForTomorrow: 0,
    errors: [],
  },
};

function status(): SelfImprovementStatus {
  return {
    enabled: true,
    settings: { projectId: "p1", conversationReview: true, dailyRun: false },
    project: { id: "p1", name: "orkestrator-v2" },
    running: finished
      ? null
      : {
          trigger: preview ? "dry-run" : "manual",
          startedAt: new Date(startedAt).toISOString(),
          step: reviewOff ? "board" : preview ? "digesting" : "reading-conversations",
          ...(old ? {} : { progress: progress(Date.now()) }),
        },
    lastRun: finished ? LAST_RUN : null,
    nextDailyRunAt: null,
    tracked: [],
    themes: [],
    models: { notes: "claude-sonnet-5-5", themes: "claude-opus-5-5" },
    limits: { diagnosticsTicketsPerDay: 3, insightTicketsPerDay: 2, conversationPartsPerRun: 30 },
  };
}

const api = {
  getSelfImprovementStatus: async () => status(),
  runSelfImprovement: async () => ({ started: false, status: status() }),
  getProjects: async () => [{ id: "p1", name: "orkestrator-v2" }],
  patchGlobalConfig: async () => ({}) as unknown as AppConfig,
} as unknown as SelfImprovementSettingsProps["api"];

export function SelfImprovementSettingsFixture() {
  const [open, setOpen] = useState(true);
  return (
    <FullscreenSettingsLayout
      open={open}
      onOpenChange={setOpen}
      title="Fixture settings"
      menuItems={menuItems}
      defaultSection="self-improvement"
    >
      {() => <SelfImprovementSettings api={api} />}
    </FullscreenSettingsLayout>
  );
}
