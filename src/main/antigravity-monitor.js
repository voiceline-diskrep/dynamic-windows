'use strict';
/**
 * Dynamic Windows - Google Antigravity Real-Time Monitor
 * Monitors local Antigravity brain transcripts, tool executions, and step states.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { exec } = require('child_process');

const USER_HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\russell';
const BRAIN_DIR = path.join(USER_HOME, '.gemini', 'antigravity', 'brain');

class AntigravityMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.brainDir = options.brainDir || BRAIN_DIR;
    this.activeConversationId = null;
    this.transcriptPath = null;
    this.lastFileSize = 0;
    this.pollInterval = options.pollInterval || 350;
    this.timer = null;
    this.lastState = {
      status: 'idle', // 'idle' | 'running' | 'thinking' | 'done' | 'error'
      provider: 'Google Antigravity',
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
    this.findLatestConversation();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getState() {
    return { ...this.lastState };
  }

  findLatestConversation() {
    try {
      if (!fs.existsSync(this.brainDir)) return;
      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      let latestId = null;
      let latestMtime = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptFile = path.join(this.brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcriptFile)) {
          const stat = fs.statSync(transcriptFile);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestId = entry.name;
          }
        }
      }

      if (latestId && latestId !== this.activeConversationId) {
        this.activeConversationId = latestId;
        this.transcriptPath = path.join(this.brainDir, latestId, '.system_generated', 'logs', 'transcript.jsonl');
        this.lastFileSize = 0; // Trigger full read
      }
    } catch (err) {
      // Brain dir access error handling
    }
  }

  poll() {
    this.findLatestConversation();
    if (!this.transcriptPath || !fs.existsSync(this.transcriptPath)) {
      return;
    }

    try {
      const stat = fs.statSync(this.transcriptPath);
      if (stat.size === this.lastFileSize) {
        // No new bytes; if it was done > 45s ago, reset to idle
        if (this.lastState.status === 'done' && Date.now() - this.lastState.updatedAt > 45000) {
          this.lastState.status = 'idle';
          this.lastState.phase = 'Ready';
          this.emit('change', this.getState());
        }
        return;
      }

      const fd = fs.openSync(this.transcriptPath, 'r');
      let startOffset = 0;
      // If file grew, read from last position or read last 64KB for speed
      if (this.lastFileSize > 0 && stat.size > this.lastFileSize) {
        startOffset = this.lastFileSize;
      } else if (stat.size > 65536) {
        startOffset = stat.size - 65536;
      }

      const length = stat.size - startOffset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, startOffset);
      fs.closeSync(fd);
      this.lastFileSize = stat.size;

      const chunk = buffer.toString('utf-8');
      const lines = chunk.split('\n').filter(l => l.trim().length > 0);
      if (lines.length === 0) return;

      // Parse the latest JSON line
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const step = JSON.parse(lines[i]);
          this.processStep(step);
          break;
        } catch (e) {
          // Incomplete line, try previous
        }
      }
    } catch (err) {
      // Polling read error
    }
  }

  processStep(step) {
    const prevState = this.lastState.status;
    let newStatus = 'running';
    let phase = '';
    let toolName = '';
    let cmd = '';
    let fileName = '';

    if (step.tool_calls && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      const tc = step.tool_calls[0];
      const fn = tc.ToolName || (tc.function && tc.function.name) || 'tool';
      toolName = fn;
      const args = tc.Arguments || {};

      if (fn === 'run_command') {
        cmd = args.toolSummary || args.CommandLine || 'Executing shell command';
        phase = `Command: ${cmd.length > 36 ? cmd.slice(0, 36) + '...' : cmd}`;
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
      } else {
        phase = `Tool: ${fn}`;
      }
    } else if (step.thinking) {
      newStatus = 'thinking';
      phase = 'Thinking & analyzing solution...';
    } else if (step.type === 'USER_INPUT') {
      newStatus = 'running';
      phase = 'Processing request...';
    } else if (step.status === 'DONE') {
      newStatus = 'done';
      phase = 'Task finished';
    } else if (step.status === 'ERROR') {
      newStatus = 'error';
      phase = 'Error occurred';
    }

    this.lastState = {
      status: newStatus,
      provider: 'Google Antigravity',
      task: cmd || phase || 'Active Task',
      phase: phase || 'Running step',
      tool: toolName,
      file: fileName,
      command: cmd,
      progress: null,
      conversationId: this.activeConversationId || '',
      updatedAt: Date.now()
    };

    if (prevState !== 'done' && newStatus === 'done') {
      this.emit('task-completed', this.getState());
    }

    this.emit('change', this.getState());
  }

  focusAntigravityWindow() {
    const { execFile } = require('child_process');
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
      } else if (output.includes('ACTIVATED')) {
        if (this.lastState.status === 'not_running') {
          this.lastState.status = 'idle';
          this.lastState.phase = 'Ready';
          this.emit('change', this.getState());
        }
      }
    });
  }
}

module.exports = AntigravityMonitor;
