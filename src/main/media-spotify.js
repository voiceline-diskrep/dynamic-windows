'use strict';
/**
 * Dynamic Windows - Media & Spotify Controller
 * Provides media key emulation and playback state detection.
 */

const { exec } = require('child_process');

class MediaController {
  constructor() {
    this.isPlaying = false;
    this.currentTrack = {
      title: 'Spotify / Windows Media',
      artist: 'Ready for playback',
      album: ''
    };
  }

  sendMediaKey(vkCode) {
    // 0xB3 = VK_MEDIA_PLAY_PAUSE, 0xB0 = VK_MEDIA_NEXT_TRACK, 0xB1 = VK_MEDIA_PREV_TRACK
    const ps = `
      $sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);'
      $type = Add-Type -MemberDefinition $sig -Name MediaKeybd -Namespace Win32Key -PassThru
      $type::keybd_event(${vkCode}, 0, 0, 0)
      $type::keybd_event(${vkCode}, 0, 2, 0)
    `;
    exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, (err) => {
      if (err) console.error('Media key error:', err.message);
    });
  }

  playPause() {
    this.isPlaying = !this.isPlaying;
    this.sendMediaKey(0xB3);
    return this.isPlaying;
  }

  nextTrack() {
    this.sendMediaKey(0xB0);
  }

  prevTrack() {
    this.sendMediaKey(0xB1);
  }

  getState() {
    return {
      isPlaying: this.isPlaying,
      track: this.currentTrack
    };
  }
}

module.exports = MediaController;
