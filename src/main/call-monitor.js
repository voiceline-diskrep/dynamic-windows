'use strict';
/**
 * Dynamic Windows - Universal & Discord Call Monitor
 * Detects active and incoming voice calls across Discord, WhatsApp, Zoom, Teams, Telegram, and Browsers.
 * Combines Windows CoreAudio + Microphone ConsentStore with Discord Local IPC (\\.\pipe\discord-ipc-0).
 */

const EventEmitter = require('events');
const net = require('net');
const crypto = require('crypto');
const sysHelper = require('./sys-helper');

// Discord StreamKit / RPC default client ID (can also be overridden in config.json)
const DEFAULT_DISCORD_CLIENT_ID = '207646673902501888';

function classifyMicApp(rawKey) {
  const s = String(rawKey || '').toLowerCase();
  // Ignore system/assistant processes that aren't voice calls
  if (!s || s.includes('speechruntime') || s.includes('cortana') || s.includes('searchhost')) {
    return null;
  }
  if (s.includes('discord')) {
    return { appId: 'discord', appName: 'Discord', processName: 'Discord' };
  }
  if (s.includes('whatsapp')) {
    return { appId: 'whatsapp', appName: 'WhatsApp', processName: 'WhatsApp' };
  }
  if (s.includes('zoom')) {
    return { appId: 'zoom', appName: 'Zoom', processName: 'Zoom' };
  }
  if (s.includes('teams')) {
    return { appId: 'teams', appName: 'Teams', processName: 'ms-teams' };
  }
  if (s.includes('telegram')) {
    return { appId: 'telegram', appName: 'Telegram', processName: 'Telegram' };
  }
  if (s.includes('chrome')) {
    return { appId: 'browser', appName: 'Chrome Call', processName: 'chrome' };
  }
  if (s.includes('msedge')) {
    return { appId: 'browser', appName: 'Edge Call', processName: 'msedge' };
  }
  if (s.includes('firefox')) {
    return { appId: 'browser', appName: 'Firefox Call', processName: 'firefox' };
  }
  if (s.includes('brave')) {
    return { appId: 'browser', appName: 'Brave Call', processName: 'brave' };
  }
  const parts = String(rawKey).split('#');
  const exe = parts[parts.length - 1].replace(/\.exe$/i, '');
  return {
    appId: 'generic',
    appName: exe ? exe.charAt(0).toUpperCase() + exe.slice(1) : 'Voice Call',
    processName: exe || 'Discord'
  };
}

function parseCallMetadataFromWindowTitle(appId, rawTitle) {
  const title = String(rawTitle || '').trim();
  if (!title) {
    return { callType: 'dm', channelName: appId === 'discord' ? 'Voice Connected' : 'Active Call', isIncoming: false };
  }

  const isIncoming = /\b(incoming\s+call|calling|ringing)\b/i.test(title);

  if (appId === 'discord') {
    // Examples:
    // "@Username - Discord" -> DM call with Username
    // "Username, Friend2 - Discord" -> Group DM call
    // "#voice-channel | Server Name - Discord" -> Server voice call
    const stripped = title.replace(/\s*-\s*Discord(?:PTB|Canary)?$/i, '').replace(/^\(\d+\)\s*/, '').trim();
    if (stripped.startsWith('@')) {
      const dmName = stripped.slice(1).trim();
      return {
        callType: 'dm',
        channelName: dmName || 'Direct Call',
        isIncoming
      };
    }
    if (stripped.includes('|')) {
      const [chan, srv] = stripped.split('|').map((s) => s.trim());
      return {
        callType: 'group',
        channelName: chan.replace(/^#/, '') || srv || 'Voice Channel',
        serverName: srv || '',
        isIncoming
      };
    }
    if (stripped.includes(',')) {
      const names = stripped.split(',').map((s) => s.trim()).filter(Boolean);
      return {
        callType: 'group',
        channelName: names.join(', '),
        groupMembers: names,
        isIncoming
      };
    }
    if (stripped && stripped.toLowerCase() !== 'discord' && stripped.toLowerCase() !== 'friends') {
      return {
        callType: 'dm',
        channelName: stripped.replace(/^#/, ''),
        isIncoming
      };
    }
    return { callType: 'group', channelName: 'Voice Channel', isIncoming };
  }

  if (appId === 'whatsapp') {
    const stripped = title.replace(/\s*-\s*WhatsApp$/i, '').trim();
    return {
      callType: 'dm',
      channelName: stripped && stripped.toLowerCase() !== 'whatsapp' ? stripped : 'WhatsApp Call',
      isIncoming
    };
  }

  return {
    callType: 'dm',
    channelName: title.slice(0, 32),
    isIncoming
  };
}

class CallMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs || 650;
    this.clientId = options.clientId || DEFAULT_DISCORD_CLIENT_ID;
    this.accessToken = options.accessToken || null;

    this.state = {
      inCall: false,
      status: 'idle', // 'idle' | 'ringing' | 'connected'
      appId: 'none', // 'discord' | 'whatsapp' | 'zoom' | 'teams' | 'telegram' | 'browser'
      appName: '',
      processName: '',
      callType: 'dm', // 'dm' | 'group'
      channelName: '',
      participantCount: 0,
      startedAt: 0,
      selfMuted: false,
      selfDeafened: false,
      selfSpeaking: false,
      participants: [] // [{ id, name, avatarUrl, isSpeaking, isMuted, isDeafened, isSelf }]
    };

    this.externalOverride = null;
    this.preDeafenMicMute = false;
    this.dismissedUntil = 0;

    // Discord RPC state
    this.rpcSocket = null;
    this.rpcConnected = false;
    this.rpcAuthenticated = false;
    this.rpcVoiceChannel = null; // { id, name, type, voice_states: [] }
    this.rpcSpeakingUsers = new Set();
    this.rpcSelfVoiceSettings = { mute: false, deaf: false };

    if (!options.disableAutoStart) {
      this.start();
    }
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.disconnectRpc();
  }

  getState() {
    if (this.externalOverride) {
      return this.externalOverride;
    }
    return this.state;
  }

  /**
   * Allows programmatic or test injection of call state (e.g. MCP / unit tests / incoming call simulation).
   */
  updateFromExternal(customState) {
    if (!customState || customState.inCall === false) {
      this.externalOverride = null;
      this.state.inCall = false;
      this.state.status = 'idle';
      this.emit('changed', this.getState());
      return;
    }
    const participants = Array.isArray(customState.participants) ? customState.participants : [];
    const count = typeof customState.participantCount === 'number'
      ? customState.participantCount
      : Math.max(participants.length, customState.callType === 'group' ? 3 : 2);

    this.externalOverride = {
      inCall: true,
      status: customState.status || 'connected',
      appId: customState.appId || 'discord',
      appName: customState.appName || 'Discord',
      processName: customState.processName || 'Discord',
      callType: customState.callType || (count > 2 ? 'group' : 'dm'),
      channelName: customState.channelName || (customState.callType === 'group' ? 'Voice Channel' : 'Direct Call'),
      participantCount: count,
      startedAt: customState.startedAt || Date.now(),
      selfMuted: Boolean(customState.selfMuted),
      selfDeafened: Boolean(customState.selfDeafened),
      selfSpeaking: Boolean(customState.selfSpeaking),
      participants
    };
    this.emit('changed', this.getState());
  }

  async poll() {
    if (this.externalOverride) return;
    if (Date.now() < this.dismissedUntil) return;

    try {
      const audio = await sysHelper.getCallAudio();
      if (!audio || audio.error) return;

      const micApps = Array.isArray(audio.activeMicApps) ? audio.activeMicApps : [];
      const windowTitles = audio.windowTitles || {};

      // 1. Check for incoming call window title across any calling app
      let detectedApp = null;
      let isIncoming = false;
      let matchedWinTitle = '';

      for (const [procKey, title] of Object.entries(windowTitles)) {
        if (/\b(incoming\s+call|calling|ringing|whatsapp\s+call)\b/i.test(title)) {
          detectedApp = classifyMicApp(procKey);
          isIncoming = true;
          matchedWinTitle = title;
          break;
        }
      }

      // 2. Check for Discord RPC active voice channel
      if (!detectedApp && this.rpcVoiceChannel && this.rpcVoiceChannel.id) {
        detectedApp = { appId: 'discord', appName: 'Discord', processName: 'Discord' };
      }

      // 3. Check for active voice call window titles for known call apps
      if (!detectedApp) {
        for (const [procKey, title] of Object.entries(windowTitles)) {
          const tLower = title.toLowerCase();
          const pLower = procKey.toLowerCase();
          if (pLower.includes('discord') && (title.startsWith('#') || title.startsWith('@') || tLower.includes('voice connected'))) {
            detectedApp = classifyMicApp(procKey);
            matchedWinTitle = title;
            break;
          } else if (pLower.includes('whatsapp') && tLower.includes('call')) {
            detectedApp = classifyMicApp(procKey);
            matchedWinTitle = title;
            break;
          } else if ((pLower.includes('zoom') || pLower.includes('teams') || pLower.includes('skype')) && (tLower.includes('meeting') || tLower.includes('call'))) {
            detectedApp = classifyMicApp(procKey);
            matchedWinTitle = title;
            break;
          }
        }
      }

      if (!detectedApp) {
        if (this.state.inCall) {
          this.state = {
            ...this.state,
            inCall: false,
            status: 'idle',
            participants: [],
            participantCount: 0,
            startedAt: 0
          };
          this.emit('changed', this.getState());
        }
        return;
      }

      // Proactively connect to Discord RPC if not connected
      if (!this.rpcConnected && (!this.lastRpcTry || Date.now() - this.lastRpcTry > 3000)) {
        this.lastRpcTry = Date.now();
        this.tryConnectDiscordRpc(0);
      }

      const selfDeafened = Boolean(audio.outMuted) || Boolean(this.rpcSelfVoiceSettings.deaf);
      const selfMuted = selfDeafened || Boolean(audio.micMuted) || Boolean(this.rpcSelfVoiceSettings.mute);
      const selfSpeaking = !selfMuted && Number(audio.micPeak) > 0.022;
      const remoteSpeaking = !selfDeafened && Number(audio.outPeak) > 0.028;

      const winTitle =
        matchedWinTitle ||
        windowTitles[detectedApp.processName] ||
        windowTitles.Discord ||
        windowTitles.DiscordPTB ||
        windowTitles.WhatsApp ||
        '';
      const parsedMeta = parseCallMetadataFromWindowTitle(detectedApp.appId, winTitle);

      let callType = parsedMeta.callType;
      let channelName = parsedMeta.channelName;
      let status = (isIncoming || parsedMeta.isIncoming) ? 'ringing' : 'connected';
      let participants = [];
      let participantCount = 2;

      if (detectedApp.appId === 'discord' && this.rpcVoiceChannel && Array.isArray(this.rpcVoiceChannel.voice_states) && this.rpcVoiceChannel.voice_states.length > 0) {
        // Rich Discord RPC Voice Channel State
        const vsList = this.rpcVoiceChannel.voice_states;
        participantCount = vsList.length;
        // Discord channel types: 1 = DM, 3 = Group DM, 2 = Guild Voice
        callType = (this.rpcVoiceChannel.type === 1 || (participantCount <= 2 && this.rpcVoiceChannel.type !== 2)) ? 'dm' : 'group';
        channelName = this.rpcVoiceChannel.name || channelName;

        participants = vsList.slice(0, 4).map((vs) => {
          const u = vs.user || {};
          const vsState = vs.voice_state || {};
          const uid = String(u.id || '');
          const name = String(u.global_name || u.username || vs.nick || 'User');
          const avatarUrl = (uid && u.avatar)
            ? `https://cdn.discordapp.com/avatars/${uid}/${u.avatar}.png?size=64`
            : '';
          const isMuted = Boolean(vsState.mute || vsState.self_mute || vsState.suppress);
          const isDeafened = Boolean(vsState.deaf || vsState.self_deaf);
          const isSpeaking = !isMuted && !isDeafened && this.rpcSpeakingUsers.has(uid);
          return {
            id: uid,
            name,
            avatarUrl,
            isSpeaking,
            isMuted,
            isDeafened,
            isSelf: false
          };
        });
      } else {
        // Zero-Config Synthesized Participant List driven by CoreAudio Peak Meters & Window Metadata
        if (parsedMeta.groupMembers && parsedMeta.groupMembers.length > 1) {
          callType = 'group';
          participantCount = parsedMeta.groupMembers.length + 1;
          participants = [
            {
              id: 'self',
              name: 'You',
              avatarUrl: '',
              color: '#5865F2',
              isSpeaking: selfSpeaking,
              isMuted: selfMuted,
              isDeafened: selfDeafened,
              isSelf: true
            },
            ...parsedMeta.groupMembers.slice(0, 3).map((mName, idx) => ({
              id: `peer_${idx}`,
              name: mName,
              avatarUrl: '',
              color: ['#ec4899', '#10b981', '#f59e0b'][idx % 3],
              isSpeaking: idx === 0 && remoteSpeaking,
              isMuted: false,
              isDeafened: false,
              isSelf: false
            }))
          ];
        } else if (callType === 'group') {
          participantCount = 3;
          participants = [
            {
              id: 'self',
              name: 'You',
              avatarUrl: '',
              color: '#5865F2',
              isSpeaking: selfSpeaking,
              isMuted: selfMuted,
              isDeafened: selfDeafened,
              isSelf: true
            },
            {
              id: 'peer_1',
              name: channelName || 'Channel',
              avatarUrl: '',
              color: '#10b981',
              isSpeaking: remoteSpeaking,
              isMuted: false,
              isDeafened: false,
              isSelf: false
            }
          ];
        } else {
          // 1-on-1 DM Call
          callType = 'dm';
          participantCount = 2;
          const partnerName = (channelName && !['Voice Connected', 'Active Call', 'Direct Call', 'WhatsApp Call'].includes(channelName))
            ? channelName
            : (detectedApp.appName === 'WhatsApp' ? 'Contact' : 'Friend');
          participants = [
            {
              id: 'peer_dm',
              name: partnerName,
              avatarUrl: '',
              color: detectedApp.appId === 'whatsapp' ? '#25D366' : '#ec4899',
              isSpeaking: remoteSpeaking,
              isMuted: false,
              isDeafened: false,
              isSelf: false
            },
            {
              id: 'self',
              name: 'You',
              avatarUrl: '',
              color: '#5865F2',
              isSpeaking: selfSpeaking,
              isMuted: selfMuted,
              isDeafened: selfDeafened,
              isSelf: true
            }
          ];
        }
      }

      const wasInCall = this.state.inCall;
      const startedAt = wasInCall && this.state.startedAt > 0 ? this.state.startedAt : Date.now();

      const nextState = {
        inCall: true,
        status,
        appId: detectedApp.appId,
        appName: detectedApp.appName,
        processName: detectedApp.processName,
        callType,
        channelName,
        participantCount,
        startedAt,
        selfMuted,
        selfDeafened,
        selfSpeaking,
        participants
      };

      const changed = JSON.stringify(nextState) !== JSON.stringify(this.state);
      this.state = nextState;
      if (changed) {
        this.emit('changed', this.getState());
      }
    } catch (err) {
      // Ignore transient polling errors
    }
  }

  async handleAction(action) {
    if (this.externalOverride) {
      if (action === 'toggle-mute') {
        this.externalOverride.selfMuted = !this.externalOverride.selfMuted;
        const selfP = this.externalOverride.participants.find((p) => p.isSelf);
        if (selfP) selfP.isMuted = this.externalOverride.selfMuted;
      } else if (action === 'toggle-deafen') {
        this.externalOverride.selfDeafened = !this.externalOverride.selfDeafened;
        if (this.externalOverride.selfDeafened) {
          this.externalOverride.selfMuted = true;
        }
        const selfP = this.externalOverride.participants.find((p) => p.isSelf);
        if (selfP) {
          selfP.isDeafened = this.externalOverride.selfDeafened;
          selfP.isMuted = this.externalOverride.selfMuted;
        }
      } else if (action === 'leave-call' || action === 'decline-call') {
        this.externalOverride = null;
        this.state.inCall = false;
        this.state.status = 'idle';
      } else if (action === 'answer-call') {
        this.externalOverride.status = 'connected';
      }
      this.emit('changed', this.getState());
      return { ok: true, state: this.getState() };
    }

    if (action === 'toggle-mute') {
      const res = await sysHelper.toggleMicMute();
      const newMute = Boolean(res && res.micMuted);
      this.state.selfMuted = newMute;
      if (this.rpcConnected && this.rpcAuthenticated) {
        this.sendRpcCommand('SET_VOICE_SETTINGS', { mute: newMute });
      }
      await this.poll();
      this.emit('changed', this.getState());
      return { ok: true, state: this.getState() };
    }

    if (action === 'toggle-deafen') {
      const targetDeaf = !this.state.selfDeafened;
      await sysHelper.toggleMute();
      if (targetDeaf) {
        this.preDeafenMicMute = this.state.selfMuted;
        await sysHelper.setMicMute(true);
      } else if (!this.preDeafenMicMute) {
        await sysHelper.setMicMute(false);
      }
      this.state.selfDeafened = targetDeaf;
      this.state.selfMuted = targetDeaf ? true : this.preDeafenMicMute;
      if (this.rpcConnected && this.rpcAuthenticated) {
        this.sendRpcCommand('SET_VOICE_SETTINGS', { deaf: targetDeaf, mute: this.state.selfMuted });
      }
      await this.poll();
      this.emit('changed', this.getState());
      return { ok: true, state: this.getState() };
    }

    if (action === 'focus-app') {
      const proc = this.state.processName || 'Discord';
      await sysHelper.focusProcess(proc);
      return { ok: true };
    }

    if (action === 'answer-call') {
      this.state.status = 'connected';
      const proc = this.state.processName || 'Discord';
      await sysHelper.focusProcess(proc);
      this.emit('changed', this.getState());
      return { ok: true, state: this.getState() };
    }

    if (action === 'leave-call' || action === 'decline-call') {
      if (this.rpcConnected && this.rpcAuthenticated) {
        this.sendRpcCommand('SELECT_VOICE_CHANNEL', { channel_id: null, force: true });
      }
      const proc = this.state.processName || 'Discord';
      await sysHelper.focusProcess(proc);
      // Dismiss incoming ringing alerts for 45s on decline
      this.dismissedUntil = Date.now() + (action === 'decline-call' ? 45000 : 3500);
      this.state = {
        ...this.state,
        inCall: false,
        status: 'idle',
        participants: []
      };
      this.emit('changed', this.getState());
      return { ok: true, state: this.getState() };
    }

    return { ok: false };
  }

  // -------------------------------------------------------------
  // Discord Local IPC (\\.\pipe\discord-ipc-0..9) Protocol Support
  // -------------------------------------------------------------
  tryConnectDiscordRpc(pipeIndex = 0) {
    if (this.rpcSocket || this.rpcConnected) return;
    if (pipeIndex > 9) return;
    const pipePath = `\\\\?\\pipe\\discord-ipc-${pipeIndex}`;
    try {
      const sock = net.createConnection(pipePath, () => {
        this.rpcSocket = sock;
        this.rpcConnected = true;
        // Opcode 0: Handshake
        this.sendRpcFrame(0, { v: 1, client_id: this.clientId });
      });

      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const op = buf.readUInt32LE(0);
          const len = buf.readUInt32LE(4);
          if (buf.length < 8 + len) break;
          const payloadBuf = buf.slice(8, 8 + len);
          buf = buf.slice(8 + len);
          try {
            const msg = JSON.parse(payloadBuf.toString('utf8'));
            this.handleRpcMessage(op, msg);
          } catch {}
        }
      });

      sock.on('error', () => {
        this.disconnectRpc();
        if (pipeIndex < 9) {
          this.tryConnectDiscordRpc(pipeIndex + 1);
        }
      });
      sock.on('close', () => {
        this.disconnectRpc();
      });
      if (sock.unref) sock.unref();
    } catch {
      this.disconnectRpc();
      if (pipeIndex < 9) {
        this.tryConnectDiscordRpc(pipeIndex + 1);
      }
    }
  }

  sendRpcFrame(op, obj) {
    if (!this.rpcSocket || this.rpcSocket.destroyed) return;
    try {
      const json = Buffer.from(JSON.stringify(obj), 'utf8');
      const header = Buffer.alloc(8);
      header.writeUInt32LE(op, 0);
      header.writeUInt32LE(json.length, 4);
      this.rpcSocket.write(Buffer.concat([header, json]));
    } catch {}
  }

  sendRpcCommand(cmd, args = {}, evt = undefined) {
    const payload = {
      cmd,
      args,
      nonce: crypto.randomBytes(8).toString('hex')
    };
    if (evt) payload.evt = evt;
    this.sendRpcFrame(1, payload);
  }

  handleRpcMessage(op, msg) {
    if (!msg) return;
    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      this.sendRpcCommand('GET_VOICE_SETTINGS', {});
      this.sendRpcCommand('GET_SELECTED_VOICE_CHANNEL', {});
      this.sendRpcCommand('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT');
      this.sendRpcCommand('SUBSCRIBE', {}, 'VOICE_SETTINGS_UPDATE');
      if (this.accessToken) {
        this.sendRpcCommand('AUTHENTICATE', { access_token: this.accessToken });
      }
      return;
    }

    if (msg.cmd === 'AUTHENTICATE' && !msg.evt) {
      this.rpcAuthenticated = true;
      this.sendRpcCommand('GET_VOICE_SETTINGS', {});
      this.sendRpcCommand('GET_SELECTED_VOICE_CHANNEL', {});
      this.sendRpcCommand('SUBSCRIBE', {}, 'VOICE_CHANNEL_SELECT');
      this.sendRpcCommand('SUBSCRIBE', {}, 'VOICE_SETTINGS_UPDATE');
      return;
    }

    if ((msg.cmd === 'GET_SELECTED_VOICE_CHANNEL' || msg.evt === 'VOICE_CHANNEL_SELECT') && msg.data) {
      this.rpcVoiceChannel = msg.data.id ? msg.data : null;
      if (this.rpcVoiceChannel && this.rpcVoiceChannel.id && this.rpcAuthenticated) {
        const cid = this.rpcVoiceChannel.id;
        this.sendRpcCommand('SUBSCRIBE', { channel_id: cid }, 'VOICE_STATE_CREATE');
        this.sendRpcCommand('SUBSCRIBE', { channel_id: cid }, 'VOICE_STATE_UPDATE');
        this.sendRpcCommand('SUBSCRIBE', { channel_id: cid }, 'VOICE_STATE_DELETE');
        this.sendRpcCommand('SUBSCRIBE', { channel_id: cid }, 'SPEAKING_START');
        this.sendRpcCommand('SUBSCRIBE', { channel_id: cid }, 'SPEAKING_STOP');
      }
      this.poll();
      return;
    }

    if (msg.evt === 'SPEAKING_START' && msg.data && msg.data.user_id) {
      this.rpcSpeakingUsers.add(String(msg.data.user_id));
      this.poll();
      return;
    }

    if (msg.evt === 'SPEAKING_STOP' && msg.data && msg.data.user_id) {
      this.rpcSpeakingUsers.delete(String(msg.data.user_id));
      this.poll();
      return;
    }

    if ((msg.cmd === 'GET_VOICE_SETTINGS' || msg.evt === 'VOICE_SETTINGS_UPDATE') && msg.data) {
      this.rpcSelfVoiceSettings = {
        mute: Boolean(msg.data.mute),
        deaf: Boolean(msg.data.deaf)
      };
      this.poll();
    }
  }

  disconnectRpc() {
    if (this.rpcSocket) {
      try {
        this.rpcSocket.destroy();
      } catch {}
    }
    this.rpcSocket = null;
    this.rpcConnected = false;
    this.rpcAuthenticated = false;
    this.rpcVoiceChannel = null;
    this.rpcSpeakingUsers.clear();
  }
}

module.exports = CallMonitor;
