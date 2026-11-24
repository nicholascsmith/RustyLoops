// The Piano roll (F7), as in FL Studio: a floating window, or a panel docked under the Playlist, that edits the selected channel's
// notes in the current pattern — every channel, drums included (built-in drums and samplers
// follow the key). The pattern's other channels show as ghost notes; double right-click one to
// switch to its channel. Drawing past the end makes the pattern longer (its length follows the
// notes). Every edit is an op and one undo step.
import { createMemo, For, Show, untrack } from 'solid-js';
import { createSignal, effect, onCleanup, onMount, watch } from '../lib/reactive';
import { be } from '../api/backend';
import type { Id, Note } from '../api/types';
import { prefs } from '../state/prefs';
import { t, type TranslationKey } from '../lib/i18n';
import { zoomAround, type ZRange } from '../lib/zoomBar';
import { ZoomScrollbar } from '../ui/ZoomScrollbar';
import { drawRuler, rulerCursor, rulerDown, RULER_H, type RulerHost } from '../ui/timeRuler';
import { clipOfPattern, patBeatAt, songBeatIn } from '../lib/patLoop';
import { rgba, T, themeVersion } from '../ui/theme';
import { curBeat } from '../state/telemetry';
import { clamp, panText } from '../lib/format';
import { autoRollSnap, duplicateRight, keyOf, noteAt, noteWidth, notesText, ROLL_SNAPS, ROLL_SNAPS_TRIPLET, rollSnapName, scaleMask, stepsOf, transpose, velOf } from '../lib/pattern';
import { noteName } from '../lib/pitch';

/** The project key/scale as a setKey op (the roll header's key selectors commit it). */
import {
  applyProps, fitRange, fmtLen, fmtStart, followPage, invertSelection, legato, MAX_STEP, nudgeNotes, nudgeVelocity, panLine, pasteStart, velocityLine,
  parseKey, parseLen, parseStart, quantizeStarts, readProps, wheelNotches,
} from '../lib/rollEdit';
import { commit, Gesture, wheelEdit } from '../state/edit';
import { audition, chanKindLabel, channels, closeRoll, curPat, moveNotesToNewPattern, patFrom, patLoopOf, patMode, patPlayhead, patStartOf, putNotes, rollFront, selChan,
  selectChannel, setPatLoop, setPatStart, toggleRollMax,
} from '../state/pattern';
import { arrVersion, rawOf, S } from '../state/store';
import { openMenu, say, setU, U } from '../state/ui';
import { GridChip, ToolSeg, type ChipOption } from '../ui/EditorBar';
import { Knob } from '../ui/Knob';
import { LANE_ICONS, LaneSwitch } from '../ui/LaneSwitch';
import { selectionSpan, vocalsUnder } from '../lib/melody';
import { fmtPos } from '../lib/format';
import { openPitchEditor, seekSong, switchMode } from '../state/actions';
import { dblCheck, edgeScroller, panDrag, track, trackFrame } from '../ui/drag';
import { WindowBoundary } from '../ui/PanelBoundary';
import { typingHeld } from '../state/typingKeys';
import { noteClip, setNoteClip } from '../state/noteClipboard';
import { addFrameTask, fitCanvas, fonts, Layer } from '../ui/frameLoop';
import { Icon } from '../ui/icons';
import { drawRollLane, drawRoll, rollX, rollY, type RollGeo } from './patternDraw';
import { noteEndNear, onNoteEdge } from './roll/edge';
import { patGeom, PatternChip, useDataVersion, useSize } from './patternShared';
import { KeyBadge } from './KeyBadge';
import { songKey } from '../state/songKey';
import { PanelFrame, WinControls } from './PanelFrame';
import { paneDock } from '../state/docking';
import { KW, type RollCtx, type RollPtr, type Tool } from './roll/types';
import { rollDown, rollMove } from './roll/grid';
import { buildTransformOp, TOOL_META, type ToolId } from './roll/noteTools';
import type { TransformVerb } from '../api/types';
import { STAMP_INVS, STAMP_TYPES } from './roll/stamp';
import { FORK } from '../fork';

const LANE_H = 92;
/** Below this much room for the grid and the velocity lane together, the lane hides so the notes keep the space (Alt+wheel still sets velocity). */
const LANE_SHOW_AT = 300;
/** Steps past the pattern's end the roll lets you scroll to and draw in (the pattern grows). */
const ROOM = 64;
/** Key height (px): default (about FL's density) and the vertical zoom's limits. */
const ROW_H = 18, ROW_MIN = 6, ROW_MAX = 40;
/** Time zoom limits, relative to the fit-the-pattern width. */
const Z_MIN = 0.5, Z_MAX = 8;
const ROLL_ICON = 'M4 4h16v16H4z M4 9h16 M4 14h16 M9 4v5 M15 14v6';
const TOOLS: { id: Tool; key: string; label: Parameters<typeof t>[0]; icon: string; tip: Parameters<typeof t>[0] }[] = [
  { id: 'draw', key: 'p', label: 'b.pe.tool.draw', icon: 'M4 20l4.5-1L19 8.5 15.5 5 5 15.5z M13.5 7l3.5 3.5', tip: 'b.pe.tool.draw.tip' },
  { id: 'paint', key: 'b', label: 'b.pe.tool.paint', icon: 'M18 3l3 3-9 9-3-3z M9 12c-3 0-4 2-4 4s-1 3-2 4c4 0 8-1 8-5', tip: 'b.pe.tool.paint.tip' },
  { id: 'erase', key: 'd', label: 'b.pe.tool.erase', icon: 'M8 20h12 M4.5 15.5L14 6l5 5-7.5 7.5H8z', tip: 'b.pe.tool.erase.tip' },
  { id: 'select', key: 'e', label: 'b.pe.tool.select', icon: 'M4 4h4 M12 4h4 M20 4v4 M20 12v4 M20 20h-4 M12 20H8 M4 20v-4 M4 12V8', tip: 'b.pe.tool.select.tip' },
  { id: 'stamp', key: 'c', label: 'b.pe.tool.stamp', icon: 'M5 14h3v6H5z M10.5 11h3v9h-3z M16 8h3v12h-3z', tip: 'b.pe.tool.stamp.tip' },
];

/** The Piano roll window (shown while `U.rollWin` is set and there is a pattern and a channel). `docked`: laid out under the Playlist. */
export function PianoRoll(props: { z: number; docked?: boolean }) {
  // a failure of the window itself (its title bar, its body) keeps a frame that moves and closes
  return (
    <Show when={U.rollWin && curPat() && selChan()}>
      <WindowBoundary name={t('a.mn.roll')} class="patwin rollwin" docked={props.docked} z={props.z} front={rollFront} close={closeRoll}
        closeTip={t(props.docked ? 'b.dk.closeRoll' : 'b.pe.close')} geom={() => U.rollWin} move={(x, y) => patGeom('rollWin').setGeom({ x, y })}>
        <Roll z={props.z} docked={props.docked} />
      </WindowBoundary>
    </Show>
  );
}

const [lastLen, setLastLenRaw] = createSignal(2);
/** The last touched note was a Channel Rack step: new notes are steps (triggers) too (FL). */
const [lastTrig, setLastTrig] = createSignal(false);
const setLastLen = (len: number, trig = false) => { setLastLenRaw(len); setLastTrig(trig); };
/** Velocity of the last note touched: new notes take it, like the length (FL). 1 = full, stored as none. */
const [lastVel, setLastVel] = createSignal(1);
const [rollTool, setRollTool] = createSignal<Tool>('draw');
/** FL's slide toggle (S): notes drawn while it is on are slide notes. */
const [slideMode, setSlideMode] = createSignal(false);
/** FL's slide icon: a ramp triangle. */
const SLIDE_ICON = 'M4 19h16V6z';
/** The stamp picker: chord type and inversion for the stamp tool (a click writes the
 * chord rooted at the clicked key). */
const [stampType, setStampType] = createSignal('min');
const [stampInv, setStampInv] = createSignal(0);
const [rollSnap, setRollSnap] = createSignal(1);

/** Key and scale to highlight: the song's key (state/songKey.ts; C in the project scale when none is known). */
function projectKey(): { root: number; scale: number } {
  const k = songKey();
  return { root: k.root, scale: k.scale };
}

function Roll(props: { z: number; docked?: boolean }) {
  let wrap!: HTMLDivElement, cv!: HTMLCanvasElement, phead!: HTMLDivElement, laneCv!: HTMLCanvasElement, laneWrap!: HTMLDivElement;
  let rulerCv!: HTMLCanvasElement, phRuler!: HTMLDivElement;
  // memos: every read was a find() through the store (thousands per redraw of a big pattern)
  const ptM = createMemo(() => curPat()!), chM = createMemo(() => selChan()!);
  const pt = () => ptM(), ch = () => chM();
  /** The notes as plain data (canvas drawing and hit tests; redraws follow `data`/`arrVersion`). */
  const notesRaw = () => rawOf(pt()).notes;
  const size = useSize(() => wrap);
  const laneSize = useSize(() => laneWrap);
  // grid + lane together stay the same height whether the lane shows or not, so this does not flip back and forth
  const [laneOn, setLaneOn] = createSignal(true);
  /** What the lane under the grid edits (FL's event editor target): the notes' velocity or their own pan. */
  const [laneMode, setLaneMode] = createSignal<'vel' | 'pan'>('vel');
  effect(() => { const h = size().h; if (h > 0) setLaneOn(h + (untrack(laneOn) ? LANE_H : 0) >= LANE_SHOW_AT); });
  const data = useDataVersion();
  const layer = new Layer();
  const [sel, setSel] = createSignal<Set<number>>(new Set());
  const [hoverKey, setHoverKey] = createSignal<number | null>(null);
  const [marq, setMarq] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The chord name under the pointer (status bar): every note of the channel at the hovered note's step. */
  const [hoverChord, setHoverChord] = createSignal('');
  /** The stamp tool's ghost: what a click at the hovered cell would write, drawn in the grid. */
  const [stampGhost, setStampGhost] = createSignal<{ s: number; len: number; pitches: number[] } | null>(null);
  const [zbox, setZbox] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** The note properties popover (double-click a note): the notes it edits, the clicked one last. */
  const [propsFor, setPropsFor] = createSignal<number[] | null>(null);
  const [view, setViewS] = createSignal({ sx: 0, sy: 0, zoom: 1, rowH: ROW_H });
  const pk = createMemo(projectKey, { equals: (a, b) => a.root === b.root && a.scale === b.scale });
  // the note tools strip: verb + its declared fields (meaning per verb) + an optional seed
  const [toolId, setToolId] = createSignal<ToolId>('humanize');
  const [vals, setVals] = createSignal<unknown[]>(TOOL_META.humanize.fields.map(f => f.def));
  const setField = (i: number, v: unknown) => setVals(xs => { const c = xs.slice(); c[i] = v; return c; });
  const [toolSeed, setToolSeed] = createSignal('');
  // the note tools (humanize, strum, ...) live in a popover: used now and then, they do not hold toolbar space
  const [pop, setPop] = createSignal<'tools' | null>(null);
  const toolsOpen = () => pop() === 'tools', setToolsOpen = (f: boolean | ((v: boolean) => boolean)) => setPop((typeof f === 'function' ? f(toolsOpen()) : f) ? 'tools' : null);
  let toolMenu!: HTMLDivElement;
  effect(() => {
    const open = pop(); if (!open) return;
    const away = (e: PointerEvent) => { if (!toolMenu.contains(e.target as Node)) setPop(null); };
    document.addEventListener('pointerdown', away, true);
    onCleanup(() => document.removeEventListener('pointerdown', away, true));
  });
  const applyTool = () => {
    const op = buildTransformOp(toolId(), vals(), toolSeed(), pt().id, pt().len, ch().id, sel());
    commit([op], t(TOOL_META[toolId()].label));
    setSel(new Set<number>());
    say(t('b.pr.toolApplied', { verb: t(TOOL_META[toolId()].label) }));
  };
  const root = () => pk().root;
  const scaleIdx = () => pk().scale;
  const chansMap = createMemo(() => { arrVersion(); return new Map(rawOf(channels()).map(c => [c.id, c])); });
  const mask = () => scaleMask(scaleIdx());
  /** A tool field's name without its "(0..1)" range note: the slider shows the range. */
  const shortLabel = (l: string) => l.replace(/\s*\(.*\)\s*$/, '');
  const numText = (v: number, step: number) => v.toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
  /** The grid in steps: the chosen one, or (auto) the finest that is still comfortably wide at this zoom. */
  const snapNow = () => (rollSnap() < 0 ? autoRollSnap(geo().pps) : rollSnap());
  /** After a pick in a toolbar list the keyboard goes back to the roll (arrows transpose, Delete deletes) instead of staying in the list. */
  const backToRoll = (el: HTMLElement) => el.closest<HTMLElement>('.win')?.focus({ preventScroll: true });
  /** Width of the note grid (px). */
  const gridW = () => Math.max(1, size().w - KW);
  // The length the view was fitted to: taken when a pattern is shown, NOT while it grows. A
  // note dragged past the end makes the pattern longer; a scale that followed the length
  // would shrink under the pointer and the note would jump back and forth.
  const [fitSteps, setFitSteps] = createSignal(stepsOf(pt()));
  // (a memo of the id: every note edit replaces the pattern object, only another pattern changes the id)
  const patId = createMemo(() => pt().id);
  watch(patId, () => setFitSteps(stepsOf(untrack(pt))));
  /** Px per step at zoom 1: the pattern as it was opened fits the window (within sensible limits). */
  const basePps = () => clamp(gridW() / fitSteps(), 6, 48);
  /** Smallest key height: never so small that the 128 keys leave the grid half empty. */
  const rowMin = () => Math.max(ROW_MIN, size().h / 128);
  const geo = (): RollGeo => {
    const steps = stepsOf(pt());
    return { pps: basePps() * view().zoom, sx: view().sx, sy: view().sy, rowH: Math.max(view().rowH, rowMin()), kw: KW, steps };
  };
  /** Steps the view scrolls over: the pattern plus room to draw on (the pattern grows to fit). */
  const hTotal = () => Math.min(MAX_STEP, stepsOf(pt()) + ROOM);
  const maxSxAt = (pps: number) => Math.max(0, hTotal() * pps - gridW());
  const maxSx = () => maxSxAt(geo().pps);
  /** Zoom-out limit: half the fitted width, or further when that is needed to see all the steps the view scrolls over (pattern + room). */
  const zMin = () => Math.min(Z_MIN, gridW() / hTotal() / basePps());
  const maxSyAt = (rowH: number) => Math.max(0, 128 * rowH - size().h);
  // the zoom scrollbars, in steps (time) and keys from the top (key height)
  const hRange = (): ZRange => { const G = geo(); return { pos: G.sx / G.pps, len: gridW() / G.pps }; };
  const hLimits = () => ({ total: hTotal(), minLen: gridW() / (basePps() * Z_MAX), maxLen: gridW() / (basePps() * zMin()) });
  const applyH = (r: ZRange) => {
    userScrolled(); // every user zoom of the time axis goes through here (scrollbar, PageUp/Down, presets, fit, zoom box)
    const zoom = clamp(gridW() / r.len / basePps(), zMin(), Z_MAX), pps = basePps() * zoom;
    setViewS(v => ({ ...v, zoom, sx: clamp(r.pos * pps, 0, maxSxAt(pps)) }));
  };
  // Follow the playhead (the app-wide Follow toggle): the frame task flips the view a page when
  // the playhead leaves it. Moving the view by hand while it plays pauses that until the
  // pattern comes round again (no tug of war); nothing follows during a drag.
  let playingNow = false, followHold = false, dragging = false, lastBeat = -1;
  const userScrolled = () => {
    if (!playingNow || !U.follow || followHold) return;
    followHold = true; say(t('b.pr.followPaused'));
  };
  /** The time scrollbar (scrolls or zooms by hand). */
  const setH = (r: ZRange) => applyH(r);
  const vRange = (): ZRange => { const G = geo(), h = Math.max(1, size().h); return { pos: G.sy / G.rowH, len: h / G.rowH }; };
  const vLimits = () => { const h = Math.max(1, size().h); return { total: 128, minLen: h / ROW_MAX, maxLen: h / rowMin() }; };
  const setV = (r: ZRange) => {
    const rowH = clamp(Math.max(1, size().h) / r.len, rowMin(), ROW_MAX);
    setViewS(v => ({ ...v, rowH, sy: clamp(r.pos * rowH, 0, maxSyAt(rowH)) }));
  };
  const chanNotes = createMemo(() => {
    arrVersion();
    const p = rawOf(pt()), id = ch().id;
    return p.notes.map((n, i) => ({ n, i })).filter(x => x.n.ch === id);
  });
  // keep the selection valid when the notes change underneath (undo, CLI)
  effect(() => { const ok = new Set(chanNotes().map(x => x.i)); const s = sel(); if ([...s].some(i => !ok.has(i))) setSel(new Set([...s].filter(i => ok.has(i)))); });
  // the popover's notes gone (undo, another channel): it closes rather than edit other notes
  effect(() => { const p = propsFor(); if (!p) return; const ok = new Set(chanNotes().map(x => x.i)); if (p.some(i => !ok.has(i))) setPropsFor(null); });
  // another pattern: the selection is note indices of the old one, they would point at random notes
  watch(patId, () => { setSel(new Set<number>()); setPropsFor(null); }, { defer: true });
  // initial vertical position: centred on the channel's notes (or its root)
  let centred = -1;
  effect(() => {
    const h = size().h, id = ch()?.id; if (!h || centred === id) return;
    centred = id;
    const ks = chanNotes().map(x => keyOf(x.n, ch()));
    const mid = ks.length ? (Math.min(...ks) + Math.max(...ks)) / 2 : ch().root;
    setViewS(v => { const rh = Math.max(v.rowH, rowMin()); return { ...v, sy: clamp((127 - mid) * rh - h / 2, 0, maxSyAt(rh)) }; });
    setSel(new Set<number>());
  });
  // Drawing runs at most once per frame: a touchpad sends several wheel / pointer events per
  // frame and each one redrew the whole roll synchronously.
  const drawMain = () => {
    const { w, h } = size(); if (!w || !h) return;
    fitCanvas(cv, w, h);
    const g = cv.getContext('2d')!, dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lit = typingHeld();
    drawRoll(g, w, h, geo(), layer, { pt: rawOf(pt()), ch: rawOf(ch()), chans: chansMap(), sel: sel(), root: root(), mask: mask(), grid: snapNow(), hoverKey: hoverKey(), lit, marquee: marq(), zoomBox: zbox(), stampGhost: stampGhost() });
  };
  const drawVel = () => {
    const { w, h } = laneSize(); if (!w || !h) return;
    fitCanvas(laneCv, w, h);
    const g = laneCv.getContext('2d')!, dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const G = geo();
    drawRollLane(g, w, h, { x0: KW, pps: G.pps, sx: G.sx, steps: G.steps, notes: chanNotes().filter(x => !x.n.slide), sel: sel(), muted: ch().mute, mode: lane() }); // a slide note has no level or pan of its own
  };
  let rafMain = 0, rafVel = 0;
  effect(() => {
    data(); sel(); hoverKey(); marq(); zbox(); root(); mask(); rollSnap(); void fonts.epoch; size(); view(); typingHeld(); ch(); pt().len; stampGhost();
    if (U.mixView) return; // repainted on the way back from the Mix view
    if (!rafMain) rafMain = requestAnimationFrame(() => { rafMain = 0; untrack(drawMain); });
  });
  // the ghost belongs to the stamp tool: gone the moment another tool is picked
  effect(() => { if (rollTool() !== 'stamp') setStampGhost(null); });
  effect(() => {
    data(); sel(); lane(); laneSize(); view(); size(); ch(); pt().len;
    if (U.mixView) return;
    if (!rafVel) rafVel = requestAnimationFrame(() => { rafVel = 0; untrack(drawVel); });
  });
  onCleanup(() => { cancelAnimationFrame(rafMain); cancelAnimationFrame(rafVel); });
  onMount(() => onCleanup(addFrameTask(() => {
    const p = curPat(); if (!p || !phead || !U.rollWin || U.mixView) return;
    const b = patPlayhead(p);
    if (b < 0) { phead.style.opacity = phRuler.style.opacity = '0'; playingNow = false; followHold = false; lastBeat = -1; return; }
    playingNow = true;
    if (b + 1e-6 < lastBeat) followHold = false; // the pattern came round: a new pass
    lastBeat = b;
    // follow: a store write only when the view flips a page
    if (U.follow && !followHold && !dragging) {
      const to = followPage(b * 4, hRange(), 2);
      if (to != null) { const sx = clamp(to * geo().pps, 0, maxSx()); if (Math.abs(sx - view().sx) > 0.5) setViewS(v => ({ ...v, sx })); }
    }
    const x = rollX(geo(), b * 4);
    phead.style.opacity = phRuler.style.opacity = x >= KW ? '0.85' : '0';
    phead.style.transform = `translateX(${Math.round(x)}px)`;
    phRuler.style.transform = `translateX(${Math.round(x) - KW}px)`;
  })));
  onMount(() => {
    const up = () => { dragging = false; };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    onCleanup(() => { window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); });
  });
  /** Where the pointer last was over the grid (canvas px), for zooming around it; null = outside. */
  let ptr: { x: number; y: number } | null = null;
  /** The grid's box on screen (the keyboard excluded): auto-scroll zones of the drags. */
  const gridRect = () => { const r = cv.getBoundingClientRect(); return { left: r.left + KW, top: r.top, right: r.right, bottom: r.bottom }; };
  /** Scroll by (dx, dy) px; false when the view cannot move any further that way. */
  const scrollBy = (dx: number, dy: number) => {
    const v = view(), rh = geo().rowH;
    const sx = clamp(v.sx + dx, 0, maxSx()), sy = clamp(v.sy + dy, 0, maxSyAt(rh));
    if (Math.abs(sx - v.sx) < 0.01 && Math.abs(sy - v.sy) < 0.01) return false;
    if (sx !== v.sx) userScrolled();
    setViewS({ ...v, sx, sy });
    return true;
  };
  /** Middle-button pan (both axes on the grid). */
  const pan = (e: PointerEvent, yToo = true) => panDrag(e, () => ({ x: view().sx, y: view().sy }), (x, y) => {
    const sx = clamp(x, 0, maxSx()), sy = yToo ? clamp(y, 0, maxSyAt(geo().rowH)) : view().sy;
    if (sx !== view().sx) userScrolled();
    setViewS(v => ({ ...v, sx, sy }));
  });

  // ---- the time ruler (ui/timeRuler, as in the Playlist), in beats of the pattern. Click = where
  // playback starts: in SONG mode with the pattern in the playlist the song jumps to that beat of
  // it, else the pattern loop starts there (PAT mode). Drag = the part of the pattern its loop
  // plays (PAT mode); double-click = all of it again. Not edits: nothing to undo.
  /** The playlist clip of this pattern a click goes to in SONG mode (null: the pattern loop instead). */
  const songClip = () => (patMode() || U.patPlaying ? null : clipOfPattern(S.project.clips, pt().id, U.playing ? curBeat() : U.start));
  const rollSeek = (b: number) => {
    const p = pt(), c = songClip(), at = U.playing ? curBeat() : U.start;
    const s = c ? songBeatIn(c, p.len, b, at) : null;
    if (s != null) { seekSong(s); return; }
    setPatStart(p.id, b);
    if (!patMode()) switchMode(true); // not in the song (or not that beat of it): the pattern loop plays it
    say(t('b.pr.startAt', { pos: fmtPos(b) }));
  };
  const ruler: RulerHost = {
    beatAt: x => (x - rulerCv.getBoundingClientRect().left + geo().sx) / geo().pps / 4,
    bw: () => geo().pps * 4,
    unit: alt => (alt ? 0 : snapNow() / 4),
    max: () => pt().len,
    loop: () => patLoopOf(pt().id),
    edit: () => ({ set: r => setPatLoop(pt().id, r), end: () => {} }),
    clear: () => { setPatLoop(pt().id, null); say(t('b.pr.loopAll')); },
    seek: rollSeek,
    drawn: r => {
      setPatStart(pt().id, r.a);
      if (!patMode()) switchMode(true);
      say(t('b.pr.loopSet', { a: fmtPos(r.a), b: fmtPos(r.b) }));
    },
    track: (m, u, c) => { dragging = true; track(m, ev => { dragging = false; u(ev); }, c); },
    key: 'rollRuler' + props.z,
  };
  /** The start marker: the song's in SONG mode (where this pattern plays at it), else the loop's. */
  const rulerStart = () => {
    const p = pt(), c = songClip();
    return c ? patBeatAt(c, p.len, U.start) : patFrom(p);
  };
  const drawRulerNow = () => {
    const W = gridW(); if (!rulerCv || W <= 1) return;
    fitCanvas(rulerCv, W, RULER_H);
    const g = rulerCv.getContext('2d')!, dpr = window.devicePixelRatio || 1, G = geo();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRuler(g, G.sx, W, G.pps * 4, patLoopOf(pt().id), rulerStart());
    // past the pattern's end: room to draw in, not part of the pattern yet
    const xe = pt().len * 4 * G.pps - G.sx;
    if (xe < W) { g.fillStyle = rgba(T.viz, 0.55); g.fillRect(Math.max(0, xe), 0, W - Math.max(0, xe), RULER_H - 1); }
  };
  let rafRuler = 0;
  effect(() => {
    view(); size(); pt().len; pt().id; patLoopOf(pt().id); patStartOf(pt().id); rulerStart(); themeVersion(); void fonts.epoch;
    if (!rafRuler) rafRuler = requestAnimationFrame(() => { rafRuler = 0; untrack(drawRulerNow); });
  });
  onCleanup(() => cancelAnimationFrame(rafRuler));
  // ---- the overview bar on top (as in the Playlist): the pattern's notes under the view's thumb
  const paintOverview = (g: CanvasRenderingContext2D, W: number, H: number, span: number) => {
    const ns = notesRaw(), id = ch().id, m = chansMap();
    if (!ns.length) return;
    let lo = 127, hi = 0;
    for (const n of ns) { const k = keyOf(n, m.get(n.ch)); lo = Math.min(lo, k); hi = Math.max(hi, k); }
    lo -= 2; hi += 2;
    const rh = Math.max(1, (H - 4) / (hi - lo + 1)), xs = W / span;
    // the pattern's end
    const xe = stepsOf(pt()) * xs;
    if (xe < W) { g.fillStyle = rgba(T.viz, 0.45); g.fillRect(xe, 0, W - xe, H); }
    for (const own of [false, true]) {
      g.fillStyle = own ? ch().color : rgba(T.fg4, 0.5);
      g.globalAlpha = own ? 0.9 : 1;
      for (const n of ns) {
        if ((n.ch === id) !== own) continue;
        const k = keyOf(n, m.get(n.ch));
        g.fillRect(n.step * xs, 2 + (hi - k) * rh, Math.max(1, n.len * xs - 0.5), Math.max(1, rh));
      }
    }
    g.globalAlpha = 1;
  };

  const pos = (e: PointerEvent | MouseEvent | WheelEvent) => {
    const r = cv.getBoundingClientRect(), G = geo();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return { x, y, step: (x - KW + G.sx) / G.pps, key: clamp(127 - Math.floor((y + G.sy) / G.rowH), 0, 127) };
  };
  const hitNote = (step: number, key: number) => noteAt(notesRaw(), ch().id, rawOf(ch()), step, key, geo().pps);
  /** Index of another channel's note (a ghost) under (step, key), or −1. */
  const ghostAt = (step: number, key: number) => {
    const ns = notesRaw(), m = chansMap();
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]; if (n.ch === ch().id) continue;
      if (keyOf(n, m.get(n.ch)) === key && step >= n.step - 1e-3 && step < n.step + noteWidth(n, geo().pps) / geo().pps) return i;
    }
    return -1;
  };
  const edgeHit = (i: number, x: number) => { const n = notesRaw()[i], G = geo(); return onNoteEdge(x, rollX(G, n.step), noteWidth(n, G.pps)); };
  const edgeAfter = (key: number, x: number) => { const G = geo(); return noteEndNear(notesRaw(), ch().id, rawOf(ch()), key, x, s => rollX(G, s), G.pps); };
  const commitNotes = (notes: Note[], label: string) => commit([putNotes(pt(), notes)], label);

  /** Views to go back to (Ctrl+right-click), newest last. */
  const viewBack: ReturnType<typeof view>[] = [];
  const pushView = () => { viewBack.push({ ...view() }); if (viewBack.length > 32) viewBack.shift(); };
  /** Time zoom to `len` visible steps around the pointer (or the view's centre when the pointer is not over the grid). */
  const zoomTimeTo = (len: number) => {
    const r = hRange(), G = geo();
    const at = ptr && ptr.x >= KW ? (ptr.x - KW + G.sx) / G.pps : r.pos + r.len / 2;
    applyH(zoomAround(r, hLimits(), at, len / r.len));
    const bars = hRange().len / 16;
    say(t('b.pr.zoomBars', { n: bars >= 10 ? Math.round(bars) : +bars.toFixed(bars < 1 ? 2 : 1) }));
  };
  // ---- the pointer tools (roll/): everything below feeds the tool layer's view of this roll,
  // then the canvas handlers become two thin calls. The tools and gestures themselves never
  // touch a DOM event — roll/types.ts has the contract, roll/grid.ts the dispatch order.
  const modsOf = (ev: PointerEvent | KeyboardEvent) => ({ alt: ev.altKey, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey });
  // The note under the mouse, held (FL): a pad or a slow attack is heard for as long as the button is down.
  // While recording, a held key would be written into the take, so it falls back to the short audition.
  let held: { ch: Id; key: number } | null = null;
  const holdNote = (key: number | null, vel = 1) => {
    if (held) { const h = held; held = null; be().typingNote({ ch: h.ch, key: h.key, on: false }).catch(() => {}); }
    if (key == null || !prefs().noteAudition) return;
    if (S.transport.rec) { audition(ch().id, key, vel); return; }
    held = { ch: ch().id, key };
    const mine = held;
    be().typingNote({ ch: ch().id, key, vel, on: true }).catch(err => { if (held === mine) held = null; console.warn(err); });
  };
  // the button can be let go over another app (Alt+Tab mid-drag): no pointerup arrives here, so let go on blur
  const dropHeld = () => holdNote(null);
  window.addEventListener('blur', dropHeld);
  onCleanup(() => { window.removeEventListener('blur', dropHeld); holdNote(null); });
  const ctx: RollCtx = {
    pt: () => pt(), ch: () => rawOf(ch()), notes: notesRaw, chanNotes: () => chanNotes(), chans: chansMap,
    geo, snap: () => snapNow(),
    hit: hitNote, edgeHit, edgeAfter, ghostAt,
    tool: () => rollTool(),
    sel: () => sel(), setSel,
    lastLen: () => lastLen(), lastTrig: () => lastTrig(), setLastLen,
    lastVel: () => lastVel(), setLastVel,
    slideMode: () => slideMode() && slidePlays(),
    commitNotes,
    notesOp: notes => putNotes(pt(), [...notes]),
    gest: label => new Gesture(label),
    audition: (key, vel) => audition(ch().id, key, vel),
    hold: holdNote,
    typingNote: (on, key, vel) => {
      if (on) be().typingNote({ ch: ch().id, key, vel, on: true }).catch(err => say(t('b.pk.fail', { err: String(err) })));
      else be().typingNote({ ch: ch().id, key, on: false }).catch(() => {});
    },
    say,
    setMarq, setZoomBox: setZbox, setStampGhost, stampGhost: () => stampGhost(), setHoverChord, setHoverKey,
    propsOpen: () => !!propsFor(), closeProps: () => setPropsFor(null), openProps: idx => setPropsFor(idx),
    stamp: () => ({ type: stampType(), inv: stampInv() }),
    keyScale: () => pk(),
    switchChannel: id => { selectChannel(id); say(t('b.pr.switched', { name: channels().find(c => c.id === id)?.name ?? '' })); },
    zoomTo: (s0, s1, r0, r1) => {
      applyH(fitRange(Math.max(0, s0), Math.max(0, s1), hLimits()));
      setV(fitRange(clamp(r0, 0, 128), clamp(r1, 0, 128), vLimits()));
    },
    pushView, popView: () => viewBack.pop(), applyView: v => { if (v.sx !== view().sx || v.zoom !== view().zoom) userScrolled(); setViewS(v); },
    dbl: key => dblCheck(key),
    pan: e => (e ? pan(e) : false),
    setDragging: on => { dragging = on; },
    beginDrag: (o, move, up) => (o.frame ? trackFrame : track)(ev => move({ ...modsOf(ev), p: pos(ev), raw: ev }), ev => up({ ...modsOf(ev), p: pos(ev), raw: ev }), o.cursor),
    bindMods: cb => {
      const h = (ke: KeyboardEvent) => cb(modsOf(ke));
      window.addEventListener('keydown', h, true); window.addEventListener('keyup', h, true);
      return () => { window.removeEventListener('keydown', h, true); window.removeEventListener('keyup', h, true); };
    },
    autoScroll: (replay, axes) => {
      const es = edgeScroller(gridRect, scrollBy, ev => replay({ ...modsOf(ev), p: pos(ev), raw: ev }), axes);
      return { move: m => { if (m.raw) es.move(m.raw); }, stop: () => es.stop() };
    },
  };
  const ptrOf = (e: PointerEvent): RollPtr => ({ button: e.button as 0 | 1 | 2, ...modsOf(e), p: pos(e), raw: e });
  /** Hover: the tool's cursor and its previews (roll/grid.ts), nothing while a drag is open.
   * The cursor is only written when it changes: WebKitGTK can swallow the next click when the
   * cursor style churns on every mousemove (the "dead first stamp click" report). */
  const onMove = (e: PointerEvent) => {
    const p = pos(e);
    ptr = { x: p.x, y: p.y };
    if (e.buttons) return;
    const cur = rollMove(ctx, { ...modsOf(e), p });
    if (cv.style.cursor !== cur) cv.style.cursor = cur;
  };
  let velAcc = 0;
  /** Alt+wheel on note `i`: its velocity (the selection's when it is selected), 5 % a notch, 1 % with Ctrl; one undo step per wheel burst. */
  const velWheel = (e: WheelEvent, i: number) => {
    const r = wheelNotches(velAcc, e.deltaY || e.deltaX, e.deltaMode === 1); velAcc = r.acc;
    if (!r.n) return;
    const idx = sel().has(i) ? [...sel()].filter(k => notesRaw()[k]?.ch === ch().id) : [i];
    const notes = nudgeVelocity(notesRaw(), idx, r.n * (e.ctrlKey || e.metaKey ? 0.01 : 0.05));
    wheelEdit('rollVel', t('b.pr.gestVel'), [putNotes(pt(), notes)]);
    const vs = idx.map(k => Math.round(velOf(notes[k]) * 100)), lo = Math.min(...vs), hi = Math.max(...vs);
    say(t('b.pr.velX', { x: notesText(idx.length), v: (lo === hi ? lo : lo + '–' + hi) + ' %' }));
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const d = e.deltaY || e.deltaX, h = size().h;
    if (e.altKey) {
      // over a note: velocity (Ctrl+Alt = fine); elsewhere Alt+wheel stays the key height
      const p = pos(e), i = p.x >= KW ? hitNote(p.step, p.key) : -1;
      if (i >= 0) return velWheel(e, i);
    }
    if (e.ctrlKey || e.metaKey) {
      userScrolled(); // a zoom moves the view as much as a scroll would
      const p = pos(e), z = clamp(view().zoom * Math.pow(1.0015, -d), zMin(), Z_MAX);
      const pps = basePps() * z;
      setViewS(v => ({ ...v, zoom: z, sx: clamp(p.step * pps - (p.x - KW), 0, maxSxAt(pps)) }));
    } else if (e.altKey) {
      const r0 = geo().rowH, rowH = clamp(r0 * Math.pow(1.0015, -d), rowMin(), ROW_MAX);
      setViewS(v => { const k = 127 - (v.sy + h / 2) / r0; return { ...v, rowH, sy: clamp((127 - k) * rowH - h / 2, 0, maxSyAt(rowH)) }; });
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      userScrolled();
      setViewS(v => ({ ...v, sx: clamp(v.sx + d, 0, maxSx()) }));
    } else { const rh = geo().rowH; setViewS(v => ({ ...v, sy: clamp(v.sy + d * 0.7, 0, maxSyAt(rh)) })); }
  };
  // a note's own pan is played by sampler and Synkopa Instruments channels; a synth or plugin channel has the lane on velocity only
  const panPlays = () => ch().kind !== 'plugin';
  /** Slide notes bend the built-in instruments; a plugin is never told (as in FL). */
  const slidePlays = () => ch().kind !== 'plugin';
  const toggleSlide = () => {
    if (!slidePlays()) return say(t('b.pr.slideNoPlugin'));
    const on = !slideMode(); setSlideMode(on);
    say(t(on ? 'b.pr.slideOn' : 'b.pr.slideOff'));
  };
  const lane = () => (panPlays() ? laneMode() : 'vel');
  const laneDown = (e: PointerEvent) => {
    if (pan(e, false)) { dragging = true; return; } // middle-drag: scroll time, as on the grid
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const r = laneCv.getBoundingClientRect();
    const at = (ev: PointerEvent) => { const G = geo(); return { step: (ev.clientX - r.left - KW + G.sx) / G.pps, v: clamp(1 - (ev.clientY - r.top - 6) / (r.height - 9), 0, 1) }; };
    const isPan = lane() === 'pan';
    const g = new Gesture(isPan ? 'Pan' : 'Velocity');
    // FL: the left button draws freehand (every note the stroke passes, also on a fast drag), the right
    // one a straight ramp from where it went down. With a selection, only the selected notes.
    const ramp = e.button === 2, orig = notesRaw(), p0 = at(e);
    let notes = orig, prev = p0;
    const apply = (ev: PointerEvent) => {
      const q = at(ev), tol = Math.max(0.5, 5 / geo().pps);
      notes = (isPan ? panLine : velocityLine)(ramp ? orig : notes, ch().id, sel(), ramp ? p0 : prev, q, tol);
      prev = q;
      g.update([putNotes(pt(), notes)]);
      if (isPan) say(ch().name + ' · pan ' + (ramp ? panText(p0.v * 2 - 1) + ' → ' : '') + panText(Math.abs(q.v * 2 - 1) < 0.05 ? 0 : q.v * 2 - 1));
      else say(ch().name + ' · velocity ' + (ramp ? Math.round(p0.v * 100) + '% → ' : '') + Math.round(q.v * 100) + '%');
    };
    apply(e);
    track(apply, () => g.end(), ramp ? 'crosshair' : 'ns-resize');
  };
  const laneHover = (e: PointerEvent) => {
    if (e.buttons) return;
    const r = laneCv.getBoundingClientRect(), G = geo(), step = (e.clientX - r.left - KW + G.sx) / G.pps, tol = Math.max(0.25, 5 / G.pps);
    const at = chanNotes().filter(x => !x.n.slide && Math.abs(x.n.step - step) <= tol).sort((a, b) => keyOf(b.n, ch()) - keyOf(a.n, ch()));
    if (!at.length) return;
    const val = (n: Note) => (lane() === 'pan' ? panText(n.pan ?? 0) : Math.round(velOf(n) * 100) + '%');
    say(at.slice(0, 6).map(x => noteName(keyOf(x.n, ch())) + ' ' + val(x.n)).join(' · ') + (at.length > 6 ? ' …' : '')
      + (at.length > 1 ? ' — ' + t(sel().size ? 'b.pr.laneSelOnly' : 'b.pr.laneAll') : ''));
  };
  // ---- "Vocal reference": the melody (the selection, else the channel's notes) becomes the target of a vocal sung over it
  const vocals = createMemo(() => { void arrVersion(); return vocalsUnder(S.project, pt().id); });
  const vocalName = (id: number) => { const c = S.project.clips.find(x => x.id === id)!; return (S.project.sources.find(x => x.id === c.ref)?.name ?? '?') + ' · ' + (S.project.tracks[c.track]?.name ?? '') + ' · ' + fmtPos(c.start); };
  const toVocal = (clipId: number) => {
    const c = S.project.clips.find(x => x.id === clipId); if (!c) return;
    const idx = [...sel()].filter(i => notesRaw()[i]?.ch === ch().id);
    const span = idx.length ? selectionSpan(S.project, c, ch().id, pt().id, idx) : null;
    if (idx.length && !span) { say(t('b.pr.vocalNoSel')); return; }
    openPitchEditor(clipId, { channel: ch().id, span });
    say(t('b.pr.vocalOpened', { x: idx.length ? notesText(idx.length) : ch().name, name: vocalName(clipId) }));
  };
  const vocalRef = (e: MouseEvent) => {
    const vs = vocals();
    if (vs.length === 1) return toVocal(vs[0].id);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, vs.map(v => ({ t: 'item' as const, label: vocalName(v.id), act: () => toVocal(v.id) })));
  };
  const moveSelToPattern = () => { const idx = [...sel()]; setSel(new Set<number>()); moveNotesToNewPattern(pt(), idx); };
  const onKey = (e: KeyboardEvent) => {
    const tg = (e.target as HTMLElement).tagName;
    if (tg === 'INPUT' || tg === 'SELECT') return;
    const k = e.key.toLowerCase(), m = e.ctrlKey || e.metaKey;
    const tl = TOOLS.find(x => x.key === k);
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (tl && !m && !e.altKey) { stop(); setRollTool(tl.id); say(t('b.pe.rollTool', { tool: t(tl.label) })); return; }
    if (k === 's' && !m && !e.altKey && !e.shiftKey) { stop(); toggleSlide(); return; }
    if (m && k === 'a') { stop(); setSel(new Set(chanNotes().map(x => x.i))); say(t('b.pe.selected', { x: notesText(chanNotes().length) })); return; }
    // Shift+I: invert the selection within the channel
    if (e.shiftKey && !m && !e.altKey && e.code === 'KeyI') {
      stop();
      const s = invertSelection(chanNotes().map(x => x.i), sel());
      setSel(s); say(s.size ? t('b.pr.inverted', { x: notesText(s.size) }) : t('b.pe.noSel'));
      return;
    }
    // zoom: Page Up / Down in / out around the pointer; Shift+1/2/3 = 1/4/16 bars, Shift+4 = the whole pattern
    if (!m && !e.altKey && !e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) { stop(); zoomTimeTo(hRange().len * (e.key === 'PageUp' ? 0.8 : 1.25)); return; }
    if (e.shiftKey && !m && !e.altKey && /^Digit[1-4]$/.test(e.code)) {
      stop();
      const n = +e.code.slice(5);
      if (n < 4) return zoomTimeTo([16, 64, 256][n - 1]);
      applyH(fitRange(0, stepsOf(pt()), hLimits())); say(t('b.pr.zoomFit'));
      return;
    }
    const s = [...sel()].filter(i => notesRaw()[i]?.ch === ch().id);
    /** FL: with nothing selected an edit key takes every note of the channel. */
    const orAll = () => (s.length ? s : chanNotes().map(x => x.i));
    // Ctrl+Q quantize / Ctrl+L legato: the selection, or every note of the channel
    if (m && !e.shiftKey && !e.altKey && (k === 'q' || k === 'l')) {
      stop();
      const idx = s.length ? s : chanNotes().map(x => x.i);
      if (!idx.length) return;
      if (k === 'q') {
        const grid = rollSnapName(snapNow()) ?? '1/16';
        const r = quantizeStarts(notesRaw(), idx, snapNow());
        if (!r.moved) return say(t('b.pr.onGrid', { grid }));
        commitNotes(r.notes, t('b.pr.quantize'));
        say(t('b.pr.quantized', { x: notesText(r.moved), grid }));
      } else {
        const r = legato(notesRaw(), idx);
        if (!r.changed) return say(t('b.pr.legatoNone'));
        commitNotes(r.notes, t('b.pr.legato'));
        say(t('b.pr.legatoDone', { x: notesText(r.changed) }));
      }
      return;
    }
    // FL: Ctrl+U quick chop (pieces one snap step long), Ctrl+G glue; Alt+U / Alt+A open the chop / arpeggiator tool
    if (m && !e.shiftKey && !e.altKey && (k === 'u' || k === 'g')) {
      stop();
      if (!chanNotes().length) return;
      const grid = rollSnapName(snapNow()) ?? '1/16';
      const verb: TransformVerb = k === 'u' ? { kind: 'chop', len: Math.max(0.25, snapNow() || 1) } : { kind: 'glue' };
      const before = chanNotes().length;
      commit([{ op: 'transformNotes', pattern: pt().id, verb, select: s.length ? { kind: 'indices', indices: [...s].sort((a, b) => a - b) } : { kind: 'range', from: 0, to: 1e9, ch: ch().id } }],
        t(k === 'u' ? 'b.pr.tool.chop' : 'b.pr.tool.glue'));
      // the edit applies locally at once (the engine confirms it), so the count is already the new one
      const after = chanNotes().length;
      say(k === 'u' ? (after > before ? t('b.pr.chopped', { grid, x: notesText(after) }) : t('b.pr.chopNone', { grid }))
        : (after < before ? t('b.pr.glued', { x: notesText(before - after) }) : t('b.pr.glueNone')));
      setSel(new Set<number>());
      return;
    }
    if (e.altKey && !m && !e.shiftKey && (k === 'u' || k === 'a')) {
      stop();
      const id: ToolId = k === 'u' ? 'chop' : 'arp';
      setToolId(id); setVals(TOOL_META[id].fields.map(f => (id === 'chop' && f.kind === 'num' ? Math.max(0.25, snapNow() || 1) : f.def)));
      setToolsOpen(true);
      return;
    }
    // Ctrl+Shift+X: cut the selection out to a new pattern, in place (the playlist keeps it)
    if (m && e.shiftKey && k === 'x') { stop(); if (s.length) moveSelToPattern(); else say(t('b.pe.noSel')); return; }
    if (m && (k === 'c' || k === 'x') && !e.shiftKey) {
      // copy takes every note when nothing is selected (FL); cut only ever removes a selection
      stop(); const w = k === 'x' ? s : orAll(); if (!w.length) { if (k === 'x') say(t('b.pe.noSel')); return; }
      setNoteClip(w.map(i => notesRaw()[i]));
      if (k === 'x') { const del = new Set(w); commitNotes(notesRaw().filter((_, i) => !del.has(i)), t('b.pe.cutNotes')); setSel(new Set<number>()); }
      say(t(k === 'x' ? 'b.pe.cutX' : 'b.pe.copiedX', { x: notesText(w.length) }));
      return;
    }
    if (m && k === 'v' && !e.shiftKey) {
      stop(); const clip = noteClip.notes; if (!clip.length) return;
      const a = noteClip.from ?? Math.min(...clip.map(n => n.step)), b = Math.max(...clip.map(n => n.step + n.len));
      // FL: copied notes keep their time, so a bar copied to another pattern or channel lands on the same
      // bar (out of view: on the first bar shown) and arrives selected, to drag. Notes handed over by the
      // pitch editor (`at` set) still start where it says and chain on.
      let at = noteClip.at ?? pasteStart(a, hRange().pos, hRange().len);
      // a paste exactly onto the notes it copied (Ctrl+C, Ctrl+V in place) would stack invisible doubles:
      // it goes a whole bar on past the block instead, like FL's paste after its source
      // the channel's notes by place, so each candidate bar costs O(copied), not O(copied × notes)
      const key = (step: number, n: Note) => `${Math.round(step * 1e6)}|${Math.round(n.len * 1e6)}|${n.p ?? null}`;
      const cid = ch().id, here = new Set(notesRaw().filter(o => o.ch === cid).map(o => key(o.step, o)));
      const lands = (from: number) => clip.every(n => here.has(key(n.step - a + from, n)));
      for (let guard = 0; guard < 64 && lands(at); guard++) at += Math.max(1, Math.ceil((b - a) / 16 - 1e-9)) * 16;
      const copies = clip.map(n => ({ ...n, ch: ch().id, step: n.step - a + at }));
      const base = notesRaw().length;
      commitNotes([...notesRaw(), ...copies], t('b.pe.pasteNotes')); setSel(new Set(copies.map((_, j) => base + j)));
      // the next paste chains on: right after the block, or a whole bar on when the block keeps its place in the bar
      if (noteClip.at != null) noteClip.at = at + (noteClip.from != null ? Math.max(1, Math.ceil((b - a) / 16 - 1e-9)) * 16 : b - a);
      say(t('b.pe.pastedX', { x: notesText(copies.length) }));
      return;
    }
    // FL: Ctrl+D deselects (Ctrl+B duplicates)
    if (m && k === 'd') { stop(); setSel(new Set<number>()); return; }
    if (m && k === 'b') {
      stop(); const w = orAll(); if (!w.length) return;
      const r = duplicateRight(notesRaw(), w);
      commitNotes(r.notes, t('b.pe.dupNotes')); setSel(new Set(r.idx));
      say(t('b.pe.dupX', { x: notesText(w.length) }));
      return;
    }
    // FL: Shift+↑↓ a semitone, Ctrl+↑↓ an octave, Shift+←→ one grid step; the selection, else every note.
    // A bare arrow moves nothing: every drawn note is left selected, so a stray ↑ used to transpose it.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey !== m && !e.altKey) {
      stop(); const w = orAll(); if (!w.length) return;
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (m ? 12 : 1);
      const notes = transpose(notesRaw(), w, d, ch());
      commitNotes(notes, t(m ? 'b.pe.octave' : 'b.pe.transpose'));
      const lead = notes[w[w.length - 1]]; audition(ch().id, keyOf(lead, ch()), lead.v ?? 1);
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey && !m && !e.altKey) {
      stop(); const w = orAll(); if (!w.length) return;
      commitNotes(nudgeNotes(notesRaw(), w, (e.key === 'ArrowLeft' ? -1 : 1) * (snapNow() || 1 / 32)), t('b.pe.gestMove'));
      return;
    }
    // Delete only ever removes a selection: F7 then Delete, meant for a clip in the Playlist, must not empty the channel
    if (e.key === 'Delete' || e.key === 'Backspace') {
      stop(); const w = s; if (!w.length) { say(t('b.pe.noSel')); return; }
      const del = new Set(w);
      commitNotes(notesRaw().filter((_, i) => !del.has(i)), t('b.pe.gestDelNotes')); setSel(new Set<number>());
      say(t('b.pe.deleted', { x: notesText(w.length) }));
      return;
    }
    if (e.key === 'Escape' && sel().size) { stop(); setSel(new Set<number>()); }
  };
  /** The note properties popover, under the clicked note (above it near the bottom). */
  function PropsPop(pp: { idx: number[] }) {
    let box!: HTMLDivElement, first!: HTMLInputElement;
    // FL's note properties: knobs act at once (one undo step per turn), Reset puts back what the notes
    // were when the box opened, Accept (Enter) applies the typed fields and closes, Esc closes as it was
    const orig = notesRaw().slice();
    const init = readProps(notesRaw(), pp.idx, rawOf(ch()));
    const shown = { start: fmtStart(init.start), len: init.len == null ? '' : fmtLen(init.len), key: noteName(init.key) };
    const [err, setErr] = createSignal('');
    const picked = () => pp.idx.map(i => notesRaw()[i]).filter(Boolean);
    /** The double-clicked note: the knobs show its values and set every picked note to them (FL). */
    const lead = () => notesRaw()[pp.idx[pp.idx.length - 1]] ?? orig[pp.idx[pp.idx.length - 1]];
    const slides = () => picked().filter(n => n.slide).length;
    const allSlide = () => slides() === picked().length;
    // a slide note makes no sound of its own: it has no level or pan
    const levels = () => !allSlide(), pans = () => panPlays() && !allSlide();
    const differ = (f: (n: Note) => number) => new Set(picked().filter(n => !n.slide).map(f)).size > 1;
    let g: Gesture | null = null;
    const setAll = (f: (n: Note) => Note, label: string) => {
      const ids = new Set(pp.idx);
      const notes = notesRaw().map((n, i) => (ids.has(i) && !n.slide ? f(n) : n));
      if (g) g.update([putNotes(pt(), notes)]); else commitNotes(notes, label);
    };
    const withVel = (n: Note, v: number): Note => { const { v: _v, ...rest } = n; return v < 0.995 ? { ...rest, v: Math.round(v * 1000) / 1000 } : rest; };
    const withPan = (n: Note, p: number): Note => { const { pan: _p, ...rest } = n; return Math.abs(p) > 0.005 ? { ...rest, pan: Math.round(p * 100) / 100 } : rest; };
    const knob = (k: 'vel' | 'pan') => {
      const isVel = k === 'vel', label = t(isVel ? 'b.pr.pVel' : 'b.pr.pPan');
      const val = () => (isVel ? velOf(lead()) : (lead().pan ?? 0));
      const set = (x: number) => setAll(n => (isVel ? withVel(n, x) : withPan(n, x * 2 - 1)), label);
      return (
        <Knob key={'np' + k} size="md" label={isVel ? 'VEL' : 'PAN'} title={label + (pp.idx.length > 1 ? ' — ' + t('b.pr.propsAll') : '')}
          t={() => (isVel ? val() : (val() + 1) / 2)} zero={isVel ? undefined : () => 0.5}
          text={() => (differ(n => Math.round((isVel ? velOf(n) : (n.pan ?? 0)) * 100)) ? t('b.pr.pMixed') : isVel ? Math.round(val() * 100) + '%' : panText(val()))}
          color={isVel ? undefined : 'var(--pan)'}
          onStart={() => { g = new Gesture(label); }} onChange={set} onEnd={() => { g?.end(); g = null; }}
          onReset={() => set(isVel ? 1 : 0.5)} onWheel={set} />
      );
    };
    const setSlide = (on: boolean) => {
      const ids = new Set(pp.idx);
      // a slide note is held for its length (it sets the glide time): a step trigger becomes a held note
      commitNotes(notesRaw().map((n, i) => {
        if (!ids.has(i)) return n;
        const { slide: _s, ...rest } = n;
        return on ? { ...rest, slide: true, ...(n.trig ? { trig: false } : {}) } : rest;
      }), t(on ? 'b.pr.toSlide' : 'b.pr.toNormal'));
      say(t(on ? 'b.pr.slideSet' : 'b.pr.slideCleared', { x: notesText(pp.idx.length) }));
    };
    const W = 252, H = 26 + (pp.idx.length > 1 ? 18 : 0) + 72 + 3 * 27 + (pp.idx.some(i => notesRaw()[i]?.trig) ? 27 : 0) + 36 + 18;
    const place = () => {
      const n = lead(), G = geo(), { w, h } = size();
      if (!n) return { left: 0, top: 0 };
      const x = rollX(G, n.step), y = rollY(G, keyOf(n, ch()));
      const below = y + G.rowH + 4;
      return { left: clamp(x, KW + 2, Math.max(KW + 2, w - W - 4)), top: below + H <= h ? below : clamp(y - H - 4, 2, Math.max(2, h - H - 2)) };
    };
    // the window takes the keyboard back (found before the popover leaves the DOM)
    const close = () => { const w = box.closest<HTMLElement>('.win'); setPropsFor(null); w?.focus({ preventScroll: true }); };
    const changed = () => notesRaw().length !== orig.length || notesRaw().some((n, i) => n !== orig[i]);
    const reset = () => { if (changed()) { commitNotes(orig.slice(), t('b.pr.pReset')); say(t('b.pr.pResetDone')); } setErr(''); };
    const cancel = () => { reset(); close(); };
    const accept = () => {
      const val = (name: string) => (box.querySelector(`[name=${name}]`) as HTMLInputElement | null)?.value.trim() ?? '';
      const ch0: { len?: number; start?: number; key?: number } = {};
      const bad = (msg: string, name: string) => { setErr(msg); say(msg); (box.querySelector(`[name=${name}]`) as HTMLInputElement).select(); };
      // a field left as shown (or empty when the notes differ) changes nothing
      const s = val('start'), l = val('len'), k = val('key');
      if (s && s !== shown.start) { const x = parseStart(s); if (x == null) return bad(t('b.pr.pBadStart'), 'start'); ch0.start = x; }
      if (l && l !== shown.len) { const x = parseLen(l); if (x == null) return bad(t('b.pr.pBadLen'), 'len'); ch0.len = x; }
      if (k && k !== shown.key) { const x = parseKey(k); if (x == null) return bad(t('b.pr.pBadKey'), 'key'); ch0.key = x; }
      if (Object.keys(ch0).length) {
        const notes = applyProps(notesRaw(), pp.idx, rawOf(ch()), ch0);
        if (!notes) { setErr(t('b.pr.pRange')); say(t('b.pr.pRange')); return; }
        commitNotes(notes, t('b.pr.props'));
        if (ch0.len != null) setLastLen(ch0.len);
      }
      if (Object.keys(ch0).length || changed()) say(t('b.pr.pDone', { x: notesText(pp.idx.length) }));
      close();
    };
    onMount(() => setTimeout(() => { first.focus(); first.select(); }, 0));
    // the texts are looked up inside the JSX: a `t()` in the call's arguments would make the language
    // a dependency of the call, and a language switch would build new inputs, dropping what is typed
    const field = (name: 'start' | 'len' | 'key', label: TranslationKey, tip: TranslationKey, ref?: (el: HTMLInputElement) => void) => {
      // a plain local: the value is written once, so a placeholder update (an edit, a knob turn, the language) keeps what is typed
      const value = shown[name];
      return (
        <label class="rpf" title={t(tip)}>
          <span>{t(label)}
            <Show when={name !== 'key'}><small>{t(name === 'start' ? 'b.pr.pStartUnit' : 'b.pr.pLenUnit')}</small></Show>
          </span>
          <input ref={ref} name={name} value={value} placeholder={value ? '' : t(name === 'len' && pp.idx.every(i => notesRaw()[i]?.trig) ? 'b.pr.trigger' : 'b.pr.pMixed')} spellcheck="false" autocomplete="off" onInput={() => setErr('')} />
        </label>
      );
    };
    return (
      <div ref={box} class="menu rollprops" style={{ position: 'absolute', left: place().left + 'px', top: place().top + 'px', width: W + 'px' }}
        onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}
        onKeyDown={e => {
          e.stopPropagation(); // typed text never reaches the roll's shortcuts or the playlist
          if (e.key === 'Enter') { e.preventDefault(); accept(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}>
        <div class="mt rphead">
          <span>{t('b.pr.props')}</span>
          <span class="rpwhat">{pp.idx.length > 1 ? notesText(pp.idx.length) : noteName(keyOf(lead(), ch()))}</span>
          <button class="rpx" type="button" title={t('b.pr.pCancelTip')} onClick={cancel}>×</button>
        </div>
        <Show when={pp.idx.length > 1}><div class="rpnote">{t('b.pr.propsN', { x: notesText(pp.idx.length) })}</div></Show>
        <div class="rpknobs">
          <Show when={pans()}>{knob('pan')}</Show>
          <Show when={levels()}>{knob('vel')}</Show>
          <Show when={!levels()}><span class="rpsilent">{t('b.pr.pSlideSilent')}</span></Show>
          <div style={{ flex: 1 }} />
          <Show when={slidePlays()}>
            <button type="button" class={['rpled', { on: allSlide(), part: slides() > 0 && !allSlide() }]} aria-pressed={allSlide() ? 'true' : 'false'} title={t('b.pr.pSlideTip')}
              onClick={() => setSlide(!allSlide())}><i />{t('b.pr.pSlide')}</button>
          </Show>
        </div>
        {field('start', 'b.pr.pStart', 'b.pr.pStartTip', el => (first = el))}
        {field('len', 'b.pr.pLen', 'b.pr.pLenTip')}
        <Show when={pp.idx.some(i => notesRaw()[i]?.trig)}>
          <button class="smallbtn" type="button" title={t('b.pr.triggerTip')} onClick={() => {
            const ids = new Set(pp.idx);
            commitNotes(notesRaw().map((n, i) => ids.has(i) && n.trig ? { ...n, trig: false } : n), t('b.pr.toHeld'));
            close();
          }}>{t('b.pr.toHeld')}</button>
        </Show>
        {field('key', 'b.pr.pKey', 'b.pr.pKeyTip')}
        <div class="rpbtns">
          <button class="smallbtn" type="button" title={t('b.pr.pResetTip')} disabled={!changed()} onClick={reset}>{t('b.pr.pReset')}</button>
          <button class="smallbtn primary" type="button" title={t('b.pr.pAcceptTip')} onClick={accept}>{t('b.pr.pAccept')}</button>
        </div>
        <div class={['rpfoot', { err: !!err() }]}>{err() || t('b.pr.pFoot')}</div>
      </div>
    );
  }
  return (
    <PanelFrame name={t('a.mn.roll')} {...patGeom('rollWin')} z={props.z} class="rollwin" minW={560} minH={300} compactH={380} docked={props.docked} dockId="roll" front={rollFront} onKey={onKey} onHeadDbl={toggleRollMax}
      controls={<WinControls dock={paneDock('roll')} max={props.docked ? undefined : { on: U.rollMax, toggle: toggleRollMax }}
        close={{ tip: t(props.docked ? 'b.dk.closeRoll' : 'b.pe.close'), act: closeRoll }} />}
      head={<>
        <span class="tile" style={{ width: '20px', height: '20px', background: ch().color + '2e', color: ch().color }}><Icon d={ROLL_ICON} size={12} /></span>
        <span class="wintitle">Piano roll</span>
        <select class="sel chsel" title={t('b.pr.chTitle')} value={String(ch().id)} style={{ color: ch().color }} onChange={e => { selectChannel(+e.currentTarget.value); backToRoll(e.currentTarget); }}>
          <For each={channels()}>{c => <option value={String(c.id)}>{c.name}</option>}</For>
        </select>
        <PatternChip pat={pt()} />
      </>}>
    <div class="roll">
      <div class="ptools">
        <ToolSeg label={t('a.pl.toolsLabel')} value={rollTool()} onPick={(id, el) => { setRollTool(id); backToRoll(el); }}
          tools={TOOLS.map(tl => ({ id: tl.id, icon: tl.icon, title: t(tl.label) + ' (' + tl.key.toUpperCase() + ') — ' + t(tl.tip) }))} />
        <div class="seg tools">
          <button class={['slidetog', { on: slideMode() && slidePlays() }]} aria-pressed={slideMode() && slidePlays() ? 'true' : 'false'} disabled={!slidePlays()}
            title={slidePlays() ? t('b.pr.slideTip') : t('b.pr.slideNoPlugin')} onClick={e => { toggleSlide(); backToRoll(e.currentTarget); }}>
            <Icon d={SLIDE_ICON} size={14} />
          </button>
        </div>
        <div class="vsep" />
        <GridChip label="Snap" title={rollSnap() < 0 ? t('a.tb.snapTipAuto', { unit: rollSnapName(snapNow()) ?? '' }) : t('b.pe.snapTitle')} value={String(rollSnap())}
          modes={[{ label: 'auto', value: '-1', note: t('a.snap.autoNow', { unit: rollSnapName(autoRollSnap(geo().pps)) ?? '' }) }]}
          sections={[{ options: ROLL_SNAPS.map(([l, v]): ChipOption => [l, String(v)]) }, { label: t('b.pe.snapTriplets'), options: ROLL_SNAPS_TRIPLET.map(([l, v]): ChipOption => [l, String(v)]) }]}
          implied={rollSnap() < 0 ? String(snapNow()) : undefined}
          onChange={(v, el) => { setRollSnap(+v); backToRoll(el); }} />
        {/* the song's key, always in view (shared with the toolbar): views/KeyBadge.tsx */}
        <KeyBadge class="toolmenu" />
        <div style={{ flex: 1 }} />
        <Show when={FORK.vocal && vocals().length > 0 && chanNotes().length > 0}>
          <button class="smallbtn" style={{ 'align-self': 'center' }} title={t('b.pr.vocalTip')} onClick={vocalRef}>♪ {t('b.pr.vocal')}{vocals().length > 1 ? ' …' : ''}</button>
        </Show>
        <Show when={sel().size > 0}>
          <button class="smallbtn" style={{ 'align-self': 'center' }} title={t('b.pe.toNewPatTip')} onClick={e => { moveSelToPattern(); backToRoll(e.currentTarget); }}>{t('b.pe.toNewPat')}</button>
        </Show>
        <div class="toolmenu" ref={toolMenu}>
          <button class={['chip', { on: toolsOpen() }]} aria-expanded={toolsOpen() ? 'true' : 'false'} title={t('b.pr.toolsTip')} onClick={() => setToolsOpen(v => !v)}>
            {t('b.pr.tools')}<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
          </button>
          <Show when={toolsOpen()}>
            <div class="toolpop" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setToolsOpen(false); } }}>
              <div class="toolgrid" role="radiogroup">
                <For each={Object.keys(TOOL_META) as ToolId[]}>{v => (
                  <button role="radio" aria-checked={toolId() === v ? 'true' : 'false'} class={{ on: toolId() === v }} onClick={() => { setToolId(v); setVals(TOOL_META[v].fields.map(f => f.def)); }}>
                    <Icon d={TOOL_META[v].icon} size={15} sw={1.8} /><span>{t(TOOL_META[v].label)}</span>
                  </button>
                )}</For>
              </div>
              <For each={TOOL_META[toolId()].fields}>{(f, i) => f.kind === 'num' ? (
                // a number is a slider over its useful range, the value beside its name
                <label class="tpslide" title={t(f.label)}>
                  <span>{shortLabel(t(f.label))}</span><b>{numText(typeof vals()[i()] === 'number' ? (vals()[i()] as number) : f.def, f.step)}</b>
                  <input type="range" min={f.min} max={f.max} step={f.step} value={typeof vals()[i()] === 'number' ? (vals()[i()] as number) : f.def}
                    style={{ '--p': (((typeof vals()[i()] === 'number' ? (vals()[i()] as number) : f.def) - f.min) / (f.max - f.min)) * 100 + '%' }}
                    onInput={e => setField(i(), +e.currentTarget.value)} onDblClick={() => setField(i(), f.def)} />
                </label>
              ) : (
                <label class="tprow"><span>{t(f.label)}</span>{f.kind === 'select' ? (
                  <select class="sel" value={String(vals()[i()] ?? f.def)} onChange={e => setField(i(), e.currentTarget.value)}>
                    <For each={f.options}>{o => <option value={o.v}>{t(o.l)}</option>}</For>
                  </select>
                ) : (
                  <input type="checkbox" checked={vals()[i()] !== false} onInput={e => setField(i(), e.currentTarget.checked)} />
                )}</label>
              )}</For>
              <label class="tprow" title={t('b.pr.seedTip')}><span>{t('b.pr.seed')}</span>
                <input class="textin" type="number" step="1" value={toolSeed()} onInput={e => setToolSeed(e.currentTarget.value)} onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation(); }} />
              </label>
              <button class="smallbtn primary" title={t('b.pr.applyTip')} onClick={e => { applyTool(); backToRoll(e.currentTarget); }}>{t('b.pr.apply')}</button>
            </div>
          </Show>
        </div>
        <Show when={rollTool() === 'stamp'}>
          <label class="plab">{t('b.pr.stamp.type')}
            <span class="row" style={{ gap: '4px' }}>
              <select class="sel" title={t('b.pr.stamp.typeTitle')} value={stampType()} onChange={e => { setStampType(e.currentTarget.value); backToRoll(e.currentTarget); }}>
                <For each={STAMP_TYPES}>{o => <option value={o.v}>{t(o.l)}</option>}</For>
              </select>
              <select class="sel" title={t('b.pr.stamp.invTitle')} value={String(stampInv())} onChange={e => { setStampInv(+e.currentTarget.value); backToRoll(e.currentTarget); }}>
                <For each={STAMP_INVS}>{o => <option value={String(o.v)}>{t(o.l)}</option>}</For>
              </select>
            </span>
          </label>
        </Show>
        <span class="note mono" style={{ 'align-self': 'center', 'font-size': '10px', color: 'var(--fg5)' }}>{sel().size ? t('b.pe.nSel', { n: sel().size }) : notesText(chanNotes().length)}{t('b.pe.newNote', { len: lastLenText() })}</span>
      </div>
      <div class="rollgrid">
        <div class="ovrow" style={{ 'padding-left': KW + 'px' }}>
          <ZoomScrollbar orient="h" class="ov" range={hRange} limits={hLimits} onChange={setH} title={t('b.pr.hbarTip')}
            paint={paintOverview} paintKey={() => [data(), ch().id, pt().len, chansMap()]} />
        </div>
        <div class="rollruler">
          <div class="corner" style={{ width: KW + 'px' }} />
          <div class="rcv">
            <canvas ref={rulerCv} title={t('b.pr.rulerTip')} onPointerDown={e => { if (propsFor()) setPropsFor(null); rulerDown(ruler, e); }} onContextMenu={e => e.preventDefault()}
              onPointerMove={e => { if (!e.buttons) rulerCv.style.cursor = rulerCursor(ruler, e); }} />
            <div ref={phRuler} class="pphead" />
          </div>
        </div>
        <div ref={wrap} class="parea">
          <canvas ref={cv} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', 'touch-action': 'none' }}
            onPointerDown={e => rollDown(ctx, ptrOf(e))} onPointerMove={onMove} onPointerLeave={() => { ptr = null; setStampGhost(null); setHoverChord(''); }} onWheel={wheel} onContextMenu={e => e.preventDefault()} />
          <div ref={phead} class="pphead" />
          <Show when={propsFor()} keyed>{idx => <PropsPop idx={idx} />}</Show>
        </div>
        <ZoomScrollbar orient="v" range={vRange} limits={vLimits} onChange={setV} title={t('b.pr.vbarTip')} />
      </div>
      <div class="lanerow" style={{ height: LANE_H + 'px', display: laneOn() ? undefined : 'none' }}>
        <div ref={laneWrap} class="lanecv">
          <canvas ref={laneCv} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', 'touch-action': 'none', cursor: 'ns-resize' }}
            onPointerDown={laneDown} onPointerMove={laneHover} onContextMenu={e => e.preventDefault()} />
<LaneSwitch label={t('b.pr.laneTarget')} value={lane()} onPick={(id, el) => { setLaneMode(id); backToRoll(el); }} items={[
            { id: 'vel', cls: 'vel', label: t('b.pr.laneVel'), icon: LANE_ICONS.vel, tip: t('b.pr.laneVelTip') },
            { id: 'pan', cls: 'pan', label: t('b.pr.lanePan'), icon: LANE_ICONS.pan, tip: t(panPlays() ? 'b.pr.lanePanTip' : 'b.pr.lanePanOff'), disabled: !panPlays() },
          ]} />
        </div>
      </div>
      <div class="pstatus mono">
        <span>{ch().name} · {chanKindLabel(ch())}</span>
        <span>{t(TOOLS.find(x => x.id === rollTool())!.tip)}</span>
        <Show when={hoverChord()}>
          <span title={t('b.pr.chordTitle')} style={{ color: 'var(--acc2)' }}>{hoverChord()}</span>
        </Show>
        <button class="hintlink" title={t('b.pr.keysTip')} onClick={() => setU('help', true)}>{t('a.mn.shortcuts')}</button>
      </div>
    </div>
    </PanelFrame>
  );
}

function lastLenText() {
  if (lastTrig()) return t('b.pe.newStep');
  const l = lastLen();
  return l >= 4 && l % 4 === 0 ? t(l === 4 ? 'b.pe.beat1' : 'b.pe.beatN', { n: l / 4 }) : rollSnapName(l) ?? t('b.pe.stepsN', { n: +l.toFixed(2) });
}
