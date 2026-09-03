export const MAX_SSH_AGENT_SOCKET_PATH_CHARS = 4_096;

export const SSH_AGENT_SOCKET_PATH_ERROR_MESSAGES = {
  tooLong: "SSH agent socket path is too long.",
  containsNull: "SSH agent socket path must not contain NUL characters.",
  notAbsolute: "SSH agent socket path must be an absolute path.",
} as const;
