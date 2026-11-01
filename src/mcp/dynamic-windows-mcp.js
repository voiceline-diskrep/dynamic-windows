'use strict';
/**
 * Dynamic Windows + One-Shot - Antigravity Model Context Protocol (MCP) Server
 * Exposes dynamic island & notch control tools to Google Antigravity over Stdio JSON-RPC.
 */

const http = require('http');

const PORT = 47823;

const TOOLS = [
  {
    name: 'dynamic_island_notify',
    description: 'Send a live notification and agent status update directly to the Dynamic Island / Dynamic Notch desktop interface.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['running', 'thinking', 'waiting', 'done', 'error', 'idle'],
          description: 'Current agent activity status.'
        },
        phase: {
          type: 'string',
          description: 'Short human-readable summary of the current step or action (e.g. "Executing tests", "Analyzing codebase").'
        },
        task: {
          type: 'string',
          description: 'Optional overall task title.'
        },
        tool: {
          type: 'string',
          description: 'Optional specific tool or action being executed (e.g. "run_command", "edit_file").'
        },
        command: {
          type: 'string',
          description: 'Optional shell command string or sub-task summary.'
        },
        file: {
          type: 'string',
          description: 'Optional file path or target filename being operated on.'
        },
        progress: {
          type: 'number',
          description: 'Optional integer percentage progress (0 to 100).'
        }
      },
      required: ['status', 'phase']
    }
  },
  {
    name: 'dynamic_island_shelf_file',
    description: 'Directly place a file into the Drop Shelf inside the Dynamic Island / Notch so the user can immediately view, open, or drag it from the desktop.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute file path of the file to shelf.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'dynamic_island_set_mode',
    description: 'Switch the Dynamic Windows interface between "island" (floating pill) and "notch" (flush MacBook-style bezel notch).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['island', 'notch'],
          description: 'Target interface display mode.'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'dynamic_island_get_state',
    description: 'Get the current Dynamic Windows state, including active display mode, shelf files count, and configured presets.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

function forwardToApp(endpoint, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 2000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ success: res.statusCode === 200, raw: body });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: 'Dynamic Windows application is not running on 127.0.0.1:' + PORT });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'Request to Dynamic Windows timed out' });
    });

    req.write(data);
    req.end();
  });
}

async function handleToolCall(name, args) {
  if (name === 'dynamic_island_notify') {
    const res = await forwardToApp('/mcp/notify', args);
    if (res.error) return { content: [{ type: 'text', text: `Warning: ${res.error}` }] };
    return { content: [{ type: 'text', text: `Dynamic Island updated: status="${args.status}", phase="${args.phase}"` }] };
  }

  if (name === 'dynamic_island_shelf_file') {
    const res = await forwardToApp('/mcp/shelf-file', args);
    if (res.error) return { content: [{ type: 'text', text: `Warning: ${res.error}` }] };
    return { content: [{ type: 'text', text: `File "${args.path}" successfully shelved into Dynamic Island Drop Zone.` }] };
  }

  if (name === 'dynamic_island_set_mode') {
    const res = await forwardToApp('/mcp/set-mode', args);
    if (res.error) return { content: [{ type: 'text', text: `Warning: ${res.error}` }] };
    return { content: [{ type: 'text', text: `Dynamic Windows display style switched to "${args.mode}".` }] };
  }

  if (name === 'dynamic_island_get_state') {
    const res = await forwardToApp('/mcp/state', {});
    return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function sendResponse(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) {
    msg.error = { code: error.code || -32603, message: error.message || 'Internal error' };
  } else {
    msg.result = result;
  }
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Stdio JSON-RPC Stream Reader
let buffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep trailing incomplete segment

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch (e) {
      sendResponse(null, null, { code: -32700, message: 'Parse error' });
      continue;
    }

    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dynamic-windows', version: '1.1.4' }
        });
      } else if (method === 'notifications/initialized') {
        // Notification, no reply needed
      } else if (method === 'ping') {
        sendResponse(id, {});
      } else if (method === 'tools/list') {
        sendResponse(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const { name, arguments: toolArgs } = params || {};
        const result = await handleToolCall(name, toolArgs || {});
        sendResponse(id, result);
      } else {
        sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
      }
    } catch (err) {
      sendResponse(id, null, { code: -32603, message: err.message });
    }
  }
});
