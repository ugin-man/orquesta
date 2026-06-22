# Vision Alignment Layer

Use the Vision Alignment Layer when creative work depends on taste, implicit user intent, aesthetics, tone, fantasy, friction, or "this is not quite it" feedback.

## Core Rule

Questions may come from any specialist, but curation is event-driven. Do not keep a vision agent running as a watcher.

- Specialists propose narrow questions from their own domain.
- `vision-curator` wakes only on triggers, merges and rewrites questions, and interprets answered batches.
- The orchestrator reviews the curator report, decides adoption, and applies or rejects the proposed document updates.
- Specialists read only the adopted documents relevant to their scope.

The orchestrator must not independently turn raw answers into project direction. If an answer is ambiguous, playful, contradictory, or taste-heavy, the orchestrator routes it to `vision-curator` and waits for a curator report. This keeps the user's nuance with the question specialist instead of letting the manager become an accidental taste interpreter.

## Triggers

Wake `vision-curator` when one of these is true:

- project kickoff needs initial vision capture
- uncurated questions reach 10 or more
- any question has `priority: "high"`
- a task is accepted and produced new creative ambiguity
- the user says they want to answer, review, or consolidate questions
- a major direction change conflicts with previous decisions

## Question Lifecycle

Use these statuses:

- `draft`: specialist proposed it
- `ready`: curator approved it for the user
- `answered`: user answered it
- `adopted`: orchestrator reflected it into documents
- `retired`: duplicate, stale, or unnecessary

## Files

```text
.orquesta/vision/
  questions.json
  answers.json
  profile.md
  decisions.md
  anti_vision.md
  specialists/
    visual.md
    world.md
    gameplay.md
    ui.md
    technical.md
  curator_reports/
```

## Curator Output

After a user answer batch, the curator writes a report with:

- answer batch summary
- inferred user taste
- anti-vision signals
- contradictions or unresolved ambiguities
- proposed updates to `profile.md`, `anti_vision.md`, `decisions.md`, and specialist files
- recommended next questions, if any

The curator owns interpretation. The orchestrator owns acceptance.

By default, the curator may propose exact patches or write to `.orquesta/vision/**` when its task contract allows it, but it must clearly separate:

- raw answer text
- inferred meaning
- confidence level
- proposed adopted direction
- follow-up questions

The curator does not directly edit specialist production documents unless the task contract explicitly allows it. The orchestrator applies accepted changes.
