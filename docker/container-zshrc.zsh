# Shared interactive Zsh setup for Orkestrator container terminals.

if (( EUID == 0 )); then
    export HISTFILE=/root/.zsh_history
else
    export HISTFILE=/commandhistory/.bash_history
fi
HISTSIZE=10000
SAVEHIST=10000
setopt APPEND_HISTORY SHARE_HISTORY

# Oh My Zsh previously initialized compsys before loading its Git and fzf
# plugins. Keep that shell behavior without retaining the prompt framework.
autoload -Uz compinit
# /usr/local/share is intentionally node-owned so global package installs stay
# writable. Root therefore sees its completion directory as group-insecure;
# -u accepts this known container ownership model instead of prompting on every
# orkroot shell startup.
compinit -u

if [ -r /etc/orkestrator/git-aliases.zsh ]; then
    source /etc/orkestrator/git-aliases.zsh
fi

if [ -r /usr/share/doc/fzf/examples/key-bindings.zsh ]; then
    source /usr/share/doc/fzf/examples/key-bindings.zsh
fi
if [ -r /usr/share/doc/fzf/examples/completion.zsh ]; then
    source /usr/share/doc/fzf/examples/completion.zsh
fi

if command -v starship >/dev/null 2>&1; then
    eval "$(starship init zsh)"
fi
