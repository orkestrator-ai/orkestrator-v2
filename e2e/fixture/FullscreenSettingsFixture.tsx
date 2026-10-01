import { useState } from "react";
import { FullscreenSettingsLayout } from "../../apps/web/src/components/settings/FullscreenSettingsLayout";

// Enough sections to overflow a short desktop window, without depending on any
// particular settings consumer's inventory or backend state.
const menuItems = Array.from({ length: 16 }, (_, index) => ({
  id: `section-${index + 1}`,
  label: `Section ${index + 1}`,
  icon: null,
}));
const lastSection = menuItems[menuItems.length - 1].id;

export function FullscreenSettingsFixture() {
  const [open, setOpen] = useState(true);
  const [defaultSection, setDefaultSection] = useState(
    new URLSearchParams(window.location.search).get("section") ?? menuItems[0].id,
  );
  const [sectionRequest, setSectionRequest] = useState(0);

  return (
    <FullscreenSettingsLayout
      open={open}
      onOpenChange={setOpen}
      title="Fixture settings"
      menuItems={menuItems}
      defaultSection={defaultSection}
      sectionRequest={sectionRequest}
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
          Content for {section}
        </div>
      )}
    </FullscreenSettingsLayout>
  );
}
