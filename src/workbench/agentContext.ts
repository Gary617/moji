import type { WorkbenchState } from "./model";

export interface WorkbenchAgentSnapshot {
  snapshotVersion: string;
  currentDate: string;
  goals: WorkbenchState["goals"];
  projects: WorkbenchState["projects"];
  tasks: WorkbenchState["tasks"];
  countdowns: WorkbenchState["countdowns"];
  scheduleExceptions: WorkbenchState["scheduleExceptions"];
  memories: WorkbenchState["memories"];
  pendingPlanProposals: WorkbenchState["planProposals"];
  recentChat: WorkbenchState["aiChatHistory"];
  preferences: Omit<WorkbenchState["preferences"], "aiConfig">;
}

export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function workbenchStateVersion(state: WorkbenchState): string {
  return buildWorkbenchAgentSnapshot(state, "").snapshotVersion;
}

export function buildWorkbenchAgentSnapshot(state: WorkbenchState, currentDate: string, recentChatLimit = 24): WorkbenchAgentSnapshot {
  const snapshot = {
    currentDate,
    goals: state.goals.filter((goal) => goal.status !== "completed").slice(0, 30),
    projects: state.projects.slice(0, 30),
    tasks: state.tasks.filter((task) => !task.completedAt).slice(0, 80),
    countdowns: state.countdowns.slice(0, 30),
    scheduleExceptions: state.scheduleExceptions.slice(-60),
    memories: state.memories.filter((memory) => memory.confirmed && memory.lifecycle !== "expired").slice(-100),
    pendingPlanProposals: state.planProposals.filter((proposal) => proposal.status === "pending").slice(-10),
    recentChat: (state.aiChatHistory ?? []).slice(-recentChatLimit),
    preferences: {
      nickname: state.preferences.nickname,
      defaultFocusMinutes: state.preferences.defaultFocusMinutes,
      defaultDailyCapacityMinutes: state.preferences.defaultDailyCapacityMinutes,
      bufferPercent: state.preferences.bufferPercent,
      proactiveMessages: state.preferences.proactiveMessages,
      showMetrics: state.preferences.showMetrics,
      memoryTutorialVersion: state.preferences.memoryTutorialVersion,
    },
  };
  const serialized = JSON.stringify(snapshot);
  return { ...snapshot, snapshotVersion: stableHash(serialized) };
}
