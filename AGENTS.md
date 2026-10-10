This is source code for `openloop` - a framework that automates AI agents.
It is written in swift lang and uses SPM (Swift Package Manager).

There are 3 core components:
- openloop
- runner
- api

`openloop` monitors for workflows and launches them in a continious loop.
`runner` runs a provided worflow that `openloop` sends to it.
`api` implements a minimal flight control: HTTP API + web frontend (website). It allows for inspection of all openloop instances, workflows each instance executed, and logs for the workflow. Instance in this context means an instance of `openloop`: users run openloop inside project folders, hence there may be many instances running concurrently on the same computer. One instance is responsible for executing workflows in its containing folder.

There is also `shared` library which contains a lot of all reusable code. Before writting the first line of code familiarize yourself with whats available in it.
