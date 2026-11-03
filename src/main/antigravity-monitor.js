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
    this.pollInterval = options.pollInterval || 350;
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

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
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

  updateFromMcp(data) {
    if (!data) return;
    this.lastMcpTime = Date.now();
    const convId = data.conversationId || (this.projects.size > 0 ? Array.from(this.projects.keys())[0] : 'default');
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
      updatedAt: Date.now()
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
    existing.updatedAt = Date.now();

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

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptFile = path.join(this.brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptFile)) continue;

        const stat = fs.statSync(transcriptFile);
        const ageMs = Date.now() - stat.mtimeMs;
        const existing = this.projects.get(entry.name);
        const isActive = existing && ['running', 'thinking', 'waiting'].includes(existing.status);

        // Track conversations modified within 25 minutes or currently active
        if (ageMs > 25 * 60 * 1000 && !isActive) {
          if (existing && existing.status === 'done' && Date.now() - existing.updatedAt > 20 * 60 * 1000) {
            this.projects.delete(entry.name);
          }
          continue;
        }

        const lastSize = this.fileOffsets.get(entry.name) || 0;
        if (stat.size === lastSize && existing) {
          // If task completed > 8s ago, transition to idle Ready
          if (existing.status === 'done' && Date.now() - existing.updatedAt > 8000) {
            existing.status = 'idle';
            existing.phase = 'Ready';
            this.emit('change', this.getState());
          }
          continue;
        }

        this.fileOffsets.set(entry.name, stat.size);
        const readLen = Math.min(stat.size, 32768);
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
            const projName = existing ? existing.project : this.extractProjectName(transcriptFile, 'Antigravity');
            const parsed = this.parseStepToState(step, entry.name, projName);
            if (parsed) {
              const prev = this.projects.get(entry.name);
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
