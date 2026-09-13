import { createWorkbenchId as id, localDateKey, type WorkbenchState, type WorkbenchTask, type WorkbenchProject, type CaptureItem, type PlanProposal } from "./model";

export function newTask(title: string, projectId: string | null = null, date = localDateKey()): WorkbenchTask {
  return { id: id("task"), title, notes: "", priority: "medium", estimateMinutes: 30, projectId, scheduledFor: date, completedAt: null, createdAt: Date.now(), status: "todo", steps: [], fixedDate: false };
}
export function convertCapture(state: WorkbenchState, captureId: string, kind: "task" | "project" | "note", projectId: string | null, date = localDateKey()): WorkbenchState {
  const capture = state.captures.find((item) => item.id === captureId);
  if (!capture || capture.convertedTo || (kind === "note" && !state.projects.some((p) => p.id === projectId))) return state;
  const targetId = id(kind);
  const next = { ...state, captures: state.captures.map((item) => item.id === captureId ? { ...item, convertedTo: { kind, id: targetId } } : item) };
  if (kind === "task") return { ...next, tasks: [...state.tasks, { ...newTask(capture.text, projectId, date), id: targetId, sourceId: captureId, notes: capture.documentId ? `关联资料：${capture.documentId}` : "" }] };
  if (kind === "project") return { ...next, projects: [...state.projects, { id: targetId, name: capture.text.slice(0, 80), goal: capture.text, status: "active", stages: [], createdAt: Date.now(), linkedDocumentIds: capture.documentId ? [capture.documentId] : [] }] };
  return { ...next, projectNotes: [...state.projectNotes, { id: targetId, projectId: projectId!, text: capture.text, sourceId: captureId, createdAt: Date.now() }] };
}
export function trashItem(state: WorkbenchState, kind: "task" | "project" | "capture", itemId: string): WorkbenchState {
  const list = kind === "task" ? state.tasks : kind === "project" ? state.projects : state.captures;
  const value = list.find((item) => item.id === itemId);
  if (!value) return state;
  return { ...state,
    tasks: kind === "task" ? state.tasks.filter((item) => item.id !== itemId) : state.tasks,
    projects: kind === "project" ? state.projects.filter((item) => item.id !== itemId) : state.projects,
    captures: kind === "capture" ? state.captures.filter((item) => item.id !== itemId) : state.captures,
    trash: [...state.trash, { id: id("trash"), kind, value, deletedAt: Date.now() }],
  };
}
export function restoreTrash(state: WorkbenchState, trashId: string): WorkbenchState {
  const entry = state.trash.find((item) => item.id === trashId);
  if (!entry) return state;
  const key = entry.kind === "task" ? "tasks" : entry.kind === "project" ? "projects" : "captures";
  if (state[key].some((item) => item.id === entry.value.id)) return state;
  return { ...state, [key]: [...state[key], entry.value as WorkbenchTask | WorkbenchProject | CaptureItem], trash: state.trash.filter((item) => item.id !== trashId) };
}
export function materializeRecurring(state: WorkbenchState, date = localDateKey()): WorkbenchState {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  let tasks = state.tasks;
  const rules = state.recurrenceRules.map((rule) => {
    if (!rule.active || date < rule.startDate || rule.lastDate === date || (rule.frequency === "weekly" && weekday !== rule.weekday)) return rule;
    if (rule.projectId && !state.projects.some((p) => p.id === rule.projectId && p.status !== "archived" && p.status !== "completed")) return rule;
    const instanceId = `${rule.id}:${date}`;
    if (!tasks.some((t) => t.id === instanceId) && !state.trash.some((t) => t.kind === "task" && t.value.id === instanceId)) tasks = [...tasks, { ...newTask(rule.title, rule.projectId, date), id: instanceId, recurrenceId: rule.id, estimateMinutes: rule.minutes }];
    return { ...rule, lastDate: date };
  });
  return rules.every((r, i) => r === state.recurrenceRules[i]) ? state : { ...state, tasks, recurrenceRules: rules };
}
export function projectDeadline(state: WorkbenchState, projectId: string | null): string | null {
  return state.countdowns.filter((c) => c.projectId === projectId && projectId).map((c) => c.targetDate).sort()[0] ?? null;
}
export function proposalConflict(state: WorkbenchState, proposal: PlanProposal): string | null {
  const ids = new Set<string>();
  for (const change of proposal.changes) {
    if (change.type === "addScheduleException") continue;
    if (change.type === "updateGoal") {
      if (!state.goals.some((goal) => goal.id === change.goalId)) return "目标已删除，请重新生成方案";
      continue;
    }
    if (change.type === "saveMemory") {
      if (!change.memory.value.trim() || change.memory.value.length > 4000) return "记忆内容无效或过长";
      if (change.memory.goalId && !state.goals.some((goal) => goal.id === change.memory.goalId)) return "记忆关联的目标不存在";
      continue;
    }
    const task = change.type === "rescheduleTask" ? state.tasks.find((t) => t.id === change.taskId) : change.task;
    if (!task) return "任务已删除，请重新生成方案";
    if (ids.has(task.id)) return "方案包含重复任务";
    ids.add(task.id);
    if (change.type === "rescheduleTask" && (task.scheduledFor !== change.fromDate || task.completedAt || task.fixedDate)) return "任务已变化或日期已固定，请重新生成方案";
    if (change.type === "createTask" && state.tasks.some((t) => t.id === task.id)) return "任务已经存在，请重新生成方案";
    const date = change.type === "rescheduleTask" ? change.toDate : task.scheduledFor;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(`${date}T12:00:00`).getTime())) return "安排日期无效";
    const deadline = projectDeadline(state, task.projectId);
    if (deadline && date > deadline) return "安排超出项目截止日期，请修改方案";
    if (task.projectId && !state.projects.some((p) => p.id === task.projectId && p.status !== "archived")) return "所属项目已归档或删除";
  }
  return null;
}
export function undoLastOperation(state: WorkbenchState): WorkbenchState {
  const operation = state.undoOperations.at(-1);
  if (!operation) return state;
  if (JSON.stringify(state.tasks) !== JSON.stringify(operation.afterTasks) || JSON.stringify(state.scheduleExceptions) !== JSON.stringify(operation.afterExceptions) || (operation.afterGoals && JSON.stringify(state.goals) !== JSON.stringify(operation.afterGoals)) || (operation.afterMemories && JSON.stringify(state.memories) !== JSON.stringify(operation.afterMemories))) throw new Error("工作台已有后续编辑，无法撤销；请手动调整，避免覆盖新内容。");
  return { ...state, tasks: operation.beforeTasks, scheduleExceptions: operation.beforeExceptions, goals: operation.beforeGoals ?? state.goals, memories: operation.beforeMemories ?? state.memories, undoOperations: state.undoOperations.slice(0, -1) };
}
export function weekDates(offset = 0): string[] {
  const start = new Date(); start.setHours(12, 0, 0, 0); start.setDate(start.getDate() - (start.getDay() + 6) % 7 + offset * 7);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return localDateKey(d); });
}
export function reviewDraft(state: WorkbenchState, projectId: string, dates: string[]): string {
  const project = state.projects.find((p) => p.id === projectId);
  const tasks = state.tasks.filter((t) => t.projectId === projectId);
  const done = tasks.filter((t) => t.completedAt && dates.includes(localDateKey(new Date(t.completedAt))));
  const focus = state.focusRecords.filter((f) => tasks.some((t) => t.id === f.taskId) && dates.includes(localDateKey(new Date(f.endedAt))));
  return `# ${project?.name ?? "项目"} · 周复盘\n\n${dates[0]} — ${dates[6]}\n\n## 完成事项\n${done.map((t) => `- ${t.title}`).join("\n") || "暂无完成记录"}\n\n## 投入\n${focus.reduce((n, f) => n + f.actualMinutes, 0)} 分钟（专注记录）\n\n## 阻塞\n${tasks.filter((t) => t.status === "blocked").map((t) => `- ${t.title}：${t.blockedReason || "待补充"}`).join("\n") || "暂无阻塞"}\n\n## 成果\n${state.outcomes.filter((o) => o.projectId === projectId && dates.includes(localDateKey(new Date(o.createdAt)))).map((o) => `- ${o.summary}${o.url ? ` · ${o.url}` : ""}`).join("\n") || "暂无成果记录"}`;
}
