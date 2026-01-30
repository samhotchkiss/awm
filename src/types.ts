// Agent Work Manager - Core Types

export type TaskType = 'project' | 'recurring' | 'default';
export type TaskStatus = 'active' | 'paused' | 'completed' | 'abandoned';

export interface Task {
  id: string;
  name: string;
  type: TaskType;
  owner: string;                    // agent ID
  helpers?: string[];               // other agents who assist
  instruction?: string;             // what to do
  status: TaskStatus;
  cadence?: string;                 // for recurring: "5s", "5m", "1h", "daily"
  statusInterval?: string;          // how often to check in: "15m"
  lastUpdate: number;               // timestamp ms
  lastOutcome?: string;             // result of last execution
  createdAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentConfig {
  agentId: string;
  defaultMode?: {
    taskName: string;
    instruction: string;
  };
  activeTaskId?: string;            // current project/one-off task
  recurringTaskIds: string[];       // tasks this agent runs on schedule
  lastCheckIn?: number;             // timestamp of last activity
  idleThreshold?: string;           // how long before idle reminder: "30m"
}

export interface StatusUpdate {
  taskId: string;
  agentId: string;
  timestamp: number;
  message: string;
  outcome?: 'success' | 'failure' | 'in-progress';
}

export interface AWMState {
  tasks: Record<string, Task>;
  agents: Record<string, AgentConfig>;
  history: StatusUpdate[];          // recent updates (trimmed periodically)
}

export interface AgentContext {
  agentId: string;
  activeTask?: Task;
  defaultMode?: AgentConfig['defaultMode'];
  overdueRecurring: Task[];
  pendingStatusCheck: Task[];       // projects that need a status update
  message: string;                  // what to inject into agent context
}

export interface AWMConfig {
  dataPath: string;                 // where to store state
  defaultStatusInterval: string;    // default for projects: "15m"
  overdueThreshold: number;         // multiplier for "overdue" (e.g., 2x interval)
}
