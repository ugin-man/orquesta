# Orquesta

Orquesta is a local-first Windows application and Codex skill for running long-lived AI specialists as a coordinated project team.

Instead of putting an entire project into one growing conversation, Orquesta gives different kinds of work to persistent specialist roles, keeps project state in the repository, and makes handoffs, questions, user decisions, and results visible in one Desktop workspace.

## What it does

- Creates persistent specialist roles for implementation, visual work, writing, QA, research, and other project needs.
- Routes work to the relevant specialist instead of making one agent handle everything.
- Keeps project-owned state under `.orquesta/` so important context survives long projects and new sessions.
- Shows the active team, tasks, records, pending user actions, and conversations in Orquesta Desktop.
- Lets specialists return reports or artifacts that can be reviewed before the project moves on.
- Uses the user's existing Codex environment and approval boundaries.

Orquesta is intended for projects that last days or months and benefit from multiple distinct areas of expertise. For a small one-file task, it is usually unnecessary.

## Download

The current public preview is **Orquesta Desktop 0.4.0-preview.1** for Windows x64.

Download the installer or portable ZIP from [GitHub Releases](https://github.com/ugin-man/orquesta/releases/latest).

The preview is currently unsigned, so Windows may show an unknown-publisher warning. Code signing, automatic updates, macOS, and Linux packages are not available yet.

## First run

1. Install and open Orquesta.
2. Choose an existing project folder or create a new one.
3. Describe what you are building and answer the initial setup questions.
4. Orquesta creates the initial team and opens the project workspace.
5. Continue working through the Desktop or through the connected Codex project.

Existing Orquesta projects keep their state in `.orquesta/`. Do not delete that directory when updating the app.

## Run from source

Windows x64, Node.js 22.12.0 or newer, and an available Codex session are required.

```powershell
git clone https://github.com/ugin-man/orquesta.git
cd orquesta
npm install
npm install --prefix apps/orquesta-desktop
npm run start:desktop --prefix apps/orquesta-desktop
```

## Install the Codex skill only

```powershell
$skillRoot = "$env:USERPROFILE\.codex\skills\orquesta"
New-Item -ItemType Directory -Force -Path $skillRoot
node .\scripts\sync-orquesta-skill.js --target $skillRoot
node .\scripts\sync-orquesta-skill.js --check --target $skillRoot
```

Restart Codex after installing the skill, then start a new project thread and ask it to use the `orquesta` skill.

## Project data

Orquesta stores project state inside the managed project rather than in one chat history. The Desktop is local-first; repository access and Codex communication are handled outside the sandboxed renderer.

The browser dashboard included in the repository is a diagnostic surface. Orquesta Desktop is the normal interface.

## Contributing and feedback

Bug reports, usability feedback, and contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

For a small disposable test project, see [the public preview test](docs/testing/moltbook-ai-preview-test.md).

## License

MIT. See [LICENSE](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
