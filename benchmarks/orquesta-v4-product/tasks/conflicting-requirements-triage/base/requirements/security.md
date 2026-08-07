# Audit data policy

Audit events may contain local project paths and task summaries.

- The application must not transmit audit events until the user explicitly
  opts in for the current project.
- Remote retention must not be enabled until the owner has selected an allowed
  retention period and confirmed the applicable policy.
- When either decision is missing, the safe default is local-only storage with
  no network request.
- An unresolved conflict must be returned to the user instead of being silently
  decided by an implementation agent.
