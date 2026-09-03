import { useEffect, useState } from "react";
import { Loader2, PauseCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as backend from "@/lib/backend";
import { SettingsHeaderActions } from "./FullscreenSettingsLayout";
import {
  DEFAULT_AGENT_MESSAGING_SETTINGS,
  type AgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";

export function MessagingSettings() {
  const [settings, setSettings] = useState<AgentMessagingSettings>({
    ...DEFAULT_AGENT_MESSAGING_SETTINGS,
  });
  const [saved, setSaved] = useState<AgentMessagingSettings>({
    ...DEFAULT_AGENT_MESSAGING_SETTINGS,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

  if (loading)
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  const changed = JSON.stringify(settings) !== JSON.stringify(saved);
  const save = async () => {
    setSaving(true);
    try {
      await backend.updateAgentMessagingSettings(settings);
      setSaved(settings);
      toast.success("Messaging settings saved");
    } catch (error) {
      toast.error("Messaging settings were not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsHeaderActions>
        <Button variant="outline" disabled={!changed || saving} onClick={() => setSettings(saved)}>
          Reset
        </Button>
        <Button aria-label="Save changes" disabled={!changed || saving} onClick={() => void save()}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <span className="sm:hidden">Save</span>
          <span className="hidden sm:inline">Save changes</span>
        </Button>
      </SettingsHeaderActions>
      <div className="mx-auto max-w-2xl space-y-8 pb-8">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-400">
            Agent coordination
          </p>
          <h2 className="mt-2 text-xl font-semibold">Messaging</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Messages are stored by Orkestrator before delivery. Automatic delivery places untrusted
            text into an idle agent’s context and remains off until the recipient opts in.
          </p>
        </div>
        <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/40">
          <SettingRow
            label="Enable messaging"
            description="Expose inbox and send tools to interactive agent tabs."
          >
            <Switch
              checked={settings.enabled}
              onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
            />
          </SettingRow>
          <SettingRow
            label="Pause delivery"
            description="Keep accepting durable messages but stop automatic delivery."
          >
            <Switch
              checked={settings.paused}
              onCheckedChange={(paused) => setSettings({ ...settings, paused })}
            />
          </SettingRow>
          <SettingRow
            label="Allow cross-project messages"
            description="Let agents discover and store messages outside their current project. They are never automatically delivered."
          >
            <Switch
              checked={settings.allowCrossProject}
              onCheckedChange={(allowCrossProject) =>
                setSettings({ ...settings, allowCrossProject })
              }
            />
          </SettingRow>
          <SettingRow
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
          </SettingRow>
          <SettingRow
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
          </SettingRow>
        </div>
        {settings.paused && (
          <div className="flex gap-3 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p>
              Delivery is paused. New messages remain durable and unread until delivery resumes or
              the recipient pulls them.
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
