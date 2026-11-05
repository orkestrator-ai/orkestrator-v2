import { createElement, useState } from "react";
import { SchedulesSettings } from "../../apps/web/src/components/settings/SchedulesSettings";
import { dispatchResourceChange } from "../../apps/web/src/lib/resource-sync";
import type { SchedulerStatus } from "@orkestrator/protocol/scheduled-jobs";

const key = "scheduler-status-fixture";
let revision = 0;
function status(): SchedulerStatus {
  return JSON.parse(localStorage.getItem(key) ?? '{"firing":true}');
}
function install() {
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T>(command: string): Promise<T> => {
      if (command === "list_scheduled_jobs")
        return {
          scheduler: status(),
          schedules: [
            {
              id: "fixture-schedule",
              action: { kind: "action", action: "send_message", input: {} },
              name: "Daily check",
              owner: { kind: "operator" },
              ownerLabel: "You",
              state: "active",
              timeZone: "UTC",
              trigger: {
                kind: "interval",
                everySeconds: 3600,
                anchorAt: "2099-01-01T00:00:00.000Z",
              },
              nextFireAt: "2099-01-01T00:00:00.000Z",
              lastFire: null,
              activeFire: null,
            },
          ],
        } as T;
      return {} as T;
    },
  };
}

export function SchedulerStatusFixture() {
  useState(install);
  const [away, setAway] = useState(false);
  const pause = () => {
    localStorage.setItem(key, JSON.stringify({ firing: false, reason: "writer-lease-lost" }));
    dispatchResourceChange({ resource: "scheduled-job", id: "scheduler", revision: ++revision });
  };
  return createElement(
    "main",
    { className: "dark bg-background text-foreground p-4 min-h-screen" },
    createElement("button", { onClick: pause }, "Lose writer lease"),
    createElement(
      "button",
      { onClick: () => setAway(!away) },
      away ? "Return to schedules" : "Switch away",
    ),
    away ? null : createElement(SchedulesSettings),
  );
}
