// User preferences kept on this computer (localStorage), applied live. The theme lives in
// ui/theme.ts; audio and MIDI devices are saved by the engine.
import { createSignal } from '../lib/reactive';
import { setLang, type Lang } from '../lib/i18n';
import { be } from '../api/backend';
import * as A from './actions';
import { U } from './ui';
import { setFullscreen } from './fullscreen';
import { FORK } from '../fork';

export interface Prefs {
  /** interface language */
  lang: Lang;
  /** interface zoom, 0.8–1.5 */
  uiScale: number;
  /** instrument icons on playlist clips */
  clipIcons: boolean;
  /** play notes while drawing / clicking them in the step sequencer and piano roll */
  noteAudition: boolean;
  /** autosave interval in minutes (0 = off): a saved project is saved to its file, one that
   *  was never saved gets a crash-recovery copy (app/src/recovery.rs) */
  autosaveMin: number;
  /** show the tool hint in the toolbar's hint line */
  hints: boolean;
  /** FL's CPU meter (load + underrun count) in the toolbar's output block, beside the volume; on
   *  by default. The underrun count is always in Settings → Audio. */
  cpuMeter: boolean;
  /** open the app in full screen (F11 toggles it any time) */
  startFullscreen: boolean;
  /** room between the Channel Rack's step buttons (state/pattern.ts RACK_SPACINGS) */
  rackSpacing: 'normal' | 'roomy' | 'wide';
  /** FL's Channel Rack "Auto resize: Minimum height": the rack is as tall as its channels need
   *  (floating, or alone in a bottom dock strip), up to the room there is */
  rackAutoH: boolean;
}

const KEY = 'wave.prefs';
const DEFAULTS: Prefs = { lang: 'en', uiScale: 1, clipIcons: true, noteAudition: true, autosaveMin: 2, hints: true, cpuMeter: true, startFullscreen: false, rackSpacing: 'normal', rackAutoH: true };

function load(): Prefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { ...DEFAULTS, ...v, lang: FORK.polish && v.lang === 'pl' ? 'pl' : 'en', rackSpacing: ['roomy', 'wide'].includes(v.rackSpacing) ? v.rackSpacing : 'normal' }; } catch { return { ...DEFAULTS }; }
}

const [prefs, setPrefsSig] = createSignal<Prefs>(DEFAULTS);
export { prefs };

export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
  const next = { ...prefs(), [k]: v };
  setPrefsSig(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private window */ }
  applyPref(k, next);
}

export function resetPrefs() {
  setPrefsSig({ ...DEFAULTS });
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  for (const k of Object.keys(DEFAULTS) as (keyof Prefs)[]) applyPref(k, DEFAULTS);
}

let timer: ReturnType<typeof setInterval> | null = null;

function applyPref(k: keyof Prefs, p: Prefs) {
  if (k === 'lang') setLang(p.lang);
  if (k === 'uiScale') void applyScale(p.uiScale);
  // switching it on (or off) in Settings shows what it does now, not only at the next start
  if (k === 'startFullscreen') void setFullscreen(p.startFullscreen);
  if (k === 'autosaveMin') {
    if (timer) clearInterval(timer);
    timer = null;
    // the autosave is a recovery snapshot (recovery.rs), saved project or not: it never writes
    // over the project's own file, so the last save stays as the user made it
    if (p.autosaveMin > 0) timer = setInterval(() => {
      if (U.openingProject) return;
      void A.recoveryTick(); // also drops a stale snapshot once nothing is unsaved
    }, p.autosaveMin * 60_000);
  }
}

async function applyScale(z: number) {
  // the webview's own zoom keeps text crisp; a browser (or a refusing webview) falls back to CSS zoom
  if (await be().win?.setZoom(z) === true) return;
  // CSS zoom. 100vh is measured before the zoom, so the app would be z times the window's
  // height and its bottom (the mixer) cut off: --ui-zoom lets the layout divide it back out.
  const st = document.documentElement.style as CSSStyleDeclaration & { zoom: string };
  st.zoom = z === 1 ? '' : String(z);
  if (z === 1) st.removeProperty('--ui-zoom'); else st.setProperty('--ui-zoom', String(z));
}

/** Load and apply saved preferences. Call once at startup. */
export function initPrefs() {
  const p = load();
  setPrefsSig(p);
  setLang(p.lang);
  // full screen needs the window (the backend): main.tsx applies it once that is up
  for (const k of Object.keys(p) as (keyof Prefs)[]) if (k !== 'startFullscreen' && p[k] !== DEFAULTS[k]) applyPref(k, p);
  // autosave is a timer, not a value: it must start at the default interval too (it never ran
  // until the setting was changed once)
  if (p.autosaveMin === DEFAULTS.autosaveMin) applyPref('autosaveMin', p);
}
