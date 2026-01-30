// Agent Work Manager - Core Logic

import { randomUUID } from 'crypto';
import { Storage } from './storage.js';
import type { 
  Task, AgentConfig, StatusUpdate, AgentContext, 
  TaskType, TaskStatus, AWMConfig 
} from './types.js';

// Parse duration strings like "5s", "5m", "1h", "daily" to ms
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    if (duration === 'daily') return 24 * 60 * 60 * 1000;
    throw new Error(`Invalid duration: ${duration}`);
  }
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    default: throw new Error(`Invalid unit: ${unit}`);
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export class AWM {
  private storage: Storage;
  private config: AWMConfig;

  constructor(config: Partial<AWMConfig> = {}) {
    this.config = {
      dataPath: config.dataPath || './awm-data.json',
      defaultStatusInterval: config.defaultStatusInterval || '15m',
      overdueThreshold: config.overdueThreshold || 2
    };
    this.storage = new Storage(this.config.dataPath);
  }

  // === TASK MANAGEMENT ===

  createTask(params: {
    name: string;
    type: TaskType;
    owner: string;
    instruction?: string;
    helpers?: string[];
    cadence?: string;
    statusInterval?: string;
    metadata?: Record<string, unknown>;
  }): Task {
    const now = Date.now();
    const task: Task = {
      id: `task_${randomUUID().slice(0, 8)}`,
      name: params.name,
      type: params.type,
      owner: params.owner,
      instruction: params.instruction,
      helpers: params.helpers,
      cadence: params.cadence,
      statusInterval: params.statusInterval || (params.type === 'project' ? this.config.defaultStatusInterval : undefined),
      status: 'active',
      lastUpdate: now,
      createdAt: now,
      metadata: params.metadata
    };

    this.storage.saveTask(task);

    // Update agent's active task if it's a project
    if (task.type === 'project') {
      this.setActiveTask(params.owner, task.id);
    } else if (task.type === 'recurring') {
      this.addRecurringTask(params.owner, task.id);
    }

    return task;
  }

  updateTaskStatus(taskId: string, message: string, outcome?: StatusUpdate['outcome']): Task | undefined {
    const task = this.storage.getTask(taskId);
    if (!task) return undefined;

    const now = Date.now();
    task.lastUpdate = now;
    task.lastOutcome = message;
    this.storage.saveTask(task);

    // Also update agent's lastCheckIn
    this.checkIn(task.owner);

    this.storage.addHistoryEntry({
      taskId,
      agentId: task.owner,
      timestamp: now,
      message,
      outcome
    });

    return task;
  }

  completeTask(taskId: string, finalMessage?: string): Task | undefined {
    const task = this.storage.getTask(taskId);
    if (!task) return undefined;

    task.status = 'completed';
    task.completedAt = Date.now();
    task.lastUpdate = Date.now();
    if (finalMessage) task.lastOutcome = finalMessage;
    this.storage.saveTask(task);

    // Clear from agent's active task
    const agent = this.storage.getAgent(task.owner);
    if (agent && agent.activeTaskId === taskId) {
      agent.activeTaskId = undefined;
      this.storage.saveAgent(agent);
    }

    this.storage.addHistoryEntry({
      taskId,
      agentId: task.owner,
      timestamp: Date.now(),
      message: finalMessage || 'Task completed',
      outcome: 'success'
    });

    return task;
  }

  pauseTask(taskId: string): Task | undefined {
    const task = this.storage.getTask(taskId);
    if (!task) return undefined;
    task.status = 'paused';
    task.lastUpdate = Date.now();
    this.storage.saveTask(task);
    return task;
  }

  resumeTask(taskId: string): Task | undefined {
    const task = this.storage.getTask(taskId);
    if (!task) return undefined;
    task.status = 'active';
    task.lastUpdate = Date.now();
    this.storage.saveTask(task);
    return task;
  }

  abandonTask(taskId: string, reason?: string): Task | undefined {
    const task = this.storage.getTask(taskId);
    if (!task) return undefined;
    task.status = 'abandoned';
    task.lastUpdate = Date.now();
    task.lastOutcome = reason || 'Abandoned';
    this.storage.saveTask(task);

    // Clear from agent
    const agent = this.storage.getAgent(task.owner);
    if (agent && agent.activeTaskId === taskId) {
      agent.activeTaskId = undefined;
      this.storage.saveAgent(agent);
    }

    return task;
  }

  // === AGENT MANAGEMENT ===

  configureAgent(params: {
    agentId: string;
    defaultMode?: { taskName: string; instruction: string };
  }): AgentConfig {
    const existing = this.storage.getAgent(params.agentId);
    const agent: AgentConfig = {
      agentId: params.agentId,
      defaultMode: params.defaultMode || existing?.defaultMode,
      activeTaskId: existing?.activeTaskId,
      recurringTaskIds: existing?.recurringTaskIds || []
    };
    this.storage.saveAgent(agent);
    return agent;
  }

  setActiveTask(agentId: string, taskId: string): void {
    let agent = this.storage.getAgent(agentId);
    if (!agent) {
      agent = { agentId, recurringTaskIds: [] };
    }
    agent.activeTaskId = taskId;
    this.storage.saveAgent(agent);
  }

  addRecurringTask(agentId: string, taskId: string): void {
    let agent = this.storage.getAgent(agentId);
    if (!agent) {
      agent = { agentId, recurringTaskIds: [] };
    }
    if (!agent.recurringTaskIds.includes(taskId)) {
      agent.recurringTaskIds.push(taskId);
    }
    this.storage.saveAgent(agent);
  }

  // === CONTEXT GENERATION ===

  getAgentContext(agentId: string): AgentContext {
    const agent = this.storage.getAgent(agentId);
    const now = Date.now();

    // Get active task
    let activeTask: Task | undefined;
    if (agent?.activeTaskId) {
      activeTask = this.storage.getTask(agent.activeTaskId);
      if (activeTask?.status !== 'active') activeTask = undefined;
    }

    // Get overdue recurring tasks
    const overdueRecurring: Task[] = [];
    if (agent?.recurringTaskIds) {
      for (const taskId of agent.recurringTaskIds) {
        const task = this.storage.getTask(taskId);
        if (task && task.status === 'active' && task.cadence) {
          const interval = parseDuration(task.cadence);
          if (now - task.lastUpdate > interval) {
            overdueRecurring.push(task);
          }
        }
      }
    }

    // Check if active task needs status update
    const pendingStatusCheck: Task[] = [];
    if (activeTask && activeTask.statusInterval) {
      const interval = parseDuration(activeTask.statusInterval);
      if (now - activeTask.lastUpdate > interval) {
        pendingStatusCheck.push(activeTask);
      }
    }

    // Generate context message
    const message = this.generateContextMessage(agentId, activeTask, agent?.defaultMode, overdueRecurring, pendingStatusCheck);

    return {
      agentId,
      activeTask,
      defaultMode: agent?.defaultMode,
      overdueRecurring,
      pendingStatusCheck,
      message
    };
  }

  private generateContextMessage(
    agentId: string,
    activeTask?: Task,
    defaultMode?: AgentConfig['defaultMode'],
    overdueRecurring: Task[] = [],
    pendingStatusCheck: Task[] = []
  ): string {
    const lines: string[] = ['[AWM]'];

    // Overdue recurring tasks (highest priority)
    if (overdueRecurring.length > 0) {
      lines.push('⚠️ OVERDUE RECURRING TASKS:');
      for (const task of overdueRecurring) {
        const ago = formatDuration(Date.now() - task.lastUpdate);
        lines.push(`  • ${task.name} (last run: ${ago} ago, cadence: ${task.cadence})`);
        if (task.instruction) lines.push(`    → ${task.instruction}`);
      }
      lines.push('');
    }

    // Status check needed
    if (pendingStatusCheck.length > 0) {
      lines.push('📋 STATUS UPDATE REQUIRED:');
      for (const task of pendingStatusCheck) {
        const ago = formatDuration(Date.now() - task.lastUpdate);
        lines.push(`  • ${task.name} (last update: ${ago} ago)`);
      }
      lines.push('');
    }

    // Active task
    if (activeTask) {
      const ago = formatDuration(Date.now() - activeTask.lastUpdate);
      lines.push(`🎯 ACTIVE TASK: ${activeTask.name}`);
      lines.push(`   Last update: ${ago} ago`);
      if (activeTask.instruction) lines.push(`   → ${activeTask.instruction}`);
      if (activeTask.lastOutcome) lines.push(`   Last status: ${activeTask.lastOutcome}`);
    } else if (defaultMode) {
      lines.push(`🏠 DEFAULT MODE: ${defaultMode.taskName}`);
      lines.push(`   → ${defaultMode.instruction}`);
    } else {
      lines.push('💤 No active task or default mode configured.');
    }

    return lines.join('\n');
  }

  // === MONITORING ===

  getOverdueTasks(): { recurring: Task[]; statusChecks: Task[] } {
    const now = Date.now();
    const recurring: Task[] = [];
    const statusChecks: Task[] = [];

    for (const task of this.storage.getActiveTasks()) {
      if (task.type === 'recurring' && task.cadence) {
        const interval = parseDuration(task.cadence);
        if (now - task.lastUpdate > interval * this.config.overdueThreshold) {
          recurring.push(task);
        }
      }
      
      if (task.type === 'project' && task.statusInterval) {
        const interval = parseDuration(task.statusInterval);
        if (now - task.lastUpdate > interval * this.config.overdueThreshold) {
          statusChecks.push(task);
        }
      }
    }

    return { recurring, statusChecks };
  }

  // === DATA ACCESS ===

  getTask(id: string): Task | undefined {
    return this.storage.getTask(id);
  }

  getAllTasks(): Task[] {
    return this.storage.getAllTasks();
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.storage.getAgent(id);
  }

  getAllAgents(): AgentConfig[] {
    return this.storage.getAllAgents();
  }

  getHistory(taskId?: string, limit?: number): StatusUpdate[] {
    return this.storage.getHistory(taskId, limit);
  }

  // === CHECK-IN TRACKING ===

  checkIn(agentId: string, message?: string): AgentConfig {
    let agent = this.storage.getAgent(agentId);
    if (!agent) {
      agent = { agentId, recurringTaskIds: [] };
    }
    agent.lastCheckIn = Date.now();
    this.storage.saveAgent(agent);

    if (message) {
      this.storage.addHistoryEntry({
        taskId: 'checkin',
        agentId,
        timestamp: Date.now(),
        message,
        outcome: 'success'
      });
    }

    return agent;
  }

  setIdleThreshold(agentId: string, threshold: string): AgentConfig {
    let agent = this.storage.getAgent(agentId);
    if (!agent) {
      agent = { agentId, recurringTaskIds: [] };
    }
    agent.idleThreshold = threshold;
    this.storage.saveAgent(agent);
    return agent;
  }

  getIdleAgents(defaultThreshold: string = '30m'): Array<{ agent: AgentConfig; idleSince: number }> {
    const now = Date.now();
    const idle: Array<{ agent: AgentConfig; idleSince: number }> = [];

    for (const agent of this.storage.getAllAgents()) {
      // Skip agents without default mode (nothing to remind them of)
      if (!agent.defaultMode) continue;

      const threshold = agent.idleThreshold || defaultThreshold;
      const thresholdMs = this.parseDurationSafe(threshold);
      if (!thresholdMs) continue;

      const lastActivity = agent.lastCheckIn || 0;
      if (now - lastActivity > thresholdMs) {
        idle.push({ agent, idleSince: lastActivity });
      }
    }

    return idle;
  }

  private parseDurationSafe(duration: string): number | undefined {
    try {
      const match = duration.match(/^(\d+)(s|m|h|d)$/);
      if (!match) {
        if (duration === 'daily') return 24 * 60 * 60 * 1000;
        return undefined;
      }
      const [, num, unit] = match;
      const n = parseInt(num, 10);
      switch (unit) {
        case 's': return n * 1000;
        case 'm': return n * 60 * 1000;
        case 'h': return n * 60 * 60 * 1000;
        case 'd': return n * 24 * 60 * 60 * 1000;
        default: return undefined;
      }
    } catch {
      return undefined;
    }
  }

  // === PULL-BASED WORK ASSIGNMENT ===
  
  /**
   * Get work for an agent (pull model).
   * Returns prioritized tasks + idle work instructions.
   * Designed for agent heartbeats to pull their work queue.
   */
  getAgentWork(agentId: string, opts?: { log?: boolean }): {
    hasWork: boolean;
    tasks: Array<{ id: string; name: string; instruction: string; cadence?: string; overdueMins: number }>;
    idleTask?: { name: string; instruction: string };
    message: string;
  } {
    const agent = this.storage.getAgent(agentId);
    const now = Date.now();

    // Log pull if requested (temporary for debugging)
    if (opts?.log) {
      this.storage.addHistoryEntry({
        taskId: 'pull',
        agentId,
        timestamp: now,
        message: 'Agent pulled work queue'
      });
    }

    // Collect overdue recurring tasks, sorted by how overdue they are
    const overdueTasks: Array<{ task: Task; overdueMins: number }> = [];
    
    if (agent?.recurringTaskIds) {
      for (const taskId of agent.recurringTaskIds) {
        const task = this.storage.getTask(taskId);
        if (task && task.status === 'active' && task.cadence) {
          const interval = this.parseDurationSafe(task.cadence) || 0;
          const elapsed = now - task.lastUpdate;
          if (elapsed > interval) {
            overdueTasks.push({
              task,
              overdueMins: Math.floor(elapsed / 60000)
            });
          }
        }
      }
    }

    // Sort by most overdue first
    overdueTasks.sort((a, b) => b.overdueMins - a.overdueMins);

    // Format tasks for output
    const tasks = overdueTasks.map(({ task, overdueMins }) => ({
      id: task.id,
      name: task.name,
      instruction: task.instruction || task.name,
      cadence: task.cadence,
      overdueMins
    }));

    // Get idle task
    const idleTask = agent?.defaultMode ? {
      name: agent.defaultMode.taskName,
      instruction: agent.defaultMode.instruction
    } : undefined;

    // Generate human-readable message
    const lines: string[] = [];
    
    if (tasks.length > 0) {
      lines.push(`🚨 DO THIS NOW (${tasks.length} task${tasks.length > 1 ? 's' : ''}):`);
      lines.push('');
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        lines.push(`${i + 1}. **${t.name}** (${t.overdueMins}m overdue)`);
        lines.push(`   → ${t.instruction}`);
        lines.push(`   Log completion: \`awm update ${t.id} -m "what you did"\``);
        lines.push('');
      }
      lines.push('⚠️ DO NOT ASK PERMISSION. DO THE WORK. POST UPDATES TO SLACK.');
      lines.push('');
    }

    if (idleTask) {
      if (tasks.length > 0) {
        lines.push('');
        lines.push('────────────────────────────────────────────────────────────');
        lines.push('');
      }
      lines.push('🏠 IDLE MODE: ' + idleTask.name);
      lines.push('');
      lines.push(idleTask.instruction);
      lines.push('');
      lines.push('When you complete idle work, check in:');
      lines.push(`  ${agentId === 'frank' ? '/Users/sam/clawd/bin/awm' : 'awm'} checkin ${agentId} -m "what you did"`);
      lines.push('');
      lines.push('────────────────────────────────────────────────────────────');
    }

    if (tasks.length === 0 && !idleTask) {
      lines.push('✅ Nothing to do right now.');
    }

    // Record check-in
    this.checkIn(agentId);

    return {
      hasWork: tasks.length > 0 || !!idleTask,
      tasks,
      idleTask,
      message: lines.join('\n')
    };
  }
}
