/**
 * Module 10 — client-side notification aids: an audible chime and optional
 * desktop notifications. Preferences are per-browser (localStorage) and never
 * leave the device — nothing here talks to the server.
 */

const SOUND_KEY = 'wa.notify.sound';
const BROWSER_KEY = 'wa.notify.browser';

export function getSoundPref() {
  return localStorage.getItem(SOUND_KEY) !== '0';
}

export function setSoundPref(enabled) {
  localStorage.setItem(SOUND_KEY, enabled ? '1' : '0');
}

export function getBrowserPref() {
  return localStorage.getItem(BROWSER_KEY) === '1';
}

export function setBrowserPref(enabled) {
  localStorage.setItem(BROWSER_KEY, enabled ? '1' : '0');
}

let audioContext = null;

/**
 * A short two-tone chime synthesised with the Web Audio API, so the app ships
 * with no audio asset. Browsers require a user gesture before audio can play;
 * by the time a notification arrives the user has already interacted with the
 * page, and any blocked attempt simply stays silent.
 */
export function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioContext = audioContext || new Ctx();
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    const master = audioContext.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    master.connect(audioContext.destination);

    [880, 1320].forEach((frequency, index) => {
      const osc = audioContext.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, now + index * 0.12);
      osc.connect(master);
      osc.start(now + index * 0.12);
      osc.stop(now + 0.55);
    });
  } catch {
    /* audio is best-effort */
  }
}

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Asks the browser for permission; only ever called from a user click. */
export async function requestBrowserPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function showDesktopNotification(title, body, onActivate) {
  if (!browserNotificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, { body, tag: 'wa-module10' });
    notification.onclick = () => {
      window.focus();
      onActivate?.();
      notification.close();
    };
  } catch {
    /* ignored */
  }
}
