# Contributing to Orquesta

Orquesta is an early-stage Codex skill for long-lived specialist-team workflows.

## Good first contributions

Useful first contributions include:

- testing a clean GitHub install
- improving `START_HERE.md`
- reporting dashboard setup issues
- documenting confusing workflow steps
- adding small reproducible examples
- improving smoke-test notes

## Running checks

From the repository root:

```powershell
npm run check
npm run test:triggers
npm run test:question-candidates
npm run test:ports
```

For dashboard UI changes, run the dashboard and then:

```powershell
npm run smoke:dashboard -- http://127.0.0.1:4177/
```

## Reporting issues

When reporting a bug, include:

- operating system
- Codex environment
- install method
- command or prompt used
- expected behavior
- actual behavior
- relevant `.orquesta/` state, if safe to share

Do not include private project files, API keys, local secrets, or personal information.
