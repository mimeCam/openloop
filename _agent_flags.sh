#!/usr/bin/env bash
# Adding an agent: extend the switch + Dockerfile ARG/install steps + install_dev.sh prune globs

WITH_CC=0
WITH_OC=0
WITH_MV=0
for arg in "$@"; do
    case "$arg" in
        --with-claude-code)  WITH_CC=1 ;;
        --with-opencode)     WITH_OC=1 ;;
        --with-mistral-vibe) WITH_MV=1 ;;
        *)
            echo "Unknown flag: $arg" >&2
            echo "Usage: $0 [--with-claude-code] [--with-opencode] [--with-mistral-vibe]" >&2
            exit 1
            ;;
    esac
done

case "$WITH_CC$WITH_OC$WITH_MV" in
    [01][01][01]) ;;
    *)
        echo "ASSERT: WITH_CC/WITH_OC/WITH_MV must each be 0 or 1, got $WITH_CC/$WITH_OC/$WITH_MV" >&2
        exit 1
        ;;
esac
