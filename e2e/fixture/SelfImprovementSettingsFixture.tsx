import { useState } from "react";
import type {
  SelfImprovementProgress,
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
 * `?old` a backend that sends no progress at all.
 */
const params = new URLSearchParams(window.location.search);
const quiet = params.has("quiet");
const old = params.has("old");

const menuItems = [{ id: "self-improvement", label: "Self-improvement", icon: null }];
const startedAt = Date.now() - 95_000;

function progress(now: number): SelfImprovementProgress {
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
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

function status(): SelfImprovementStatus {
  return {
    enabled: true,
    settings: { projectId: "p1", conversationReview: true, dailyRun: false },
    project: { id: "p1", name: "orkestrator-v2" },
    running: {
      trigger: "manual",
      startedAt: new Date(startedAt).toISOString(),
      step: "reading-conversations",
      ...(old ? {} : { progress: progress(Date.now()) }),
    },
    lastRun: null,
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
