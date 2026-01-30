#!/usr/bin/env node
// Agent Work Manager - CLI

import { Command } from 'commander';
import { AWM } from './manager.js';
import { startServer } from './server.js';

const program = new Command();
const awm = new AWM({ dataPath: process.env.AWM_DATA || './awm-data.json' });

program
  .name('awm')
  .description('Agent Work Manager - Task persistence for AI agents')
  .version('0.1.0');

// === TASK COMMANDS ===

program
  .command('create')
  .description('Create a new task')
  .requiredOption('-n, --name <name>', 'Task name')
  .requiredOption('-t, --type <type>', 'Task type: project, recurring, default')
  .requiredOption('-o, --owner <agent>', 'Owner agent ID')
  .option('-i, --instruction <text>', 'Task instruction')
  .option('-c, --cadence <duration>', 'Cadence for recurring tasks (e.g., 5m, 1h)')
  .option('-s, --status-interval <duration>', 'Status check interval (e.g., 15m)')
  .option('--helpers <agents...>', 'Helper agent IDs')
  .action((opts) => {
    const task = awm.createTask({
      name: opts.name,
      type: opts.type,
      owner: opts.owner,
      instruction: opts.instruction,
      cadence: opts.cadence,
      statusInterval: opts.statusInterval,
      helpers: opts.helpers
    });
    console.log('Created task:', JSON.stringify(task, null, 2));
  });

program
  .command('update <taskId>')
  .description('Update task status')
  .requiredOption('-m, --message <text>', 'Status message')
  .option('--outcome <outcome>', 'Outcome: success, failure, in-progress')
  .option('--quiet', 'Minimal output')
  .action((taskId, opts) => {
    const task = awm.updateTaskStatus(taskId, opts.message, opts.outcome);
    if (task) {
      if (opts.quiet) {
        console.log(`✓ Updated: ${task.name}`);
      } else {
        console.log(`✓ Updated: ${task.name}`);
        console.log(`  Last outcome: ${task.lastOutcome}`);
      }
      
      // Remind about default mode if agent has one
      const agent = awm.getAgent(task.owner);
      if (agent?.defaultMode) {
        console.log('');
        console.log('─'.repeat(60));
        console.log('');
        console.log(`🏠 IDLE MODE: ${agent.defaultMode.taskName}`);
        console.log('');
        console.log(agent.defaultMode.instruction);
        console.log('');
        console.log('When you complete idle work, check in:');
        console.log(`  /Users/sam/clawd/bin/awm checkin ${task.owner} -m "what I did"`);
        console.log('');
        console.log('─'.repeat(60));
      }
    } else {
      console.error('Task not found:', taskId);
      process.exit(1);
    }
  });

program
  .command('complete <taskId>')
  .description('Mark task as completed')
  .option('-m, --message <text>', 'Final message')
  .action((taskId, opts) => {
    const task = awm.completeTask(taskId, opts.message);
    if (task) {
      console.log('Completed task:', JSON.stringify(task, null, 2));
    } else {
      console.error('Task not found:', taskId);
      process.exit(1);
    }
  });

program
  .command('pause <taskId>')
  .description('Pause a task')
  .action((taskId) => {
    const task = awm.pauseTask(taskId);
    if (task) {
      console.log('Paused task:', task.name);
    } else {
      console.error('Task not found:', taskId);
      process.exit(1);
    }
  });

program
  .command('resume <taskId>')
  .description('Resume a paused task')
  .action((taskId) => {
    const task = awm.resumeTask(taskId);
    if (task) {
      console.log('Resumed task:', task.name);
    } else {
      console.error('Task not found:', taskId);
      process.exit(1);
    }
  });

program
  .command('abandon <taskId>')
  .description('Abandon a task')
  .option('-r, --reason <text>', 'Reason for abandoning')
  .action((taskId, opts) => {
    const task = awm.abandonTask(taskId, opts.reason);
    if (task) {
      console.log('Abandoned task:', task.name);
    } else {
      console.error('Task not found:', taskId);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all tasks')
  .option('-t, --type <type>', 'Filter by type')
  .option('-s, --status <status>', 'Filter by status')
  .option('-o, --owner <agent>', 'Filter by owner')
  .action((opts) => {
    let tasks = awm.getAllTasks();
    
    if (opts.type) tasks = tasks.filter(t => t.type === opts.type);
    if (opts.status) tasks = tasks.filter(t => t.status === opts.status);
    if (opts.owner) tasks = tasks.filter(t => t.owner === opts.owner);
    
    if (tasks.length === 0) {
      console.log('No tasks found.');
      return;
    }

    console.log('\nTasks:');
    console.log('─'.repeat(80));
    for (const task of tasks) {
      const age = Math.floor((Date.now() - task.lastUpdate) / 60000);
      console.log(`[${task.status.toUpperCase().padEnd(9)}] ${task.id}`);
      console.log(`  ${task.type.padEnd(10)} │ ${task.name}`);
      console.log(`  Owner: ${task.owner} │ Last update: ${age}m ago`);
      if (task.instruction) console.log(`  → ${task.instruction}`);
      console.log('');
    }
  });

// === AGENT COMMANDS ===

program
  .command('agent')
  .description('Configure an agent')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .option('--default-task <name>', 'Default mode task name')
  .option('--default-instruction <text>', 'Default mode instruction')
  .action((opts) => {
    const defaultMode = opts.defaultTask ? {
      taskName: opts.defaultTask,
      instruction: opts.defaultInstruction || opts.defaultTask
    } : undefined;

    const agent = awm.configureAgent({
      agentId: opts.agent,
      defaultMode
    });
    console.log('Configured agent:', JSON.stringify(agent, null, 2));
  });

program
  .command('agents')
  .description('List all agents')
  .action(() => {
    const agents = awm.getAllAgents();
    if (agents.length === 0) {
      console.log('No agents configured.');
      return;
    }
    console.log('\nAgents:');
    console.log('─'.repeat(60));
    for (const agent of agents) {
      console.log(`${agent.agentId}`);
      if (agent.activeTaskId) {
        const task = awm.getTask(agent.activeTaskId);
        console.log(`  Active: ${task?.name || agent.activeTaskId}`);
      }
      if (agent.defaultMode) {
        console.log(`  Default: ${agent.defaultMode.taskName}`);
      }
      if (agent.recurringTaskIds.length > 0) {
        console.log(`  Recurring: ${agent.recurringTaskIds.length} tasks`);
      }
      console.log('');
    }
  });

// === CHECK-IN COMMANDS ===

program
  .command('checkin <agentId>')
  .description('Record agent check-in (I\'m here, working on idle mode)')
  .option('-m, --message <text>', 'Optional status message')
  .action((agentId, opts) => {
    const agent = awm.checkIn(agentId, opts.message);
    console.log(`Checked in: ${agentId} at ${new Date().toISOString()}`);
    if (agent.defaultMode) {
      console.log(`Default mode: ${agent.defaultMode.taskName}`);
    }
  });

program
  .command('idle')
  .description('Show agents that are idle (no recent check-in)')
  .option('-t, --threshold <duration>', 'Idle threshold (default: 30m)', '30m')
  .action((opts) => {
    const idle = awm.getIdleAgents(opts.threshold);
    if (idle.length === 0) {
      console.log('No idle agents.');
      return;
    }
    console.log('\n💤 Idle Agents:');
    for (const { agent, idleSince } of idle) {
      const ago = idleSince ? Math.floor((Date.now() - idleSince) / 60000) : 'never';
      console.log(`  • ${agent.agentId} - last check-in: ${ago === 'never' ? 'never' : ago + 'm ago'}`);
      if (agent.defaultMode) {
        console.log(`    → ${agent.defaultMode.taskName}: ${agent.defaultMode.instruction}`);
      }
    }
  });

// === CONTEXT COMMAND ===

program
  .command('context <agentId>')
  .description('Get context for an agent (what to inject into their session)')
  .option('--json', 'Output as JSON')
  .action((agentId, opts) => {
    const context = awm.getAgentContext(agentId);
    if (opts.json) {
      console.log(JSON.stringify(context, null, 2));
    } else {
      console.log(context.message);
    }
  });

// === MONITORING ===

program
  .command('overdue')
  .description('Show overdue tasks')
  .action(() => {
    const { recurring, statusChecks } = awm.getOverdueTasks();
    
    if (recurring.length === 0 && statusChecks.length === 0) {
      console.log('No overdue tasks.');
      return;
    }

    if (recurring.length > 0) {
      console.log('\n⚠️  Overdue Recurring Tasks:');
      for (const task of recurring) {
        const ago = Math.floor((Date.now() - task.lastUpdate) / 60000);
        console.log(`  • ${task.name} (${task.owner}) - ${ago}m since last run`);
      }
    }

    if (statusChecks.length > 0) {
      console.log('\n⚠️  Projects Needing Status Update:');
      for (const task of statusChecks) {
        const ago = Math.floor((Date.now() - task.lastUpdate) / 60000);
        console.log(`  • ${task.name} (${task.owner}) - ${ago}m since last update`);
      }
    }
  });

program
  .command('history')
  .description('Show task history')
  .option('-t, --task <taskId>', 'Filter by task')
  .option('-l, --limit <n>', 'Number of entries', '20')
  .action((opts) => {
    const history = awm.getHistory(opts.task, parseInt(opts.limit));
    if (history.length === 0) {
      console.log('No history entries.');
      return;
    }
    console.log('\nHistory:');
    for (const entry of history) {
      const date = new Date(entry.timestamp).toLocaleString();
      const outcome = entry.outcome ? ` [${entry.outcome}]` : '';
      console.log(`[${date}] ${entry.agentId} → ${entry.taskId}${outcome}`);
      console.log(`  ${entry.message}`);
    }
  });

// === SERVER COMMAND ===

program
  .command('serve')
  .description('Start the AWM HTTP server with API + Web UI')
  .option('-p, --port <port>', 'Port to listen on', '3456')
  .option('--cors', 'Enable CORS headers')
  .action((opts) => {
    startServer({
      port: parseInt(opts.port),
      dataPath: process.env.AWM_DATA || './awm-data.json',
      cors: opts.cors || false
    });
  });

program.parse();
