const assert = require("assert");
const { validateApprovalWaits } = require("./approval-wait-check");

function validState() {
  return {
    userTasks: {
      tasks: [
        {
          user_task_id: "UT-APPROVAL-001",
          source: "approval_wait",
          source_ids: ["T100"],
          source_agent_id: "implementation-001",
          assigned_by: "user-liaison",
          status: "ready",
          priority: "high",
          title: "Approve local server restart",
          prompt: "implementation-001 needs your approval before restarting the local server.",
          approval_type: "codex_safety_approval",
          requested_action: "Approve or deny the restart request in Codex.",
          resume_instruction: "After approval, tell implementation-001 to retry T100."
        }
      ]
    },
    tasks: [
      {
        task_id: "T100",
        state: "blocked",
        owner_agent_id: "implementation-001",
        blocked_by: ["user_approval_required"]
      }
    ]
  };
}

{
  const result = validateApprovalWaits(validState());
  assert.deepStrictEqual(result.errors, []);
}

{
  const state = validState();
  delete state.userTasks.tasks[0].approval_type;
  const result = validateApprovalWaits(state);
  assert(result.errors.some((error) => error.includes("approval_type")));
}

{
  const state = validState();
  state.userTasks.tasks = [];
  const result = validateApprovalWaits(state);
  assert(result.errors.some((error) => error.includes("T100")));
}

{
  const state = validState();
  state.userTasks.tasks[0].status = "resolved";
  const result = validateApprovalWaits(state);
  assert(result.errors.some((error) => error.includes("T100")));
}

console.log("approval-wait-check tests passed");
