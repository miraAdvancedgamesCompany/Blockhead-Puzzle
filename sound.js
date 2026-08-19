// ═══════════════════════════════════════
//  Sound Manager — BGM-only mute, SFX always on
// ═══════════════════════════════════════
export class SoundManager {
  constructor() {
    this.sounds = {};
    this.bgm = null;
    // BGM starts OFF by default
    this.bgmEnabled = false;
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

  // SFX always plays regardless of bgmEnabled
  play(name) {
    if (!this.sounds[name]) return;
    try {
      const clone = this.sounds[name].cloneNode();
      clone.volume = this.sounds[name].volume || 0.5;
      clone.play().catch(() => {});
    } catch (e) { /* graceful fail */ }
  }

  startBGM() {
    if (!this.bgmEnabled || !this.bgm) return;
    this.bgm.play().catch(() => {});
  }

  stopBGM() {
    if (this.bgm) { this.bgm.pause(); this.bgm.currentTime = 0; }
  }

  resumeBGM() {
    if (!this.bgmEnabled || !this.bgm) return;
    this.bgm.play().catch(() => {});
  }

  pauseBGM() {
    if (this.bgm) this.bgm.pause();
  }

  // Toggle BGM only — returns true if BGM is now ON
  toggleBGM() {
    this.bgmEnabled = !this.bgmEnabled;
    if (this.bgmEnabled) {
      this.startBGM();
    } else {
      if (this.bgm) this.bgm.pause();
    }
    return this.bgmEnabled;
  }

  isBGMEnabled() {
    return this.bgmEnabled;
  }
}

export const sound = new SoundManager();
