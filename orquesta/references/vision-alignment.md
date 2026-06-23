# Vision Alignment Layer

Use the Vision Alignment Layer when creative work depends on taste, implicit user intent, aesthetics, tone, fantasy, friction, or "this is not quite it" feedback.

## Core Rule

Questions may come from any specialist, but curation is event-driven. Do not keep a vision agent running as a watcher.

- Specialists propose narrow questions from their own domain.
- `vision-curator` wakes only on triggers, merges and rewrites questions, and interprets answered batches.
- The orchestrator reviews the curator report, separates discussion seeds from adoptable direction, and asks for user review before turning creative answers into implementation direction.
- Specialists read only the adopted documents relevant to their scope.

The orchestrator must not independently turn raw answers into project direction. If an answer is ambiguous, playful, contradictory, or taste-heavy, the orchestrator routes it to `vision-curator` and waits for a curator report. This keeps the user's nuance with the question specialist instead of letting the manager become an accidental taste interpreter.

User answers are seeds for thought, not commands. A question exists to help the user notice, compare, and refine ideas, including ideas they had never consciously considered. Unless the user explicitly says a point is a hard requirement, Orquesta must treat the answer as provisional material for dialogue.

Do not convert an answer directly into implementation work just because it sounds sensible. First turn it into a conversation object: what seems good, what may be weak, what alternative the AI suggests, what needs user confirmation, and what should not be adopted yet.

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
- `curated`: curator interpreted it, but it is still not project direction
- `needs_user_review`: curator or orchestrator turned it into discussion seeds or adoption candidates that need user review
- `approved_for_adoption`: the user or an explicit project policy approved a candidate
- `adopted`: orchestrator reflected an approved candidate into adopted documents
- `retired`: duplicate, stale, or unnecessary

## Adoption Cushion

Every answer batch should pass through this cushion before it changes production direction:

1. Raw answer is saved.
2. `vision-curator` interprets the answer as provisional.
3. The curator labels each extracted idea as one of:
   - `discussion_seed`: useful for conversation, not ready to adopt
   - `strong_signal`: likely important, but still needs framing
   - `candidate_rule`: may become a rule after review
   - `counterproposal_needed`: the AI should suggest a better or sharper alternative
   - `do_not_adopt_yet`: interesting but too uncertain, playful, reactive, or underdeveloped
4. The orchestrator may adopt only low-risk operating rules directly. Creative, product, UX, story, visual, and completion-map changes should usually become `needs_user_review` first.
5. `user-liaison` may present the review as a short user task: keep as-is, revise, reject, or ask Orquesta to propose alternatives.
6. Only confirmed candidates become adopted vision documents or implementation tasks.

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
- discussion seeds
- AI counterproposals or improvements
- explicit user-review candidates
- proposed updates to `profile.md`, `anti_vision.md`, `decisions.md`, and specialist files
- recommended next questions, if any

The curator owns interpretation. The orchestrator owns acceptance.

By default, the curator may propose exact patches or write to `.orquesta/vision/**` when its task contract allows it, but it must clearly separate:

- raw answer text
- inferred meaning
- confidence level
- discussion seed versus proposed adopted direction
- where the AI thinks the user's first answer may be incomplete, over-broad, or worth challenging
- follow-up questions

The curator does not directly edit specialist production documents unless the task contract explicitly allows it. The orchestrator applies accepted changes.
