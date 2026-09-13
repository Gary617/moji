import type { PlanChange, TaskPriority, WorkbenchTask, ScheduleException, MemoryEntry } from "./model";

export type AgentResponse =
  | { kind: "answer"; answer: string; evidence: string[] }
  | { kind: "clarification"; question: string; known: string[] }
  | { kind: "proposal"; title: string; summary: string; evidence: string[]; changes: PlanChange[]; requiresConfirmation: boolean }
  | { kind: "error"; message: string };

function jsonCandidate(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 20) : [];
}

export function parseAgentResponse(text: string): AgentResponse {
  const raw = jsonCandidate(text);
  if (!raw || typeof raw !== "object") return { kind: "answer", answer: text.trim() || "AI 没有返回可显示的结果。", evidence: [] };
  const value = raw as Record<string, unknown>;
  const nested = ["data", "result", "output", "response"].map((key) => value[key]).find((item) => item && typeof item === "object" && !Array.isArray(item));
  const body = (nested as Record<string, unknown> | undefined) ?? value;
  const kind = body.kind ?? body.type;
  if ((kind === "clarification" || kind === "question") && typeof (body.question ?? body.message) === "string") {
    return { kind: "clarification", question: String(body.question ?? body.message).trim(), known: strings(body.known ?? body.context ?? body.evidence) };
  }
  if ((kind === "proposal" || kind === "plan") && typeof (body.title ?? body.summary ?? body.explanation) === "string") {
    const changes = Array.isArray(body.changes) ? body.changes.map(normalizePlanChange).filter((item): item is PlanChange => Boolean(item)) : [];
    return { kind: "proposal", title: String(body.title ?? "AI 工作台变更").trim(), summary: String(body.summary ?? body.explanation ?? "").trim(), evidence: strings(body.evidence), changes, requiresConfirmation: body.requiresConfirmation !== false };
  }
  if (typeof body.answer === "string" || typeof body.message === "string") return { kind: "answer", answer: String(body.answer ?? body.message).trim(), evidence: strings(body.evidence) };
  return { kind: "answer", answer: text.trim(), evidence: [] };
}

function normalizePlanChange(value: unknown): PlanChange | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if ((item.type === "rescheduleTask" || item.type === "moveTask" || item.type === "updateTaskDate") && typeof item.taskId === "string") {
    const fromDate = String(item.fromDate ?? item.currentDate ?? "");
    const toDate = String(item.toDate ?? item.date ?? item.scheduledFor ?? "");
    return fromDate && toDate ? { type: "rescheduleTask", taskId: item.taskId, fromDate, toDate } : null;
  }
  if ((item.type === "createTask" || item.type === "addTask") && item.task && typeof item.task === "object") {
    return { type: "createTask", task: item.task as WorkbenchTask };
  }
  if ((item.type === "createTask" || item.type === "addTask") && typeof (item.title ?? item.name) === "string") {
    const priority: TaskPriority = item.priority === "high" || item.priority === "low" ? item.priority : "medium";
    const task: WorkbenchTask = { id: `agent-task-${Date.now()}-${Math.random().toString(16).slice(2)}`, title: String(item.title ?? item.name), notes: typeof item.notes === "string" ? item.notes : "", priority, estimateMinutes: Math.max(10, Math.min(240, Number(item.estimateMinutes ?? item.minutes ?? 30) || 30)), actualMinutes: null, projectId: typeof item.projectId === "string" ? item.projectId : null, goalId: typeof item.goalId === "string" ? item.goalId : null, scheduledFor: String(item.scheduledFor ?? item.date ?? ""), completedAt: null, createdAt: Date.now(), postponements: 0 };
    return task.scheduledFor ? { type: "createTask", task } : null;
  }
  if (item.type === "addScheduleException" && item.exception && typeof item.exception === "object") return { type: "addScheduleException", exception: item.exception as ScheduleException };
  if ((item.type === "updateGoal" || item.type === "update_goal") && typeof item.goalId === "string" && item.patch && typeof item.patch === "object") {
    const patch = item.patch as Record<string, unknown>;
    return { type: "updateGoal", goalId: item.goalId, patch: { outcome: typeof patch.outcome === "string" ? patch.outcome : "", dimensions: Array.isArray(patch.dimensions) ? patch.dimensions.filter((value): value is string => typeof value === "string").slice(0, 20) : [], currentLevel: typeof patch.currentLevel === "string" ? patch.currentLevel : "", weeklyAvailableMinutes: typeof patch.weeklyAvailableMinutes === "number" && Number.isFinite(patch.weeklyAvailableMinutes) ? Math.max(30, Math.min(10080, Math.round(patch.weeklyAvailableMinutes))) : null } };
  }
  if ((item.type === "saveMemory" || item.type === "save_memory") && item.memory && typeof item.memory === "object") {
    const memory = item.memory as Record<string, unknown>;
    if (typeof memory.value !== "string" || !memory.value.trim()) return null;
    const category = memory.category === "profile" || memory.category === "goal" || memory.category === "habit" ? memory.category : "preference";
    return { type: "saveMemory", memory: { id: typeof memory.id === "string" ? memory.id : `agent-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`, category, key: typeof memory.key === "string" && memory.key.trim() ? memory.key : "agentFact", value: memory.value.trim().slice(0, 4000), goalId: typeof memory.goalId === "string" ? memory.goalId : null, source: "inferred", confidence: Math.max(0, Math.min(100, Number(memory.confidence) || 70)), evidenceCount: 1, confirmed: true, validated: true, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: null, lifecycle: "active", lifecycleNote: "Agent 提案，待确认" } };
  }
  return null;
}
