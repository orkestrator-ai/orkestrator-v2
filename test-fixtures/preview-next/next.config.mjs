/** @type {import("next").NextConfig} */
const nextConfig = {
  // The dev overlay's badge is not under test and would cover page controls.
  devIndicators: false,
  // Next.js 16.4 otherwise writes an AGENTS.md into the project on `next dev`.
  agentRules: false,
};

export default nextConfig;
