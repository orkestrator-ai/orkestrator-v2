import { useEffect, useState } from "react";
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
} from "lucide-react";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { GlobalSettings } from "./GlobalSettings";
import { SkillsSettings } from "./SkillsSettings";
import { McpSettings } from "./McpSettings";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "./FullscreenSettingsLayout";
import { MessagingSettings } from "./MessagingSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";

const MENU_ITEMS: SettingsMenuItem<GlobalSettingsSection>[] = [
  { id: "general", label: "General", icon: <Settings2 className="h-4 w-4" /> },
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
  { id: "mcp", label: "MCP", icon: <Cable className="h-4 w-4" /> },
  { id: "messaging", label: "Messaging", icon: <MessagesSquare className="h-4 w-4" /> },
  { id: "container", label: "Container", icon: <Container className="h-4 w-4" /> },
  { id: "experimental", label: "Experimental", icon: <FlaskConical className="h-4 w-4" /> },
  { id: "debug", label: "Debug", icon: <Bug className="h-4 w-4" /> },
];

interface SettingsPageProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSection?: GlobalSettingsSection;
}

export function SettingsPage({ open, onOpenChange, defaultSection }: SettingsPageProps) {
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
    >
      {(activeSection) =>
        // Skills is a read-only browser of the host's skill directories, not a
        // config form, so it bypasses GlobalSettings and its Reset/Save bar.
        activeSection === "skills" ? (
          <SkillsSettings />
        ) : activeSection === "connections" ? (
          <ConnectionsSettings />
        ) : activeSection === "mcp" ? (
          <McpSettings />
        ) : activeSection === "messaging" ? (
          <MessagingSettings />
        ) : isLoading && !initialLoadDone ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <GlobalSettings activeSection={activeSection} onSaveSuccess={() => onOpenChange(false)} />
        )
      }
    </FullscreenSettingsLayout>
  );
}
