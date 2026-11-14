# 08 – Jobs, CLI and agent use

## US-8.1 Run tools from the browser — Done
As a creator, I want to start every tool from the app, so that I do not need the terminal.
- Tools view: extract, info, blur, normalize, compose, each with its options.
- Preview tabs for every available video of the project.

## US-8.2 Follow a running job — Done
As a creator, I want to see what a job is doing.
- Job list with status and percentage; live log; cancel button.
- Limit: jobs are kept in memory and disappear when the server restarts; one job at a time.

## US-8.3 Use everything from the command line — Done
As a power user, I want every operation available as a CLI command, so that I can script it.
- `tools/reframed.py info | extract | blur-bg | normalize-audio | compose`, each with `--help`.
- `compose` works with the system Python; only `blur-bg` needs the virtual environment.

## US-8.4 Let an AI agent operate the tools — Done
As a user of coding agents, I want the tools described for agents, so that I can ask for edits in plain language.
- `.claude/skills/reframed/SKILL.md`, `AGENTS.md` and `ARCHITECTURE.md` describe formats, commands and conventions.

## US-8.5 Safe local server — Done
As a user, I want the server reachable only from my machine and unable to run arbitrary commands.
- Binds to 127.0.0.1; only known commands, known projects and clamped numeric options are accepted.

## US-8.6 Job history survives restarts — Planned
As a creator, I want past jobs and their logs kept after a restart.

## US-8.7 Batch processing — Planned
As a creator, I want to queue blur + normalize + export for several projects in one go.
