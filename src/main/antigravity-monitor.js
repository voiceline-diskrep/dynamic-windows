'use strict';
/**
 * Dynamic Windows - Google Antigravity Real-Time Monitor
 * Monitors local Antigravity brain transcripts, tool executions, and step states.
 * Supports concurrent multi-project tracking and stacked Dynamic Island status.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const USER_HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\russell';
const BRAIN_DIR = path.join(USER_HOME, '.gemini', 'antigravity', 'brain');

class AntigravityMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.brainDir = options.brainDir || BRAIN_DIR;
    this.activeConversationId = null;
    this.transcriptPath = null;
    this.lastFileSize = 0;
    this.lastMcpTime = 0;
    this.pollInterval = options.pollInterval || 1500;
    this.timer = null;

    // Multi-project tracking Map: conversationId -> ProjectState
    this.projects = new Map();
    this.fileOffsets = new Map();

    this.lastState = {
      status: 'idle', // 'idle' | 'running' | 'thinking' | 'waiting' | 'done' | 'error'
      provider: 'Google Antigravity',
      project: 'Antigravity',
      task: '',
      phase: '',
      tool: '',
      file: '',
      command: '',
      progress: null,
      conversationId: '',
      updatedAt: Date.now()
    };
  }

  scheduleNext(delayMs) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.paused) return;
    const hasActive = Array.from(this.projects.values()).some(p => p.status === 'running' || p.status === 'RUNNING');
    const delay = typeof delayMs === 'number' ? delayMs : (hasActive ? 400 : (this.pollInterval || 1500));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.paused) return;
      this.poll();
      this.scheduleNext();
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }

  start() {
    this.paused = false;
    if (this.timer) return;
    this.poll();
    this.scheduleNext();
  }

  setPaused(paused) {
    const next = Boolean(paused);
    if (this.paused === next) return;
    this.paused = next;
    if (next) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    } else if (!this.timer) {
      this.poll();
      this.scheduleNext();
    }
  }

  stop() {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getState() {
    const list = Array.from(this.projects.values()).filter(p => {
      if (p.status === 'not_running') return false;
      // Prune idle projects older than 20 minutes
      if (p.status === 'idle' && Date.now() - p.updatedAt > 20 * 60 * 1000) return false;
      return true;
    }).sort((a, b) => {
      const weight = (s) => (s === 'running' ? 3 : (s === 'thinking' ? 2 : (s === 'waiting' ? 1 : 0)));
      const aWeight = weight(a.status);
      const bWeight = weight(b.status);
      if (aWeight !== bWeight) return bWeight - aWeight;
      return b.updatedAt - a.updatedAt;
    });

    const primary = list[0] || this.lastState;

    return {
      ...primary,
      projects: list.length > 0 ? list : [this.lastState]
    };
  }

  resolveMcpConversationId(data) {
    if (data.conversationId) return data.conversationId;

    const realProjects = Array.from(this.projects.values())
      .filter(p => p.conversationId && p.conversationId !== 'default')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (realProjects.length === 0) return 'default';

    if (data.project) {
      const targetProj = String(data.project).toLowerCase();
      const activeMatch = realProjects.find(p =>
        ['running', 'thinking', 'waiting'].includes(p.status) &&
        p.project && p.project.toLowerCase() === targetProj
      );
      if (activeMatch) return activeMatch.conversationId;

      const anyMatch = realProjects.find(p => p.project && p.project.toLowerCase() === targetProj);
      if (anyMatch) return anyMatch.conversationId;
    }

    const activeRecent = realProjects.find(p => ['running', 'thinking', 'waiting'].includes(p.status));
    if (activeRecent) return activeRecent.conversationId;

    return realProjects[0].conversationId;
  }

  updateFromMcp(data) {
    if (!data) return;
    const now = Date.now();
    this.lastMcpTime = now;
    const convId = this.resolveMcpConversationId(data);
    const existing = this.projects.get(convId) || {
      provider: 'Google Antigravity',
      project: data.project || 'Antigravity',
      conversationId: convId,
      status: 'running',
      phase: 'Agent Active',
      tool: '',
      file: '',
      command: '',
      progress: null,
      lastMcpTime: now,
      updatedAt: now
    };

    const prevState = existing.status;
    const newStatus = data.status || 'running';
    existing.status = newStatus;
    existing.phase = data.phase || 'Agent Active';
    if (data.project) existing.project = data.project;
    if (data.task) existing.task = data.task;
    if (data.tool) existing.tool = data.tool;
    if (data.file) existing.file = data.file;
    if (data.command) existing.command = data.command;
    if (typeof data.progress === 'number') existing.progress = data.progress;
    existing.lastMcpTime = now;
    existing.updatedAt = now;

    this.projects.set(convId, existing);
    this.lastState = { ...existing };

    if (prevState !== 'done' && newStatus === 'done') {
      this.emit('task-completed', this.getState());
    }
    this.emit('change', this.getState());
  }

  extractProjectName(transcriptPath, fallback) {
    try {
      if (!fs.existsSync(transcriptPath)) return fallback || 'Antigravity';
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n');

      // 1. Scan lines from head for tool_calls or content with project paths
      for (let i = 0; i < Math.min(lines.length, 35); i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const step = JSON.parse(line);
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            for (const tc of step.tool_calls) {
              if (!tc.args) continue;
              for (const key of Object.keys(tc.args)) {
                const val = String(tc.args[key]);
                const m = val.match(/(?:Documents[\\\/]antigravity|scratch|projects|repos|workspace)[\\\/]([^\\\/\"\'\s\r\n]+)/i);
                if (m && m[1]) {
                  const name = m[1].replace(/\\/g, '').trim();
                  if (name && name !== 'Documents' && name !== 'antigravity') return name;
                }
              }
            }
          }
          if (typeof step.content === 'string') {
            const m = step.content.match(/(?:Active Workspaces|Command Working Directory):[\s\r\n-]+(?:[a-zA-Z]:)?[\\/][^"'\r\n]+[\\/]([^"'\r\n\\\/]+)/i);
            if (m && m[1]) {
              const name = m[1].trim();
              if (name && name !== 'Documents' && name !== 'antigravity') return name;
            }
          }
        } catch (e) {}
      }

      // 2. Scan backwards from tail (latest commands/tools often operate in the workspace)
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const step = JSON.parse(line);
          if (step.tool_calls && Array.isArray(step.tool_calls)) {
            for (const tc of step.tool_calls) {
              if (!tc.args) continue;
              for (const key of Object.keys(tc.args)) {
                const val = String(tc.args[key]);
                const m = val.match(/(?:Documents[\\\/]antigravity|scratch|projects|repos|workspace)[\\\/]([^\\\/\"\'\s\r\n]+)/i);
                if (m && m[1]) {
                  const name = m[1].replace(/\\/g, '').trim();
                  if (name && name !== 'Documents' && name !== 'antigravity') return name;
                }
              }
            }
          }
        } catch (e) {}
      }

    } catch (e) {}

    return fallback || 'Island';
  }

  poll() {
    try {
      if (!fs.existsSync(this.brainDir)) return;
      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptFile = path.join(this.brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptFile)) continue;

        const stat = fs.statSync(transcriptFile);
        const ageMs = now - stat.mtimeMs;
        const existing = this.projects.get(entry.name);
        const isActive = existing && ['running', 'thinking', 'waiting'].includes(existing.status);

        // Clean up transient 'default' MCP bucket once a real active UUID conversation is seen
        if (ageMs < 60000 && this.projects.has('default')) {
          const defProj = this.projects.get('default');
          this.projects.delete('default');
          if (!existing && defProj && defProj.lastMcpTime && (now - defProj.lastMcpTime < 4000)) {
            this.projects.set(entry.name, { ...defProj, conversationId: entry.name });
          }
        }

        const currentExisting = this.projects.get(entry.name);
        const lastMcpAge = currentExisting && currentExisting.lastMcpTime ? (now - currentExisting.lastMcpTime) : Infinity;
        const effectiveAgeMs = Math.min(ageMs, lastMcpAge);

        // Auto-expire stuck active chats after 2 minutes without transcript or MCP updates
        if (isActive && effectiveAgeMs > 120000) {
          currentExisting.status = 'idle';
          currentExisting.phase = 'Ready';
          currentExisting.updatedAt = now;
          this.lastState = { ...currentExisting };
          this.emit('change', this.getState());
          continue;
        }

        // Track conversations modified within 25 minutes or currently active
        if (ageMs > 25 * 60 * 1000 && !isActive) {
          if (currentExisting && ['done', 'idle'].includes(currentExisting.status) && now - currentExisting.updatedAt > 20 * 60 * 1000) {
            this.projects.delete(entry.name);
          }
          continue;
        }

        const lastSize = this.fileOffsets.get(entry.name) || 0;
        if (stat.size === lastSize && currentExisting) {
          // If task completed > 8s ago, transition to idle Ready
          if (currentExisting.status === 'done' && now - currentExisting.updatedAt > 8000) {
            currentExisting.status = 'idle';
            currentExisting.phase = 'Ready';
            this.lastState = { ...currentExisting };
            this.emit('change', this.getState());
          }
          continue;
        }

        this.fileOffsets.set(entry.name, stat.size);
        const readLen = Math.min(stat.size, 262144);
        if (readLen <= 0) continue;
        const fd = fs.openSync(transcriptFile, 'r');
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
        fs.closeSync(fd);

        const chunk = buf.toString('utf8');
        const lines = chunk.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) continue;

        // Parse latest step
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const step = JSON.parse(lines[i]);
            const projName = (currentExisting && currentExisting.project && currentExisting.project !== 'Antigravity')
              ? currentExisting.project
              : this.extractProjectName(transcriptFile, 'Antigravity');
            const parsed = this.parseStepToState(step, entry.name, projName);
            if (parsed) {
              // On initial discovery of stale conversations, mark them idle immediately
              if (!currentExisting) {
                if (ageMs > 120000 && ['running', 'thinking', 'waiting'].includes(parsed.status)) {
                  parsed.status = 'idle';
                  parsed.phase = 'Ready';
                  parsed.updatedAt = stat.mtimeMs;
                } else if (ageMs > 8000 && parsed.status === 'done') {
                  parsed.status = 'idle';
                  parsed.phase = 'Ready';
                  parsed.updatedAt = stat.mtimeMs;
                }
              }

              // Preserve previous tool phase when generic tool output arrives
              if (parsed.phase === 'Processing tool results...' && currentExisting && currentExisting.phase && currentExisting.phase !== 'Ready') {
                parsed.phase = currentExisting.phase;
                parsed.tool = currentExisting.tool;
                parsed.command = currentExisting.command;
                parsed.file = currentExisting.file;
              }

              // Preserve recent MCP override unless transcript explicitly finished or awaits user input
              if (lastMcpAge < 4000 && currentExisting && parsed.status !== 'done' && parsed.status !== 'waiting') {
                parsed.status = currentExisting.status;
                parsed.phase = currentExisting.phase;
                parsed.tool = currentExisting.tool;
                parsed.command = currentExisting.command;
                parsed.file = currentExisting.file;
                parsed.progress = currentExisting.progress;
              }

              if (currentExisting && currentExisting.lastMcpTime) {
                parsed.lastMcpTime = currentExisting.lastMcpTime;
              }

              const prev = currentExisting;
              this.projects.set(entry.name, parsed);

              if (!prev || prev.status !== parsed.status || prev.phase !== parsed.phase) {
                if (prev && prev.status !== 'done' && parsed.status === 'done') {
                  this.emit('task-completed', this.getState());
                }
                this.lastState = { ...parsed };
                this.emit('change', this.getState());
              }
              break;
            }
          } catch (e) {}
        }
      }
    } catch (err) {}
  }

  parseStepToState(step, conversationId, projectName) {
    if (!step) return null;

    const cleanArg = (val) => {
      if (typeof val !== 'string') return val;
      val = val.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        return val.slice(1, -1);
      }
      return val;
    };

    let newStatus = 'running';
    let phase = '';
    let toolName = '';
    let cmd = '';
    let fileName = '';

    if (step.tool_calls && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      const tc = step.tool_calls[0];
      const fn = tc.name || tc.ToolName || (tc.function && tc.function.name) || 'tool';
      toolName = fn;
      const rawArgs = tc.args || tc.Arguments || {};
      const args = {};
      for (const [k, v] of Object.entries(rawArgs)) {
        args[k] = cleanArg(v);
      }

      if (fn === 'run_command') {
        cmd = args.toolSummary || args.CommandLine || 'Executing command';
        phase = `Command: ${cmd.length > 34 ? cmd.slice(0, 34) + '...' : cmd}`;
      } else if (fn === 'write_file' || fn === 'edit_file') {
        const fp = args.Path || '';
        fileName = path.basename(fp) || 'file';
        phase = `Editing ${fileName}`;
      } else if (fn === 'read_file') {
        const fp = args.Path || '';
        fileName = path.basename(fp) || 'file';
        phase = `Reading ${fileName}`;
      } else if (fn === 'ask_question') {
        newStatus = 'waiting';
        phase = 'Waiting for your answer';
      } else if (fn === 'call_mcp_tool') {
        const server = args.ServerName || 'MCP';
        const mcpTool = args.ToolName || 'tool';
        phase = `${server}: ${mcpTool}`;
        toolName = `${server}.${mcpTool}`;
      } else if (fn === 'search_web') {
        phase = `Searching: ${args.query ? args.query.slice(0, 28) : 'web'}`;
      } else if (fn === 'search_marketplace') {
        phase = 'Searching marketplace';
      } else if (fn === 'invoke_subagent') {
        phase = `Subagent: ${args.Role || args.TypeName || 'agent'}`;
      } else {
        phase = `Tool: ${fn}`;
      }
    } else if (step.type === 'USER_INPUT') {
      newStatus = 'running';
      phase = 'Processing request...';
    } else if (step.type === 'PLANNER_RESPONSE' && step.status === 'DONE' && (!step.tool_calls || step.tool_calls.length === 0)) {
      newStatus = 'done';
      phase = 'Task finished';
    } else if (step.thinking) {
      newStatus = 'thinking';
      phase = 'Thinking & analyzing solution...';
    } else if (step.type === 'GENERIC' || step.type === 'TOOL_RESPONSE') {
      newStatus = 'running';
      phase = 'Processing tool results...';
    } else {
      newStatus = 'idle';
      phase = 'Ready';
    }

    return {
      provider: 'Google Antigravity',
      project: projectName || 'Antigravity',
      status: newStatus,
      phase,
      tool: toolName,
      file: fileName,
      command: cmd,
      progress: null,
      conversationId: conversationId || '',
      updatedAt: Date.now()
    };
  }

  processStep(step) {
    const parsed = this.parseStepToState(step, this.activeConversationId || 'default', 'Antigravity');
    if (!parsed) return;

    const prevState = this.lastState.status;
    if (parsed.phase === 'Processing tool results...' && this.lastState.phase && this.lastState.phase !== 'Ready') {
      parsed.phase = this.lastState.phase;
      parsed.tool = this.lastState.tool;
      parsed.command = this.lastState.command;
      parsed.file = this.lastState.file;
    }

    this.lastState = { ...parsed };
    this.projects.set(parsed.conversationId, { ...parsed });

    if (prevState !== 'done' && parsed.status === 'done') {
      this.emit('task-completed', this.getState());
    }
    this.emit('change', this.getState());
  }

  focusAntigravityWindow() {
    const ps = [
      "$ws = New-Object -ComObject WScript.Shell",
      "$activated = $ws.AppActivate('Antigravity')",
      "if (-not $activated) {",
      "  $procs = Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue",
      "  if ($procs) {",
      "    foreach ($p in $procs) {",
      "      if ($ws.AppActivate($p.Id)) { $activated = $true; break }",
      "    }",
      "  }",
      "}",
      "if ($activated) { Write-Output 'ACTIVATED' } else { Write-Output 'NOT_RUNNING' }"
    ].join('\n');

    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], (err, stdout) => {
      const output = (stdout || '').trim();
      if (output.includes('NOT_RUNNING')) {
        this.lastState.status = 'not_running';
        this.lastState.phase = 'Antigravity is not running';
        this.emit('change', this.getState());
      }
    });
  }
}

module.exports = AntigravityMonitor;
