# AWM - Agent Work Manager

Task persistence and scheduling for AI agents. Tracks recurring tasks, projects, and idle modes so agents know what to work on.

## Features

- **Recurring Tasks** — Define tasks with cadences (5m, 1h, daily). AWM tracks when they're overdue.
- **Idle Modes** — Default work for agents when no specific tasks are due.
- **Check-ins** — Agents report task completion and get reminded of their next work.
- **Daemon** — Background process wakes agents via Slack when tasks are overdue.
- **Dashboard** — Web UI shows all agents and their task status.

## Installation

```bash
npm install
npm run build
```

## CLI Commands

```bash
# See agent's current context (what's overdue, what to do)
awm context <agentId>

# Update a task after completing it
awm update <taskId> -m "what I did"

# Check in while working on idle mode
awm checkin <agentId> -m "what I'm working on"

# List all tasks
awm list

# Show overdue tasks
awm overdue

# Show idle agents
awm idle

# Start the web dashboard
awm serve --port 3457

# Create a new recurring task
awm create -n "Task name" -t recurring -o agentId -c 30m -i "Instructions"

# Configure an agent's default mode
awm agent -a agentId --default-task "Idle Mode Name" --default-instruction "What to do when idle"
```

## Daemon

The AWM daemon runs every 30 seconds and wakes agents via Slack when:
- Recurring tasks are overdue (missed their cadence)
- Agents haven't checked in for 30+ minutes (idle reminder)

### LaunchAgent Setup (macOS)

```bash
# Install the LaunchAgent
cp com.awm.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.awm.daemon.plist
```

### Environment Variables

- `AWM_DATA` — Path to data file (default: `./awm-data.json`)
- `SLACK_BOT_TOKEN` — Slack bot token for sending wake messages

## Integration with Agents

Add to your AGENTS.md:

```markdown
## 🔄 AWM - Agent Work Manager (MANDATORY)

AWM tracks your recurring tasks. **Update it every time you complete work.**

After completing any task:
  /path/to/awm update <taskId> -m "what you did"

If working on idle mode, check in periodically:
  /path/to/awm checkin <your-agent-id> -m "what I'm doing"

If you don't update, you'll keep getting pinged.
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
