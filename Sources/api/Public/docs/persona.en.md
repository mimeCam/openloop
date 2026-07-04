# Personas

Imagine how your company works. Sarah the engineer, Marcus the designer, Priya the product manager—each person brings their own expertise, opinions, and boundaries. Sarah doesn't approve budgets. Marcus doesn't architect systems. Priya doesn't pick button colors.

**Personas are how you encode real people into OpenLoop.**

## What makes a good persona?

A persona is an AI agent with a specific role, personality, and task. The key is making them *opinionated*. A generic "code reviewer" gives generic feedback. But a persona modeled after your actual engineer—who hates over-engineering and will fight you on premature optimization—that persona gives useful feedback.

## The four parts of a persona

- **Name** — What you call it (e.g., "Sarah-the-Code-Stickler")
- **Role** — Its expertise (e.g., "Senior Software Engineer, 10 years experience")
- **About** — Personality, context, how it approaches work
- **Task** — What it should do when activated

## Real example

Let's say you have a senior engineer named Sarah. In real life, Sarah:
- Reviews every PR with a fine-tooth comb
- Hates "clever" code and prefers boring, obvious solutions
- Has strong opinions about code organization

Here's how you encode Sarah as a persona:

**Name:** Sarah-the-Code-Stickler
**Role:** Senior Software Engineer
**About:** 10 years experience. Believes boring code is good code. Strong opinions about separation of concerns and naming. Hates premature abstraction.
**Task:** Review the provided frontend code changes. Be thorough. Check for code organization, and over-engineering. Be opinionated—don't just say "looks good" unless it actually does.

When this persona runs in a workflow, it brings Sarah's perspective. No generic "As an AI language model, I think..." responses. It responds like Sarah would.

## Writing effective tasks

A well-crafted task follows a simple formula:

1. **Start with a verb** — `Create`, `Implement`, `Review`, `Analyze`, `Refactor`, `Debug`
2. **Define the scope** — What to do and how to approach it (2-3 sentences max)
3. **Set boundaries** — If outside your expertise, acknowledge it and stop

**Good task:**
> Review frontend code changes. Check for naming conventions and over-engineering. If this involves domain logic outside your expertise (e.g., financial calculations), say so and limit feedback to code quality only.

**Poor task:**
> Help with the code. (Too vague, no clear action, no boundaries)

## Why opinionated personas matter

Generic AI agents give generic answers. Opinionated personas give *useful* answers.

A designer persona shouldn't suggest architecture changes. A CTO persona shouldn't comment on button colors. Each persona owns its lane. This is how you get AI that actually works like your team does.

## Personas have territory

This isn't just about "better output"—it's about **realistic collaboration**.

When you create personas, you're not just writing prompts. You encode persona's expertise in its folder, by placing its "knowledge" files. Usually this is markdown files that LLM agent can read, understand and act on it.

## The sandbox: experiment with organizational structures

Here's the fun part. You're not stuck with how your company works—you can model how you *wish* it worked:

> What happens when you:
> - Add a security reviewer to every feature workflow?
> - Have design review happen *before* development instead of after?
> - Remove a bottleneck—what breaks when the CTO doesn't sign off?
> - Discover you're missing a role—maybe you need a technical writer?

Your personas will respond authentically because they have real opinions and territories. The simulation teaches you something about process—without the real-world cost of reorganizing your actual team.

## How personas fit together

- **[Workflows](workflow)** pull personas into structured levels where levels run like in a "waterfall" process - not "agile"
- **[Instances](instance)** are the company where all your personas live and work

Think of personas as your team members. Workflows are the processes they follow.

## Personas and LLM Agents

Openloop launches each persona as its own LLM agent (OpenCol, Claude Code, Mistral Vibe, ...). That's how you can use multiple LLM agents concurrently to work together on the same task.
You can assign individual agent to each persona.

## MCPs

When openloop launches an LLM agent for a particular persona, you may customize the list of MCP servers to use, or use default set.

Below example uses `mcp-yolo.json` filename that related to Claude Code agent. Other agents may use other file names, so account for a different file name in the example below.

Default mcp config file is located at `<project-folder>/.openloop/mcp-yolo.json`. By default it is empty, you may add your project-specific MCPs.
If you want a <persona> to use a custom set of MCPs you may create `<project-folder>/.openloop/personas/<persona-id>-mcp-yolo.json` and configure as desired.

Openloop will first look for persona's custom mcp file and then for project-wide file.

For example see `scripts/yolo/openloop_cc_docker` in the openloop source code or `~/.local/bin/openloop_cc_docker` if you have installed openloop already.
