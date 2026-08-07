# Orquesta Desktop

Orquesta Desktop is the Windows interface for Orquesta projects.

It brings the project team, tasks, conversations, user actions, and saved records into one local workspace while keeping repository access and Codex communication outside the sandboxed renderer.

## Features

- Open and switch between Orquesta projects.
- View the full specialist team on the project map.
- Send text and images to the orchestrator or a selected specialist.
- Read project conversation history.
- Review approval requests and respond with the choices provided by Codex.
- Inspect project records and specialist results.
- Keep project state local and file-backed.
- Fall back cleanly when live Codex execution is unavailable instead of presenting prepared work as completed work.

## Requirements

- Windows 10 or 11, x64.
- Installer and portable builds do not require Node.js.
- Source builds require Node.js 22.12.0 or newer.
- Codex actions require an available Codex session.

## Download

Use the latest Windows installer or portable ZIP from the repository's GitHub Releases page.

The current preview is not code-signed, so Windows may show an unknown-publisher warning.

## Run from source

From the repository root:

```powershell
npm install
npm install --prefix apps/orquesta-desktop
npm run start:desktop --prefix apps/orquesta-desktop
```

For development:

```powershell
npm run dev:desktop --prefix apps/orquesta-desktop
```

## Architecture

The application uses Electron, React, TypeScript, and Vite. The renderer communicates through a limited preload bridge to Electron Main and a separate Core process. Filesystem access and Codex communication do not run directly in the renderer.

The packaged Windows app includes the Codex runtime it expects to use and relies on the normal Codex sandbox and approval flow rather than adding a second command-execution security layer.

## Project state

Managed projects keep Orquesta-owned state under `.orquesta/`. Application preferences such as recent projects, language, and local drafts are stored separately from project state.

Do not delete `.orquesta/` when updating an existing managed project.

## Current limitations

- Windows x64 only.
- No code signing yet.
- No automatic updater yet.
- No macOS or Linux package yet.
- The browser dashboard is diagnostic; the Desktop application is the primary interface.
