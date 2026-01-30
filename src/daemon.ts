#!/usr/bin/env node
// AWM Daemon - Checks for overdue tasks and wakes agents
// Flow: silent wake first → escalate to Slack only if agent doesn't respond

import { AWM } from './manager.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

interface DaemonConfig {
  dataPath: string;
  wakeStatePath: string;
  gatewayUrl: string;
  gatewayToken: string;
  dryRun: boolean;
  verbose: boolean;
}

interface PendingWake {
  wakeTime: number;
  taskIds: string[];
  lastTaskUpdate: number; // Snapshot of most recent task update at wake time
}

interface WakeState {
  lastWake: Record<string, number>;        // agentId -> last wake timestamp
  pendingWakes: Record<string, PendingWake>; // agentId -> pending silent wake
}

// Agent -> Slack channel mapping (for escalation)
const AGENT_CHANNELS: Record<string, string> = {
  frank: 'D0ABF8X5TM2',
  nova: 'C0AB5S2J15H',
  tex: 'C0ABFRHFWUU',
  linc: 'C0ABFRHMGPN',
  ivy: 'C0ABA6GN72A',
  penny: 'C0AC6HCQ796',
  stone: 'C0AB8QVHETX',
  pixel: 'C0AAWMTAXQX',
  trey: 'C0AB8QVSEVB',
};

// AWM agent name -> Clawdbot agent ID (for session keys)
const CLAWDBOT_AGENT_IDS: Record<string, string> = {
  frank: 'main',
  nova: 'ai-updates',
  tex: 'technonymous',
  linc: 'personal-brand',
  ivy: 'itsalive',
  penny: 'email-mgmt',
  stone: 'three-stones',
  pixel: 'avatar-design',
  trey: 'trading',
};

const MIN_WAKE_INTERVAL_MS = 300000;  // 5 minutes between wakes
const ESCALATION_GRACE_MS = 180000;   // 3 minutes before escalating to Slack

function loadWakeState(path: string): WakeState {
  if (!existsSync(path)) {
    return { lastWake: {}, pendingWakes: {} };
  }
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    return { lastWake: state.lastWake || {}, pendingWakes: state.pendingWakes || {} };
  } catch {
    return { lastWake: {}, pendingWakes: {} };
  }
}

function saveWakeState(path: string, state: WakeState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// Silent wake via Clawdbot Gateway API
async function silentWake(agentId: string, message: string, config: DaemonConfig): Promise<boolean> {
  const clawdbotAgentId = CLAWDBOT_AGENT_IDS[agentId];
  if (!clawdbotAgentId) {
    console.error(`No Clawdbot agent mapping for: ${agentId}`);
    return false;
  }

  if (config.dryRun) {
    console.log(`[DRY RUN] Would silently wake ${agentId} (agent: ${clawdbotAgentId})`);
    return true;
  }

  try {
    // Use sessions_send via Gateway /tools/invoke endpoint
    // The agent will receive this as a system message in their session
    const res = await fetch(`${config.gatewayUrl}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.gatewayToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tool: 'sessions_send',
        args: {
          agentId: clawdbotAgentId,
          message: `[AWM Silent Wake]\n${message}`,
          label: 'awm-wake',
          timeoutSeconds: 0  // fire-and-forget
        }
      })
    });

    if (res.ok) {
      console.log(`[${new Date().toISOString()}] Silent wake sent to ${agentId}`);
      return true;
    } else {
      const text = await res.text();
      console.error(`Silent wake failed for ${agentId}: ${res.status} ${text}`);
      return false;
    }
  } catch (err: any) {
    console.error(`Silent wake error for ${agentId}:`, err.message || err);
    return false;
  }
}

// Escalate to Slack (visible message)
async function escalateToSlack(agentId: string, message: string, config: DaemonConfig): Promise<boolean> {
  const channel = AGENT_CHANNELS[agentId];
  if (!channel) {
    console.error(`No Slack channel mapping for: ${agentId}`);
    return false;
  }

  if (config.dryRun) {
    console.log(`[DRY RUN] Would escalate ${agentId} to Slack`);
    return true;
  }

  try {
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      console.error('SLACK_BOT_TOKEN not set');
      return false;
    }

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel,
        text: message,
        mrkdwn: true
      })
    });

    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error(`Slack error for ${agentId}: ${data.error}`);
      return false;
    }
    
    console.log(`[${new Date().toISOString()}] Escalated ${agentId} to Slack`);
    return true;
  } catch (err: any) {
    console.error(`Slack error for ${agentId}:`, err.message || err);
    return false;
  }
}

async function runDaemon(config: DaemonConfig): Promise<void> {
  const awm = new AWM({ dataPath: config.dataPath });
  const { recurring, statusChecks } = awm.getOverdueTasks();
  const idleAgents = awm.getIdleAgents('30m');
  const wakeState = loadWakeState(config.wakeStatePath);
  const now = Date.now();

  // Collect tasks with full info
  interface TaskInfo { id: string; name: string; cadence?: string; instruction?: string; lastUpdate: number; }
  const agentTaskList = new Map<string, TaskInfo[]>();

  for (const task of recurring) {
    const list = agentTaskList.get(task.owner) || [];
    list.push({ id: task.id, name: task.name, cadence: task.cadence, instruction: task.instruction, lastUpdate: task.lastUpdate });
    agentTaskList.set(task.owner, list);
  }

  for (const task of statusChecks) {
    const list = agentTaskList.get(task.owner) || [];
    list.push({ id: task.id, name: task.name, instruction: task.instruction, lastUpdate: task.lastUpdate });
    agentTaskList.set(task.owner, list);
  }

  // Also add idle agents with no overdue tasks
  for (const { agent } of idleAgents) {
    if (!agentTaskList.has(agent.agentId) && agent.defaultMode) {
      agentTaskList.set(agent.agentId, []);
    }
  }

  if (agentTaskList.size === 0) {
    if (config.verbose) {
      console.log(`[${new Date().toISOString()}] No overdue tasks or idle agents.`);
    }
    return;
  }

  let stateChanged = false;

  for (const [agentId, tasks] of agentTaskList) {
    const lastWoke = wakeState.lastWake[agentId] || 0;
    const timeSinceWake = now - lastWoke;
    const pending = wakeState.pendingWakes[agentId];

    // Check cooldown
    if (timeSinceWake < MIN_WAKE_INTERVAL_MS) {
      if (config.verbose) {
        console.log(`[${new Date().toISOString()}] Skipping ${agentId} (woken ${Math.round(timeSinceWake/1000)}s ago)`);
      }
      continue;
    }

    // Build message
    const lines: string[] = [];
    let latestTaskUpdate = 0;
    
    if (tasks.length > 0) {
      lines.push('*[AWM] Overdue Tasks*', '');
      for (const t of tasks) {
        lines.push(`• *${t.name}* \`${t.id}\``);
        if (t.cadence) lines.push(`  Every ${t.cadence}, last: ${formatAgo(t.lastUpdate)}`);
        if (t.instruction) lines.push(`  → ${t.instruction}`);
        lines.push('');
        latestTaskUpdate = Math.max(latestTaskUpdate, t.lastUpdate);
      }
      lines.push('_When done:_ `/Users/sam/clawd/bin/awm update <id> -m "summary"`');
    } else {
      const idleInfo = idleAgents.find(i => i.agent.agentId === agentId);
      if (idleInfo?.agent.defaultMode) {
        lines.push('*[AWM] Idle Check-in*', '');
        lines.push(`You've been quiet. Your default mode:`);
        lines.push(`• *${idleInfo.agent.defaultMode.taskName}*`);
        lines.push(`  → ${idleInfo.agent.defaultMode.instruction}`);
        lines.push('');
        lines.push(`_Check in:_ \`/Users/sam/clawd/bin/awm checkin ${agentId} -m "what I'm doing"\``);
      }
    }

    if (lines.length === 0) continue;
    const message = lines.join('\n');

    // Check if we have a pending silent wake
    if (pending) {
      const timeSincePending = now - pending.wakeTime;
      
      // Check if agent responded (task was updated since pending wake)
      if (latestTaskUpdate > pending.lastTaskUpdate) {
        // Agent responded! Clear pending wake
        if (config.verbose) {
          console.log(`[${new Date().toISOString()}] ${agentId} responded to silent wake, clearing pending`);
        }
        delete wakeState.pendingWakes[agentId];
        stateChanged = true;
        continue;
      }

      // Grace period expired without response → escalate to Slack
      if (timeSincePending >= ESCALATION_GRACE_MS) {
        if (await escalateToSlack(agentId, message, config)) {
          wakeState.lastWake[agentId] = now;
          delete wakeState.pendingWakes[agentId];
          stateChanged = true;
        }
      } else if (config.verbose) {
        console.log(`[${new Date().toISOString()}] ${agentId} pending wake, ${Math.round((ESCALATION_GRACE_MS - timeSincePending)/1000)}s until escalation`);
      }
    } else {
      // No pending wake → try silent wake first
      if (await silentWake(agentId, message, config)) {
        wakeState.lastWake[agentId] = now;
        wakeState.pendingWakes[agentId] = {
          wakeTime: now,
          taskIds: tasks.map(t => t.id),
          lastTaskUpdate: latestTaskUpdate
        };
        stateChanged = true;
      } else {
        // Silent wake failed → fall back to Slack immediately
        if (await escalateToSlack(agentId, message, config)) {
          wakeState.lastWake[agentId] = now;
          stateChanged = true;
        }
      }
    }
  }

  // Clean up stale pending wakes (agent no longer has overdue tasks)
  for (const agentId of Object.keys(wakeState.pendingWakes)) {
    if (!agentTaskList.has(agentId)) {
      if (config.verbose) {
        console.log(`[${new Date().toISOString()}] Clearing stale pending wake for ${agentId}`);
      }
      delete wakeState.pendingWakes[agentId];
      stateChanged = true;
    }
  }

  if (stateChanged) {
    saveWakeState(config.wakeStatePath, wakeState);
  }
}

function formatAgo(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// CLI entry point
const args = process.argv.slice(2);
const config: DaemonConfig = {
  dataPath: process.env.AWM_DATA || './awm-data.json',
  wakeStatePath: process.env.AWM_WAKE_STATE || '/Users/sam/clawd/data/awm-wake-state.json',
  gatewayUrl: process.env.AWM_GATEWAY_URL || 'http://localhost:18789',
  gatewayToken: process.env.AWM_GATEWAY_TOKEN || process.env.CLAWDBOT_GATEWAY_TOKEN || '',
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose') || args.includes('-v')
};

if (!config.gatewayToken) {
  console.error('Warning: No gateway token set (AWM_GATEWAY_TOKEN or CLAWDBOT_GATEWAY_TOKEN)');
}

runDaemon(config);
