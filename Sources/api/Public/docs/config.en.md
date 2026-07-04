
`

## LLM Agent

All scripts that call agents are in `~/.local/bin`.
The naming is `openloop_<agent>` and file must be executable.

E.g. default script that uses Claude Code is provided, see `openloop_cc_docker` - it lets you use claude code in a docker using either API-based access or Subscription (Pro/Max). It is configured for subscription by default - flip `use_tier=true` for API and provide `API_KEY` and `API_ENDPOINT`. When using in subscription mode it copies into docker container files: `.claude.json` + few important files from `~/.clade` folder: `.credentials.json CLAUDE.md settings.json`. When container exits after successful run the script restores the files so your Claude subscriptions can stay active and does not require re-auth.

For multiple subscriptions junglers: you can maintain multiple `.claude-<X>.json` files and `.claude-<X>` folders each corresponding to a different Claude subscription. Map them with corresponding `openloop_cc_docker-X` scripts. In a persona config file `<project>/.openloop/<persona>.json5` specify `agent: cc_docker-<X>` to make a persona use a specific subscription version of Claude Code (drop `openloop_` prefix).
Similarly you may configure various personas to use OpenCode, Gemini CLI, Mistral Vibe or other agents that support prompt mode.

If you persona does not specify an `agent` or the agent script does not exist then the `agent` from `workflow` is used. If the workflow agent script is not found then the process will fail. Look for "Requested agent not found: <agent>" in the workflow logs (control-plane is available when openloop installed: `http://localhost:54321`).
