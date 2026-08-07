# Architecture Reframe

Use this as a judgment lens when evidence suggests that the current problem definition or route may be wrong. It is not a stage, form, approval, status, report, or machine gate.

Pause long enough to understand the user-visible outcome, where evidence first diverges from it, and which assumption made the current route look reasonable. Then decide naturally whether the situation calls for a bounded repair, simplification, replacement, or another route. Consider only alternatives that are genuinely useful; do not enumerate options to satisfy a template.

Question the current route when local fixes keep moving the same failure, new evidence weakens its assumptions, or another compatibility layer, exception, retry, validator, state, or reconciliation mechanism is proposed mainly to preserve it. These are signals for judgment, not automatic proof that the architecture is wrong.

When existing assets matter to the decision, say plainly which ones still help, which need adaptation, and which have become obsolete or conflicting. Use labels such as `retain`, `adapt`, `replace`, `isolate`, or `remove` only when they make the decision clearer. Do not classify unrelated assets or preserve an asset only because effort has already been spent on it.

Prefer one clear authority for the same decision, state, or side effect. A fix that explains only one observed example and needs another special case for the next example is evidence to reconsider the framing, not an automatic command to replace the system.

For a small defect on a proven end-to-end route, fix and verify it normally. Do not run an architecture exercise just because this reference exists.

If the chosen approach materially changes the current work, express the change in ordinary prose through the existing TaskIntent fields or specialist handoff. Update the desired outcome, assumptions, constraints, or acceptance criteria that are actually affected, and supersede an obsolete intent when necessary. Do not create a separate reframe task, schema, checklist, or report solely to record the reasoning.

The orchestrator owns changes to the task framing. A specialist may return concrete evidence that the assigned framing is wrong and pause for a revised handoff; it does not need to complete a reframe form. The absence of a separate reframe artifact is never, by itself, a reason to block implementation or reject a report.
