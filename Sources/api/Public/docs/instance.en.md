# Instances

## What is an instance?

An Instance is an autonomous OpenLoop runner that lives on your machine. It's a background worker that runs your workflows on schedule.

You set it up once. It keeps working. Forever.
You then watch the results and tweak prompts to better suit your needs.

## How it works

Each instance watches a folder containing your personas and workflows. When a workflow's schedule fires—the instance wakes up and runs that workflow.

[Workflows](workflow) represent processes in a company.
[Personas](persona) represent opinionated employees each performing its role.

Think how your company works and encode it into a set of structured workflows.

An instance is your always-on simulation. Set it up, run experiments, iterate, and let the workflow teach you what works. Go do something else while your organizational sandbox runs itself.

## The folder-watching magic

Instances are tied to folders. This means:
- Different projects have different instances
- Each instance can define its own set of [personas](persona) and [workflows](workflow)
- You can spin up an instance for a specific project and shut it down when done

## The folder hierarchy

Project folders nest, and an instance reads through the whole ladder: its own `.openloop` first, then each parent project's up to your home folder, and the global share — `~/.local/share/openloop` — last. Lookups are always nearest-first: the closest definition wins.

What resolves through the ladder:
- [Personas](persona), [workflows](workflow) and persona knowledge — define them once at the top, reuse them in every project below.
- Node-enabled functionality (MCP servers on graph nodes) travels attached to personas — see [Personas](persona) for the approved sharing flow.

What never travels: execution state. Run logs and artifacts always land in the running project's `.openloop` — parent projects and the global share are read-only inputs and are never written to.
