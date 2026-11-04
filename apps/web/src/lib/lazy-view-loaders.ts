// Keep the import promises explicit so failure tests can reject the same loaders
// React.lazy uses, without substituting a second lazy component.
export async function loadAgentMailMarkdown() {
  return { default: (await import("@/components/agent-mail/AgentMailMarkdown")).AgentMailMarkdown };
}

export async function loadTerminalPortalHost() {
  return { default: (await import("@/components/terminal/TerminalPortalHost")).TerminalPortalHost };
}

export async function loadPullRequestView() {
  return { default: (await import("@/components/pull-requests/PullRequestView")).PullRequestView };
}

export async function loadPullRequestList() {
  return { default: (await import("@/components/pull-requests/PullRequestList")).PullRequestList };
}
