// ═══════════════════════════════════════
//  Sound Manager
// ═══════════════════════════════════════
export class SoundManager {
  constructor() {
    this.sounds = {};
    this.bgm = null;
    this.muted = localStorage.getItem('blockhead_muted') === 'true';
    this.bgmPendingStart = false;
  }

  preload() {
    const files = {
      bgm: 'bgm_jazz.mp3',
      pickup: 'sfx_pickup.mp3',
      place: 'sfx_place.mp3',
      pop: 'sfx_pop.mp3',
      combo: 'sfx_combo.MP3',
      snap: 'sfx_snap.mp3',
      coin: 'sfx_coin.MP3',
      powerup: 'sfx_powerup.mp3',
      hammer: 'sfx_hammer.mp3',
      gameover: 'sfx_gameover.mp3',
      click: 'sfx_click.mp3',
      // Multiplayer sounds — reuse existing files with pitch/volume variations
      turn: 'sfx_click.mp3',
      invite: 'sfx_powerup.mp3',
      timerWarn: 'sfx_snap.mp3',
      victory: 'sfx_combo.MP3',
      matchFound: 'sfx_powerup.mp3'
    };

    for (const [key, file] of Object.entries(files)) {
      try {
        const audio = new Audio(file);
        audio.preload = 'auto';
        if (key === 'bgm') {
          audio.loop = true;
          audio.volume = 0.25;
          this.bgm = audio;
        } else if (key === 'turn') {
          audio.volume = 0.7;
        } else if (key === 'timerWarn') {
          audio.volume = 0.6;
        } else if (key === 'victory' || key === 'matchFound') {
          audio.volume = 0.6;
        } else {
          audio.volume = 0.5;
        }
        this.sounds[key] = audio;
      } catch (e) { /* graceful fail */ }
    }
  }

  play(name) {
    if (this.muted || !this.sounds[name]) return;
    try {
      const clone = this.sounds[name].cloneNode();
      clone.volume = this.sounds[name].volume || 0.5;
      clone.play().catch(() => {});
    } catch (e) { /* graceful fail */ }
  }

  startBGM() {
    if (this.muted || !this.bgm) return;
    const p = this.bgm.play();
    if (p) p.catch(() => { this.bgmPendingStart = true; });
  }

  stopBGM() {
    if (this.bgm) { this.bgm.pause(); this.bgm.currentTime = 0; }
    this.bgmPendingStart = false;
  }

  resumeBGM() {
    if (this.muted || !this.bgm) return;
    this.bgm.play().catch(() => {});
  }

  pauseBGM() {
    if (this.bgm) this.bgm.pause();
  }

  tryPendingBGM() {
    if (this.bgmPendingStart && !this.muted && this.bgm) {
      this.bgm.play().catch(() => {});
      this.bgmPendingStart = false;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('blockhead_muted', this.muted);
    if (this.muted) {
      if (this.bgm) this.bgm.pause();
    } else {
      this.startBGM();
    }
    return this.muted;
  }
}

export const sound = new SoundManager();
