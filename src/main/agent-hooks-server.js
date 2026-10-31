'use strict';
/**
 * Dynamic Windows - Agent Hooks HTTP Server
 * Listens on 127.0.0.1:47823 for Claude Code & Codex hooks,
 * handling permission requests, rate limit reports, and prompt rewakes.
 */

const http = require('http');
const { EventEmitter } = require('events');

const PORT = 47823;

class AgentHooksServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || PORT;
    this.server = null;
    this.pendingPermissions = new Map(); // id -> { res, timeout, details }
    this.pendingReplies = new Map();     // sessionId -> res
    this.lastUsage = {
      fiveHour: null,
      sevenDay: null,
      context: null,
      model: '',
      updatedAt: 0
    };
    this.serial = 0;
  }

  start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('error', (err) => {
      console.warn('[AgentHooksServer] HTTP error:', err.message);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[AgentHooksServer] Listening for agent hooks on 127.0.0.1:${this.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2000000) req.destroy();
    });

    req.on('end', () => {
      let data = {};
      try {
        if (body) data = JSON.parse(body);
      } catch (e) {}

      // 1. Hook endpoint: /twocode-hook
      if (url.pathname === '/twocode-hook') {
        this.handleHookEvent(data, res);
      }
      // 2. Statusline endpoint: /twocode-status
      else if (url.pathname === '/twocode-status') {
        this.handleStatusReport(data, res);
      }
      // 3. Wait for reply endpoint: /twocode-wait
      else if (url.pathname === '/twocode-wait') {
        this.handleWaitReply(data, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  }

  handleHookEvent(data, res) {
    const eventType = data.event || data.type || '';
    const agent = data.agent || 'claude';

    // Permission Request: hold response until user allows/denies in Island
    if (eventType === 'PermissionRequest') {
      const permId = `perm_${++this.serial}`;
      const timeout = setTimeout(() => {
        if (this.pendingPermissions.has(permId)) {
          this.pendingPermissions.delete(permId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'deny', reason: 'Timeout' }));
          this.emit('permission-expired', { id: permId });
        }
      }, 300000); // 5 minutes

      this.pendingPermissions.set(permId, { res, timeout, details: data });
      this.emit('permission-requested', {
        id: permId,
        agent,
        command: data.command || '',
        file: data.file || '',
        message: data.message || 'Permission requested to proceed'
      });
      return;
    }

    // Standard notification or state change
    this.emit('agent-event', {
      agent,
      event: eventType,
      data
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  respondPermission(permId, allow) {
    const item = this.pendingPermissions.get(permId);
    if (!item) return false;
    clearTimeout(item.timeout);
    this.pendingPermissions.delete(permId);
    item.res.writeHead(200, { 'Content-Type': 'application/json' });
    item.res.end(JSON.stringify({ decision: allow ? 'allow' : 'deny' }));
    return true;
  }

  handleStatusReport(data, res) {
    this.lastUsage = {
      fiveHour: data.five_hour || null,
      sevenDay: data.seven_day || null,
      context: data.context || null,
      model: data.model || '',
      updatedAt: Date.now()
    };
    this.emit('usage-updated', this.lastUsage);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  handleWaitReply(data, res) {
    const sessionId = data.session_id || 'default';
    this.pendingReplies.set(sessionId, res);
    this.emit('waiting-reply', { sessionId });
  }

  sendReply(sessionId, replyText) {
    const res = this.pendingReplies.get(sessionId);
    if (!res) return false;
    this.pendingReplies.delete(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reply: replyText }));
    return true;
  }
}

module.exports = AgentHooksServer;
