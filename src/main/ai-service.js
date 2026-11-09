'use strict';
/**
 * Dynamic Windows - AI Chat & Multimodal Service
 * Manages Gemini API & OpenAI-compatible endpoints, chat session persistence,
 * and multimodal attachments (screen captures, drag-drop files, clipboard images).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const DATA_DIR = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'DynamicWindows')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DynamicWindows');

const CHATS_FILE = path.join(DATA_DIR, 'ai_chats.json');

class AiService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir || DATA_DIR;
    this.chatsFile = options.chatsFile || CHATS_FILE;
    this.configManager = options.configManager || null;
    this.sessions = [];
    this.activeSessionId = null;
    this.ensureDir();
    this.loadSessions();
  }

  ensureDir() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[AiService] Failed to create data dir:', e.message);
    }
  }

  loadSessions() {
    this.ensureDir();
    try {
      if (fs.existsSync(this.chatsFile)) {
        const raw = fs.readFileSync(this.chatsFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.sessions)) {
          this.sessions = parsed.sessions;
          this.activeSessionId = parsed.activeSessionId || (this.sessions[0] ? this.sessions[0].id : null);
          return;
        }
      }
    } catch (e) {
      console.warn('[AiService] Failed to read chats file, initializing fresh:', e.message);
    }
    this.sessions = [];
    this.activeSessionId = null;
    // Ensure at least one default session exists
    this.createSession('New Chat');
  }

  saveSessions() {
    this.ensureDir();
    try {
      const data = {
        activeSessionId: this.activeSessionId,
        sessions: this.sessions
      };
      fs.writeFileSync(this.chatsFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('[AiService] Failed to save chats file:', e);
      return false;
    }
  }

  getSessions() {
    return this.sessions.map(s => ({
      id: s.id,
      title: s.title || 'Chat',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: Array.isArray(s.messages) ? s.messages.length : 0
    }));
  }

  getSession(id) {
    const session = this.sessions.find(s => s.id === id);
    if (!session) {
      if (this.sessions.length > 0) return this.sessions[0];
      return this.createSession('New Chat');
    }
    return session;
  }

  createSession(title = 'New Chat') {
    const id = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const newSession = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    this.sessions.unshift(newSession);
    this.activeSessionId = id;
    this.saveSessions();
    return newSession;
  }

  deleteSession(id) {
    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx !== -1) {
      this.sessions.splice(idx, 1);
      if (this.activeSessionId === id) {
        this.activeSessionId = this.sessions[0] ? this.sessions[0].id : null;
      }
      if (this.sessions.length === 0) {
        this.createSession('New Chat');
      } else {
        this.saveSessions();
      }
    }
    return this.getSessions();
  }

  setActiveSession(id) {
    if (this.sessions.some(s => s.id === id)) {
      this.activeSessionId = id;
      this.saveSessions();
    }
    return this.getSession(this.activeSessionId);
  }

  getConfig() {
    if (this.configManager) {
      return {
        aiProvider: this.configManager.get('aiProvider') || 'gemini',
        aiApiKey: this.configManager.get('aiApiKey') || '',
        aiModel: this.configManager.get('aiModel') || 'gemini-1.5-flash',
        aiBaseUrl: this.configManager.get('aiBaseUrl') || 'https://api.openai.com/v1',
        aiSubMode: this.configManager.get('aiSubMode') || 'chat'
      };
    }
    return {
      aiProvider: 'gemini',
      aiApiKey: '',
      aiModel: 'gemini-1.5-flash',
      aiBaseUrl: 'https://api.openai.com/v1',
      aiSubMode: 'chat'
    };
  }

  /**
   * Converts a local file path or data URL into a standardized { mimeType, base64 } object
   */
  processImageInput(imageInput) {
    if (!imageInput) return null;
    if (typeof imageInput === 'object' && imageInput.base64 && imageInput.mimeType) {
      return imageInput;
    }
    if (typeof imageInput === 'string') {
      // Check if it's already a Data URL
      const match = imageInput.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          mimeType: match[1],
          base64: match[2]
        };
      }
      // Check if it's a file path
      if (fs.existsSync(imageInput)) {
        try {
          const ext = path.extname(imageInput).toLowerCase();
          let mimeType = 'image/png';
          if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
          else if (ext === '.webp') mimeType = 'image/webp';
          else if (ext === '.gif') mimeType = 'image/gif';
          const buffer = fs.readFileSync(imageInput);
          return {
            mimeType,
            base64: buffer.toString('base64')
          };
        } catch (e) {
          console.warn('[AiService] Failed to read image file:', e.message);
        }
      }
    }
    return null;
  }

  /**
   * Dispatches chat prompt to Gemini API
   */
  async callGemini(apiKey, model, conversationMessages, options = {}) {
    if (!apiKey) throw new Error('Gemini API key is required. Please set it in Dynamic Windows Settings.');

    const cleanModel = model || 'gemini-1.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

    // Build contents array formatted for Gemini
    const contents = [];
    for (const msg of conversationMessages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = [];

      // Add attached images
      if (Array.isArray(msg.images)) {
        for (const img of msg.images) {
          const processed = this.processImageInput(img);
          if (processed) {
            parts.push({
              inlineData: {
                mimeType: processed.mimeType,
                data: processed.base64
              }
            });
          }
        }
      }

      // Add text content
      if (msg.content) {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    if (contents.length === 0) {
      throw new Error('Cannot send empty message');
    }

    const payload = {
      contents,
      generationConfig: {
        temperature: options.temperature !== undefined ? options.temperature : 0.7,
        maxOutputTokens: options.maxOutputTokens || 2048
      }
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let errMsg = `Gemini API error (${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson.error && errJson.error.message) {
          errMsg = errJson.error.message;
        }
      } catch (e) {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    const candidate = data.candidates && data.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error('Gemini returned an empty response.');
    }

    const textParts = candidate.content.parts.map(p => p.text || '').join('');
    return textParts.trim();
  }

  /**
   * Dispatches chat prompt to OpenAI-compatible endpoint
   */
  async callOpenAI(apiKey, model, baseUrl, conversationMessages, options = {}) {
    if (!apiKey) throw new Error('API key is required. Please set it in Dynamic Windows Settings.');

    const cleanBase = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const endpoint = `${cleanBase}/chat/completions`;

    const messages = [];
    for (const msg of conversationMessages) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const contentParts = [];

      if (msg.content) {
        contentParts.push({ type: 'text', text: msg.content });
      }

      if (Array.isArray(msg.images)) {
        for (const img of msg.images) {
          const processed = this.processImageInput(img);
          if (processed) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${processed.mimeType};base64,${processed.base64}`
              }
            });
          }
        }
      }

      // If text-only, pass string for maximum compatibility
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        messages.push({ role, content: contentParts[0].text });
      } else if (contentParts.length > 0) {
        messages.push({ role, content: contentParts });
      }
    }

    const payload = {
      model: model || 'gpt-4o-mini',
      messages,
      temperature: options.temperature !== undefined ? options.temperature : 0.7
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let errMsg = `OpenAI API error (${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson.error && errJson.error.message) {
          errMsg = errJson.error.message;
        }
      } catch (e) {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      throw new Error('AI returned an empty response.');
    }

    return choice.message.content.trim();
  }

  /**
   * Main entry point to send user query + optional images to active session
   */
  async sendMessage({ sessionId, text, images = [], options = {} }) {
    const session = this.getSession(sessionId || this.activeSessionId);
    if (!session) throw new Error('Session not found');

    const config = this.getConfig();
    const provider = (config.aiProvider || 'gemini').toLowerCase();
    const apiKey = config.aiApiKey;
    const model = config.aiModel;
    const baseUrl = config.aiBaseUrl;

    if (!apiKey) {
      throw new Error('No API key configured. Open Settings > AI to enter your API key.');
    }

    // Process images
    const processedImages = [];
    for (const img of images) {
      const p = this.processImageInput(img);
      if (p) {
        processedImages.push(`data:${p.mimeType};base64,${p.base64}`);
      }
    }

    // Push user message to session
    const userMsg = {
      role: 'user',
      content: text || (processedImages.length > 0 ? 'Analyze attached image' : ''),
      images: processedImages,
      timestamp: Date.now()
    };
    session.messages.push(userMsg);

    // Auto-title session if it's currently untitled or 'New Chat'
    if (session.title === 'New Chat' || !session.title) {
      const snippet = (text || 'Image Analysis').slice(0, 32).trim();
      session.title = snippet.length >= 32 ? snippet + '...' : snippet;
    }

    session.updatedAt = Date.now();
    this.saveSessions();

    try {
      let replyText = '';
      if (provider === 'gemini') {
        replyText = await this.callGemini(apiKey, model, session.messages, options);
      } else {
        replyText = await this.callOpenAI(apiKey, model, baseUrl, session.messages, options);
      }

      // Push assistant reply to session
      const assistantMsg = {
        role: 'assistant',
        content: replyText,
        timestamp: Date.now()
      };
      session.messages.push(assistantMsg);
      session.updatedAt = Date.now();
      this.saveSessions();

      return {
        reply: replyText,
        session
      };
    } catch (err) {
      // Record error message in session for user visibility
      const errorMsg = {
        role: 'assistant',
        content: `⚠️ Error: ${err.message}`,
        isError: true,
        timestamp: Date.now()
      };
      session.messages.push(errorMsg);
      session.updatedAt = Date.now();
      this.saveSessions();
      throw err;
    }
  }
}

module.exports = {
  AiService,
  DATA_DIR,
  CHATS_FILE
};
