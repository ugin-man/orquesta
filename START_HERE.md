# Start Here

Orquesta is a Windows desktop application and Codex skill for projects that benefit from a persistent team of AI specialists.

The current public preview is **0.4.0-preview.1** for Windows x64.

## Install

Download the installer or portable ZIP from [GitHub Releases](https://github.com/ugin-man/orquesta/releases/latest).

The preview is unsigned, so Windows may show an unknown-publisher warning.

## Create a project

1. Open Orquesta.
2. Select or create a project folder.
3. Describe what you want to build.
4. Answer the initial setup questions.
5. Orquesta prepares the project state and the first specialist team.

The project keeps its Orquesta state under `.orquesta/`. Keep that directory when updating or moving a managed project.

## What to expect

Orquesta separates project work into specialist roles and keeps their handoffs and results visible. The exact team depends on the project: an application may need implementation and QA specialists, while a creative project may also need visual, narrative, research, or other roles.

The Desktop shows the project, team, tasks, saved records, conversations, and anything waiting for your input.

## Run from source

Windows x64, Node.js 22.12.0 or newer, and an available Codex session are required.

```powershell
git clone https://github.com/ugin-man/orquesta.git
cd orquesta
npm install
npm install --prefix apps/orquesta-desktop
npm run start:desktop --prefix apps/orquesta-desktop
```

## Skill-only install

```powershell
$skillRoot = "$env:USERPROFILE\.codex\skills\orquesta"
New-Item -ItemType Directory -Force -Path $skillRoot
node .\scripts\sync-orquesta-skill.js --target $skillRoot
node .\scripts\sync-orquesta-skill.js --check --target $skillRoot
```

Restart Codex, open the target project, and ask Codex to use the `orquesta` skill.

## Feedback

If installation fails or the workflow is confusing, open an issue with your Windows version, install method, what you tried, what you expected, and what happened. Do not include secrets or private project data.
