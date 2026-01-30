#!/usr/bin/env node
// AWM Server - HTTP API + Web UI

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AWM } from './manager.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ServerConfig {
  port: number;
  dataPath: string;
  cors: boolean;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  return {
    port: parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] || '3456'),
    dataPath: process.env.AWM_DATA || './awm-data.json',
    cors: args.includes('--cors')
  };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data, null, 2));
}

function html(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(content);
}

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWM - Agent Work Manager</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117; color: #c9d1d9; padding: 20px; 
      max-width: 1200px; margin: 0 auto;
    }
    h1 { color: #58a6ff; margin-bottom: 20px; }
    .refresh { 
      position: fixed; top: 20px; right: 20px; 
      background: #238636; color: white; border: none; 
      padding: 8px 16px; border-radius: 6px; cursor: pointer; 
    }
    .refresh:hover { background: #2ea043; }
    
    .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 16px; }
    
    .agent-card { 
      background: #161b22; border: 1px solid #30363d; border-radius: 8px; 
      padding: 16px; 
    }
    .agent-card.has-overdue { border-color: #f85149; }
    
    .agent-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .agent-name { font-size: 18px; font-weight: 600; color: #f0f6fc; }
    .agent-status { 
      font-size: 11px; padding: 2px 8px; border-radius: 12px;
      background: #238636; color: white;
    }
    .agent-status.idle { background: #30363d; color: #8b949e; }
    .agent-status.overdue { background: #f85149; }
    
    .current-project {
      background: #388bfd22; border: 1px solid #388bfd55; border-radius: 6px;
      padding: 12px; margin-bottom: 12px;
    }
    .current-project-label { font-size: 11px; color: #58a6ff; text-transform: uppercase; margin-bottom: 4px; }
    .current-project-name { font-weight: 600; color: #f0f6fc; }
    .current-project-instruction { font-size: 13px; color: #8b949e; margin-top: 4px; }
    .current-project-status { font-size: 12px; color: #7ee787; margin-top: 6px; }
    .current-project-status.overdue { color: #f85149; }
    
    .task-list { margin-top: 8px; }
    .task-item { 
      padding: 8px 0; border-bottom: 1px solid #21262d;
    }
    .task-item:last-child { border-bottom: none; }
    .task-header { display: flex; justify-content: space-between; align-items: center; }
    .task-name { font-size: 14px; color: #c9d1d9; cursor: pointer; }
    .task-name:hover { color: #58a6ff; }
    .task-cadence { font-size: 12px; color: #8b949e; }
    .task-instruction { 
      font-size: 12px; color: #8b949e; margin-top: 6px; 
      white-space: pre-wrap; padding-left: 8px; border-left: 2px solid #30363d;
    }
    .task-cadence.overdue { color: #f85149; font-weight: 600; }
    
    .default-mode {
      background: #30363d; border-radius: 4px; padding: 8px 12px;
      font-size: 13px; color: #8b949e; margin-top: 12px;
    }
    .default-mode strong { color: #c9d1d9; }
    
    .no-tasks { color: #8b949e; font-style: italic; font-size: 13px; }
  </style>
</head>
<body>
  <button class="refresh" onclick="load()">↻ Refresh</button>
  <h1>🎯 Agent Work Manager</h1>
  <div id="agents" class="agent-grid"></div>

  <script>
    function parseCadence(cadence) {
      if (!cadence) return Infinity;
      const match = cadence.match(/^(\\d+)(s|m|h|d)$/);
      if (!match) return cadence === 'daily' ? 86400000 : Infinity;
      const [, num, unit] = match;
      const n = parseInt(num);
      switch(unit) {
        case 's': return n * 1000;
        case 'm': return n * 60000;
        case 'h': return n * 3600000;
        case 'd': return n * 86400000;
        default: return Infinity;
      }
    }
    
    function formatCadence(cadence) {
      if (!cadence) return '';
      return 'every ' + cadence.replace(/^(\\d+)s$/, '$1 sec')
        .replace(/^(\\d+)m$/, '$1 min')
        .replace(/^(\\d+)h$/, '$1 hr')
        .replace(/^(\\d+)d$/, '$1 day');
    }
    
    function formatAgo(ts) {
      const ms = Date.now() - ts;
      const mins = Math.floor(ms / 60000);
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }
    
    function isOverdue(task) {
      if (!task.cadence && !task.statusInterval) return false;
      const interval = parseCadence(task.cadence || task.statusInterval);
      return Date.now() - task.lastUpdate > interval * 2;
    }

    async function load() {
      const [tasks, agents] = await Promise.all([
        fetch('/api/tasks').then(r => r.json()),
        fetch('/api/agents').then(r => r.json())
      ]);
      
      // Get all unique agent IDs from tasks + configured agents
      const agentIds = new Set([
        ...tasks.map(t => t.owner),
        ...agents.map(a => a.agentId)
      ]);
      
      const agentCards = [...agentIds].sort().map(agentId => {
        const agent = agents.find(a => a.agentId === agentId) || { agentId, recurringTaskIds: [] };
        const agentTasks = tasks.filter(t => t.owner === agentId && t.status === 'active');
        
        // Separate project from recurring
        const activeProject = agentTasks.find(t => t.type === 'project');
        const recurringTasks = agentTasks
          .filter(t => t.type === 'recurring')
          .sort((a, b) => parseCadence(a.cadence) - parseCadence(b.cadence));
        
        const hasOverdue = agentTasks.some(t => isOverdue(t));
        const isIdle = !activeProject && !recurringTasks.length;
        
        // Status badge
        let statusClass = 'idle';
        let statusText = 'Idle';
        if (hasOverdue) {
          statusClass = 'overdue';
          statusText = 'Overdue';
        } else if (activeProject || recurringTasks.length) {
          statusClass = '';
          statusText = 'Active';
        }
        
        return \`
          <div class="agent-card \${hasOverdue ? 'has-overdue' : ''}">
            <div class="agent-header">
              <span class="agent-name">\${agentId}</span>
              <span class="agent-status \${statusClass}">\${statusText}</span>
            </div>
            
            \${activeProject ? \`
              <div class="current-project">
                <div class="current-project-label">Current Project</div>
                <div class="current-project-name">\${activeProject.name}</div>
                \${activeProject.instruction ? \`<div class="current-project-instruction">→ \${activeProject.instruction}</div>\` : ''}
                <div class="current-project-status \${isOverdue(activeProject) ? 'overdue' : ''}">
                  Last update: \${formatAgo(activeProject.lastUpdate)}
                  \${activeProject.statusInterval ? ' · check-in: every ' + activeProject.statusInterval : ''}
                </div>
              </div>
            \` : ''}
            
            \${recurringTasks.length ? \`
              <div class="task-list">
                \${recurringTasks.map(t => \`
                  <div class="task-item">
                    <div class="task-header">
                      <span class="task-name">\${t.name}</span>
                      <span class="task-cadence \${isOverdue(t) ? 'overdue' : ''}">\${formatCadence(t.cadence)}</span>
                    </div>
                    <div class="task-instruction">\${t.instruction || 'No details'}</div>
                  </div>
                \`).join('')}
              </div>
            \` : ''}
            
            \${agent.defaultMode ? \`
              <div class="default-mode">
                <strong>Idle Mode:</strong> \${agent.defaultMode.taskName}<br>
                \${agent.defaultMode.instruction}
              </div>
            \` : ''}
            
            \${isIdle && !agent.defaultMode ? '<p class="no-tasks">No tasks configured</p>' : ''}
          </div>
        \`;
      }).join('');
      
      document.getElementById('agents').innerHTML = agentCards;
    }
    
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;

export function startServer(config: ServerConfig): void {
  const awm = new AWM({ dataPath: config.dataPath });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${config.port}`);
    const path = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    try {
      // API routes
      if (path === '/api/tasks') {
        return json(res, awm.getAllTasks());
      }
      
      if (path === '/api/agents') {
        return json(res, awm.getAllAgents());
      }
      
      if (path.startsWith('/api/context/')) {
        const agentId = path.split('/')[3];
        return json(res, awm.getAgentContext(agentId));
      }
      
      if (path === '/api/overdue') {
        return json(res, awm.getOverdueTasks());
      }
      
      if (path.startsWith('/api/task/')) {
        const taskId = path.split('/')[3];
        const task = awm.getTask(taskId);
        if (task) return json(res, task);
        return json(res, { error: 'Task not found' }, 404);
      }
      
      if (path.startsWith('/api/agent/')) {
        const agentId = path.split('/')[3];
        const agent = awm.getAgent(agentId);
        if (agent) return json(res, agent);
        return json(res, { error: 'Agent not found' }, 404);
      }

      if (path === '/api/history') {
        const taskId = url.searchParams.get('task') || undefined;
        const limit = parseInt(url.searchParams.get('limit') || '50');
        return json(res, awm.getHistory(taskId, limit));
      }

      // POST: Update task status
      if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/update$/)) {
        const taskId = path.split('/')[3];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { message } = JSON.parse(body || '{}');
            const task = awm.updateTaskStatus(taskId, message || 'Updated');
            if (task) {
              return json(res, { ok: true, task });
            }
            return json(res, { error: 'Task not found' }, 404);
          } catch (e) {
            return json(res, { error: 'Invalid JSON' }, 400);
          }
        });
        return;
      }

      // POST: Complete task
      if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/complete$/)) {
        const taskId = path.split('/')[3];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { message } = JSON.parse(body || '{}');
            const task = awm.completeTask(taskId, message || 'Completed');
            if (task) {
              return json(res, { ok: true, task });
            }
            return json(res, { error: 'Task not found' }, 404);
          } catch (e) {
            return json(res, { error: 'Invalid JSON' }, 400);
          }
        });
        return;
      }

      // Web UI
      if (path === '/' || path === '/index.html') {
        return html(res, UI_HTML);
      }

      // 404
      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      console.error('Server error:', err);
      json(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(config.port, () => {
    console.log(`AWM server running at http://localhost:${config.port}`);
    console.log(`API endpoints:`);
    console.log(`  GET /api/tasks       - All tasks`);
    console.log(`  GET /api/agents      - All agents`);
    console.log(`  GET /api/context/:id - Agent context`);
    console.log(`  GET /api/overdue     - Overdue tasks`);
    console.log(`  GET /api/history     - Status history`);
    console.log(`  GET /                - Web UI`);
  });
}

// CLI entry
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const config = parseArgs();
  startServer(config);
}
