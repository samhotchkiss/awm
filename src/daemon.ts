#!/usr/bin/env node
// AWM Daemon - Checks for overdue tasks and wakes agents via Slack

import { AWM } from './manager.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

interface DaemonConfig {
  dataPath: string;
  wakeStatePath: string;
  clawdbotPath: string;
  dryRun: boolean;
  verbose: boolean;
}

interface WakeState {
  lastWake: Record<string, number>; // agentId -> timestamp
}

// Agent -> Slack channel mapping
const AGENT_CHANNELS: Record<string, string> = {
  frank: 'D0ABF8X5TM2',      // Frank's DM with Sam
  nova: 'C0AB5S2J15H',       // #project-ai-updates
  tex: 'C0ABFRHFWUU',        // #project-technonymous
  linc: 'C0ABFRHMGPN',       // #project-personal-brand
  ivy: 'C0ABA6GN72A',        // #project-itsalive
  penny: 'C0AC6HCQ796',      // #project-email-mgmt
  stone: 'C0AB8QVHETX',      // #project-three-stones
  pixel: 'C0AAWMTAXQX',      // #avatar-design
  trey: 'C0AB8QVSEVB',       // #project-trading
};

// AWM agent name -> Clawdbot agent ID
const CLAWDBOT_AGENT_IDS: Record<string, string> = {
  frank: 'email-mgmt',
  nova: 'ai-updates',
  // Others TBD when configured in Clawdbot
};

const MIN_WAKE_INTERVAL_MS = 300000; // Don't wake same agent more than once per 5 minutes

function loadWakeState(path: string): WakeState {
  if (!existsSync(path)) {
    return { lastWake: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { lastWake: {} };
  }
}

function saveWakeState(path: string, state: WakeState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

async function wakeAgent(agentId: string, message: string, config: DaemonConfig): Promise<boolean> {
  const channel = AGENT_CHANNELS[agentId];

  if (config.dryRun) {
    console.log(`[DRY RUN] Would wake ${agentId}:\n${message.substring(0, 200)}...`);
    return true;
  }

  // Post to Slack channel
  if (!channel) {
    console.error(`No channel mapping for agent: ${agentId}`);
    return false;
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
    
    console.log(`[${new Date().toISOString()}] Woke ${agentId} via Slack (fallback)`);
    return true;
  } catch (err: any) {
    console.error(`Error waking ${agentId}:`, err.message || err);
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
      // No overdue tasks but agent is idle - add as idle wake
      agentTaskList.set(agent.agentId, []);
    }
  }

  if (agentTaskList.size === 0) {
    if (config.verbose) {
      console.log(`[${new Date().toISOString()}] No overdue tasks or idle agents.`);
    }
    return;
  }

  // Wake each agent (with cooldown check)
  let anyWoken = false;
  for (const [agentId, tasks] of agentTaskList) {
    const lastWoke = wakeState.lastWake[agentId] || 0;
    const timeSinceWake = now - lastWoke;

    if (timeSinceWake < MIN_WAKE_INTERVAL_MS) {
      if (config.verbose) {
        console.log(`[${new Date().toISOString()}] Skipping ${agentId} (woken ${Math.round(timeSinceWake/1000)}s ago)`);
      }
      continue;
    }

    // Build message
    const lines: string[] = [];
    
    if (tasks.length > 0) {
      // Has overdue tasks
      lines.push('*[AWM] Overdue Tasks*', '');
      for (const t of tasks) {
        lines.push(`• *${t.name}* \`${t.id}\``);
        if (t.cadence) lines.push(`  Every ${t.cadence}, last: ${formatAgo(t.lastUpdate)}`);
        if (t.instruction) lines.push(`  → ${t.instruction}`);
        lines.push('');
      }
      lines.push('_When done:_ `/Users/sam/clawd/bin/awm update <id> -m "summary"`');
    } else {
      // Idle agent with default mode
      const idleInfo = idleAgents.find(i => i.agent.agentId === agentId);
      if (idleInfo?.agent.defaultMode) {
        lines.push('*[AWM] Idle Check-in*', '');
        lines.push(`You've been quiet. Your default mode:`);
        lines.push(`• *${idleInfo.agent.defaultMode.taskName}*`);
        lines.push(`  → ${idleInfo.agent.defaultMode.instruction}`);
        lines.push('');
        lines.push('_Check in:_ `/Users/sam/clawd/bin/awm checkin ' + agentId + ' -m "what I\'m doing"`');
      }
    }

    if (lines.length === 0) continue;

    const message = lines.join('\n');
    if (await wakeAgent(agentId, message, config)) {
      wakeState.lastWake[agentId] = now;
      anyWoken = true;
    }
  }

  if (anyWoken) {
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
  clawdbotPath: process.env.AWM_CLAWDBOT_PATH || '/Users/sam/.npm-global/bin/clawdbot',
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose') || args.includes('-v')
};

runDaemon(config);
