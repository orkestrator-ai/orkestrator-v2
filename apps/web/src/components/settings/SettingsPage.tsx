import { useEffect, useState } from "react";
import { useFederation } from "@/components/federation/FederationProvider";
import { MachineDot } from "@/components/federation/MachineDot";
import { useCommandNode } from "@/components/federation/useCommandNode";
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
  Network,
  MonitorPlay,
  Volume2,
  Server,
  HardDrive,
} from "lucide-react";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { GlobalSettings } from "./GlobalSettings";
import { SkillsSettings } from "./SkillsSettings";
import { DiskUsageSettings } from "./DiskUsageSettings";
import { McpSettings } from "./McpSettings";
import { ProviderMcpSettings } from "./mcp-servers/ProviderMcpSettings";
import { PreviewSettings } from "./PreviewSettings";
import { WebAnnotationSettings } from "./WebAnnotationSettings";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "./FullscreenSettingsLayout";
import { MessagingSettings } from "./MessagingSettings";
import { MachinesSettings } from "./machines/MachinesSettings";
import { SoundsSettings } from "./SoundsSettings";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";

const MENU_ITEMS: SettingsMenuItem<GlobalSettingsSection>[] = [
  { id: "general", label: "General", icon: <Settings2 className="h-4 w-4" /> },
  { id: "machines", label: "Machines", icon: <Network className="h-4 w-4" /> },
  { id: "disk-usage", label: "Disk usage", icon: <HardDrive className="h-4 w-4" /> },
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

/**
 * Every settings page says whose settings it edits. They are the command
 * node's: the machine this client is connected to, which hands them down to
 * the machines it controls. They stay the command node's while the window
 * works on another machine; only machine-specific details (accounts, disk,
 * tools, logs) are that machine's. Another machine's own settings are opened
 * from that machine.
 */
function SettingsScopeBanner({ section }: { section: GlobalSettingsSection | "" }) {
  const { enabled, boundMachine } = useFederation();
  const commandNode = useCommandNode();
  if (!commandNode || !section) return null;
  // With a single machine there is nothing to tell apart, except in Machines.
  if (!enabled && section !== "machines") return null;
  const name = <span className="font-medium text-zinc-200">{commandNode.name}</span>;
  return (
    <div
      className="mb-5 flex max-w-4xl items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400"
      data-testid="settings-scope"
    >
      <MachineDot
        colorToken={commandNode.colorToken}
        machineName={commandNode.name}
        className="mt-1"
      />
      <span>
        <span className="font-medium text-zinc-200">Command node: {commandNode.name}.</span>{" "}
        {section === "machines" ? (
          <>
            These are the machines {name} controls. Settings changed in this app are for {name} only
            and apply to its work on every machine; a machine&apos;s individual settings are opened
            from that machine.
          </>
        ) : commandNode.workspaceHere ? (
          <>
            These settings are for {name} only and apply to the work it runs on every machine it
            controls. Each machine&apos;s individual settings are opened from that machine (Settings
            → Machines).
          </>
        ) : (
          <>
            These settings are for {name} only and apply to the work it runs on every machine it
            controls. Machine-specific details (accounts, disk, tools, logs) are those of{" "}
            <span className="font-medium text-zinc-200">
              {boundMachine?.name ?? "this machine"}
            </span>
            , where this window is working; its other settings are opened from that machine.
          </>
        )}
      </span>
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
            activeSection === "machines" ? (
              <MachinesSettings />
            ) : activeSection === "disk-usage" ? (
              <DiskUsageSettings />
            ) : activeSection === "skills" ? (
              <SkillsSettings />
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
