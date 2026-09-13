import { createInitialWorkbenchState, type WorkbenchState } from "./model";

export const WORKBENCH_STORAGE_KEY = "moji.personal-workbench.v2";
const LEGACY_STORAGE_KEY = "moji.personal-workbench.v1";

type LegacyState = Partial<Omit<WorkbenchState, "version">> & { version?: number };

export function normalizeWorkbenchState(value: unknown): WorkbenchState {
  const initial = createInitialWorkbenchState();
  if (!value || typeof value !== "object") return initial;
  const candidate = value as LegacyState;
  if (typeof candidate.version === "number" && candidate.version > 3) throw new Error("此数据来自更高版本，请升级墨集后打开");
  if (!Array.isArray(candidate.tasks)
    || !Array.isArray(candidate.projects)
    || !Array.isArray(candidate.countdowns)
    || !Array.isArray(candidate.focusRecords)) return initial;

  return {
    ...initial,
    ...candidate,
    version: 3,
    captures: Array.isArray(candidate.captures) ? candidate.captures : [],
    projectNotes: Array.isArray(candidate.projectNotes) ? candidate.projectNotes : [],
    outcomes: Array.isArray(candidate.outcomes) ? candidate.outcomes : [],
    reviews: Array.isArray(candidate.reviews) ? candidate.reviews : [],
    recurrenceRules: Array.isArray(candidate.recurrenceRules) ? candidate.recurrenceRules : [],
    focusSession: candidate.focusSession ?? null,
    trash: Array.isArray(candidate.trash) ? candidate.trash : [],
    undoOperations: Array.isArray(candidate.undoOperations) ? candidate.undoOperations : [],
    tasks: candidate.tasks.map((task) => ({ ...task, status: task.completedAt ? "done" : task.status === "blocked" || task.status === "doing" ? task.status : "todo", steps: task.steps ?? [], fixedDate: task.fixedDate ?? false, actualMinutes: task.actualMinutes ?? null, goalId: task.goalId ?? null, postponements: task.postponements ?? 0 })),
    projects: candidate.projects.map((project) => {
      const linkedDocumentIds = (project as { linkedDocumentIds?: unknown }).linkedDocumentIds;
      const linkedDocuments = (project as { linkedDocuments?: unknown }).linkedDocuments;
      return {
        ...project, status: project.status ?? "active", goal: project.goal ?? "", stages: project.stages ?? [],
        linkedDocumentIds: Array.isArray(linkedDocumentIds)
          ? linkedDocumentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [],
        linkedDocuments: Array.isArray(linkedDocuments)
          ? linkedDocuments.filter((item): item is NonNullable<WorkbenchState["projects"][number]["linkedDocuments"]>[number] => Boolean(item && typeof item === "object" && typeof (item as { documentId?: unknown }).documentId === "string"))
          : [],
      };
    }),
    countdowns: candidate.countdowns.map((countdown) => ({
      ...countdown,
      goalId: countdown.goalId ?? null,
      progress: countdown.progress ?? 0,
      researchSuppressed: countdown.researchSuppressed ?? false,
      research: countdown.research ? {
        ...countdown.research,
        suggestedOutcome: countdown.research.suggestedOutcome ?? null,
        suggestedDimensions: Array.isArray(countdown.research.suggestedDimensions) ? countdown.research.suggestedDimensions : [],
      } : null,
    })),
    goals: Array.isArray(candidate.goals) ? candidate.goals : [],
    memories: Array.isArray(candidate.memories) ? candidate.memories.map((memory) => ({
      ...memory,
      sourceQuery: memory.sourceQuery ?? null,
      // Goal answers created before online validation are kept for review but never sent to AI.
      validated: memory.validated ?? (memory.category === "goal" ? false : true),
      lifecycle: memory.lifecycle ?? (memory.category === "goal" ? "needs_review" : undefined),
    })) : [],
    memoryUsageEvents: Array.isArray(candidate.memoryUsageEvents) ? candidate.memoryUsageEvents : [],
    aiUsageRecords: Array.isArray(candidate.aiUsageRecords) ? candidate.aiUsageRecords : [],
    aiMessages: Array.isArray(candidate.aiMessages) ? candidate.aiMessages : [],
    aiChatHistory: Array.isArray(candidate.aiChatHistory) ? candidate.aiChatHistory.filter((turn) => turn && typeof turn.id === "string" && (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string").slice(-200) : [],
    agentRuns: Array.isArray((candidate as { agentRuns?: unknown }).agentRuns) ? (candidate as { agentRuns: unknown[] }).agentRuns.filter((run) => run && typeof run === "object" && typeof (run as { id?: unknown }).id === "string").slice(-50) as WorkbenchState["agentRuns"] : [],
    scheduleExceptions: Array.isArray(candidate.scheduleExceptions) ? candidate.scheduleExceptions : [],
    planProposals: Array.isArray(candidate.planProposals) ? candidate.planProposals.map((proposal) => ({
      ...proposal,
      projectId: proposal.projectId ?? null,
      sourceDocumentIds: Array.isArray(proposal.sourceDocumentIds) ? proposal.sourceDocumentIds.filter((id): id is string => typeof id === "string") : [],
    })) : [],
    dailyCheckIns: Array.isArray(candidate.dailyCheckIns) ? candidate.dailyCheckIns : [],
    suppressedMemoryKeys: Array.isArray(candidate.suppressedMemoryKeys)
      ? candidate.suppressedMemoryKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
      : [],
    preferences: {
      ...initial.preferences,
      ...(candidate.preferences ?? {}),
      showMetrics: candidate.preferences?.showMetrics ?? true,
      memoryTutorialVersion: candidate.preferences?.memoryTutorialVersion ?? 0,
      aiConfig: {
        ...initial.preferences.aiConfig,
        ...(candidate.preferences?.aiConfig ?? {}),
      },
    },
  };
}

export function loadWorkbenchState(storage: Pick<Storage, "getItem"> = window.localStorage): WorkbenchState {
  try {
    const raw = storage.getItem(WORKBENCH_STORAGE_KEY) ?? storage.getItem(LEGACY_STORAGE_KEY);
    return raw ? normalizeWorkbenchState(JSON.parse(raw)) : createInitialWorkbenchState();
  } catch {
    return createInitialWorkbenchState();
  }
}

export function saveWorkbenchState(state: WorkbenchState, storage: Pick<Storage, "setItem"> & Partial<Pick<Storage, "getItem">> = window.localStorage): void {
  if (storage === window.localStorage) {
    const raw = storage.getItem?.(WORKBENCH_STORAGE_KEY);
    if (raw) validateStoredWorkbench(JSON.parse(raw));
  }
  storage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(state));
}

export function validateStoredWorkbench(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作台数据格式无效，请从备份恢复");
  const state = value as Record<string, unknown>;
  if (typeof state.version !== "number" || state.version < 1 || state.version > 3) throw new Error("工作台数据版本不兼容");
  for (const key of ["tasks", "projects", "countdowns", "focusRecords"]) {
    if (!Array.isArray(state[key])) throw new Error("工作台数据不完整，请从备份恢复");
    const ids = new Set<string>();
    for (const entry of state[key] as unknown[]) {
      if (!entry || typeof entry !== "object" || typeof (entry as {id?: unknown}).id !== "string" || ids.has((entry as {id: string}).id)) throw new Error("工作台条目无效或重复");
      ids.add((entry as {id: string}).id);
    }
  }
}
