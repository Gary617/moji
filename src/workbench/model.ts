export type TaskPriority = "high" | "medium" | "low";
export type FocusOutcome = "completed" | "partial" | "blocked";
export type GoalStatus = "collecting" | "ready" | "active" | "completed";
export type MemoryCategory = "profile" | "goal" | "habit" | "preference";
export type MemorySource = "user" | "inferred";
export type MemoryLifecycle = "active" | "paused" | "needs_review" | "expired" | "completed";
export type AiMessageKind = "question" | "anomaly" | "suggestion" | "information";
export type AiMessageSeverity = "normal" | "important" | "urgent";
export type AiMessageStatus = "unread" | "read" | "resolved" | "dismissed";
export type GoalQuestionKey = "researchConfirmation" | "outcome" | "dimensions" | "currentLevel" | "weeklyAvailability";
export type GoalResearchStatus = "idle" | "researching" | "needs_confirmation" | "ready" | "failed";

export interface GoalResearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface GoalResearch {
  status: GoalResearchStatus;
  query: string;
  interpretation: string;
  summary: string;
  question: string | null;
  /** Public facts inferred from online research; never contains user-specific assumptions. */
  suggestedOutcome?: string | null;
  suggestedDimensions?: string[];
  sources: GoalResearchSource[];
  confirmed: boolean;
  error: string | null;
  updatedAt: number;
}

export interface CaptureItem {
  id: string; text: string; documentId?: string; projectId?: string;
  createdAt: number; convertedTo?: { kind: "task" | "project" | "note"; id: string };
}
export interface ProjectNote { id: string; projectId: string; text: string; sourceId?: string; createdAt: number }
export interface ProjectOutcome { id: string; projectId: string | null; taskId: string; summary: string; url: string; documentId: string | null; createdAt: number }
export interface ProjectReview { id: string; projectId: string; week: string; text: string; nextStep: string; taskId?: string; createdAt: number }
export interface RecurrenceRule { id: string; title: string; projectId: string | null; minutes: number; frequency: "daily" | "weekly"; weekday: number; startDate: string; lastDate?: string; active: boolean }
export interface FocusSession { taskId: string; duration: number; remaining: number; startedAt: number; updatedAt: number }
export interface TrashEntry { id: string; kind: "task" | "project" | "capture"; value: WorkbenchTask | WorkbenchProject | CaptureItem; deletedAt: number }
export interface OperationUndo { id: string; title: string; beforeTasks: WorkbenchTask[]; afterTasks: WorkbenchTask[]; beforeExceptions: ScheduleException[]; afterExceptions: ScheduleException[]; beforeGoals?: GoalProfile[]; afterGoals?: GoalProfile[]; beforeMemories?: MemoryEntry[]; afterMemories?: MemoryEntry[]; createdAt: number }
export interface WorkbenchTask {
  id: string;
  title: string;
  notes: string;
  priority: TaskPriority;
  estimateMinutes: number;
  actualMinutes?: number | null;
  status?: "todo" | "doing" | "blocked" | "done";
  blockedReason?: string;
  fixedDate?: boolean;
  steps?: { id: string; text: string; done: boolean }[];
  sourceId?: string;
  recurrenceId?: string;
  projectId: string | null;
  goalId?: string | null;
  scheduledFor: string;
  completedAt: number | null;
  createdAt: number;
  postponements?: number;
}

export interface WorkbenchProject {
  goal?: string;
  status?: "active" | "completed" | "archived";
  stages?: string[];
  template?: string;
  id: string;
  name: string;
  createdAt: number;
  /** IDs are the source of truth; snapshots keep the card useful if the library is temporarily unavailable. */
  linkedDocumentIds: string[];
  linkedDocuments?: WorkbenchProjectDocument[];
}

export interface WorkbenchProjectDocument {
  documentId: string;
  displayName: string;
  format: string;
  modifiedAtMs: number;
  linkedAt: number;
}

export interface WorkbenchCountdown {
  id: string;
  title: string;
  targetDate: string;
  kind: "exam" | "deadline" | "project" | "personal";
  projectId: string | null;
  goalId?: string | null;
  research?: GoalResearch | null;
  /** Set when the user removes the current AI research so startup repair does not restore it. */
  researchSuppressed?: boolean;
  createdAt: number;
  progress?: number;
}

export interface FocusRecord {
  id: string;
  taskId: string;
  plannedMinutes: number;
  actualMinutes: number;
  outcome: FocusOutcome;
  note: string;
  endedAt: number;
  startedAt?: number;
  nextStep?: string;
}

export interface GoalProfile {
  id: string;
  countdownId: string | null;
  projectId: string | null;
  title: string;
  outcome: string;
  completionStandard: string;
  dimensions: string[];
  currentLevel: string;
  weeklyAvailableMinutes: number | null;
  constraints: string[];
  fixedCommitments: string[];
  primary: boolean;
  status: GoalStatus;
  research?: GoalResearch | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  goalId: string | null;
  source: MemorySource;
  confidence: number;
  evidenceCount: number;
  confirmed: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lifecycle?: MemoryLifecycle;
  lifecycleNote?: string | null;
  completedAt?: number | null;
  validated?: boolean;
  /** Internal link used to distinguish a research snapshot from later edits. */
  sourceQuery?: string | null;
}

export interface MemoryUsageSnapshot {
  id: string;
  category: MemoryCategory;
  value: string;
  goalId: string | null;
  lifecycle?: MemoryLifecycle;
}

export interface MemoryUsageEvent {
  id: string;
  trigger: "assistant_chat";
  promptSummary: string;
  memories: MemoryUsageSnapshot[];
  status: "pending" | "completed" | "failed";
  createdAt: number;
  completedAt: number | null;
}

export interface WorkbenchAiUsageRecord {
  id: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: number;
}

export interface AiMessage {
  id: string;
  kind: AiMessageKind;
  severity: AiMessageSeverity;
  title: string;
  body: string;
  evidence: string[];
  goalId: string | null;
  taskId: string | null;
  countdownId?: string | null;
  questionKey?: GoalQuestionKey;
  dedupeKey: string;
  status: AiMessageStatus;
  createdAt: number;
  readAt: number | null;
}

export interface WorkbenchChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export type AgentRunStatus = "idle" | "planning" | "retrieving" | "waiting_confirmation" | "executing" | "completed" | "failed" | "cancelled";
export interface AgentTraceEvent { id: string; runId: string; kind: "stage" | "tool" | "evidence" | "proposal" | "error"; label: string; detail?: string; createdAt: number }
export interface AgentRun { id: string; sessionId: string; status: AgentRunStatus; snapshotVersion: string; startedAt: number; finishedAt: number | null; currentStep: string; trace: AgentTraceEvent[]; requiresConfirmation: boolean; error: string | null }

export interface ScheduleException {
  id: string;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  capacityOverrideMinutes: number | null;
  recurring: boolean;
  sourceText: string;
  createdAt: number;
}

export type PlanChange =
  | { type: "rescheduleTask"; taskId: string; fromDate: string; toDate: string }
  | { type: "createTask"; task: WorkbenchTask }
  | { type: "addScheduleException"; exception: ScheduleException }
  | { type: "updateGoal"; goalId: string; patch: Pick<GoalProfile, "outcome" | "dimensions" | "currentLevel" | "weeklyAvailableMinutes"> }
  | { type: "saveMemory"; memory: MemoryEntry };

export interface PlanProposal {
  id: string;
  kind: "daily" | "goal" | "replan" | "rescue";
  title: string;
  summary: string;
  evidence: string[];
  changes: PlanChange[];
  status: "pending" | "applied" | "rejected";
  createdAt: number;
  projectId?: string | null;
  sourceDocumentIds?: string[];
  /** Deadline evidence used to build a project action plan. */
  deadlineDate?: string | null;
  deadlineSource?: string | null;
  deadlineEvidence?: string | null;
  snapshotVersion?: string;
}

export interface DailyCheckIn {
  id: string;
  date: string;
  availableMinutes: number | null;
  state: "low" | "normal" | "high";
  note: string;
  createdAt: number;
}

export interface WorkbenchPreferences {
  nickname: string;
  defaultFocusMinutes: number;
  defaultDailyCapacityMinutes: number;
  bufferPercent: number;
  proactiveMessages: boolean;
  showMetrics?: boolean;
  memoryTutorialVersion?: number;
  aiConfig: WorkbenchAiConfig;
}

export interface WorkbenchAiConfig {
  baseUrl: string;
  model: string;
  balanceUrl?: string;
}

export interface WorkbenchState {
  version: 3;
  captures: CaptureItem[];
  projectNotes: ProjectNote[];
  outcomes: ProjectOutcome[];
  reviews: ProjectReview[];
  recurrenceRules: RecurrenceRule[];
  focusSession: FocusSession | null;
  trash: TrashEntry[];
  undoOperations: OperationUndo[];
  tasks: WorkbenchTask[];
  projects: WorkbenchProject[];
  countdowns: WorkbenchCountdown[];
  focusRecords: FocusRecord[];
  goals: GoalProfile[];
  memories: MemoryEntry[];
  memoryUsageEvents: MemoryUsageEvent[];
  aiUsageRecords: WorkbenchAiUsageRecord[];
  aiMessages: AiMessage[];
  aiChatHistory: WorkbenchChatTurn[];
  agentRuns: AgentRun[];
  scheduleExceptions: ScheduleException[];
  planProposals: PlanProposal[];
  dailyCheckIns: DailyCheckIn[];
  /** User-deleted auto memories are kept as suppression keys so repair never resurrects them. */
  suppressedMemoryKeys: string[];
  preferences: WorkbenchPreferences;
}

export function localDateKey(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function createWorkbenchId(prefix: string): string {
  const value = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`;
}

export function createInitialWorkbenchState(): WorkbenchState {
  return {
    version: 3,
    captures: [], projectNotes: [], outcomes: [], reviews: [], recurrenceRules: [],
    focusSession: null, trash: [], undoOperations: [],
    tasks: [],
    projects: [],
    countdowns: [],
    focusRecords: [],
    goals: [],
    memories: [],
    memoryUsageEvents: [],
    aiUsageRecords: [],
    aiMessages: [],
    aiChatHistory: [],
    agentRuns: [],
    scheduleExceptions: [],
    planProposals: [],
    dailyCheckIns: [],
    suppressedMemoryKeys: [],
    preferences: {
      nickname: "",
      defaultFocusMinutes: 25,
      defaultDailyCapacityMinutes: 240,
      bufferPercent: 20,
      proactiveMessages: true,
      showMetrics: true,
      memoryTutorialVersion: 0,
      aiConfig: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5",
        balanceUrl: "",
      },
    },
  };
}

export function daysUntil(dateKey: string, today = localDateKey()): number {
  const target = new Date(`${dateKey}T00:00:00`).getTime();
  const start = new Date(`${today}T00:00:00`).getTime();
  return Math.ceil((target - start) / 86_400_000);
}

export function taskPriorityLabel(priority: TaskPriority): string {
  return priority === "high" ? "重要" : priority === "medium" ? "常规" : "稍后";
}
