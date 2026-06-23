# Start Here

Orquesta is a Codex skill for people who want to run Codex as a long-lived specialist team, not as one disposable coding agent.

It is currently `0.1.0-beta.2`. Expect rough edges. The project is public so people can try it, break it, and help shape the workflow.

## Who This Is For

Orquesta is most useful if you already feel one of these pains:

- One Codex thread accumulates too much context and starts losing the project shape.
- Disposable subagents are not enough because you want durable specialist roles.
- Creative projects need direct conversations with visual, narrative, gameplay, QA, or implementation specialists.
- You want a local dashboard that shows which AI roles exist, what they are doing, and where user action is needed.

If you only need a quick one-file coding task, Orquesta is probably too much.

## What It Does

When Orquesta is started in a project, it creates a file-backed operating layer under `.orquesta/` and uses long-lived Codex threads as roles:

- `orchestrator`: routes work, tracks state, accepts reports.
- `user-liaison`: organizes user-side tasks and approvals.
- `vision-curator`: turns creative answers into reviewable direction.
- `error-concierge`: turns repeated failures into repair cards.
- `orquesta-admin`: helps with Orquesta setup and configuration.

Production specialists, such as implementation, dashboard UX, visual art, worldbuilding, or QA, are created only when the actual project needs them.

## Install

Install the skill from this repository path:

```text
https://github.com/ugin-man/orquesta/tree/main/orquesta
```

If you are installing manually on Windows:

```powershell
$skillRoot = "$env:USERPROFILE\.codex\skills\orquesta"
New-Item -ItemType Directory -Force -Path $skillRoot
Copy-Item -Recurse -Force .\orquesta\* $skillRoot
```

Restart Codex after installing a new skill.

## First Prompt

Open a new Codex thread in the project you want Orquesta to manage and say something like:

```text
Use the orquesta skill to set up this project.
```

Then describe what you want to build. For example:

```text
I want to make a browser game. Please use Orquesta to set up the project team and dashboard.
```

## Expected First Run

On a healthy first run, Orquesta should:

1. Treat the current chat as the orchestrator.
2. Create the foundation roles.
3. Initialize `.orquesta/` state files.
4. Start or explain the local dashboard.
5. Verify the dashboard through `/api/state`, not just an HTTP 200.
6. Ask for project intake before generating setup questions.
7. Use your answers to prepare an initial completion map and specialist plan.

## Dashboard

From the repository root:

```powershell
npm run dashboard
```

Open the URL printed by the command. The default is `http://127.0.0.1:4177/`, but Orquesta will use a nearby free port if that one is already occupied.

## Current Beta Caveats

- Orquesta is not fully autonomous. It is designed to work with the user.
- The dashboard is local and file-backed.
- Some Codex thread-management actions still depend on what tools are available in the current Codex environment.
- GitHub-install bootstrap has passed once, but more clean-project tests are needed.
- Real multi-agent operation should be judged by handoffs, specialist reports, and orchestrator acceptance, not by the dashboard alone.

## Looking For Testers

The most useful feedback right now is:

- Did install work?
- Did first setup make sense?
- Did the dashboard show the real team?
- Did you understand what to do next?
- Did any specialist work actually get delegated and reported back?
- Where did the workflow feel confusing or too heavy?

Open an issue or contact the maintainer if you want to test Orquesta with a real Codex project.
