'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CallMonitor = require('../src/main/call-monitor');

test('CallMonitor starts in idle state and emits call-change on external update', async () => {
  const cm = new CallMonitor();
  const initial = cm.getState();
  assert.equal(initial.inCall, false);
  assert.equal(initial.status, 'idle');

  let emitted = null;
  cm.on('changed', (state) => {
    emitted = state;
  });

  // 1. DM call with speaking & mute state
  cm.updateFromExternal({
    inCall: true,
    status: 'connected',
    appId: 'discord',
    appName: 'Discord',
    callType: 'dm',
    channelName: 'Alex',
    participantCount: 2,
    selfMuted: false,
    selfDeafened: false,
    selfSpeaking: true,
    participants: [
      { id: '1', name: 'Alex', isSpeaking: true, isMuted: false, isDeafened: false },
      { id: '2', name: 'You', isSpeaking: false, isMuted: true, isDeafened: false }
    ]
  });

  assert.ok(emitted);
  assert.equal(emitted.inCall, true);
  assert.equal(emitted.appId, 'discord');
  assert.equal(emitted.callType, 'dm');
  assert.equal(emitted.channelName, 'Alex');
  assert.equal(emitted.participants.length, 2);
  assert.equal(emitted.participants[0].isSpeaking, true);
  assert.equal(emitted.participants[1].isMuted, true);

  // 2. Group VC call with 4 joined
  cm.updateFromExternal({
    inCall: true,
    status: 'connected',
    appId: 'discord',
    appName: 'Discord',
    callType: 'group',
    channelName: 'Lobby VC',
    participantCount: 4,
    selfMuted: true,
    selfDeafened: true,
    participants: [
      { id: '1', name: 'Alex', isSpeaking: true, isMuted: false, isDeafened: false },
      { id: '2', name: 'Sam', isSpeaking: false, isMuted: true, isDeafened: false },
      { id: '3', name: 'Jordan', isSpeaking: false, isMuted: false, isDeafened: true },
      { id: '4', name: 'You', isSpeaking: false, isMuted: true, isDeafened: true }
    ]
  });

  const groupState = cm.getState();
  assert.equal(groupState.callType, 'group');
  assert.equal(groupState.participantCount, 4);
  assert.equal(groupState.selfDeafened, true);
  assert.equal(groupState.participants.length, 4);
  assert.equal(groupState.participants[2].isDeafened, true);

  // 3. End call
  cm.updateFromExternal({ inCall: false, status: 'idle' });
  assert.equal(cm.getState().inCall, false);
});
