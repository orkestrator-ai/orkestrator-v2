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
# Root never loads completion functions from a directory it does not own: -i
# skips any insecure fpath entry silently. The image keeps fpath root-owned
# (only npm-global under /usr/local/share belongs to node), so nothing is
# skipped today; a directory node could write would be. node keeps -u, which
# only trusts directories node itself can already write.
if (( EUID == 0 )); then
    compinit -i
else
    compinit -u
fi

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
