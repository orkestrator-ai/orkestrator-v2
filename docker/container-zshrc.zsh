# Shared interactive Zsh setup for Orkestrator container terminals.

export HISTFILE=/commandhistory/.bash_history
HISTSIZE=10000
SAVEHIST=10000
setopt APPEND_HISTORY SHARE_HISTORY

if [ -r /usr/share/doc/fzf/examples/key-bindings.zsh ]; then
    source /usr/share/doc/fzf/examples/key-bindings.zsh
fi
if [ -r /usr/share/doc/fzf/examples/completion.zsh ]; then
    source /usr/share/doc/fzf/examples/completion.zsh
fi

eval "$(starship init zsh)"
