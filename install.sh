#!/usr/bin/env bash
#
# Wrapper around install_dev.sh.
# Source this script to have PATH updated in your current shell:
#   source install.sh
#

cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

./install_dev.sh "$@" && export PATH="$HOME/.local/bin:$PATH"
