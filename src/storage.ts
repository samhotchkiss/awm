// Agent Work Manager - File-based Storage

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { AWMState, Task, AgentConfig, StatusUpdate } from './types.js';

const DEFAULT_STATE: AWMState = {
  tasks: {},
  agents: {},
  history: []
};

export class Storage {
  private dataPath: string;
  private state: AWMState;

  constructor(dataPath: string) {
    this.dataPath = dataPath;
    this.state = this.load();
  }

  private load(): AWMState {
    if (!existsSync(this.dataPath)) {
      // Ensure directory exists
      const dir = dirname(this.dataPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.save(DEFAULT_STATE);
      return { ...DEFAULT_STATE };
    }
    
    try {
      const data = readFileSync(this.dataPath, 'utf-8');
      return JSON.parse(data) as AWMState;
    } catch (e) {
      console.error('Failed to load AWM state, using defaults:', e);
      return { ...DEFAULT_STATE };
    }
  }

  private save(state?: AWMState): void {
    const toSave = state || this.state;
    const dir = dirname(this.dataPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.dataPath, JSON.stringify(toSave, null, 2));
  }

  // Tasks
  getTask(id: string): Task | undefined {
    this.reload(); // Always read fresh
    return this.state.tasks[id];
  }

  getAllTasks(): Task[] {
    this.reload(); // Always read fresh
    return Object.values(this.state.tasks);
  }

  getTasksByOwner(agentId: string): Task[] {
    return this.getAllTasks().filter(t => t.owner === agentId);
  }

  getTasksByType(type: Task['type']): Task[] {
    return this.getAllTasks().filter(t => t.type === type);
  }

  getActiveTasks(): Task[] {
    this.reload(); // Always read fresh
    return this.getAllTasks().filter(t => t.status === 'active');
  }

  saveTask(task: Task): void {
    this.state.tasks[task.id] = task;
    this.save();
  }

  deleteTask(id: string): void {
    delete this.state.tasks[id];
    this.save();
  }

  // Agents
  getAgent(id: string): AgentConfig | undefined {
    return this.state.agents[id];
  }

  getAllAgents(): AgentConfig[] {
    this.reload(); // Always read fresh
    return Object.values(this.state.agents);
  }

  saveAgent(agent: AgentConfig): void {
    this.state.agents[agent.agentId] = agent;
    this.save();
  }

  // History
  addHistoryEntry(entry: StatusUpdate): void {
    this.state.history.push(entry);
    // Keep last 1000 entries
    if (this.state.history.length > 1000) {
      this.state.history = this.state.history.slice(-1000);
    }
    this.save();
  }

  getHistory(taskId?: string, limit = 50): StatusUpdate[] {
    let history = this.state.history;
    if (taskId) {
      history = history.filter(h => h.taskId === taskId);
    }
    return history.slice(-limit);
  }

  // Utility
  getState(): AWMState {
    return this.state;
  }

  reload(): void {
    this.state = this.load();
  }
}
