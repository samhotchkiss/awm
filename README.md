# AWM - Agent Work Manager

Task persistence and scheduling for AI agents. Tracks recurring tasks, projects, and idle modes so agents know what to work on.

## Features

- **Recurring Tasks** — Define tasks with cadences (5m, 1h, daily). AWM tracks when they're overdue.
- **Idle Modes** — Default work for agents when no specific tasks are due.
- **Pull Model** — Agents pull their work queue on heartbeat (preferred).
- **Check-ins** — Agents report task completion and get reminded of their next work.
- **Dashboard** — Web UI shows all agents and their task status.

## Installation

```bash
npm install
npm run build
```

## Pull Model (Recommended)

Agents pull their work queue on every heartbeat instead of being pushed notifications.

```bash
# Agent runs this on heartbeat
awm pull <agentId>
```

Returns:
1. Prioritized list of overdue tasks
2. Idle work instructions

Example output:
```
📋 YOU HAVE 3 TASK(S) TO DO:

1. **VIP monitoring** (15m overdue)
   → Check VIP list, engage authentically
   When done: `awm update task_abc123 -m "what you did"`

2. **Breaking news watch** (8m overdue)
   → Watch for breaking AI/tech news
   When done: `awm update task_def456 -m "what you did"`

---
After completing tasks above, continue with:
🏠 IDLE WORK: Engagement
   → Twitter engagement, mentions, replies, likes...
   Check in periodically: `awm checkin nova -m "what you did"`
```

### Agent Workflow

1. **Pull** — `awm pull <agentId>` on every heartbeat
2. **Work** — Do each task in order
3. **Post** — Post progress to Slack channel (visibility!)
4. **Log** — `awm update <taskId> -m "what you did"` after each task
5. **Idle** — Do idle work if all tasks complete
6. **Check in** — `awm checkin <agentId> -m "summary"`

## CLI Commands

```bash
# Pull work queue (use this in heartbeats!)
awm pull <agentId>

# Update a task after completing it
awm update <taskId> -m "what I did"

# Check in while working on idle mode
awm checkin <agentId> -m "what I'm working on"

# See agent's current context
awm context <agentId>

# List all tasks
awm list

# Show overdue tasks
awm overdue

# Show idle agents (no recent check-in)
awm idle

# Show task history
awm history --limit 20

# Start the web dashboard
awm serve --port 3457

# Create a new recurring task
awm create -n "Task name" -t recurring -o agentId -c 30m -i "Instructions"

# Configure an agent's default mode
awm agent -a agentId --default-task "Idle Mode Name" --default-instruction "What to do when idle"
```

## Daemon (Deprecated)

> **Note:** The pull model is now preferred. Agents pull work on heartbeat instead of being pushed.

The AWM daemon runs every 30 seconds and wakes agents via Slack when:
- Recurring tasks are overdue (missed their cadence)
- Agents haven't checked in for 30+ minutes (idle reminder)

### Environment Variables

- `AWM_DATA` — Path to data file (default: `./awm-data.json`)
- `SLACK_BOT_TOKEN` — Slack bot token for sending wake messages (daemon only)

## Integration with Agents

Add to your HEARTBEAT.md:

```markdown
## 🔴 AWM PULL (EVERY HEARTBEAT)

**FIRST THING EVERY HEARTBEAT:** Run AWM pull to get your work queue.

/path/to/awm pull <your-agent-id>

**COMPLETE EVERYTHING** before replying HEARTBEAT_OK:
1. Do each task in order
2. POST to your Slack channel as you work (visibility!)
3. LOG to AWM: `awm update <taskId> -m "what you did"`
4. When all tasks done, do idle work
5. CHECK IN: `awm checkin <agentId> -m "summary"`

**If AWM returns nothing:** Reply HEARTBEAT_OK
**If AWM returns work:** Do it ALL, then HEARTBEAT_OK
```

## Data Structure

AWM stores state in a JSON file:

```json
{
  "tasks": {
    "task_abc123": {
      "id": "task_abc123",
      "name": "VIP monitoring",
      "type": "recurring",
      "owner": "nova",
      "instruction": "Check VIP list, engage authentically",
      "cadence": "3m",
      "status": "active",
      "lastUpdate": 1234567890
    }
  },
  "agents": {
    "nova": {
      "agentId": "nova",
      "defaultMode": {
        "taskName": "Engagement",
        "instruction": "Twitter engagement, mentions, replies..."
      },
      "recurringTaskIds": ["task_abc123"],
      "lastCheckIn": 1234567890
    }
  }
}
```

## License

MIT
