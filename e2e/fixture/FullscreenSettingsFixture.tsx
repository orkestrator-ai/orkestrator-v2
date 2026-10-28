import { ProjectSearchBar } from "@/components/sidebar/ProjectSearchBar";
import { useState } from "react";
import { FullscreenSettingsLayout } from "../../apps/web/src/components/settings/FullscreenSettingsLayout";
import { SettingsMachineStrip } from "../../apps/web/src/components/settings/SettingsMachineStrip";

// Enough sections to overflow a short desktop window, without depending on any
// particular settings consumer's inventory or backend state.
const menuItems = Array.from({ length: 16 }, (_, index) => ({
  id: `section-${index + 1}`,
  label: `Section ${index + 1}`,
  icon: null,
}));
const lastSection = menuItems[menuItems.length - 1].id;

// `?machines`: a command node with machines attached, one of them offline.
// Section 2 stands for a section only the command node has.
const machines = [
  { nodeId: null, name: "Studio", colorToken: "violet", connected: true },
  { nodeId: "bk_desk", name: "Desk", colorToken: "teal", connected: true },
  { nodeId: "bk_build", name: "Build box", colorToken: "amber", connected: true },
  { nodeId: "bk_laptop", name: "Laptop", colorToken: "rose", connected: false },
];
const withSearch = new URLSearchParams(window.location.search).has("search-ui");
const withMachines = new URLSearchParams(window.location.search).has("machines");

export function FullscreenSettingsFixture() {
  const [open, setOpen] = useState(true);
  const [defaultSection, setDefaultSection] = useState(
    new URLSearchParams(window.location.search).get("section") ?? menuItems[0].id,
  );
  const [sectionRequest, setSectionRequest] = useState(0);
  const [machine, setMachine] = useState<string | null>(null);

  return (
    <>
      {/* The page underneath, which the keyboard must not reach while settings are open. */}
      <button type="button">Page underneath</button>
      {withSearch && (
        <ProjectSearchBar
          projects={[]}
          environments={[]}
          onSelectProject={() => {}}
          onSelectEnvironment={() => {}}
        />
      )}
      <FullscreenSettingsLayout
        open={open}
        onOpenChange={setOpen}
        title="Fixture settings"
        menuItems={menuItems}
        defaultSection={defaultSection}
        sectionRequest={sectionRequest}
        headerStart={
          withMachines
            ? (section) => (
                <SettingsMachineStrip
                  options={machines}
                  selected={machine}
                  locked={section === "section-2"}
                  onSelect={setMachine}
                />
              )
            : undefined
        }
        headerActions={
          <button
            type="button"
            onClick={() => {
              setDefaultSection(lastSection);
              setSectionRequest((request) => request + 1);
            }}
          >
            Jump to last section
          </button>
        }
      >
        {(section) => (
          <div className="h-[1200px]" data-testid="settings-content">
            {withSearch && <input aria-label="Settings value" />}
            Content for {section}
            {withMachines
              ? ` on ${section === "section-2" ? "Studio" : (machines.find((m) => m.nodeId === machine)?.name ?? "")}`
              : null}
          </div>
        )}
      </FullscreenSettingsLayout>
    </>
  );
}
