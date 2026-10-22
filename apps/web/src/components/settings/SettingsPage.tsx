import { useEffect, useState } from "react";
import { useFederation } from "@/components/federation/FederationProvider";
import { MachineDot } from "@/components/federation/MachineDot";
import { useConfigStore } from "@/stores";
import * as backend from "@/lib/backend";
import {
  Loader2,
  Settings2,
  Terminal,
  Shield,
  Container,
  Bug,
  FlaskConical,
  Globe2,
  Eye,
  Sparkles,
  Boxes,
  SlidersHorizontal,
  Cable,
  MessagesSquare,
  RadioTower,
  MonitorPlay,
  Volume2,
  Server,
  HardDrive,
  Download,
  ChartArea,
} from "lucide-react";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { GlobalSettings } from "./GlobalSettings";
import { SkillsSettings } from "./SkillsSettings";
import { DiskUsageSettings } from "./DiskUsageSettings";
import { UsageSettings } from "./usage/UsageSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { McpSettings } from "./McpSettings";
import { ProviderMcpSettings } from "./mcp-servers/ProviderMcpSettings";
import { PreviewSettings } from "./PreviewSettings";
import { WebAnnotationSettings } from "./WebAnnotationSettings";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "./FullscreenSettingsLayout";
import { MessagingSettings } from "./MessagingSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { SoundsSettings } from "./SoundsSettings";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";

const MENU_ITEMS: SettingsMenuItem<GlobalSettingsSection>[] = [
  { id: "general", label: "General", icon: <Settings2 className="h-4 w-4" /> },
  { id: "updates", label: "Updates", icon: <Download className="h-4 w-4" /> },
  { id: "disk-usage", label: "Disk usage", icon: <HardDrive className="h-4 w-4" /> },
  { id: "usage", label: "Usage", icon: <ChartArea className="h-4 w-4" /> },
  { id: "connections", label: "Connections", icon: <RadioTower className="h-4 w-4" /> },
  { id: "defaults", label: "Defaults", icon: <SlidersHorizontal className="h-4 w-4" /> },
  { id: "platforms", label: "Platforms", icon: <Boxes className="h-4 w-4" /> },
  { id: "review", label: "Review", icon: <Eye className="h-4 w-4" /> },
  {
    id: "claude",
    label: "Claude",
    icon: <AgentPlatformIcon platform="claude" accent className="h-4 w-4" />,
  },
  {
    id: "codex",
    label: "Codex",
    icon: <AgentPlatformIcon platform="codex" accent className="h-4 w-4" />,
  },
  {
    id: "cursor",
    label: "Cursor",
    icon: <AgentPlatformIcon platform="cursor" accent className="h-4 w-4" />,
  },
  {
    id: "grok",
    label: "Grok",
    icon: <AgentPlatformIcon platform="grok" accent className="h-4 w-4" />,
  },
  {
    id: "opencode",
    label: "OpenCode",
    icon: <AgentPlatformIcon platform="opencode" accent className="h-4 w-4" />,
  },
  {
    id: "pi",
    label: "Pi",
    icon: <AgentPlatformIcon platform="pi" accent className="h-4 w-4" />,
  },
  { id: "skills", label: "Skills", icon: <Sparkles className="h-4 w-4" /> },
  { id: "terminal", label: "Terminal", icon: <Terminal className="h-4 w-4" /> },
  { id: "network", label: "Network", icon: <Shield className="h-4 w-4" /> },
  { id: "web-client", label: "Web client", icon: <Globe2 className="h-4 w-4" /> },
  { id: "previews", label: "Browser previews", icon: <MonitorPlay className="h-4 w-4" /> },
  { id: "mcp-servers", label: "MCP servers", icon: <Server className="h-4 w-4" /> },
  { id: "mcp", label: "Control MCP", icon: <Cable className="h-4 w-4" /> },
  { id: "messaging", label: "Messaging", icon: <MessagesSquare className="h-4 w-4" /> },
  { id: "sounds", label: "Sounds", icon: <Volume2 className="h-4 w-4" /> },
  { id: "container", label: "Container", icon: <Container className="h-4 w-4" /> },
  { id: "experimental", label: "Experimental", icon: <FlaskConical className="h-4 w-4" /> },
  { id: "debug", label: "Debug", icon: <Bug className="h-4 w-4" /> },
];

interface SettingsPageProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSection?: GlobalSettingsSection;
  /** Changes on every section request; see FullscreenSettingsLayout. */
  sectionRequest?: number;
}

/** Sections that configure this client rather than a backend. */
const CLIENT_SECTIONS: ReadonlySet<GlobalSettingsSection> = new Set(["connections"]);

/**
 * With several machines in view, every settings page says whose settings it
 * edits: this client, or the machine this window is bound to. Provider
 * credentials, defaults, toolchains, containers and maintenance always
 * target one specific backend.
 */
function SettingsScopeBanner({ section }: { section: GlobalSettingsSection | "" }) {
  const { enabled, boundMachine } = useFederation();
  if (!enabled || !boundMachine) return null;
  if (!section) return null;
  const client = CLIENT_SECTIONS.has(section);
  return (
    <div
      className="mb-5 flex max-w-4xl items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400"
      data-testid="settings-scope"
    >
      {client ? (
        <span>
          <span className="font-medium text-zinc-200">This client</span> — saved on this device
          only.
        </span>
      ) : (
        <>
          <MachineDot colorToken={boundMachine.colorToken} machineName={boundMachine.name} />
          <span>
            <span className="font-medium text-zinc-200">Backend: {boundMachine.name}</span> — these
            settings belong to that machine. Other machines keep their own; open a machine&apos;s
            panel to change its settings.
          </span>
        </>
      )}
    </div>
  );
}

export function SettingsPage({
  open,
  onOpenChange,
  defaultSection,
  sectionRequest,
}: SettingsPageProps) {
  const setConfig = useConfigStore((state) => state.setConfig);
  const isLoading = useConfigStore((state) => state.isLoading);
  const setLoading = useConfigStore((state) => state.setLoading);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  // Load config when page opens
  useEffect(() => {
    if (open && !initialLoadDone) {
      const loadConfig = async () => {
        setLoading(true);
        try {
          const config = await backend.getConfig();
          setConfig(config);
          setInitialLoadDone(true);
        } catch (err) {
          console.error("[settings-page] Failed to load config:", err);
        } finally {
          setLoading(false);
        }
      };
      loadConfig();
    }
  }, [open, initialLoadDone, setConfig, setLoading]);

  return (
    <FullscreenSettingsLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      menuItems={MENU_ITEMS}
      defaultSection={defaultSection}
      sectionRequest={sectionRequest}
    >
      {(activeSection) => (
        <>
          <SettingsScopeBanner section={activeSection} />
          {
            // Skills is a read-only browser of the host's skill directories, not a
            // config form, so it bypasses the auto-saving settings form.
            activeSection === "updates" ? (
              <UpdatesSettings />
            ) : activeSection === "disk-usage" ? (
              <DiskUsageSettings />
            ) : activeSection === "usage" ? (
              <UsageSettings />
            ) : activeSection === "skills" ? (
              <SkillsSettings />
            ) : activeSection === "connections" ? (
              <ConnectionsSettings />
            ) : activeSection === "mcp" ? (
              <McpSettings />
            ) : activeSection === "mcp-servers" ? (
              <ProviderMcpSettings />
            ) : activeSection === "previews" ? (
              <div className="space-y-8">
                <PreviewSettings />
                <WebAnnotationSettings />
              </div>
            ) : activeSection === "messaging" ? (
              <MessagingSettings />
            ) : isLoading && !initialLoadDone ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : activeSection === "sounds" ? (
              <SoundsSettings />
            ) : (
              <GlobalSettings activeSection={activeSection} />
            )
          }
        </>
      )}
    </FullscreenSettingsLayout>
  );
}
