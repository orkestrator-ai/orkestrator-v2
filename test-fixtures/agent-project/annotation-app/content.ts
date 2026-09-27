/**
 * Product copy for the annotation fixture. This is the file an agent edits
 * when it implements the fixture's expected source change (see
 * `EXPECTED_SOURCE_CHANGE` in `fixture-data.ts`); `verify-change.ts` checks
 * both this source and the page it renders. All content is synthetic.
 */

export interface FixturePlan {
  id: "starter" | "team" | "enterprise";
  name: string;
  price: string;
  cadence: string;
  cta: string;
  features: string[];
}

export const PLANS: FixturePlan[] = [
  {
    id: "starter",
    name: "Starter",
    price: "$12",
    cadence: "per seat / month",
    cta: "Choose Starter",
    features: ["3 projects", "Community support", "7-day history"],
  },
  {
    id: "team",
    name: "Team",
    price: "$48",
    cadence: "per seat / month",
    cta: "Choose Team",
    features: ["Unlimited projects", "Priority support", "90-day history", "Audit log"],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    cadence: "billed annually",
    cta: "Contact sales",
    features: ["SSO", "Dedicated support", "Unlimited history", "Audit log", "Data residency"],
  },
];

/** Repeated, visually identical buttons: only their row label tells them apart. */
export const FEATURE_TOGGLES = [
  "Email digests",
  "Audit log",
  "Webhooks",
  "Usage alerts",
  "Beta features",
];

export const SETTINGS_COPY = {
  heading: "Workspace settings",
  save: "Save",
  cancel: "Cancel",
  displayNameLabel: "Display name",
  displayName: "Fixture Workspace",
  emailLabel: "Contact email",
  email: "owner@fixture.invalid",
};
