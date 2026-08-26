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
} from "lucide-react";
import {
  ClaudeIcon,
  CodexIcon,
  CursorAgentIcon,
  GrokBuildIcon,
  PiIcon,
  OpenCodeIcon,
} from "@/components/icons/AgentIcons";
import { GlobalSettings } from "./GlobalSettings";
import { SkillsSettings } from "./SkillsSettings";
import { McpSettings } from "./McpSettings";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "./FullscreenSettingsLayout";

const MENU_ITEMS: SettingsMenuItem[] = [
  { id: "general", label: "General", icon: <Settings2 className="h-4 w-4" /> },
  { id: "defaults", label: "Defaults", icon: <SlidersHorizontal className="h-4 w-4" /> },
  { id: "platforms", label: "Platforms", icon: <Boxes className="h-4 w-4" /> },
  { id: "review", label: "Review", icon: <Eye className="h-4 w-4" /> },
  { id: "claude", label: "Claude", icon: <ClaudeIcon className="h-4 w-4" /> },
  { id: "codex", label: "Codex", icon: <CodexIcon className="h-4 w-4 text-emerald-400" /> },
  { id: "cursor", label: "Cursor", icon: <CursorAgentIcon className="h-4 w-4" /> },
  { id: "grok", label: "Grok", icon: <GrokBuildIcon className="h-4 w-4" /> },
  { id: "opencode", label: "OpenCode", icon: <OpenCodeIcon className="h-4 w-4" /> },
  { id: "pi", label: "Pi", icon: <PiIcon className="h-4 w-4 text-amber-400" /> },
  { id: "skills", label: "Skills", icon: <Sparkles className="h-4 w-4" /> },
  { id: "terminal", label: "Terminal", icon: <Terminal className="h-4 w-4" /> },
  { id: "network", label: "Network", icon: <Shield className="h-4 w-4" /> },
  { id: "web-client", label: "Web client", icon: <Globe2 className="h-4 w-4" /> },
  { id: "mcp", label: "MCP", icon: <Cable className="h-4 w-4" /> },
  { id: "container", label: "Container", icon: <Container className="h-4 w-4" /> },
  { id: "experimental", label: "Experimental", icon: <FlaskConical className="h-4 w-4" /> },
  { id: "debug", label: "Debug", icon: <Bug className="h-4 w-4" /> },
];

interface SettingsPageProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsPage({ open, onOpenChange }: SettingsPageProps) {
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
    >
      {(activeSection) =>
        // Skills is a read-only browser of the host's skill directories, not a
        // config form, so it bypasses GlobalSettings and its Reset/Save bar.
        activeSection === "skills" ? (
          <SkillsSettings />
        ) : activeSection === "mcp" ? (
          <McpSettings />
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
