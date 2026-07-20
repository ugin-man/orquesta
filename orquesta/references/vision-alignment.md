# Vision Alignment Layer

Migration note: the behaviors in this document are now owned by `user-support`. See `user-support.md`. Keep this file only so older reports and state references remain understandable; do not generate a `vision-curator` agent for new projects.

Use the Vision Alignment Layer when creative work depends on taste, implicit user intent, aesthetics, tone, fantasy, friction, or "this is not quite it" feedback.

## Core Rule

Questions may come from any specialist, but curation is event-driven. Do not keep a vision agent running as a watcher.

- Specialists propose narrow questions from their own domain.
- `vision-curator` wakes only on triggers, merges and rewrites questions, and interprets answered batches.
- The orchestrator reviews the curator report, separates discussion seeds from adoptable direction, and asks for user review before turning creative answers into implementation direction.
- Specialists read only the adopted documents relevant to their scope.

The orchestrator must not independently turn raw answers into project direction. If an answer is ambiguous, playful, contradictory, or taste-heavy, the orchestrator routes it to `vision-curator` and waits for a curator report. This keeps the user's nuance with the question specialist instead of letting the manager become an accidental taste interpreter.

Specialist question candidates are also raw material, not user-facing questions. Every specialist report must include structured `question_candidates`: either 0-3 useful candidates or `status: "none"` with a valid `none_reason`. The orchestrator stores submitted candidates in `.orquesta/vision/question_candidates.json`; `vision-curator` decides which candidates become curated questions in `.orquesta/vision/questions.json`.

Beta V3 records each candidate as an observation before it becomes a question. `observation.value_type`, `user_emergence_value`, `decision_cluster_id`, `suggested_action`, and `reason` describe why it exists. A low-value or maintenance observation may stay in the inbox with `status: "observation"`; it must not create a user question merely because time passed.

User answers are seeds for thought, not commands. A question exists to help the user notice, compare, and refine ideas, including ideas they had never consciously considered. Unless the user explicitly says a point is a hard requirement, Orquesta must treat the answer as provisional material for dialogue.

Do not convert an answer directly into implementation work just because it sounds sensible. First turn it into a conversation object: what seems good, what may be weak, what alternative the AI suggests, what needs user confirmation, and what should not be adopted yet.

## Triggers

Wake `vision-curator` when one of these is true:

- project kickoff needs initial vision capture
- uncurated questions reach 10 or more
- any question has `priority: "high"`
- any pending question candidate has `priority: "high"`
- pending question candidates reach 5 or more
- the oldest pending question candidate is older than 24 hours during active development
- a pending question candidate has `suggested_timing: "before_acceptance"`
- a task is accepted and produced new creative ambiguity
- the user says they want to answer, review, or consolidate questions
- a major direction change conflicts with previous decisions

## Question Candidate Lifecycle

Specialist reports produce candidates, not final questions. Store raw candidates in `.orquesta/vision/question_candidates.json`.

Use these statuses:

- `pending_curator_review`: submitted by a specialist and waiting for curator triage
- `observation`: raw operating or emergence material, not a user-facing question
- `clustered`: linked to a curator decision cluster before promotion
- `curator_accepted`: curator decided the candidate is useful
- `curator_rejected`: curator rejected it as low-value, unclear, or not user-actionable
- `merged_duplicate`: curator merged it into another candidate or existing question
- `promoted_to_question`: curator created or updated a `questions.json` entry from it
- `retired`: stale or no longer useful

Candidate items should include:

- `priority`: `low`, `medium`, or `high`
- `category`: `scope`, `design`, `workflow`, `quality`, `risk`, `roadmap`, `user_preference`, `technical_direction`, `release`, or `other`
- `question`
- `why_now`
- `user_impact`
- `suggested_timing`: `now`, `before_next_task`, `before_acceptance`, `batch_later`, or `roadmap_review`
- `source_task_id`
- `source_agent_id`
- `source_report_path`

`vision-curator` should batch low and medium candidates unless timing makes them acceptance-critical. Raw candidates should not appear directly as user-facing questions.

Curator promotion is semantic work. Deterministic intake may validate and deduplicate observation metadata, but it cannot infer the user decision or rewrite the raw text into a question without `vision-curator`.

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
  question_candidates.json
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
