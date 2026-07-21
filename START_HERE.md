# Start Here

Orquesta V4 is a Windows desktop application and Codex skill for people who want to run Codex as a long-lived specialist team, not as one disposable coding agent.

The current hackathon build is `Orquesta V4 Desktop, 0.1.0 preview`. Expect rough edges: it is Windows x64 only and the installer is not code-signed. The project is public so people can try it, break it, and help shape the workflow.

## Who This Is For

Orquesta is most useful if you already feel one of these pains:

- One Codex thread accumulates too much context and starts losing the project shape.
- Disposable subagents are not enough because you want durable specialist roles.
- Creative projects need direct conversations with visual, narrative, gameplay, QA, or implementation specialists.
- You want a local Desktop command room that shows which AI roles exist, what they are doing, and where user action is needed.

If you only need a quick one-file coding task, Orquesta is probably too much.

## What It Does

When Orquesta is started in a project, it creates a file-backed operating layer under `.orquesta/` and uses long-lived Codex threads as roles:

- `orchestrator`: routes work, tracks state, accepts reports.
- `user-support`: organizes questions, user decisions, and repeated-failure intake.
- `orquesta-admin`: shown as Luca in the Desktop, where it explains saved project evidence without changing project state.

Production specialists, such as implementation, dashboard UX, visual art, worldbuilding, or QA, are created only when the actual project needs them.

## Install the Desktop Preview

Download [the Windows x64 installer](https://github.com/ugin-man/orquesta/releases/download/v0.1.0-v4-preview/OrquestaSetup.exe). Windows may show an unknown-publisher warning because this preview is not code-signed.

To run the Desktop from source:

```powershell
npm install
npm install --prefix apps/orquesta-desktop
npm run start:desktop --prefix apps/orquesta-desktop
```

## Install the Skill Only

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
4. Open the Desktop command room, or explain the legacy local dashboard when running the skill alone.
5. Verify that the selected project state is loaded, not just that a window or HTTP server opened.
6. Ask for project intake before generating setup questions.
7. Use your answers to prepare an initial completion map and specialist plan.

## Legacy Browser Dashboard

From the repository root:

```powershell
npm run dashboard
```

Open the URL printed by the command. The default is `http://127.0.0.1:4177/`, but Orquesta will use a nearby free port if that one is already occupied.

## Current Beta Caveats

- Orquesta is not fully autonomous. It is designed to work with the user.
- The Desktop and legacy dashboard are local and file-backed.
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
