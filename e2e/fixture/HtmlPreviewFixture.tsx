import { onAppShortcut } from "@/lib/app-shortcuts";
import { useEffect, useState } from "react";
import { HtmlFileTab } from "@/components/html/HtmlFileTab";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";

export function HtmlPreviewFixture() {
  const [saves, setSaves] = useState(0);
  const [searches, setSearches] = useState(0);
  const [settings, setSettings] = useState(0);
  useEffect(() => {
    const search = onAppShortcut("search-projects", () => setSearches((n) => n + 1));
    const setting = onAppShortcut("open-settings", () => setSettings((n) => n + 1));
    return () => {
      search();
      setting();
    };
  }, []);
  return (
    <main className="h-screen">
      <output aria-label="Searches">{searches}</output>
      <output aria-label="Settings">{settings}</output>
      <output aria-label="Saves">{saves}</output>
      <KeyboardShortcutsDialog platform="mac" />
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="30%">
          <p>Files</p>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel>
          <div className="relative h-full">
            <HtmlFileTab
              tabId="html-preview-fixture"
              filePath="report.html"
              initialContent={
                '<h1>Report</h1><a href="#end">Jump</a><p style="height:1200px">Contents</p><h2 id="end">End</h2>'
              }
              language="html"
              isActive
              isSaving={false}
              onSave={async () => {
                setSaves((n) => n + 1);
                return true;
              }}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  );
}
