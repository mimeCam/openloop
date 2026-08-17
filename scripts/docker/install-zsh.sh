#!/bin/sh
set -eu

ZSH_IN_DOCKER_VERSION=1.2.0
REMOTE_SCRIPT_URL="https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh"
REMOTE_SCRIPT="/tmp/zsh-in-docker-remote.sh"
LOCAL_SCRIPT="$(dirname "$0")/zsh-in-docker.sh"

run_installer() {
    sh "$1" \
        -p git \
        -p fzf \
        -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
        -a "source /usr/share/doc/fzf/examples/completion.zsh" \
        -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
        -x
}

try_remote() {
    wget -O "$REMOTE_SCRIPT" "$REMOTE_SCRIPT_URL" &&
        run_installer "$REMOTE_SCRIPT"
}

use_local_fallback() {
    echo ">> remote zsh-in-docker failed, falling back to vendored: $LOCAL_SCRIPT"
    run_installer "$LOCAL_SCRIPT"
}

try_remote || use_local_fallback
