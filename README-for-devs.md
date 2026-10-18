- Graph node storage
    - Node metadata lives in `.openloop/nodes/<UUID>.json5` (one file per
      node, `NodeStore.swift`) — it is the source of truth and is meant to be
      committed: node trees `git merge` across machines. Do NOT add `nodes/`
      to `.gitignore`.
    - Timestamps inside node files are reference-date Doubles (seconds since
      2001-01-01) — same format as in memory and in the run-log DB; the API
      converts to unix ms at the edge.
    - Only graph RUN logs stay in sqlite (`.openloop/logs.db`,
      `graph_run_logs`). The old `graph_nodes` table was migrated to files
      and renamed to `graph_nodes_bak` (kept for rollback; dropping it is a
      later release task).
    - Upgrade note: after migrating an instance, restart its `api` binary —
      an old binary still writes to the renamed table.
- MCP authorization keys (`SecretStore.swift`)
    - Keys NEVER live in node files (they are committed) — they live per
      machine in `.openloop/secrets.json5`, keyed by MCP URL, gitignored,
      owner-only (0600).

- Examples
    - `feature-work` workflow 
        - visual development
        - screenshot picking as feature developement
            - send asks in plain language
            - ai researches/codes/tests
            - you pick 1 from 2 screenshots: before and after
        - 
        - Personas
            - Architect
            - UI Designer
            - UX Researcher
        - Code agent features
            - skills
        - Custom Git strategies
            - Commit step as Persona's agent
            - New Workspace as step
        - Agents as commands 
            - A/B with screenshots
    - 
    - `living-web` workflow
    - 
    - `24/7` workflow
        - dedicated markdown file(s) as state
-
