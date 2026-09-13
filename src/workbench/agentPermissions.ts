import type { PlanChange } from "./model";

export type AgentPermissionMode = "suggest" | "assist" | "autonomous";
export type AgentChangeRisk = "read" | "low" | "high";

export function changeRisk(change: PlanChange): AgentChangeRisk {
  if (change.type === "saveMemory") return "low";
  if (change.type === "createTask") return "low";
  if (change.type === "updateGoal") return "high";
  if (change.type === "addScheduleException") return "high";
  return "high";
}

export function filterChangesForPermission(changes: PlanChange[], mode: AgentPermissionMode): PlanChange[] {
  if (mode === "suggest") return [];
  if (mode === "assist") return changes.slice(0, 50);
  return changes.filter((change) => changeRisk(change) === "low").slice(0, 20);
}

export function requiresConfirmation(changes: PlanChange[], mode: AgentPermissionMode): boolean {
  if (mode !== "autonomous") return changes.length > 0;
  return changes.some((change) => changeRisk(change) === "high");
}
