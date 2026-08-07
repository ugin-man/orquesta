import fs from "node:fs/promises";
import path from "node:path";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verify({ workspaceRoot }) {
  const outputPath = path.join(workspaceRoot, "organization.json");
  const started = Date.now();
  try {
    const text = await fs.readFile(outputPath, "utf8");
    const data = JSON.parse(text);
    requireCondition(data && typeof data === "object" && !Array.isArray(data), "Root element should be a JSON object");
    const organization = data.organization;
    const departments = organization.departments;
    requireCondition(departments.length >= 3, "Organization must have at least 3 departments");
    const departmentIds = new Set();
    for (const department of departments) {
      departmentIds.add(department.id);
      requireCondition(department.employees.length >= 2, `Department ${department.id} need 2 employees`);
      const employeeIds = new Set();
      for (const employee of department.employees) {
        requireCondition(!employeeIds.has(employee.id), `Same ID ${employee.id} ${department.id}`);
        employeeIds.add(employee.id);
      }
      for (const project of department.projects) {
        for (const memberId of project.members) requireCondition(employeeIds.has(memberId), `${memberId} ${project.name} not in ${department.name}`);
      }
    }
    requireCondition(departmentIds.size === departments.length, "Department IDs must be unique");
    const statistics = data.statistics;
    const totalBudget = departments.reduce((sum, department) => sum + department.budget, 0);
    requireCondition(Math.abs(statistics.averageDepartmentBudget - totalBudget / departments.length) < 0.01, "Budget average incorrect");
    const totalEmployees = departments.reduce((sum, department) => sum + department.employees.length, 0);
    requireCondition(statistics.totalEmployees === totalEmployees, "Total employee count incorrect");
    const statusCounts = new Map();
    for (const department of departments) {
      requireCondition(statistics.departmentSizes[department.name] === department.employees.length, `Bad size ${department.name}`);
      for (const project of department.projects) statusCounts.set(project.status, (statusCounts.get(project.status) || 0) + 1);
    }
    for (const [status, count] of statusCounts) requireCondition(statistics.projectStatusDistribution[status] === count, `${status} count wrong`);
    return { status: "passed", passed: true, duration_ms: Date.now() - started, output: "public verifier passed" };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "failed", passed: false, duration_ms: Date.now() - started, output: "organization.json does not exist" };
    return { status: "failed", passed: false, duration_ms: Date.now() - started, output: error.message };
  }
}
