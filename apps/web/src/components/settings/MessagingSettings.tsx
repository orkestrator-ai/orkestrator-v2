import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, PauseCircle } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import * as backend from "@/lib/backend";
import {
  AGENT_MAIL_MAX_AUTONOMOUS_WAKE_BUDGET,
  AGENT_MAIL_MAX_HOURLY_WAKE_LIMIT,
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  type AgentMessagingSettings,
  type CoordinatorStatusWakeMode,
} from "@orkestrator/protocol/agent-mail";
import { SETTINGS_CARD_CLASS, SettingsPageLayout, SettingsRow } from "./SettingsPageLayout";
import { cn } from "@/lib/utils";

// One write after a burst of edits, matching the shared settings form.
const MESSAGING_AUTO_SAVE_DEBOUNCE_MS = 400;

export function MessagingSettings() {
  const [settings, setSettings] = useState<AgentMessagingSettings>({
    ...DEFAULT_AGENT_MESSAGING_SETTINGS,
  });
  const [saved, setSaved] = useState<AgentMessagingSettings>({
    ...DEFAULT_AGENT_MESSAGING_SETTINGS,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const failedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    void backend
      .getAgentMessagingSettings()
      .then((value) => {
        setSettings(value);
        setSaved(value);
      })
      .catch((error) =>
        toast.error("Could not load messaging settings", {
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setLoading(false));
  }, []);

  const signature = JSON.stringify(settings);
  const savedSignature = JSON.stringify(saved);
  const changed = signature !== savedSignature;

  // Latest values for the unmount flush, which must not re-run on every edit.
  const latestRef = useRef({ loading, saving, changed, signature, settings });
  useLayoutEffect(() => {
    latestRef.current = { loading, saving, changed, signature, settings };
  }, [loading, saving, changed, signature, settings]);

  // Auto-save on every change once the initial load has settled. A rejected
  // edit is not retried until it changes again, so a backend that keeps
  // refusing the same value cannot spin.
  useEffect(() => {
    if (loading || saving || !changed) return;
    if (failedSignatureRef.current === signature) return;
    const timer = setTimeout(() => {
      setSaving(true);
      backend
        .updateAgentMessagingSettings(settings)
        .then(() => {
          failedSignatureRef.current = null;
          setSaved(settings);
        })
        .catch((error) => {
          failedSignatureRef.current = signature;
          toast.error("Messaging settings were not saved", {
            description: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => setSaving(false));
    }, MESSAGING_AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [loading, saving, changed, signature, settings]);

  // Switching to another settings section unmounts this pane. Flush a still
  // debounced edit so it is not silently dropped.
  useEffect(() => {
    return () => {
      const current = latestRef.current;
      if (current.loading || current.saving || !current.changed) return;
      if (failedSignatureRef.current === current.signature) return;
      void backend.updateAgentMessagingSettings(current.settings).catch((error) => {
        console.error("[settings] Failed to flush messaging settings:", error);
      });
    };
  }, []);

  if (loading)
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );

  return (
    <SettingsPageLayout
      title="Messaging"
      description="Messages are stored by Orkestrator before delivery. Automatic delivery places untrusted text into an idle agent’s context. Coordinator mail wakes recipients automatically. Peer wake is opt-in; other mail follows the recipient’s delivery policy."
    >
      <div className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
        <SettingsRow
          label="Enable messaging"
          htmlFor="messaging-enabled"
          description="Expose inbox and send tools to interactive agent tabs."
        >
          <Switch
            id="messaging-enabled"
            aria-label="Enable messaging"
            checked={settings.enabled}
            onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
          />
        </SettingsRow>
        <SettingsRow
          label="Pause delivery"
          htmlFor="messaging-paused"
          description="Keep accepting durable messages but stop automatic delivery."
        >
          <Switch
            id="messaging-paused"
            aria-label="Pause delivery"
            checked={settings.paused}
            onCheckedChange={(paused) => setSettings({ ...settings, paused })}
          />
        </SettingsRow>
        <SettingsRow
          label="Allow cross-project messages"
          htmlFor="messaging-allowCrossProject"
          description="Let agents discover and store messages outside their current project. They are never automatically delivered."
        >
          <Switch
            id="messaging-allowCrossProject"
            aria-label="Allow cross-project messages"
            checked={settings.allowCrossProject}
            onCheckedChange={(allowCrossProject) => setSettings({ ...settings, allowCrossProject })}
          />
        </SettingsRow>
        <SettingsRow
          label="Wake peers"
          htmlFor="messaging-wakePeers"
          description="Mail between agents in environments you created starts the recipient's next turn when it is idle. Coordinators and the workers they create always wake each other."
        >
          <Switch
            id="messaging-wakePeers"
            aria-label="Wake peers"
            checked={settings.wakePeers}
            onCheckedChange={(wakePeers) => setSettings({ ...settings, wakePeers })}
          />
        </SettingsRow>
        <SettingsRow
          label="Unattended exchange budget"
          description="Messages two agents may trade automatically before delivery pauses. A coordinator request, your prompt to either agent, or Resume starts a new budget."
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="Unattended exchange budget"
              type="number"
              min={1}
              max={AGENT_MAIL_MAX_AUTONOMOUS_WAKE_BUDGET}
              value={settings.autonomousWakeBudget}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  autonomousWakeBudget: Math.max(
                    1,
                    Math.min(
                      AGENT_MAIL_MAX_AUTONOMOUS_WAKE_BUDGET,
                      Number(event.target.value) || 1,
                    ),
                  ),
                })
              }
              className="w-20"
            />
            <span className="text-xs text-muted-foreground">messages</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Hourly limit per pair"
          description="Most automatic messages two agents may exchange in an hour. Mail over the limit waits and is delivered as the hour passes."
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="Hourly limit per pair"
              type="number"
              min={1}
              max={AGENT_MAIL_MAX_HOURLY_WAKE_LIMIT}
              value={settings.hourlyWakeLimit}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  hourlyWakeLimit: Math.max(
                    1,
                    Math.min(AGENT_MAIL_MAX_HOURLY_WAKE_LIMIT, Number(event.target.value) || 1),
                  ),
                })
              }
              className="w-20"
            />
            <span className="text-xs text-muted-foreground">per hour</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Coordinator status updates"
          description="Wake a coordinator when work it started changes state: a Multi Review ready or fixed, a build that ends or stops on an error, a stall, a worker waiting for input or approval. Updates that land together arrive as one wake."
        >
          <select
            aria-label="Coordinator status updates"
            value={settings.coordinatorStatusWakes}
            onChange={(event) =>
              setSettings({
                ...settings,
                coordinatorStatusWakes: event.target.value as CoordinatorStatusWakeMode,
              })
            }
            className="h-9 rounded-md border border-border/70 bg-input-surface px-3 text-sm"
          >
            <option value="off">Finished work only</option>
            <option value="settled">Decisions and problems</option>
            <option value="stages">Every build stage too</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Default automatic delivery"
          description="Idle delivery can start billable work, including a tab that has never received a prompt."
        >
          <select
            aria-label="Default automatic delivery"
            value={settings.defaultInjectPolicy}
            onChange={(event) =>
              setSettings({
                ...settings,
                defaultInjectPolicy: event.target.value as "off" | "idle",
              })
            }
            className="h-9 rounded-md border border-border/70 bg-input-surface px-3 text-sm"
          >
            <option value="off">Off</option>
            <option value="idle">When idle</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label="Retention"
          description="Messages and delivery-status records older than this are removed, including unread mail for closed tabs."
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="Retention days"
              type="number"
              min={1}
              max={365}
              value={settings.retentionDays}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  retentionDays: Math.max(1, Math.min(365, Number(event.target.value) || 1)),
                })
              }
              className="w-20"
            />
            <span className="text-xs text-muted-foreground">days</span>
          </div>
        </SettingsRow>
      </div>
      {settings.paused && (
        <div className="flex gap-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p>
            Delivery is paused. New messages remain durable and unread until delivery resumes or the
            recipient pulls them.
          </p>
        </div>
      )}
    </SettingsPageLayout>
  );
}
