import { proposalConflict } from "./ecosystem";
import { workbenchStateVersion } from "./agentContext";
import {
  createWorkbenchId,
  daysUntil,
  localDateKey,
  type AiMessage,
  type GoalProfile,
  type GoalQuestionKey,
  type MemoryEntry,
  type MemoryLifecycle,
  type PlanProposal,
  type ScheduleException,
  type WorkbenchCountdown,
  type WorkbenchState,
  type WorkbenchTask,
  type GoalResearch,
  type TaskPriority,
} from "./model";

const DAY_MS = 86_400_000;
const priorityRank = { high: 0, medium: 1, low: 2 } as const;

export interface CapacityResult {
  availableMinutes: number;
  effectiveMinutes: number;
  bufferMinutes: number;
  evidence: string[];
}

export interface ParsedArrangement {
  exception: ScheduleException;
  needsClarification: boolean;
}

export interface ProjectPlanTaskDraft {
  title: string;
  scheduledFor: string;
  estimateMinutes: number;
  priority: TaskPriority;
  notes: string;
  reason: string;
}

export interface ProjectPlanDraft {
  summary: string;
  tasks: ProjectPlanTaskDraft[];
  assumptions: string[];
  deadlineDate: string | null;
  deadlineSource: string | null;
  deadlineEvidence: string | null;
}

export interface DocumentDeadlineHint {
  date: string;
  sourceDocument: string;
  evidence: string;
}

function dateKeyFromParts(year: number, month: number, day: number): string | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return localDateKey(date);
}

/** Extract only explicit delivery/deadline dates from document text. The text is reference data, not an instruction. */
export function extractDocumentDeadlineHints(documents: Array<{ name: string; content: string }>, today = localDateKey()): DocumentDeadlineHint[] {
  const keyword = /截止|交付|提交|里程碑|完成日期|交件|due\s*date|deadline/i;
  const currentYear = Number(today.slice(0, 4)) || new Date().getFullYear();
  const results: DocumentDeadlineHint[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    const content = document.content.replace(/\s+/g, " ").trim();
    if (!content) continue;
    const matches: Array<{ index: number; length: number; date: string }> = [];
    const add = (regex: RegExp, resolve: (match: RegExpExecArray) => string | null) => {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content))) {
        const date = resolve(match);
        if (date) matches.push({ index: match.index, length: match[0].length, date });
      }
    };
    add(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*(?:日|号)?/g, (match) => dateKeyFromParts(Number(match[1]), Number(match[2]), Number(match[3])));
    add(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/g, (match) => dateKeyFromParts(currentYear, Number(match[1]), Number(match[2])));
    add(/(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})/g, (match) => dateKeyFromParts(Number(match[1]), Number(match[2]), Number(match[3])));
    for (const match of matches) {
      if (match.date < today) continue;
      const nearby = content.slice(Math.max(0, match.index - 100), Math.min(content.length, match.index + match.length + 100));
      if (!keyword.test(nearby)) continue;
      const evidence = nearby.length > 220 ? nearby.slice(0, 220) : nearby;
      const key = `${match.date}:${document.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ date: match.date, sourceDocument: document.name, evidence });
    }
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

/** Parse and constrain the online model's project-plan response before it can enter a proposal. */
export function parseProjectPlanResponse(text: string, today = localDateKey(), targetDate?: string | null, documentDeadlineDate?: string | null): ProjectPlanDraft | null {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return parseMarkdownPlan(source, today, targetDate, documentDeadlineDate);
  let parsed: unknown;
  try { parsed = JSON.parse(source.slice(start, end + 1)); } catch { return parseMarkdownPlan(source, today, targetDate, documentDeadlineDate); }
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;

  // Providers frequently wrap the requested object in `plan`, `data` or
  // `result`, and some models use equivalent field names. Normalize those
  // harmless variations before applying the strict safety constraints below.
  let value = parsed as Record<string, unknown>;
  for (let depth = 0; depth < 4; depth += 1) {
    const content = value.content;
    if (typeof content === "string" && content.trim().startsWith("{")) {
      try {
        const decoded = JSON.parse(content);
        if (decoded && typeof decoded === "object") { value = decoded as Record<string, unknown>; continue; }
      } catch { /* continue with the outer object */ }
    }
    const wrapped = ["plan", "data", "result", "output", "response", "payload", "actionPlan", "action_plan", "taskPlan", "task_plan", "行动方案", "方案"].map((key) => value[key]).find((item) => item && typeof item === "object" && !Array.isArray(item));
    if (!wrapped) break;
    value = wrapped as Record<string, unknown>;
  }
  const summary = [value.summary, value.overview, value.description, value.title, value.planSummary, value.plan_summary, value.总结, value.概述]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim().slice(0, 600) ?? "";
  const rawTasks = value.tasks ?? value.actions ?? value.items ?? value.steps ?? value.todos ?? value.todoList ?? value.todo_list ?? value.taskList ?? value.task_list ?? value.actionItems ?? value.action_items ?? value.deliverables ?? value.任务 ?? value.任务列表 ?? value.任务清单 ?? value.行动项;
  if (!Array.isArray(rawTasks)) return null;
  const safeSummary = summary || "根据关联资料生成的行动方案";
  const tasks: ProjectPlanTaskDraft[] = [];
  for (const item of rawTasks.slice(0, 14)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const title = [candidate.title, candidate.name, candidate.task, candidate.action, candidate.todo, candidate.description, candidate.任务, candidate.行动, candidate.名称]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim().slice(0, 120) ?? "";
    const date = [candidate.scheduledFor, candidate.date, candidate.dueDate, candidate.scheduled_for, candidate.scheduled_date, candidate.day, candidate.日期, candidate.计划日期]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() ?? "";
    const normalizedDate = normalizePlanDate(date, today);
    const minutes = Number(candidate.estimateMinutes ?? candidate.minutes ?? candidate.duration ?? candidate.durationMinutes ?? candidate.estimated_minutes ?? candidate.预计分钟 ?? candidate.时长 ?? 30);
    if (!title || !normalizedDate || normalizedDate < today || (targetDate && normalizedDate > targetDate) || (documentDeadlineDate && normalizedDate > documentDeadlineDate)) continue;
    if (!Number.isFinite(minutes)) continue;
    const estimateMinutes = Math.max(10, Math.min(240, Math.round(minutes / 5) * 5));
    const rawPriority = candidate.priority ?? candidate.level ?? candidate.优先级;
    const priority: TaskPriority = rawPriority === "high" || rawPriority === "高" ? "high" : rawPriority === "low" || rawPriority === "低" ? "low" : "medium";
    tasks.push({ title, scheduledFor: normalizedDate, estimateMinutes, priority, notes: typeof (candidate.notes ?? candidate.note ?? candidate.说明) === "string" ? String(candidate.notes ?? candidate.note ?? candidate.说明).trim().slice(0, 240) : "", reason: typeof (candidate.reason ?? candidate.依据 ?? candidate.原因) === "string" ? String(candidate.reason ?? candidate.依据 ?? candidate.原因).trim().slice(0, 240) : "" });
  }
  if (!tasks.length) return null;
  const assumptions = Array.isArray(value.assumptions)
    ? value.assumptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 200)).slice(0, 8)
    : [];
  let deadlineDate: string | null = null;
  let deadlineSource: string | null = null;
  let deadlineEvidence: string | null = null;
  const rawDeadline = value.deadline ?? value.deliveryDate;
  if (rawDeadline && typeof rawDeadline === "object") {
    const deadline = rawDeadline as Record<string, unknown>;
    const candidateDate = typeof deadline.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(deadline.date) ? deadline.date : null;
    if (candidateDate && candidateDate >= today && (!targetDate || candidateDate <= targetDate) && (!documentDeadlineDate || candidateDate <= documentDeadlineDate)) {
      deadlineDate = candidateDate;
      deadlineSource = typeof deadline.sourceDocument === "string" ? deadline.sourceDocument.trim().slice(0, 160) : null;
      deadlineEvidence = typeof deadline.evidence === "string" ? deadline.evidence.trim().slice(0, 240) : null;
    }
  }
  return { summary: safeSummary, tasks, assumptions, deadlineDate, deadlineSource, deadlineEvidence };
}

function parseMarkdownPlan(source: string, today: string, targetDate?: string | null, documentDeadlineDate?: string | null): ProjectPlanDraft | null {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tasks: ProjectPlanTaskDraft[] = [];
  for (const line of lines) {
    const dateMatch = line.match(/(20\d{2}[-年./]\d{1,2}[-月./]\d{1,2}日?号?)/);
    if (!dateMatch) continue;
    const date = normalizePlanDate(dateMatch[1], today);
    if (!date || date < today || (targetDate && date > targetDate) || (documentDeadlineDate && date > documentDeadlineDate)) continue;
    const title = line.replace(/^[-*•\d.、)\s]+/, "").replace(dateMatch[0], "").replace(/[：:|]/g, " ").trim().slice(0, 120);
    if (!title) continue;
    const minutesMatch = line.match(/(\d{1,3})\s*(?:分钟|分|min|小时|h)/i);
    const rawMinutes = minutesMatch ? Number(minutesMatch[1]) * (/小时|h/i.test(minutesMatch[0]) ? 60 : 1) : 30;
    tasks.push({ title, scheduledFor: date, estimateMinutes: Math.max(10, Math.min(240, Math.round(rawMinutes / 5) * 5)), priority: /高优先|紧急/.test(line) ? "high" : /低优先/.test(line) ? "low" : "medium", notes: "", reason: "" });
  }
  if (!tasks.length) return null;
  return { summary: lines.find((line) => !/20\d{2}[-年./]\d{1,2}[-月./]\d{1,2}/.test(line))?.replace(/^#+\s*/, "").slice(0, 600) ?? "根据资料生成行动方案", tasks: tasks.slice(0, 14), assumptions: [], deadlineDate: null, deadlineSource: null, deadlineEvidence: null };
}

function normalizePlanDate(value: string, today: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const chinese = trimmed.match(/^(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*(?:日|号)?$/);
  if (chinese) return dateKeyFromParts(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]));
  const monthDay = trimmed.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?$/);
  if (monthDay) return dateKeyFromParts(Number(today.slice(0, 4)), Number(monthDay[1]), Number(monthDay[2]));
  if (trimmed === "今天" || trimmed === "今日") return today;
  if (trimmed === "明天") return localDateKey(new Date(new Date(`${today}T00:00:00`).getTime() + DAY_MS));
  if (trimmed === "后天") return localDateKey(new Date(new Date(`${today}T00:00:00`).getTime() + DAY_MS * 2));
  return null;
}

export function minutesLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}`;
}

export function parseChineseAmount(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.startsWith("十")) return 10 + (digits[value[1]] ?? 0);
  if (value.includes("十")) return (digits[value[0]] ?? 0) * 10 + (digits[value[2]] ?? 0);
  return digits[value] ?? 0;
}

function minutesBetween(start: string | null, end: string | null): number {
  if (!start || !end) return 0;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return Math.max(0, endHour * 60 + endMinute - startHour * 60 - startMinute);
}

export function calculateDailyCapacity(state: WorkbenchState, date = localDateKey()): CapacityResult {
  const evidence: string[] = [];
  const checkIn = [...state.dailyCheckIns].reverse().find((item) => item.date === date);
  const exceptions = state.scheduleExceptions.filter((item) => item.date === date);
  const explicitOverride = [...exceptions].reverse().find((item) => item.capacityOverrideMinutes !== null)?.capacityOverrideMinutes ?? checkIn?.availableMinutes ?? null;
  let availableMinutes = explicitOverride ?? state.preferences.defaultDailyCapacityMinutes;
  if (explicitOverride !== null) evidence.push(`用户明确提供当天可用时间 ${minutesLabel(explicitOverride)}`);
  else evidence.push(`个人设置中的日常可用时间为 ${minutesLabel(state.preferences.defaultDailyCapacityMinutes)}`);

  if (explicitOverride === null) {
    const blocked = exceptions.reduce((sum, item) => sum + minutesBetween(item.startTime, item.endTime), 0);
    if (blocked > 0) {
      availableMinutes = Math.max(30, availableMinutes - blocked);
      evidence.push(`临时安排占用 ${minutesLabel(blocked)}`);
    }
  }

  if (checkIn) {
    if (checkIn.state === "low") {
      availableMinutes = Math.max(30, Math.round(availableMinutes * .8));
      evidence.push("用户标记今天状态偏低，容量下调 20%");
    } else if (checkIn.state === "high") {
      availableMinutes = Math.round(availableMinutes * 1.1);
      evidence.push("用户标记今天状态良好，容量上调 10%");
    }
    if (checkIn.note.trim()) evidence.push(`用户补充：${checkIn.note.trim()}`);
  }

  const recentCutoff = Date.now() - 14 * DAY_MS;
  const completedByDay = new Map<string, number>();
  for (const task of state.tasks) {
    if (!task.completedAt || task.completedAt < recentCutoff) continue;
    const key = localDateKey(new Date(task.completedAt));
    completedByDay.set(key, (completedByDay.get(key) ?? 0) + (task.actualMinutes || task.estimateMinutes));
  }
  if (completedByDay.size >= 3 && explicitOverride === null) {
    const average = Math.round([...completedByDay.values()].reduce((sum, value) => sum + value, 0) / completedByDay.size);
    availableMinutes = Math.max(45, Math.round(availableMinutes * .8 + average * .2));
    evidence.push(`最近 14 天有 ${completedByDay.size} 天完成记录，历史表现仅占容量判断的 20%`);
  }

  const bufferMinutes = Math.round(availableMinutes * Math.max(0, Math.min(50, state.preferences.bufferPercent)) / 100);
  return { availableMinutes, bufferMinutes, effectiveMinutes: Math.max(30, availableMinutes - bufferMinutes), evidence };
}

function hasConfirmedOnlineResearch(research: GoalResearch | null | undefined): research is GoalResearch {
  return research?.status === "ready" && research.confirmed;
}

/**
 * Research confirmation is reserved for genuine ambiguity. A model may still
 * return polite confirmation language ("这样理解对吗？") even after it has
 * found a dominant interpretation; that should be treated as an answer, not a
 * blocking question. Only explicit alternatives or an unresolved choice reach
 * the confirmation dialog.
 */
export function isGenuineGoalResearchAmbiguity(question: string | null | undefined): boolean {
  const value = question?.trim();
  if (!value) return false;
  if (/还是|或者|二选一|多个合理解释|存在歧义|无法确定|不确定(?:是|指)/.test(value)) return true;
  return /哪(?:个|种|一|项|门|类|件|方面)/.test(value);
}

export function memorySuppressionKey(memory: Pick<MemoryEntry, "category" | "key" | "goalId">): string {
  return `${memory.category}:${memory.key}:${memory.goalId ?? "*"}`;
}

function isMemorySuppressed(state: WorkbenchState, memory: Pick<MemoryEntry, "category" | "key" | "goalId">): boolean {
  return state.suppressedMemoryKeys?.includes(memorySuppressionKey(memory)) ?? false;
}

export function nextGoalQuestion(goal: GoalProfile): { key: GoalQuestionKey; title: string; body: string } | null {
  // A confirmed online study is the source of truth for public goal facts. Do not
  // send users back through generic outcome/domain questions just because a model
  // omitted one of the optional structured fields.
  const hasPublicResearch = hasConfirmedOnlineResearch(goal.research);
  if (!hasPublicResearch && !goal.outcome.trim()) return { key: "outcome", title: `完善“${goal.title}”的目标`, body: "达到什么结果时，你会认为这个目标已经完成？" };
  if (!hasPublicResearch && !goal.dimensions.length) return { key: "dimensions", title: `补充“${goal.title}”的目标领域`, body: "这个目标主要包含哪些学科、模块或工作方向？可以用顿号或逗号分隔。" };
  if (!goal.currentLevel.trim()) return { key: "currentLevel", title: `了解“${goal.title}”的当前基础`, body: "你目前已经完成了什么，哪些部分还比较薄弱？" };
  if (goal.weeklyAvailableMinutes === null) return { key: "weeklyAvailability", title: `确认“${goal.title}”的可用时间`, body: "通常每周能为这个目标投入多少小时？" };
  return null;
}

export function createGoalResearchMessage(goal: GoalProfile, countdownId: string, question: string, evidence: string[]): AiMessage {
  return {
    ...questionMessage(goal, "researchConfirmation", `确认目标“${goal.title}”`, question, countdownId),
    evidence: [...evidence, "在线研究完成后仍需你确认，墨集不会自动创建任务"],
    dedupeKey: `goal-research-confirmation:${countdownId}`,
  };
}

/** A visible hand-off while online goal research is still in flight. */
export function createGoalResearchPendingMessage(countdown: WorkbenchCountdown): AiMessage {
  return {
    id: createWorkbenchId("message"),
    kind: "information",
    severity: "normal",
    title: `正在了解“${countdown.title}”`,
    body: "我正在联网搜索这个目标的含义、相关要求和规划重点。研究完成后，我会在这里继续询问或给出建议。",
    evidence: ["在线研究进行中", "不会自动创建任务或修改日程"],
    goalId: null,
    taskId: null,
    countdownId: countdown.id,
    dedupeKey: `goal-research-pending:${countdown.id}`,
    status: "unread",
    createdAt: Date.now(),
    readAt: null,
  };
}

/** Recover research records left in flight by a closed app or interrupted request. */
export function recoverStaleGoalResearch(state: WorkbenchState, now = Date.now()): WorkbenchState {
  const stale = state.countdowns.filter((countdown) => countdown.research?.status === "researching"
    && now - countdown.research.updatedAt > 2 * 60 * 1000);
  if (!stale.length) return state;
  const staleIds = new Set(stale.map((countdown) => countdown.id));
  const nextCountdowns = state.countdowns.map((countdown) => {
    if (!staleIds.has(countdown.id) || !countdown.research) return countdown;
    return {
      ...countdown,
      research: {
        ...countdown.research,
        status: "failed" as const,
        error: "研究请求已中断，可能是应用关闭或中转站未返回。",
        summary: "上一次在线研究没有完成，可以重新研究。",
        updatedAt: now,
      },
    };
  });
  let aiMessages = state.aiMessages.map((message) => {
    if (!message.countdownId || !staleIds.has(message.countdownId) || !message.dedupeKey.startsWith("goal-research-pending:")) return message;
    return { ...message, status: "resolved" as const, readAt: now, body: "上一次研究已中断。请重新研究这个目标，或先检查 AI 配置和网络。" };
  });
  for (const countdown of stale) {
    const dedupeKey = `goal-research-interrupted:${countdown.id}:${countdown.research?.updatedAt ?? now}`;
    if (aiMessages.some((message) => message.dedupeKey === dedupeKey)) continue;
    aiMessages = [...aiMessages, {
      id: createWorkbenchId("message"), kind: "information" as const, severity: "important" as const,
      title: `“${countdown.title}”的研究已中断`,
      body: "在线研究没有在后台继续运行，墨集已把状态恢复为可重试。检查连接后可以重新研究。",
      evidence: ["研究请求超过 2 分钟未完成", "不会用不完整结果创建计划"], goalId: null,
      taskId: null, countdownId: countdown.id, dedupeKey, status: "unread" as const, createdAt: now, readAt: null,
    }];
  }
  return { ...state, countdowns: nextCountdowns, aiMessages };
}

function questionMessage(goal: GoalProfile, key: GoalQuestionKey, title: string, body: string, countdownId: string | null = null): AiMessage {
  return {
    id: createWorkbenchId("message"), kind: "question", severity: "normal", title, body,
    evidence: ["回答只会写入这个目标的本地资料，可随时修改或删除"], goalId: goal.id, taskId: null, countdownId,
    questionKey: key, dedupeKey: `goal-question:${goal.id}:${key}`, status: "unread", createdAt: Date.now(), readAt: null,
  };
}

function researchDefaults(countdown: WorkbenchCountdown, research: GoalResearch | null | undefined): { outcome: string; dimensions: string[] } {
  if (!hasConfirmedOnlineResearch(research)) return { outcome: "", dimensions: [] };
  const evidence = `${research.interpretation} ${research.summary}`;
  const knownDimensions = ["听力", "阅读", "写作", "翻译", "口语", "词汇", "语法"];
  const dimensions = Array.from(new Set((research.suggestedDimensions ?? []).map((item) => item.trim()).filter(Boolean)))
    .concat(knownDimensions.filter((item) => evidence.includes(item)))
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 12);
  const outcome = research.suggestedOutcome?.trim()
    || (countdown.kind === "exam" && /考试|四级|六级|考研|考证/.test(`${countdown.title}${research.interpretation}`) ? `通过${countdown.title.replace(/考试$/, "")}考试` : "");
  return { outcome, dimensions };
}

export function createGoalFromCountdown(countdown: WorkbenchCountdown, existingGoals: GoalProfile[]): { goal: GoalProfile; message: AiMessage } {
  const now = Date.now();
  const defaults = researchDefaults(countdown, countdown.research);
  const goal: GoalProfile = {
    id: createWorkbenchId("goal"), countdownId: countdown.id, projectId: countdown.projectId,
    title: countdown.title, outcome: defaults.outcome, completionStandard: defaults.outcome, dimensions: defaults.dimensions, currentLevel: "",
    weeklyAvailableMinutes: null, constraints: [], fixedCommitments: [], primary: !existingGoals.some((item) => item.primary),
    status: "collecting", research: countdown.research ?? null, createdAt: now, updatedAt: now,
  };
  const question = nextGoalQuestion(goal);
  if (question) return { goal, message: questionMessage(goal, question.key, question.title, question.body, countdown.id) };
  const readyGoal = { ...goal, status: "ready" as const };
  return {
    goal: readyGoal,
    message: {
      id: createWorkbenchId("message"), kind: "information", severity: "normal",
      title: `“${readyGoal.title}”的资料已可用于规划`, body: "在线研究和已保存的个人资料足以生成第一版计划。",
      evidence: ["计划生成前仍会展示确认内容，不会直接改动任务或日程"], goalId: readyGoal.id, taskId: null,
      countdownId: countdown.id, dedupeKey: `goal-ready:${readyGoal.id}`, status: "unread", createdAt: now, readAt: null,
    },
  };
}

/** Apply a fresh research result to an existing goal without creating duplicates. */
export function updateGoalFromCountdown(goal: GoalProfile, countdown: WorkbenchCountdown): { goal: GoalProfile; message: AiMessage } {
  const now = Date.now();
  const defaults = researchDefaults(countdown, countdown.research);
  const researchChanged = Boolean(goal.research?.query && countdown.research?.query && goal.research.query !== countdown.research.query);
  const updated: GoalProfile = {
    ...goal,
    countdownId: countdown.id,
    projectId: countdown.projectId,
    title: countdown.title,
    outcome: researchChanged ? defaults.outcome : goal.outcome.trim() || defaults.outcome,
    completionStandard: researchChanged ? defaults.outcome : goal.completionStandard.trim() || defaults.outcome || goal.outcome,
    dimensions: researchChanged ? defaults.dimensions : goal.dimensions.length ? goal.dimensions : defaults.dimensions,
    currentLevel: researchChanged ? "" : goal.currentLevel,
    weeklyAvailableMinutes: researchChanged ? null : goal.weeklyAvailableMinutes,
    constraints: researchChanged ? [] : goal.constraints,
    fixedCommitments: researchChanged ? [] : goal.fixedCommitments,
    research: countdown.research ?? null,
    updatedAt: now,
    status: "collecting",
  };
  const question = nextGoalQuestion(updated);
  if (question) return { goal: updated, message: questionMessage(updated, question.key, question.title, question.body, countdown.id) };
  const readyGoal: GoalProfile = { ...updated, status: "ready" };
  return {
    goal: readyGoal,
    message: {
      id: createWorkbenchId("message"), kind: "information", severity: "normal",
      title: `“${readyGoal.title}”的资料已更新`, body: "在线研究已更新，现有个人资料仍然有效，可以继续使用当前计划。",
      evidence: ["没有创建重复目标", "计划生成前仍会展示确认内容"], goalId: readyGoal.id, taskId: null,
      countdownId: countdown.id, dedupeKey: `goal-research-updated:${readyGoal.id}:${countdown.research?.updatedAt ?? now}`,
      status: "unread", createdAt: now, readAt: null,
    },
  };
}

/** Repair goals created before online research was persisted as structured facts. */
export function repairResearchBackedGoals(state: WorkbenchState, now = Date.now()): WorkbenchState {
  let changed = false;
  // Older builds persisted polite confirmation questions. Promote those
  // records on startup when the model did not identify a real alternative.
  let countdowns = state.countdowns.map((countdown) => {
    const research = countdown.research;
    if (countdown.researchSuppressed || research?.status !== "needs_confirmation" || isGenuineGoalResearchAmbiguity(research.question)) return countdown;
    changed = true;
    return {
      ...countdown,
      research: { ...research, status: "ready" as const, confirmed: true, question: null, updatedAt: now },
    };
  });
  let aiMessages = state.aiMessages;
  let goals = state.goals.map((goal) => {
    const countdown = countdowns.find((item) => item.id === goal.countdownId || item.goalId === goal.id) ?? null;
    // Countdown research is newer than the goal snapshot after a retry. This also
    // reconnects goals saved by older desktop builds that did not persist research.
    const research = countdown?.researchSuppressed ? null : countdown?.research ?? goal.research ?? null;
    if (countdown?.researchSuppressed && goal.research) {
      const cleared = { ...goal, research: null, updatedAt: now };
      changed = true;
      return cleared;
    }
    const publicResearchConfirmed = hasConfirmedOnlineResearch(research);
    const defaults = countdown ? researchDefaults(countdown, research) : { outcome: "", dimensions: [] };
    if (!publicResearchConfirmed && !defaults.outcome && !defaults.dimensions.length) return goal;
    const outcome = goal.outcome.trim() || defaults.outcome;
    const dimensions = goal.dimensions.length ? goal.dimensions : defaults.dimensions;
    const hasSameResearch = goal.research?.status === research?.status
      && goal.research?.confirmed === research?.confirmed
      && goal.research?.query === research?.query
      && goal.research?.updatedAt === research?.updatedAt;
    const candidate: GoalProfile = { ...goal, outcome, dimensions, research };
    const status: GoalProfile["status"] = goal.status === "completed" ? "completed" : nextGoalQuestion(candidate) ? "collecting" : "ready";
    if (outcome === goal.outcome
      && dimensions.join("\u0000") === goal.dimensions.join("\u0000")
      && hasSameResearch
      && status === goal.status) return goal;
    changed = true;
    return {
      ...goal,
      outcome,
      completionStandard: goal.completionStandard.trim() || outcome,
      dimensions,
      research,
      status,
      updatedAt: now,
    };
  });
  let memories = state.memories;

  // A countdown can finish research while the app is closed before its goal
  // snapshot is written. Recreate that one goal in place and continue with the
  // normal progressive personal-profile questions.
  for (const countdown of countdowns) {
    const research = countdown.research;
    if (!hasConfirmedOnlineResearch(research)) continue;
    const existingGoal = goals.find((goal) => goal.id === countdown.goalId || goal.countdownId === countdown.id);
    if (existingGoal) continue;
    const created = createGoalFromCountdown(countdown, goals);
    goals = [...goals, created.goal];
    countdowns = countdowns.map((item) => item.id === countdown.id ? { ...item, goalId: created.goal.id } : item);
    aiMessages = [...aiMessages, created.message];
    changed = true;
  }

  // Resolve any old confirmation message that is now covered by automatic
  // judgment. Genuine alternatives remain untouched for the user to choose.
  aiMessages = aiMessages.map((message) => {
    if (message.questionKey !== "researchConfirmation" || !message.countdownId) return message;
    const countdown = countdowns.find((item) => item.id === message.countdownId);
    const research = countdown?.research;
    if (!research || research.status !== "ready" || isGenuineGoalResearchAmbiguity(message.body)) return message;
    if (message.status === "resolved" && message.body === "我已根据在线研究自动采用最可能的目标理解。") return message;
    changed = true;
    return { ...message, status: "resolved" as const, readAt: now, body: "我已根据在线研究自动采用最可能的目标理解。" };
  });

  for (const goal of goals) {
    const countdown = countdowns.find((item) => item.id === goal.countdownId || item.goalId === goal.id) ?? null;
    const research = countdown?.researchSuppressed ? null : countdown?.research ?? goal.research ?? null;
    if (hasConfirmedOnlineResearch(research) && !isMemorySuppressed(state, { category: "goal", key: "onlineResearch", goalId: goal.id })) {
      const value = `在线研究结论：${research.interpretation}。${research.summary}`;
      const researchMemories = memories.filter((item) => item.goalId === goal.id && item.key === "onlineResearch");
      const existingMemory = researchMemories.find((item) => item.value === value);
      if (existingMemory) {
        // Migrate any duplicate records left by an older confirmation path.
        const deduped = memories.filter((item) => !(item.goalId === goal.id && item.key === "onlineResearch") || item.id === existingMemory.id);
        if (deduped.length !== memories.length) {
          memories = deduped;
          changed = true;
        }
      } else {
        const researchMemory = createGoalResearchMemory(state, goal, research, countdown?.targetDate);
        memories = [...memories.filter((item) => !(item.goalId === goal.id && item.key === "onlineResearch")), researchMemory];
        changed = true;
      }
    }
    const next = nextGoalQuestion(goal);
    const related = aiMessages.filter((message) => message.goalId === goal.id && message.kind === "question" && message.status !== "resolved" && message.status !== "dismissed");
    for (const message of related) {
      const canResolve = (hasConfirmedOnlineResearch(research) && (message.questionKey === "outcome" || message.questionKey === "dimensions"))
        || (message.questionKey === "outcome" && Boolean(goal.outcome.trim()))
        || (message.questionKey === "dimensions" && goal.dimensions.length > 0);
      if (canResolve) {
        aiMessages = aiMessages.map((item) => item.id === message.id ? {
          ...item,
          status: "resolved" as const,
          readAt: now,
          body: "在线研究已接管这类公开资料，不再需要你重复填写。",
        } : item);
        changed = true;
      }
    }
    if (next && !aiMessages.some((message) => message.goalId === goal.id && message.questionKey === next.key && message.status !== "dismissed")) {
      aiMessages = [...aiMessages, questionMessage(goal, next.key, next.title, next.body)];
      changed = true;
    }
  }
  return changed ? { ...state, countdowns, goals, aiMessages, memories } : state;
}

export function confirmGoalResearch(state: WorkbenchState, messageId: string): WorkbenchState {
  const message = state.aiMessages.find((item) => item.id === messageId && item.kind === "question" && item.questionKey === "researchConfirmation");
  const countdown = message?.countdownId ? state.countdowns.find((item) => item.id === message.countdownId) : null;
  const research = countdown?.research;
  // The repair pass can promote a polite/legacy confirmation to `ready` while
  // its old message is still visible. Treat confirmation as idempotent so the
  // button still completes the same goal flow instead of appearing inert.
  if (!message || !countdown || !research || (research.status !== "needs_confirmation" && research.status !== "ready")) return state;
  const now = Date.now();
  const confirmedResearch = { ...research, confirmed: true, status: "ready" as const, question: null, updatedAt: now };
  const confirmedCountdown = { ...countdown, research: confirmedResearch };
  const existingGoal = state.goals.find((item) => item.id === countdown.goalId || item.countdownId === countdown.id) ?? null;
  const { goal, message: nextMessage } = existingGoal
    ? updateGoalFromCountdown(existingGoal, confirmedCountdown)
    : createGoalFromCountdown(confirmedCountdown, state.goals);
  const researchMemory = createGoalResearchMemory(state, goal, confirmedResearch, countdown.targetDate);
  return {
    ...state,
    countdowns: state.countdowns.map((item) => item.id === countdown.id ? { ...item, goalId: goal.id, research: confirmedResearch } : item),
    goals: existingGoal ? state.goals.map((item) => item.id === goal.id ? goal : item) : [...state.goals, goal],
    memories: [...state.memories.filter((item) => !(item.goalId === goal.id && item.key === "onlineResearch")), researchMemory],
    aiMessages: [
      ...state.aiMessages.map((item) => item.id === message.id ? { ...item, status: "resolved" as const, readAt: now } : item),
      nextMessage,
    ],
  };
}

function goalMemoryExpiresAt(state: WorkbenchState, goalId: string, fallbackDate?: string): number {
  const goal = state.goals.find((item) => item.id === goalId);
  const countdown = goal?.countdownId ? state.countdowns.find((item) => item.id === goal.countdownId) : null;
  const date = countdown?.targetDate ?? fallbackDate;
  return date ? new Date(`${date}T23:59:59`).getTime() : Date.now() + 90 * DAY_MS;
}

export function createGoalResearchMemory(state: WorkbenchState, goal: GoalProfile, research: GoalResearch, fallbackDate?: string): MemoryEntry {
  const now = Date.now();
  return {
    id: createWorkbenchId("memory"), category: "goal", key: "onlineResearch",
    value: `在线研究结论：${research.interpretation}。${research.summary}`,
    goalId: goal.id, source: "inferred", confidence: 85, evidenceCount: Math.max(1, research.sources.length), confirmed: true,
    createdAt: now, updatedAt: now, expiresAt: goalMemoryExpiresAt(state, goal.id, fallbackDate), lifecycle: "active", lifecycleNote: "在线研究得到的公开目标资料", validated: true, sourceQuery: research.query,
  };
}

function memoryDimensionValues(value: string): string[] {
  return value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
}

/** Remove a memory and, for online research, revoke the linked public facts. */
export function deleteMemory(state: WorkbenchState, memoryId: string, now = Date.now()): WorkbenchState {
  const memory = state.memories.find((item) => item.id === memoryId);
  if (!memory) return state;

  let countdowns = state.countdowns;
  let goals = state.goals;
  let aiMessages = state.aiMessages;
  // Suppression is only for automatically inferred records. Manually entered
  // memories should simply disappear; recreating the same key later must work.
  let shouldSuppress = memory.source === "inferred";

  if (memory.key === "onlineResearch" && memory.goalId) {
    const goal = state.goals.find((item) => item.id === memory.goalId) ?? null;
    const countdown = goal?.countdownId
      ? state.countdowns.find((item) => item.id === goal.countdownId) ?? null
      : state.countdowns.find((item) => item.goalId === memory.goalId) ?? null;
    const currentResearch = countdown?.research ?? goal?.research ?? null;
    // Old completed snapshots can remain visible after a target is renamed. Do
    // not suppress a newer research run when the user deletes that old record.
    const isCurrentSnapshot = !currentResearch || !memory.sourceQuery || currentResearch.query === memory.sourceQuery;
    shouldSuppress = isCurrentSnapshot;
    if (isCurrentSnapshot) {
      if (countdown) {
        countdowns = countdowns.map((item) => item.id === countdown.id
          ? { ...item, research: null, researchSuppressed: true }
          : item);
      }
      if (goal) {
        const userOutcome = state.memories.find((item) => item.id !== memory.id && item.goalId === goal.id && item.key === "outcome" && item.source === "user");
        const userDimensions = state.memories.find((item) => item.id !== memory.id && item.goalId === goal.id && item.key === "dimensions" && item.source === "user");
        const cleared = {
          ...goal,
          outcome: userOutcome?.value ?? "",
          completionStandard: userOutcome?.value ?? "",
          dimensions: userDimensions ? memoryDimensionValues(userDimensions.value) : [],
          research: null,
          status: "collecting" as const,
          updatedAt: now,
        };
        goals = goals.map((item) => item.id === goal.id ? cleared : item);
      }
      aiMessages = aiMessages.map((message) => {
        const related = message.goalId === memory.goalId || message.countdownId === countdown?.id;
        if (!related || (message.questionKey !== "researchConfirmation" && !message.dedupeKey.startsWith("goal-research-"))) return message;
        return { ...message, status: "dismissed" as const, readAt: now, body: "这条在线研究资料已删除，后续不会自动恢复。" };
      });
    }
  }

  const suppressionKey = memorySuppressionKey(memory);
  const existingSuppressedKeys = state.suppressedMemoryKeys ?? [];
  const suppressedMemoryKeys = shouldSuppress && !existingSuppressedKeys.includes(suppressionKey)
    ? [...existingSuppressedKeys, suppressionKey]
    : existingSuppressedKeys;
  return {
    ...state,
    countdowns,
    goals,
    aiMessages,
    memories: state.memories.filter((item) => item.id !== memoryId),
    suppressedMemoryKeys,
  };
}

/** Remove a countdown together with its generated goal context and messages. */
export function deleteCountdown(state: WorkbenchState, countdownId: string, now = Date.now()): WorkbenchState {
  const countdown = state.countdowns.find((item) => item.id === countdownId);
  if (!countdown) return state;
  const goalIds = new Set(state.goals.filter((goal) => goal.countdownId === countdownId || goal.id === countdown.goalId).map((goal) => goal.id));
  const suppressedMemoryKeys = (state.suppressedMemoryKeys ?? []).filter((key) => ![...goalIds].some((goalId) => key.endsWith(`:${goalId}`)));
  return {
    ...state,
    countdowns: state.countdowns.filter((item) => item.id !== countdownId),
    goals: state.goals.filter((goal) => !goalIds.has(goal.id)),
    memories: state.memories.filter((memory) => !goalIds.has(memory.goalId ?? "")),
    tasks: state.tasks.map((task) => goalIds.has(task.goalId ?? "") ? { ...task, goalId: null } : task),
    aiMessages: state.aiMessages.map((message) => message.countdownId === countdownId || goalIds.has(message.goalId ?? "")
      ? { ...message, status: "dismissed" as const, readAt: now, body: "关联倒数日已删除，这条消息不再参与规划。" }
      : message),
    suppressedMemoryKeys,
  };
}

export function answerGoalQuestion(state: WorkbenchState, messageId: string, answer: string): WorkbenchState {
  const message = state.aiMessages.find((item) => item.id === messageId && item.kind === "question");
  if (!message?.goalId || !message.questionKey || !answer.trim()) return state;
  const value = answer.trim();
  const now = Date.now();
  let updatedGoal: GoalProfile | null = null;
  const goals = state.goals.map((goal) => {
    if (goal.id !== message.goalId) return goal;
    const updated = { ...goal, updatedAt: now };
    if (message.questionKey === "outcome") updated.outcome = value;
    if (message.questionKey === "dimensions") updated.dimensions = value.split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
    if (message.questionKey === "currentLevel") updated.currentLevel = value;
    if (message.questionKey === "weeklyAvailability") {
      const amount = parseChineseAmount(value.match(/[\d一二两三四五六七八九十]+/)?.[0] ?? "0");
      updated.weeklyAvailableMinutes = Math.max(30, Math.round(amount * 60));
    }
    updated.status = nextGoalQuestion(updated) ? "collecting" : "ready";
    updatedGoal = updated;
    return updated;
  });
  if (!updatedGoal) return state;
  const resolvedGoal = updatedGoal as GoalProfile;
  const memory: MemoryEntry = {
    id: createWorkbenchId("memory"), category: "goal", key: message.questionKey, value,
    goalId: message.goalId, source: "user", confidence: 100, evidenceCount: 1, confirmed: true, validated: true,
    createdAt: now, updatedAt: now, expiresAt: goalMemoryExpiresAt(state, message.goalId), lifecycle: "active", lifecycleNote: "目标问答资料",
  };
  const next = nextGoalQuestion(resolvedGoal);
  const readyProposal = next ? null : createGoalPlanProposal({ ...state, goals }, resolvedGoal);
  return {
    ...state,
    goals,
    memories: [...state.memories.filter((item) => !(item.goalId === message.goalId && item.key === message.questionKey)), memory],
    aiMessages: [
      ...state.aiMessages.map((item) => item.id === messageId ? { ...item, status: "resolved" as const, readAt: now } : item),
      ...(next ? [questionMessage(resolvedGoal, next.key, next.title, next.body)] : [{
        id: createWorkbenchId("message"), kind: "information" as const, severity: "normal" as const,
        title: `“${resolvedGoal.title}”的资料已可用于规划`, body: "AI 已经获得生成第一版阶段计划所需的基础信息。",
        evidence: ["仍会随着执行结果逐步修正，不会把第一版计划视为固定结论"], goalId: resolvedGoal.id, taskId: null,
        dedupeKey: `goal-ready:${resolvedGoal.id}`, status: "unread" as const, createdAt: now, readAt: null,
      }]),
    ],
    planProposals: readyProposal ? [...state.planProposals, readyProposal] : state.planProposals,
  };
}

export function createGoalPlanProposal(state: WorkbenchState, goal: GoalProfile): PlanProposal {
  const countdown = state.countdowns.find((item) => item.id === goal.countdownId);
  const remainingDays = countdown ? Math.max(1, daysUntil(countdown.targetDate)) : 14;
  const dailyMinutes = Math.max(20, Math.min(90, Math.round((goal.weeklyAvailableMinutes ?? 300) / 5)));
  const labels = goal.dimensions.length ? goal.dimensions.slice(0, 3) : ["准备", "核心推进", "检查收尾"];
  const offsets = [0, Math.max(1, Math.floor(remainingDays * .45)), Math.max(1, remainingDays - 2)];
  const existing = new Set(state.tasks.filter((task) => task.goalId === goal.id).map((task) => task.title));
  const tasks = labels.map((label, index) => {
    const date = new Date();
    date.setDate(date.getDate() + Math.min(remainingDays, offsets[index] ?? index));
    return {
      id: createWorkbenchId("task"), title: `${goal.title}：${label}`, notes: `目标结果：${goal.outcome}`,
      priority: index === 0 ? "high" as const : "medium" as const, estimateMinutes: dailyMinutes,
      actualMinutes: null, projectId: goal.projectId, goalId: goal.id, scheduledFor: localDateKey(date),
      completedAt: null, createdAt: Date.now() + index, postponements: 0,
    };
  }).filter((task) => !existing.has(task.title));
  return {
    id: createWorkbenchId("proposal"), kind: "goal", title: `“${goal.title}”第一版阶段计划`,
    summary: `根据目标资料生成 ${tasks.length} 个可执行阶段。后续会依据完成情况和临时安排继续调整。`,
    evidence: [
      countdown ? `距离目标日期还有 ${remainingDays} 天` : "目标尚未设置倒数日，先按两周展开",
      `用户通常每周可投入 ${minutesLabel(goal.weeklyAvailableMinutes ?? 300)}`,
      `目标领域：${goal.dimensions.join("、") || "通用推进"}`,
      "专注计时未作为任务量的核心依据",
    ],
    changes: tasks.map((task) => ({ type: "createTask" as const, task })), status: "pending", createdAt: Date.now(),
  };
}

function hasMessage(state: WorkbenchState, dedupeKey: string): boolean {
  return state.aiMessages.some((message) => message.dedupeKey === dedupeKey && message.status !== "dismissed");
}

function anomalyMessage(input: Omit<AiMessage, "id" | "kind" | "status" | "createdAt" | "readAt">): AiMessage {
  return { ...input, id: createWorkbenchId("message"), kind: "anomaly", status: "unread", createdAt: Date.now(), readAt: null };
}

export function detectProactiveMessages(state: WorkbenchState, date = localDateKey()): AiMessage[] {
  if (!state.preferences.proactiveMessages) return [];
  const messages: AiMessage[] = [];
  const open = state.tasks.filter((task) => task.scheduledFor === date && !task.completedAt);
  const load = open.reduce((sum, task) => sum + task.estimateMinutes, 0);
  const capacity = calculateDailyCapacity(state, date);
  const overloadKey = `overload:${date}:${Math.ceil(load / 60)}`;
  if (load > capacity.effectiveMinutes && !hasMessage(state, overloadKey)) {
    messages.push(anomalyMessage({
      severity: load > capacity.effectiveMinutes * 1.5 ? "important" : "normal",
      title: "今天的任务量可能偏多",
      body: `尚有 ${minutesLabel(load)} 任务，当前可执行容量约为 ${minutesLabel(capacity.effectiveMinutes)}。建议先保留一个核心任务，再调整其余事项。`,
      evidence: capacity.evidence, goalId: null, taskId: null, dedupeKey: overloadKey,
    }));
  }
  for (const task of state.tasks.filter((item) => !item.completedAt && (item.postponements ?? 0) >= 2)) {
    const key = `delayed:${task.id}:${task.postponements}`;
    if (!hasMessage(state, key)) messages.push(anomalyMessage({
      severity: "important", title: `“${task.title}”反复被推迟`,
      body: "这通常意味着任务过大、目标不清或当前时间不合适。建议拆出一个 20 分钟的启动步骤。",
      evidence: [`该任务已经调整 ${task.postponements} 次`], goalId: task.goalId ?? null, taskId: task.id, dedupeKey: key,
    }));
  }
  for (const countdown of state.countdowns.filter((item) => daysUntil(item.targetDate, date) >= 0)) {
    const days = daysUntil(countdown.targetDate, date);
    const progressKey = `countdown-progress:${countdown.id}:${days}:${countdown.progress ?? 0}`;
    if (days <= 7 && (countdown.progress ?? 0) < 40 && !hasMessage(state, progressKey)) {
      messages.push(anomalyMessage({
        severity: days <= 3 ? "important" : "normal",
        title: `“${countdown.title}”进入提醒区间`,
        body: `距离目标还有 ${days} 天，当前记录进度约为 ${countdown.progress ?? 0}%。建议今天只安排一个最小推进步骤。`,
        evidence: [`目标日期：${countdown.targetDate}`, `当前进度：${countdown.progress ?? 0}%`], goalId: countdown.goalId ?? null, taskId: null, countdownId: countdown.id, dedupeKey: progressKey,
      }));
    }
    if (!countdown.goalId && !countdown.research && !state.goals.some((goal) => goal.countdownId === countdown.id)) {
      const key = `missing-goal:${countdown.id}`;
      if (!hasMessage(state, key)) messages.push(anomalyMessage({
        severity: "normal", title: `“${countdown.title}”还缺少规划资料`,
        body: "我知道目标日期，但还不了解完成标准、目标领域和可用时间。补充后才能更准确地安排任务量。",
        evidence: [`距离目标还有 ${Math.max(0, daysUntil(countdown.targetDate, date))} 天`], goalId: null, taskId: null, dedupeKey: key,
      }));
    }
  }
  return messages;
}

function parseDateReference(input: string, now: Date): string {
  const target = new Date(now);
  if (/后天/.test(input)) target.setDate(target.getDate() + 2);
  else if (/明天|明日/.test(input)) target.setDate(target.getDate() + 1);
  const dateMatch = input.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (dateMatch) return `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;
  return localDateKey(target);
}

function normalizeHour(raw: string, period: string | undefined): number {
  let hour = parseChineseAmount(raw);
  if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
  return Math.min(23, hour);
}

export function parseTemporaryArrangement(input: string, now = new Date()): ParsedArrangement | null {
  const sourceText = input.trim();
  if (!sourceText) return null;
  const date = parseDateReference(sourceText, now);
  const capacityMatch = sourceText.match(/(?:只能|只有|可用|能用|有)\s*(?:学习|工作|处理|投入)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]+)\s*(?:个)?小时/);
  const rangeMatch = sourceText.match(/(上午|下午|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*点(?:半)?\s*(?:到|至|—|-)\s*(上午|下午|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*点(?:半)?/);
  const pointMatch = sourceText.match(/(上午|下午|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*点/);
  const periodMatch = !rangeMatch && sourceText.match(/(上午|下午|晚上)/);
  let startTime: string | null = null;
  let endTime: string | null = null;
  let needsClarification = false;
  if (rangeMatch) {
    const start = normalizeHour(rangeMatch[2], rangeMatch[1]);
    const end = normalizeHour(rangeMatch[4], rangeMatch[3] ?? rangeMatch[1]);
    startTime = `${String(start).padStart(2, "0")}:00`;
    endTime = `${String(Math.max(start + 1, end)).padStart(2, "0")}:00`;
  } else if (pointMatch) {
    const start = normalizeHour(pointMatch[2], pointMatch[1]);
    startTime = `${String(start).padStart(2, "0")}:00`;
    endTime = `${String(Math.min(23, start + 2)).padStart(2, "0")}:00`;
    needsClarification = true;
  } else if (periodMatch) {
    [startTime, endTime] = periodMatch[1] === "上午" ? ["08:00", "12:00"] : periodMatch[1] === "下午" ? ["13:00", "18:00"] : ["18:00", "22:00"];
  }
  if (!capacityMatch && !startTime && !/(安排|有课|开会|出差|聚会|医院|培训|考试)/.test(sourceText)) return null;
  return {
    needsClarification,
    exception: {
      id: createWorkbenchId("schedule"), title: sourceText, date, startTime, endTime,
      capacityOverrideMinutes: capacityMatch ? Math.round(parseChineseAmount(capacityMatch[1]) * 60) : null,
      recurring: false, sourceText, createdAt: Date.now(),
    },
  };
}

function nextDate(date: string): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + 1);
  return localDateKey(value);
}

export function createReplanProposal(state: WorkbenchState, exception: ScheduleException): PlanProposal {
  const previewState = { ...state, scheduleExceptions: [...state.scheduleExceptions, exception] };
  const capacity = calculateDailyCapacity(previewState, exception.date);
  const tasks = state.tasks
    .filter((task) => task.scheduledFor === exception.date && !task.completedAt)
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt - b.createdAt);
  let used = 0;
  const movable: WorkbenchTask[] = [];
  for (const task of tasks) {
    if (used + task.estimateMinutes <= capacity.effectiveMinutes || used === 0) used += task.estimateMinutes;
    else if (!task.fixedDate) movable.push(task);
  }
  return {
    id: createWorkbenchId("proposal"), kind: "replan", title: "临时安排后的计划调整",
    summary: movable.length ? `保留 ${tasks.length - movable.length} 项优先任务，将 ${movable.length} 项移到下一天。` : "当前任务仍在可执行容量内，不需要移动任务。",
    evidence: [...capacity.evidence, `调整后可执行容量约为 ${minutesLabel(capacity.effectiveMinutes)}`],
    changes: [
      { type: "addScheduleException", exception },
      ...movable.map((task) => ({ type: "rescheduleTask" as const, taskId: task.id, fromDate: task.scheduledFor, toDate: nextDate(exception.date) })),
    ],
    status: "pending", createdAt: Date.now(),
  };
}

export function createDailyRebalanceProposal(state: WorkbenchState, date = localDateKey()): PlanProposal {
  const capacity = calculateDailyCapacity(state, date);
  const tasks = state.tasks
    .filter((task) => task.scheduledFor === date && !task.completedAt)
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt - b.createdAt);
  let used = 0;
  const movable: WorkbenchTask[] = [];
  for (const task of tasks) {
    if (used + task.estimateMinutes <= capacity.effectiveMinutes || used === 0) used += task.estimateMinutes;
    else if (!task.fixedDate) movable.push(task);
  }
  return {
    id: createWorkbenchId("proposal"), kind: "daily", title: "今日任务量调整",
    summary: movable.length ? `保留 ${tasks.length - movable.length} 项优先任务，将 ${movable.length} 项移到明天。` : "当前任务量在可执行容量内，不需要改期。",
    evidence: [...capacity.evidence, `今天的可执行容量约为 ${minutesLabel(capacity.effectiveMinutes)}`],
    changes: movable.map((task) => ({ type: "rescheduleTask" as const, taskId: task.id, fromDate: task.scheduledFor, toDate: nextDate(date) })),
    status: "pending", createdAt: Date.now(),
  };
}

export function createStarterTaskProposal(state: WorkbenchState, taskId: string, date = localDateKey()): PlanProposal | null {
  const source = state.tasks.find((task) => task.id === taskId && !task.completedAt);
  if (!source) return null;
  const task: WorkbenchTask = {
    id: createWorkbenchId("task"), title: `启动：${source.title}`, notes: `从“${source.title}”拆出的低门槛启动步骤`,
    priority: source.priority, estimateMinutes: 20, actualMinutes: null, projectId: source.projectId,
    goalId: source.goalId ?? null, scheduledFor: date, completedAt: null, createdAt: Date.now(), postponements: 0,
  };
  return {
    id: createWorkbenchId("proposal"), kind: "rescue", title: "创建 20 分钟启动任务",
    summary: `先用一个短步骤重新开始“${source.title}”，原任务保持不变。`,
    evidence: [`该任务已经调整 ${source.postponements ?? 0} 次`, "确认前不会创建新任务"],
    changes: [{ type: "createTask", task }], status: "pending", createdAt: Date.now(),
  };
}

export function applyPlanProposal(state: WorkbenchState, proposalId: string): WorkbenchState {
  const proposal = state.planProposals.find((item) => item.id === proposalId && item.status === "pending");
  if (!proposal || proposalConflict(state, proposal)) return state;
  if (proposal.snapshotVersion && proposal.snapshotVersion !== workbenchStateVersion(state)) return state;
  let tasks = state.tasks;
  let scheduleExceptions = state.scheduleExceptions;
  let goals = state.goals;
  let memories = state.memories;
  for (const change of proposal.changes) {
    if (change.type === "rescheduleTask") tasks = tasks.map((task) => task.id === change.taskId ? { ...task, scheduledFor: change.toDate, postponements: (task.postponements ?? 0) + 1 } : task);
    if (change.type === "createTask") tasks = [...tasks, change.task];
    if (change.type === "addScheduleException") scheduleExceptions = [...scheduleExceptions, change.exception];
    if (change.type === "updateGoal") goals = goals.map((goal) => goal.id === change.goalId ? { ...goal, ...change.patch, updatedAt: Date.now() } : goal);
    if (change.type === "saveMemory") memories = [...memories.filter((memory) => !(memory.category === change.memory.category && memory.key === change.memory.key && memory.goalId === change.memory.goalId)), { ...change.memory, updatedAt: Date.now() }];
  }
  return {
    ...state, tasks, scheduleExceptions, goals, memories,
    undoOperations: [...state.undoOperations.slice(-9), { id: createWorkbenchId("undo"), title: proposal.title, beforeTasks: state.tasks, afterTasks: tasks, beforeExceptions: state.scheduleExceptions, afterExceptions: scheduleExceptions, beforeGoals: state.goals, afterGoals: goals, beforeMemories: state.memories, afterMemories: memories, createdAt: Date.now() }],
    planProposals: state.planProposals.map((item) => item.id === proposalId ? { ...item, status: "applied" } : item),
  };
}

export function memoryLifecycle(state: WorkbenchState, memory: MemoryEntry, now = Date.now()): MemoryLifecycle {
  if (memory.lifecycle === "completed") return "completed";
  if (memory.goalId && state.goals.find((goal) => goal.id === memory.goalId)?.status === "completed") return "completed";
  if (memory.validated === false || memory.lifecycle === "needs_review") return "needs_review";
  if (memory.expiresAt !== null && memory.expiresAt <= now) return "expired";
  return memory.confirmed ? "active" : "paused";
}

export function syncMemoryLifecycle(state: WorkbenchState, now = Date.now()): WorkbenchState {
  let changed = false;
  const memories = state.memories.map((memory) => {
    const lifecycle = memoryLifecycle(state, memory, now);
    const completed = lifecycle === "completed" ? (memory.completedAt ?? now) : null;
    const note = lifecycle === "completed"
      ? (memory.lifecycleNote || "关联目标已完成")
      : lifecycle === "expired"
        ? "有效期已结束"
        : memory.lifecycleNote ?? null;
    if (memory.lifecycle === lifecycle && (memory.completedAt ?? null) === completed && (memory.lifecycleNote ?? null) === note) return memory;
    changed = true;
    return { ...memory, lifecycle, completedAt: completed, lifecycleNote: note, updatedAt: now };
  });
  return changed ? { ...state, memories } : state;
}

export function relevantMemories(state: WorkbenchState, goalId: string | null, now = Date.now()): MemoryEntry[] {
  return state.memories.filter((memory) => memory.validated !== false && memoryLifecycle(state, memory, now) === "active"
    && !isMemorySuppressed(state, memory)
    && (memory.goalId === null || memory.goalId === goalId));
}

export interface ExplicitMemoryCandidate {
  category: "profile" | "preference";
  key: "major" | "identity" | "school" | "preference";
  value: string;
}

function cleanExplicitMemoryValue(value: string): string {
  return value.replace(/[\s]+/g, " ").replace(/[。.!！?？]+$/g, "").trim();
}

/**
 * Extract only high-confidence, explicitly stated user facts from ordinary chat.
 * This intentionally handles a small set of strong Chinese statements instead
 * of treating every sentence as memory.
 */
export function extractExplicitMemoryCandidate(prompt: string): ExplicitMemoryCandidate | null {
  const text = prompt.trim();
  if (text.length < 4 || text.length > 240 || /[?？]/.test(text)) return null;
  if (/(今天|明天|后天|这次|刚刚|现在|暂时|可能|也许|大概|有时候|偶尔|这几天|本周|下周|今晚)/.test(text)) return null;

  const majorBy = text.match(/我(?:其实)?是(?:一名|一位|一个)?专业(?:为|是)([^，。！？；\n]{2,40})的学生/);
  if (majorBy) {
    const major = cleanExplicitMemoryValue(majorBy[1]).replace(/专业$/g, "");
    if (major) return { category: "profile", key: "major", value: `${major}专业的学生` };
  }
  const major = text.match(/我的专业(?:是|为)([^，。！？；\n]{2,40})/)
    || text.match(/我(?:其实)?是(?:一名|一位|一个)?([^，。！？；\n]{2,40}?专业)的学生/);
  if (major) {
    const value = cleanExplicitMemoryValue(major[1]);
    if (value) return { category: "profile", key: "major", value: value.endsWith("学生") ? value : `${value}学生` };
  }
  const school = text.match(/我(?:目前)?就读于([^，。！？；\n]{2,60})/);
  if (school) {
    const value = cleanExplicitMemoryValue(school[1]);
    if (value) return { category: "profile", key: "school", value: `就读于${value}` };
  }
  const identity = text.match(/我的(?:长期)?(?:身份|职业)是([^，。！？；\n]{2,40})/)
    || text.match(/我(?:其实)?是(?:一名|一位|一个)([^，。！？；\n]{2,40})/);
  if (identity) {
    const value = cleanExplicitMemoryValue(identity[1]);
    if (value && !/学生$/.test(value)) return { category: "profile", key: "identity", value };
  }
  const preference = text.match(/我(?:通常|一直|总是|习惯|更喜欢|不喜欢)([^，。！？；\n]{3,80})/);
  if (preference) {
    const value = cleanExplicitMemoryValue(`我${text.match(/我(通常|一直|总是|习惯|更喜欢|不喜欢)/)?.[1] ?? "通常"}${preference[1]}`);
    if (value) return { category: "preference", key: "preference", value };
  }
  return null;
}

/** Persist one high-confidence chat fact while keeping conflicting profile facts inactive. */
export function recordExplicitMemoryFromChat(state: WorkbenchState, candidate: ExplicitMemoryCandidate, now = Date.now()): WorkbenchState {
  const existing = state.memories.find((memory) => memory.category === candidate.category
    && memory.key === candidate.key && memory.goalId === null && memory.value === candidate.value);
  const memories = existing
    ? state.memories.map((memory) => memory.id === existing.id
      ? { ...memory, source: "user" as const, confirmed: true, validated: true, lifecycle: "active" as const, updatedAt: now }
      : memory)
    : [
      ...state.memories.map((memory) => memory.category === candidate.category && memory.key === candidate.key && memory.goalId === null
        && (candidate.key === "major" || candidate.key === "school" || candidate.key === "identity")
        ? { ...memory, lifecycle: "completed" as const, completedAt: now, lifecycleNote: "用户提供了更新后的个人资料", updatedAt: now }
        : memory),
      {
        id: createWorkbenchId("memory"), category: candidate.category, key: candidate.key, value: candidate.value,
        goalId: null, source: "user" as const, confidence: 100, evidenceCount: 1, confirmed: true, validated: true,
        createdAt: now, updatedAt: now, expiresAt: null, lifecycle: "active" as const, lifecycleNote: "用户在普通对话中明确提供", completedAt: null,
      },
    ];
  const suppressionKey = memorySuppressionKey({ category: candidate.category, key: candidate.key, goalId: null });
  return { ...state, memories, suppressedMemoryKeys: (state.suppressedMemoryKeys ?? []).filter((key) => key !== suppressionKey) };
}

export function inferStableMemories(state: WorkbenchState, now = Date.now()): MemoryEntry[] {
  const cutoff = now - 30 * DAY_MS;
  const completions = state.tasks.filter((task) => task.completedAt && task.completedAt >= cutoff);
  if (completions.length < 4) return [];
  const periods = { morning: 0, afternoon: 0, evening: 0 };
  for (const task of completions) {
    const hour = new Date(task.completedAt!).getHours();
    periods[hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"] += 1;
  }
  const [period, count] = Object.entries(periods).sort((a, b) => b[1] - a[1])[0] as [keyof typeof periods, number];
  const share = count / completions.length;
  if (count < 4 || share < .65) return [];
  const key = "productivePeriod";
  if (isMemorySuppressed(state, { category: "habit", key, goalId: null })) return [];
  const labels = { morning: "近期更常在上午完成任务", afternoon: "近期更常在下午完成任务", evening: "近期更常在晚上完成任务" };
  const existing = state.memories.find((memory) => memory.source === "inferred" && memory.key === key && memory.goalId === null);
  return [{
    id: existing?.id ?? createWorkbenchId("memory"), category: "habit", key, value: labels[period],
    goalId: null, source: "inferred", confidence: Math.round(share * 100), evidenceCount: count,
    confirmed: true, createdAt: existing?.createdAt ?? now, updatedAt: now, expiresAt: now + 45 * DAY_MS,
  }];
}
