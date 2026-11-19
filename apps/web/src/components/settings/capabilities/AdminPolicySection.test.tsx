import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { CapabilityAdminPolicyView } from "@orkestrator/protocol/capability-admin-policy";

import { capabilitiesApi } from "@/lib/backend/capabilities";

import { AdminPolicySection } from "./AdminPolicySection";

const policy: CapabilityAdminPolicyView = {
  revision: 3,
  forbiddenSources: ["git:github.com/untrusted/"],
  forbiddenComponents: [],
  blocked: [
    {
      packageId: "git:github.com/untrusted/tools//lint",
      displayName: "lint",
      entry: "git:github.com/untrusted/",
      assigned: true,
    },
  ],
  blockedTruncated: 0,
};

afterEach(() => {
  cleanup();
  mock.restore();
});

test("lists the policy and what it blocks, and explains that policy wins", async () => {
  spyOn(capabilitiesApi, "getCapabilityAdminPolicy").mockResolvedValue(policy);
  render(<AdminPolicySection />);
  const section = await screen.findByRole("region", { name: "Policy" });
  expect(section.textContent).toContain("win over every setup");
  const sources = await within(section).findByRole("list", { name: "Forbidden sources" });
  expect(sources.textContent).toContain("git:github.com/untrusted/");
  expect(within(section).getByText("No component is forbidden.")).toBeTruthy();
  const blocked = within(section).getByRole("list", { name: "Packages blocked by policy" });
  expect(blocked.textContent).toContain("Blocked by policy");
  expect(blocked.textContent).toContain("lint");
  expect(blocked.textContent).toContain("assigned in a setup");
});

test("adds a normalised entry and removes one, each against the loaded revision", async () => {
  spyOn(capabilitiesApi, "getCapabilityAdminPolicy").mockResolvedValue(policy);
  const set = spyOn(capabilitiesApi, "setCapabilityAdminPolicy").mockResolvedValue(policy);
  render(<AdminPolicySection />);
  const input = await screen.findByLabelText("Forbid a component");
  fireEvent.change(input, { target: { value: "hook" } });
  fireEvent.click(screen.getAllByRole("button", { name: /Forbid/ })[1]!);
  await waitFor(() => expect(set).toHaveBeenCalledWith(3, { forbiddenComponents: ["kind:hook"] }));

  fireEvent.click(screen.getByRole("button", { name: "Allow git:github.com/untrusted/ again" }));
  await waitFor(() => expect(set).toHaveBeenLastCalledWith(3, { forbiddenSources: [] }));
});

test("an entry that could never match is refused before it is sent", async () => {
  spyOn(capabilitiesApi, "getCapabilityAdminPolicy").mockResolvedValue(policy);
  const set = spyOn(capabilitiesApi, "setCapabilityAdminPolicy").mockResolvedValue(policy);
  render(<AdminPolicySection />);
  const input = await screen.findByLabelText("Forbid a source");
  fireEvent.change(input, { target: { value: "github.com" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
  const hint = document.getElementById(input.getAttribute("aria-describedby")!);
  expect(hint?.textContent).toContain("Start with git:");
  expect(set).not.toHaveBeenCalled();
});

test("a conflict is shown in an alert and the current policy is read again", async () => {
  const load = spyOn(capabilitiesApi, "getCapabilityAdminPolicy").mockResolvedValue(policy);
  spyOn(capabilitiesApi, "setCapabilityAdminPolicy").mockRejectedValue(
    new Error("The policy changed since it was loaded. Review the current policy and try again."),
  );
  render(<AdminPolicySection />);
  const input = await screen.findByLabelText("Forbid a source");
  fireEvent.change(input, { target: { value: "registry:team" } });
  fireEvent.submit(input.closest("form")!);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The policy changed since it was loaded.");
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  // The draft stays, to try again on the current policy.
  expect((input as HTMLInputElement).value).toBe("registry:team");
});
