import { prefs } from '../state/prefs';
import { t as tl } from '../lib/i18n';
import { createMemo, For, Show } from 'solid-js';
import { createSignal, effect, onCleanup, onMount, watch } from '../lib/reactive';
import { InstIcon, laneAutoIcons, trackIcon } from '../ui/instIcons';
import { STRETCH_MAX, STRETCH_MIN, VOL_UNITY, type Automation, type AutoPoint, type Channel, type Clip, type Comp, type CurveShape, type Id, type Marker, type Op, type Take, type Track } from '../api/types';
import { boundaries, boundaryXfade, moveBoundary, setBoundaryXfade, takeEnd, toComp, toTimeline, unusedTakes, usedBeats, writeRange } from '../lib/comp';
import * as CA from '../state/comp';
import { compById, LANE_H, takeRow, type TakeRow } from '../state/comp';
import { clampMove, moveClips, newClip, newTrack, paintCells, placeClipCopy, resizeClip, resizeClips, sliceAcross, stackPatternClips, stretchClip, stretchClips, sharedSound, TOTAL } from '../lib/clipOps';
import { clamp, fmtPos, volText } from '../lib/format';
import { snapFloor, snapRes, snapRound } from '../lib/snap';
import * as A from '../state/actions';
import { MuteSolo } from '../ui/MuteSolo';
import { commit, Gesture, wheelEdit } from '../state/edit';
import { peaksVersion } from '../state/peaks';
import { allocId, anyTrackSolo, arrVersion, clipSrcLen, insName, onArrangementChange, plain, rawOf, S, srcLenBeats, srcOf } from '../state/store';
import { curBeat, recState, tele } from '../state/telemetry';
import { recTarget, recUntil } from '../lib/recTarget';
import { closeMenu, openMenu, openRename, revealReq, say, setU, U, type MenuItem } from '../state/ui';
import { showInsert } from '../state/mixView';
import { openStems } from '../state/stems';
import { dblCheck, dragCursor, edgeScroller, escCancels, fineMul, panDrag, track } from '../ui/drag';
import { fitSpan, zoomScroll, zoomToRange } from '../lib/viewNav';
import { barsText } from '../lib/pattern';
import { addFrameTask, fitCanvas, fonts, shiftCanvas } from '../ui/frameLoop';
import { drawFades, drawGrid, drawOverlaps, type View } from './playlistDraw';
import { drawRuler, rulerCursor, rulerDown as rulerPress, RULER_H, type RulerHost } from '../ui/timeRuler';
import { ZoomScrollbar } from '../ui/ZoomScrollbar';
import { PlaylistTools } from './PlaylistTools';
import type { ZRange } from '../lib/zoomBar';
import { laneOverlaps } from '../lib/overlaps';
import { damageRects, followScroll, planTile, snapPx, type Rect, type Tile } from './playlistTile';
import { autoDisplay, autoTweak, isAutomated, paramMenu } from '../state/automation';
import { autoValueText, parseAutoValue, cyclesOf, stairsOf } from '../lib/automation';
import { addPoint, deletePoints, dragTension, hitEnv, insetGeom, movePoints, pointsInBox, setShape, type EnvHit } from '../lib/envEdit';
import { autoById } from '../state/store';
import { addSampler, openPattern } from '../state/pattern';
import { rgba, T, theme } from '../ui/theme';
import { markerAtX } from '../lib/markers';
import * as MK from '../state/markers';
import { drawMarkers, drawMarkerTicks, MARKER_H, markerBoxes } from './markerDraw';
import { FORK } from '../fork';


/** Shared geometry, so the browser and OS drops can find a beat/track under the pointer. */
// The clip canvases are NOT `desynchronized` (Chromium's low-latency canvas): that hint is only
// valid with no DOM element above the canvas, but the fade overlay, the playhead and the marquee
// sit on top, and Chromium then kept stale pixels after scrolls (a clip or a ghost stayed on
// screen until something repainted it).

export const geom = { grid: null as HTMLDivElement | null, scroll: null as HTMLDivElement | null, tops: [0] as number[], top: RULER_H };

function trackAtY(y: number): number {
  const t = geom.tops; if (y < 0) return -1;
  for (let i = 0; i < t.length - 1; i++) if (y < t[i + 1]) return i;
  return -1;
}
function trackAtYClamped(y: number): number {
  const n = S.project.tracks.length; if (y < 0) return 0;
  const i = trackAtY(y); return i < 0 ? n - 1 : i;
}
export function gridPoint(clientX: number, clientY: number) {
  const r = geom.grid!.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
  const sr = geom.scroll!.getBoundingClientRect();
  const inside = clientX >= Math.max(r.left, sr.left + U.headW) && clientX <= Math.min(r.right, sr.right) && clientY >= Math.max(r.top, sr.top + geom.top) && clientY <= Math.min(r.bottom, sr.bottom);
  return { beat: x / U.bw, track: trackAtY(y), x, y, inside };
}
const unit = (alt: boolean) => A.snapUnit(alt);

/** Playlist zoom presets (Shift+1 / 2 / 3), px per beat: detail, the default, overview. */
const ZOOM_PRESETS = [64, 22, 8];
/** The least a "fit the song" zoom shows (beats): a few bars, so an empty song is not zoomed in to a beat. */
const FIT_MIN_BEATS = 16;
let zoomImpl: { step(f: number): void; preset(i: number): void; fit(): void } | null = null;
/** The playlist's zoom keys (App): Page Up / Down around the pointer, Shift+1–3 presets, Shift+4 fit the song. */
export const playlistZoom = {
  step: (f: number) => zoomImpl?.step(f),
  preset: (i: number) => zoomImpl?.preset(i),
  fit: () => zoomImpl?.fit(),
};

/** Place a pattern/source clip at a client point (browser drag). */
export function dropClipAt(clientX: number, clientY: number, kind: Clip['kind'], ref: Id, alt: boolean): boolean {
  const p = gridPoint(clientX, clientY);
  if (!p.inside || p.track < 0) return false;
  const len = srcLenBeats(kind, ref), start = clamp(snapFloor(p.beat, unit(alt)), 0, TOTAL - Math.min(len, TOTAL));
  const nc: Clip = { ...newClip(allocId(), p.track, start, Math.min(len, TOTAL - start), kind, ref), ...(kind === 'audio' ? sharedSound(S.project.clips, ref) : {}) };
  commit([{ op: 'putClips', clips: [nc] }], tl('a.pl.insertClip'));
  setU('sel', [nc.id]);
  return true;
}

/** Several patterns dropped at a client point: one per track from the one under the pointer (tracks added as needed), one undo step. */
export function dropPatternsAt(clientX: number, clientY: number, refs: readonly Id[], alt: boolean): boolean {
  const p = gridPoint(clientX, clientY);
  if (!p.inside || p.track < 0 || !refs.length) return false;
  const longest = Math.max(...refs.map(r => srcLenBeats('pat', r)));
  const start = clamp(snapFloor(p.beat, unit(alt)), 0, TOTAL - Math.min(longest, TOTAL));
  const n = S.project.tracks.length;
  const r = stackPatternClips(refs, p.track, start, n, TOTAL, ref => srcLenBeats('pat', ref), allocId);
  const ops: Op[] = Array.from({ length: r.newTracks }, (_, i) => ({ op: 'putTrack', track: newTrack(allocId(), n + i) }) as Op);
  commit([...ops, { op: 'putClips', clips: r.clips }], tl('a.pl.insertClips', { n: refs.length }));
  setU('sel', r.clips.map(c => c.id));
  return true;
}

/** True when `b` changes nothing of `a` that the grid draws (a fader or routing move repaints no clip). */
function sameDrawnTrack(a: Track | undefined, b: Track): boolean {
  return !!a && a.name === b.name && a.color === b.color && a.muted === b.muted && a.solo === b.solo && a.arm === b.arm && a.h === b.h && (a.icon ?? null) === (b.icon ?? null);
}
/** Same for a channel: pattern clips show its notes' rows (kind, root) and an icon (name, instrument), not its knobs. */
function sameDrawnChannel(a: Channel | undefined, b: Channel): boolean {
  return !!a && a.name === b.name && a.kind === b.kind && a.root === b.root;
}
/** True when the Channel Rack already has a sampler channel playing this source. */
function hasSamplerOf(ref: Id): boolean {
  return !!S.project.channels?.some(ch => ch.kind === 'sample' && ch.source === ref);
}

/** `cb`: a comp region boundary (`bnd` = its index in `boundaries(comp.regions)`). */
/** `head`: on the clip's name bar (the top CLIP_HEAD px), where a right-click opens its menu. */
interface Hit { c: Clip; edge: 'l' | 'r' | 'fi' | 'fo' | 'cb' | 'menu' | null; bnd?: number; head?: boolean }
/** Height (px) of a clip's name bar. */
const CLIP_HEAD = 15;
/** Trim zone of a clip's edge (px): this far inside the clip, and this far outside it. Together
 *  14 px, about what REAPER / Ableton give an edge; 6 px inside alone was hard to hit. */
const EDGE_IN = 8, EDGE_OUT = 6;
/** A take lane under a track. `cb` = comp beat under the pointer. */
interface LaneHit extends TakeRow { ti: number; k: number; take: Take; cb: number }

/** The shortest and tallest a lane gets (Alt+wheel, the vertical zoom scrollbar). */
const LANE_H_MIN = 28, LANE_H_MAX = 220;

export function Playlist() {
  let scrollEl!: HTMLDivElement, gridEl!: HTMLDivElement, gridCv!: HTMLCanvasElement, fadeCv!: HTMLCanvasElement, rulerCv!: HTMLCanvasElement;
  let phGrid!: HTMLDivElement, phRuler!: HTMLDivElement;
  let mkCv: HTMLCanvasElement | undefined, mkRow: HTMLDivElement | undefined;
  /** A marker being dragged (not sent until it is let go: Esc puts it back) and the one under the pointer. */
  const [mkDrag, setMkDrag] = createSignal<{ id: Id; at: number } | null>(null);
  const [mkHover, setMkHover] = createSignal<Id | null>(null);
  /** The markers as drawn: a dragged one at its new place. */
  const shownMarkers = (): Marker[] | undefined => {
    const ms = rawOf(S.project).markers, d = mkDrag();
    if (!ms || !d) return ms;
    return ms.map(m => (m.id === d.id ? { ...m, at: d.at } : m)).sort((a, b) => a.at - b.at || a.id - b.id);
  };
  const [vw, setVw] = createSignal(800), [vh, setVh] = createSignal(400);
  const [scroll, setScroll] = createSignal({ x: 0, y: 0 });

  /** per track: the comp whose take lanes are open below it */
  const rows = createMemo(() => S.project.tracks.map((_, i) => takeRow(i)));
  const tops = createMemo(() => {
    const t: number[] = [], rs = rows(); let y = 0;
    S.project.tracks.forEach((tr, i) => { t.push(y); y += tr.h + (rs[i]?.comp.takes.length ?? 0) * LANE_H; });
    t.push(y); return t;
  });
  const [bndHover, setBndHover] = createSignal<{ clipId: Id; i: number } | null>(null);
  // dragging a lane header: past a few px it lifts; the line shows the gap it lands in, the view
  // scrolls at its top and bottom edge, Esc puts it back
  laneDragStart = (e, from) => {
    const col = (e.currentTarget as HTMLElement).closest<HTMLElement>('.lanesCol');
    if (!col) return;
    const y0 = e.clientY;
    let lifted = false, cancelled = false, to = from;
    const run = (ev: PointerEvent) => {
      if (cancelled) return;
      if (!lifted) { if (Math.abs(ev.clientY - y0) < 5) return; lifted = true; dragCursor('grabbing'); }
      const y = ev.clientY - col.getBoundingClientRect().top, ts = tops(), n = S.project.tracks.length;
      // the gap nearest the pointer: 0 = above the first lane, n = below the last
      let gap = 0;
      for (let k = 1; k <= n; k++) if (Math.abs(ts[k] - y) < Math.abs(ts[gap] - y)) gap = k;
      to = gap > from ? gap - 1 : gap;
      setLaneDrag({ from, to, y: ts[gap] });
      say(to === from ? tl('a.pl.dragTrackSame') : tl('a.pl.dragTrackTo', { name: S.project.tracks[from].name, n: to + 1 }));
    };
    const es = edgeScroller(() => scrollEl.getBoundingClientRect(), (_dx, dy) => { const b = scrollEl.scrollTop; scrollEl.scrollTop += dy; return scrollEl.scrollTop !== b; }, run, { y: true });
    const esc = escCancels(() => lifted, () => { cancelled = true; setLaneDrag(null); es.stop(); dragCursor(null); say(tl('a.pl.dragTrackCancel')); });
    track(ev => { run(ev); if (lifted) es.move(ev); }, () => {
      esc.off();
      es.stop();
      if (lifted) dragCursor(null);
      setLaneDrag(null);
      if (lifted && !cancelled && to !== from) A.moveTrackTo(from, to);
    });
  };
  onCleanup(() => { laneDragStart = null; });
  effect(() => { geom.tops = tops(); });
  // recording starts: make sure the armed track is on screen (a tall mixer can hide it)
  watch(() => S.transport.rec && U.playing, rec => {
    if (!rec || !scrollEl) return;
    const r = recTarget(S.project, U.start, recUntil(S.project)), i = r === 'new' ? S.project.tracks.length - 1 : r; if (i < 0) return;
    const y0 = tops()[i], y1 = y0 + S.project.tracks[i].h, top = scrollEl.scrollTop, vis = scrollEl.clientHeight - 30;
    if (y0 < top || y1 > top + vis) scrollEl.scrollTop = Math.max(0, y0 - 10);
  }, { defer: true });
  // something made off screen (an automation clip): scroll its track, and its start, into view
  // (next frame: a new bottom track has to be laid out before the view can scroll to it)
  watch(revealReq, r => requestAnimationFrame(() => {
    if (!r || !scrollEl || !S.project.tracks[r.track]) return;
    const y0 = tops()[r.track], y1 = y0 + S.project.tracks[r.track].h, top = scrollEl.scrollTop, vis = scrollEl.clientHeight - 30;
    if (y0 < top || y1 > top + vis) scrollEl.scrollTop = Math.max(0, y1 - vis + 10);
    const x = r.beat * U.bw, left = scrollEl.scrollLeft, w = scrollEl.clientWidth - U.headW;
    if (x < left || x > left + w - 40) scrollEl.scrollLeft = Math.max(0, x - 40);
    syncScroll();
  }), { defer: true });
  // the marker strip shows above the ruler while the song has markers
  const mkH = () => (S.project.markers?.length ? MARKER_H : 0);
  const rowH = () => RULER_H + mkH();
  effect(() => { geom.top = rowH(); });
  const gridW = () => TOTAL * U.bw;
  const gridH = () => tops()[tops().length - 1];
  const cw = () => Math.max(1, Math.min(vw() - U.headW, gridW()));
  const ch = () => Math.max(1, Math.min(vh() - rowH(), gridH()));
  const editable = () => U.tool === 'draw' || U.tool === 'paint' || U.tool === 'select';
  const toolCursor = () => ({ draw: 'crosshair', paint: 'copy', erase: 'not-allowed', mute: 'pointer', slice: 'col-resize', select: 'crosshair' })[U.tool];

  let dirtyGrid = true, dirtyFade = true, dirtyRuler = true, dirtyOv = true, lastRecV = -1, lastPhX = -1, fontEpoch = 0, themeEpoch = -1, lastDpr = 0;
  /** Where the grid canvases sit in grid coordinates (see playlistTile.ts); null = redraw all. */
  let tile: Tile | null = null, rulerTile: Tile | null = null;
  /**
   * Parts of the grid to repaint (grid coordinates) when not all of it is dirty: the old and new
   * place of each clip an edit moved, the clips whose selection changed. A drag on a big song
   * repaints a few clips per frame instead of the whole view with every waveform in it.
   */
  let damage: Rect[] = [];
  /**
   * Zoom on a view too heavy to repaint within a frame: the tile (drawn at `tileBw` px per beat) is
   * stretched to the new zoom on the compositor and repainted sharp once the zoom has settled, or
   * as soon as the stretched tile no longer covers the view or is off by more than 2×. Without it
   * every wheel step waited for a full paint of all the waveforms in view (a zoom at ~20 fps on a
   * big song). Where a full paint fits in a frame nothing changes: every step is painted sharp.
   */
  let zoomed = false, stretched = false, tileBw = 0, zoomAt = 0;
  /**
   * A zoom waiting for the next frame: zoom and scroll are applied together right before that
   * frame paints. Applied in the input handler, the webview could show a frame between the two
   * (WebKitGTK does not align wheel events with frames): the new scroll over the canvases still
   * painted at the old zoom, so the view jumped sideways and back on every wheel step (#160).
   * Several wheel steps in one frame add up here.
   */
  let pendingView: { bw: number; x: number; y: number } | null = null;
  /** The view as it will be on the next frame (a queued zoom included). */
  const viewNow = () => pendingView ?? { bw: U.bw, x: scrollEl.scrollLeft, y: scrollEl.scrollTop };
  const queueView = (bw: number, x: number, y: number) => { pendingView = { bw, x: Math.max(0, x), y: Math.max(0, y) }; };
  const applyView = () => {
    const v = pendingView; if (!v) return;
    pendingView = null;
    if (v.bw !== U.bw) setU('bw', v.bw);
    scrollEl.scrollLeft = v.x; scrollEl.scrollTop = v.y;
    setScroll({ x: scrollEl.scrollLeft, y: scrollEl.scrollTop });
  };
  /** Frame intervals after the last full paints (ms): their median says whether a full paint fits in a frame. */
  const paintGaps: number[] = [];
  let lastDrawAt = 0, paintedFull = false;
  const heavyPaint = () => paintGaps.length >= 2 && [...paintGaps].sort((a, b) => a - b)[paintGaps.length >> 1] > 24;
  const ZOOM_SETTLE_MS = 90;
  /** Bumped when the clip lookups of `drawGrid` (patterns, sources, …) may be stale: not for a clip-only edit. */
  let lookVer = 0;
  /** The icon a lane header shows when its track has none and its name says nothing: its clips' (one pass per arrangement edit). */
  const laneIcons = createMemo((): (string | null)[] => { arrVersion(); return laneAutoIcons(rawOf(S.project)); },
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  /** The automation clip under the pointer, and the point / tension handle there. */
  const [envHover, setEnvHover] = createSignal<{ clip: Id; hover: EnvHit | null } | null>(null);
  // what the grid canvas depends on (not mixer state), split so a zoom does not re-walk every clip.
  // The view's size is not here either: `planTile` asks for a full paint only when the tile's size changes.
  // Scrolling is not here: the canvases scroll with the content and redraw only strips (`draw`)
  effect(() => { U.snap; U.tool; S.transport.rec; S.project.bpm; peaksVersion(); dirtyGrid = true; });
  // back from the Mix view: paint everything again (a webview may have dropped the hidden canvases' pixels)
  effect(() => { if (!U.mixView) { dirtyGrid = dirtyFade = dirtyRuler = dirtyOv = true; tile = null; } });
  // a zoom step is handled in `draw`: a full paint, or the tile stretched until the zoom settles
  watch(() => U.bw, () => { zoomed = true; }, { defer: true });
  // the loop range is shaded on the overlay: moving it repaints no clip
  effect(() => { S.project.loop?.a; S.project.loop?.b; dirtyFade = true; });
  effect(() => { for (const t of S.project.tracks) { t.h; t.arm; t.color; } dirtyGrid = true; });
  /** The clip's box in grid coordinates (with its ring), or null when it is drawn beyond it (comps open take lanes). */
  const clipBox = (c: Clip, P: { tracks: Track[] }): Rect | null => {
    if (c.kind === 'comp') return null;
    const tr = P.tracks[c.track], t = tops(); if (!tr || t[c.track] == null) return null;
    // exactly the rows the clip is drawn on (top + 1 … top + h − 1): rounded out to device pixels the
    // box still ends inside its own lane, so a repaint never cuts through a clip of the lane above or
    // below (which chained, clip by clip, into a repaint of the whole view)
    return { x: c.start * U.bw - 2, y: t[c.track] + 1, w: Math.max(3, c.len * U.bw - 1) + 4, h: tr.h - 2 };
  };
  const damageClip = (c: Clip | undefined, P: { tracks: Track[] }) => {
    if (!c) return;
    const r = clipBox(c, P);
    if (r) damage.push(r); else dirtyGrid = true;
  };
  // selection: only the clips whose state changed are repainted
  let drawnSel = new Set<Id>();
  effect(() => {
    const next = new Set<Id>(U.sel);
    const changed: Id[] = [];
    for (const id of next) if (!drawnSel.has(id)) changed.push(id);
    for (const id of drawnSel) if (!next.has(id)) changed.push(id);
    drawnSel = next;
    if (!changed.length) return;
    if (changed.length > 64) { dirtyGrid = true; return; }
    const P = rawOf(S.project), ids = new Set(changed);
    for (const c of P.clips) if (ids.has(c.id)) damageClip(c, P);
  });
  /**
   * Patterns edited since the last frame → their length before the edit. A note edit repaints only
   * the clips that show the pattern (their boxes change only when its length does: checked in `draw`,
   * after the edit is applied) instead of every clip in view on each frame of a piano-roll drag.
   */
  const editedPats = new Map<Id, number>();
  // clip edits: the old and the new box of each clip; pattern edits: the clips of that pattern;
  // edits of fields the grid does not draw (a fader, a channel's knobs): nothing; anything else redraws the view
  onCleanup(onArrangementChange((ops, before) => {
    if (!ops) { dirtyGrid = dirtyFade = dirtyOv = true; lookVer++; editedPats.clear(); return; }
    let byId: Map<Id, Clip> | null = null;
    const old = (id: Id) => (byId ??= new Map(before.clips.map(c => [c.id, c]))).get(id);
    for (const op of ops) {
      if (op.op === 'putClips') { dirtyFade = dirtyOv = true; for (const c of op.clips) { damageClip(old(c.id), before); damageClip(c, before); } }
      else if (op.op === 'removeClips') { dirtyFade = dirtyOv = true; for (const id of op.ids) damageClip(old(id), before); }
      else if (op.op === 'putPattern') {
        lookVer++;
        const was = before.patterns.find(x => x.id === op.pattern.id);
        if (!was) continue; // a new pattern: no clip shows it yet
        if (!editedPats.has(was.id)) editedPats.set(was.id, was.len);
        for (const c of before.clips) if (c.kind === 'pat' && c.ref === was.id) damageClip(c, before);
      }
      else if (op.op === 'putTrack' && sameDrawnTrack(before.tracks.find(x => x.id === op.track.id), op.track)) continue;
      else if (op.op === 'putChannel' && sameDrawnChannel(before.channels?.find(x => x.id === op.channel.id), op.channel)) continue;
      else { dirtyGrid = dirtyFade = dirtyOv = true; lookVer++; }
    }
  }));
  watch(() => prefs().clipIcons, () => { dirtyGrid = true; }, { defer: true });
  effect(() => {
    for (const k in S.audition) void S.audition[k];
    for (const k in S.stretching) void S.stretching[k];
    for (const k in S.missing) void S.missing[k];
    U.compSel?.from; U.compSel?.to; U.compSel?.clipId; rows(); bndHover(); dirtyGrid = true;
  });
  // envelope focus and point selection: only the automation clips involved are repainted
  let envDrawn: Id[] = [];
  effect(() => {
    const hv = envHover(), sel = U.autoSel, ids: Id[] = [];
    if (hv) ids.push(hv.clip);
    if (sel) { ids.push(sel.clip); void [...sel.idx]; }
    const P = rawOf(S.project), all = new Set([...envDrawn, ...ids]);
    for (const c of P.clips) if (all.has(c.id)) damageClip(c, P);
    envDrawn = ids;
  });
  effect(() => { U.bw; U.start; S.project.loop?.a; S.project.loop?.b; cw(); dirtyRuler = true; });
  effect(() => { for (const m of S.project.markers ?? []) { void m.at; void m.name; } mkDrag(); mkHover(); dirtyRuler = true; });

  /** The grid view of one frame; `at` places it on a region of the tile (tile-local CSS px). */
  const frameView = (): View => ({
    offX: 0, offY: 0, W: 0, H: 0, bw: U.bw, snap: U.snap, spb: 60 / S.project.bpm, tops: tops(), sel: new Set(U.sel), editable: editable(), recArmedBg: S.transport.rec, env: envHover(), autoSel: U.autoSel ? { clip: U.autoSel.clip, idx: [...U.autoSel.idx] } : null,
    rows: rows().map(r => r && { clip: rawOf(r.clip), comp: rawOf(r.comp) }), laneH: LANE_H, audition: { ...S.audition }, stretching: { ...S.stretching }, missing: { ...S.missing }, compSel: U.compSel ? { ...U.compSel } : null, bndHover: bndHover(), ver: lookVer,
  });
  const at = (v: View, t: Tile, r: Rect): View => ({ ...v, offX: t.x + r.x, offY: t.y + r.y, W: r.w, H: r.h });
  /** Draws the grid into `r` of the grid canvas only (clipped to whole device pixels: nothing is painted twice). */
  const paintGrid = (g: CanvasRenderingContext2D, v: View, t: Tile, r: Rect, dpr: number, rec: typeof recState | null) => {
    // the transform of a full paint, clipped to the region: a region repaint matches it pixel for pixel
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    g.fillStyle = T.grid; g.fillRect(r.x, r.y, r.w, r.h);
    drawGrid(g, { ...at(v, t, r), orgX: t.x, orgY: t.y }, rawOf(S.project), rec);
    g.restore();
  };
  /**
   * Grows damaged boxes over every clip they touch (until none cuts through one): a repaint edge
   * through a clip's rounded corner antialiases a few levels off a full paint, an edge on the
   * lane background never does.
   */
  const closeOverClips = (rs: Rect[]): Rect[] => {
    const P = rawOf(S.project), t = tops(), bw = U.bw;
    const out = rs.map(r => ({ ...r }));
    for (let pass = 0; pass < 4; pass++) {
      let grew = false;
      for (const c of P.clips) {
        const tr = P.tracks[c.track]; if (!tr || t[c.track] == null) continue;
        const x0 = c.start * bw - 2, x1 = x0 + Math.max(3, c.len * bw - 1) + 4, y0 = t[c.track] + 1, y1 = y0 + tr.h - 2;
        for (const r of out) {
          if (x1 <= r.x || x0 >= r.x + r.w || y1 <= r.y || y0 >= r.y + r.h) continue;
          if (x0 >= r.x && x1 <= r.x + r.w && y0 >= r.y && y1 <= r.y + r.h) continue;
          const nx = Math.min(r.x, x0), ny = Math.min(r.y, y0);
          r.w = Math.max(r.x + r.w, x1) - nx; r.h = Math.max(r.y + r.h, y1) - ny; r.x = nx; r.y = ny;
          grew = true;
        }
      }
      if (!grew) break;
    }
    return out;
  };
  /** Follow playback: scrolls before anything is drawn, so grid, ruler and playhead change in one frame. */
  const follow = (b: number) => {
    if (!U.follow || followHold || !tele.frame.playing || b < 0) return;
    const sl = scrollEl.scrollLeft, to = followScroll(b * U.bw, sl, cw());
    if (to === sl) return;
    scrollEl.scrollLeft = to;
    // the scroll event comes a frame later: the overview follows now
    setScroll({ x: scrollEl.scrollLeft, y: scrollEl.scrollTop });
  };

  const draw = (now: number) => {
    applyView();
    if (U.mixView) return; // under the Mix view: nothing to paint (following catches up on the way back)
    if (paintedFull && lastDrawAt) { paintGaps.push(now - lastDrawAt); if (paintGaps.length > 5) paintGaps.shift(); }
    lastDrawAt = now; paintedFull = false;
    const recActive = recState.active && tele.frame.playing;
    if (recActive && recState.version !== lastRecV) { dirtyGrid = true; lastRecV = recState.version; }
    else if (!recActive && lastRecV !== -1) { dirtyGrid = true; lastRecV = -1; }
    const dpr = window.devicePixelRatio || 1;
    if (fontEpoch !== fonts.epoch || themeEpoch !== theme.epoch || dpr !== lastDpr) { fontEpoch = fonts.epoch; themeEpoch = theme.epoch; lastDpr = dpr; dirtyGrid = dirtyRuler = dirtyOv = true; }
    if (editedPats.size) {
      const P = rawOf(S.project);
      for (const [id, len] of editedPats) {
        const p = P.patterns.find(x => x.id === id);
        if (!p) { dirtyGrid = dirtyFade = dirtyOv = true; continue; }
        if (p.len === len) continue;
        // its clips followed the new length: their new boxes, the fades and the overview too
        dirtyFade = dirtyOv = true;
        for (const c of P.clips) if (c.kind === 'pat' && c.ref === id) damageClip(c, P);
      }
      editedPats.clear();
    }
    const beat = curBeat();
    follow(beat);
    const sx = scrollEl.scrollLeft, sy = scrollEl.scrollTop, W = cw(), H = ch();
    if (zoomed) {
      zoomed = false; zoomAt = now;
      if (tile && tileBw && !dirtyGrid && heavyPaint()) stretched = true; else dirtyGrid = true;
    }
    if (stretched && tile) {
      const k = U.bw / tileBw, x0 = tile.x * k, x1 = (tile.x + tile.w) * k;
      const covers = x0 <= sx + 0.5 && (x1 >= sx + W - 0.5 || x1 >= gridW() - 1) && tile.y <= sy + 0.5 && (tile.y + tile.h >= sy + H - 0.5 || tile.y + tile.h >= gridH() - 1);
      if (dirtyGrid || damage.length || !covers || k > 2 || k < 0.5 || now - zoomAt > ZOOM_SETTLE_MS) { stretched = false; dirtyGrid = true; }
      else {
        // the same pixels at the new zoom; ruler, overview and playhead are cheap and stay exact
        gridCv.style.transform = fadeCv.style.transform = `translate(${x0}px, ${tile.y}px) scaleX(${k})`;
        const rt: Tile = { x: snapPx(Math.max(0, sx - 96), dpr), y: 0, w: Math.min(gridW(), W + 192), h: 26 };
        paintRuler(rt, dpr);
        if (dirtyOv) { dirtyOv = false; bumpOv(); }
        placePlayhead(beat);
        return;
      }
    }
    const plan = planTile(dirtyGrid ? null : tile, sx, sy, W, H, gridW(), gridH(), dpr);
    const t = plan.tile, moved = !tile || t.x !== tile.x || t.y !== tile.y || t.w !== tile.w || t.h !== tile.h;
    const rects = plan.full ? [] : damageRects(damage.length ? closeOverClips(damage) : damage, t, dpr);
    const full = plan.full || rects === null;
    damage = [];
    if (full || moved || rects!.length) {
      const rec = recActive ? recState : null, v = frameView();
      if (full) fitCanvas(gridCv, t.w, t.h);
      const g = gridCv.getContext('2d')!;
      if (full) { paintGrid(g, v, t, { x: 0, y: 0, w: t.w, h: t.h }, dpr, rec); tileBw = U.bw; paintedFull = true; }
      else {
        if (moved) {
          // shift what is already drawn, then draw only the exposed strips
          shiftCanvas(gridCv, Math.round(plan.dx * dpr), Math.round(plan.dy * dpr));
          for (const r of plan.strips) paintGrid(g, v, t, r, dpr, rec);
        }
        for (const r of rects!) paintGrid(g, v, t, r, dpr, rec);
      }
      dirtyGrid = false;
      if (full || moved) {
        gridCv.style.width = fadeCv.style.width = t.w + 'px';
        gridCv.style.height = fadeCv.style.height = t.h + 'px';
        gridCv.style.transform = fadeCv.style.transform = `translate(${t.x}px, ${t.y}px)`;
        dirtyFade = true;
      }
      tile = t;
    }
    // fades and the loop range: an overlay, so dragging them repaints no clip
    if (dirtyFade) {
      dirtyFade = false;
      fitCanvas(fadeCv, t.w, t.h);
      const g = fadeCv.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, fadeCv.width, fadeCv.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const P = rawOf(S.project);
      if (P.loop) { g.fillStyle = rgba(T.green, 0.05); g.fillRect(P.loop.a * U.bw - t.x, 0, (P.loop.b - P.loop.a) * U.bw, Math.min(t.h, gridH() - t.y)); }
      const fv = at(frameView(), t, { x: 0, y: 0, w: t.w, h: t.h });
      drawFades(g, fv, P);
      // stacked clips: recomputed with the overlay, i.e. on clip edits and tile moves, never per frame
      drawOverlaps(g, fv, P, laneOverlaps(P.clips));
    }
    // the ruler is cheap: redrawn whole whenever its tile moves
    if (dirtyRuler || !rulerTile || rulerTile.x !== t.x || rulerTile.w !== t.w) paintRuler(t, dpr);
    if (dirtyOv) { dirtyOv = false; bumpOv(); }
    placePlayhead(beat);
  };
  const paintRuler = (t: Tile, dpr: number) => {
    dirtyRuler = false;
    rulerTile = t;
    fitCanvas(rulerCv, t.w, RULER_H);
    const g = rulerCv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRuler(g, t.x, t.w, U.bw, S.project.loop, U.start);
    const ms = shownMarkers();
    drawMarkerTicks(g, t.x, t.w, ms, U.bw, RULER_H);
    rulerCv.style.width = t.w + 'px';
    rulerCv.style.transform = `translateX(${t.x}px)`;
    if (!mkCv) return;
    if (!ms?.length) return;
    fitCanvas(mkCv, t.w, MARKER_H);
    const mg = mkCv.getContext('2d')!;
    mg.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMarkers(mg, t.x, t.w, markerBoxes(ms, U.bw), mkDrag()?.id ?? mkHover());
    mkCv.style.width = t.w + 'px';
    mkCv.style.transform = `translateX(${t.x}px)`;
  };
  /** The playhead lives in grid coordinates like the canvases: it scrolls with them. */
  const placePlayhead = (beat: number) => {
    const x = Math.max(0, beat) * U.bw;
    if (x !== lastPhX) {
      lastPhX = x;
      phGrid.style.transform = phRuler.style.transform = `translateX(${x}px)`;
    }
  };

  onMount(() => {
    geom.grid = gridEl; geom.scroll = scrollEl;
    const ro = new ResizeObserver(() => { setVw(scrollEl.clientWidth); setVh(scrollEl.clientHeight); });
    ro.observe(scrollEl);
    const onScroll = () => setScroll({ x: scrollEl.scrollLeft, y: scrollEl.scrollTop });
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    scrollEl.addEventListener('wheel', onWheel, { passive: false });
    gridCv.style.transformOrigin = fadeCv.style.transformOrigin = '0 0';
    const stop = addFrameTask(draw);
    onCleanup(() => { ro.disconnect(); stop(); scrollEl.removeEventListener('scroll', onScroll); scrollEl.removeEventListener('wheel', onWheel); });
  });

  // the user moved the view while playing: stop following until the next Play (no tug of war)
  let followHold = false;
  const holdFollow = () => {
    if (!U.follow || !U.playing || followHold) return;
    followHold = true; say(tl('a.pl.followPaused'));
  };
  watch(() => U.playing, p => { if (p) followHold = false; });
  watch(() => U.follow, f => { if (f) followHold = false; }, { defer: true });
  // ---------- wheel ----------
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) holdFollow();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); holdFollow();
      const r = scrollEl.getBoundingClientRect(), mx = e.clientX - r.left - U.headW;
      const v = viewNow(), beat = (v.x + mx) / v.bw;
      const bw = clamp(v.bw * (e.deltaY < 0 ? 1.15 : 1 / 1.15), A.BW_MIN, A.BW_MAX);
      queueView(bw, beat * bw - mx, v.y);
    } else if (e.altKey) {
      e.preventDefault();
      const d = e.deltaY < 0 ? 6 : -6;
      wheelEdit('heights', tl('a.pl.trackHeights'), S.project.tracks.map(t => ({ op: 'putTrack', track: { ...plain(t), h: clamp(t.h + d, LANE_H_MIN, LANE_H_MAX) } }) as Op));
    }
  };

  // ---------- view navigation: pan, edge auto-scroll, zoom ----------
  /** The clip area on screen (client px): the view without the track headers, the ruler and the scrollbar. */
  const viewRect = () => {
    const r = scrollEl.getBoundingClientRect();
    return { left: r.left + U.headW, top: r.top + rowH(), right: r.left + scrollEl.clientWidth, bottom: r.top + scrollEl.clientHeight };
  };
  const syncScroll = () => setScroll({ x: scrollEl.scrollLeft, y: scrollEl.scrollTop });
  /** Scrolls by (dx, dy) px; false when the view could not move (at its ends). */
  const scrollByPx = (dx: number, dy: number) => {
    const x0 = scrollEl.scrollLeft, y0 = scrollEl.scrollTop;
    scrollEl.scrollLeft = x0 + dx; scrollEl.scrollTop = y0 + dy;
    const moved = scrollEl.scrollLeft !== x0 || scrollEl.scrollTop !== y0;
    if (moved) syncScroll();
    // a drag that carries the view along (edge auto-scroll) is the user moving it: follow pauses.
    // A plain click or edit on the grid does not (FL keeps following).
    if (scrollEl.scrollLeft !== x0) holdFollow();
    return moved;
  };
  /**
   * `track` with edge auto-scroll: dragged near or past the clip area's edge, the view scrolls and
   * `move` runs again with the last pointer event. A `move` must read positions in grid
   * coordinates (the grid's live rect), so what is dragged keeps up with the view.
   */
  const trackEdge = (move: (e: PointerEvent) => void, up: ((e: PointerEvent) => void) | null, cursor: string, axes?: { x?: boolean; y?: boolean }) => {
    const es = edgeScroller(viewRect, scrollByPx, move, axes);
    track(ev => { move(ev); es.move(ev); }, ev => { es.stop(); up?.(ev); }, cursor);
  };
  const gridLeft = () => gridEl.getBoundingClientRect().left;
  /** Middle-button drag anywhere in the playlist pans it in both directions (FL). */
  const panDown = (e: PointerEvent) => {
    if (panDrag(e, () => ({ x: scrollEl.scrollLeft, y: scrollEl.scrollTop }), (x, y) => { scrollEl.scrollLeft = x; scrollEl.scrollTop = y; syncScroll(); })) { holdFollow(); closeMenu(); }
  };
  /** The last pointer position over the playlist (Page Up / Down zoom around it). */
  let lastPtr: { x: number; y: number } | null = null;
  /** Views to go back to with a plain Ctrl+right-click (saved before a range zoom, a preset or a fit). */
  const views: { bw: number; x: number; y: number }[] = [];
  const pushView = () => { views.push(viewNow()); if (views.length > 32) views.shift(); };
  const setView = (bw: number, x: number, y = viewNow().y) => {
    holdFollow(); // every user zoom (pointer steps, presets, fit, zoom box) goes through here
    queueView(clamp(bw, A.BW_MIN, A.BW_MAX), x, y);
  };
  const viewW = () => Math.max(1, scrollEl.clientWidth - U.headW);
  /** Zoom to `bw` around the pointer when it is over the clips, else around the middle of the view. */
  const zoomTo = (bw: number) => {
    const v = viewNow(), nb = clamp(bw, A.BW_MIN, A.BW_MAX); if (nb === v.bw) return;
    const r = viewRect(), p = lastPtr;
    const anchor = p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom ? p.x - r.left : viewW() / 2;
    setView(nb, zoomScroll(v.x, anchor, v.bw, nb), v.y);
  };
  const barsInView = () => barsText(Math.max(1, Math.round(viewW() / viewNow().bw / 4)));
  zoomImpl = {
    step: f => zoomTo(viewNow().bw * f),
    preset: i => { const bw = ZOOM_PRESETS[i]; if (bw == null) return; if (bw !== viewNow().bw) { pushView(); zoomTo(bw); } say(tl('a.pl.zoomPreset', { n: i + 1, bars: barsInView() })); },
    fit: () => {
      const span = fitSpan(songEnd(), 4, FIT_MIN_BEATS);
      pushView();
      setView(zoomToRange(0, span, viewW(), A.BW_MIN, A.BW_MAX).k, 0);
      say(tl('a.pl.zoomFit', { bars: barsText(Math.round(span / 4)) }));
    },
  };
  onCleanup(() => { zoomImpl = null; });
  const [zbox, setZbox] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Ctrl + right-drag: a box; on release the view zooms horizontally to it. A plain Ctrl+right-click goes back to the previous view. */
  function zoomBoxDrag(e: PointerEvent) {
    e.preventDefault(); closeMenu();
    const p0 = pt(e);
    let moved = false;
    trackEdge(ev => {
      const q = pt(ev);
      if (!moved && Math.abs(q.x - p0.x) < 4) return;
      moved = true;
      setZbox({ x0: p0.x, y0: p0.y, x1: q.x, y1: q.y });
    }, ev => {
      setZbox(null);
      if (!moved) {
        const v = views.pop();
        if (!v) { say(tl('a.pl.zoomNoBack')); return; }
        setView(v.bw, v.x, v.y);
        say(tl('a.pl.zoomBack'));
        return;
      }
      const q = pt(ev), a = clamp(Math.min(p0.beat, q.beat), 0, TOTAL), b = clamp(Math.max(p0.beat, q.beat), 0, TOTAL);
      if (b - a < 1e-6) return;
      pushView();
      const z = zoomToRange(a, b, viewW(), A.BW_MIN, A.BW_MAX);
      setView(z.k, z.scroll);
      say(tl('a.pl.zoomRange', { a: fmtPos(a), b: fmtPos(b) }));
    }, 'zoom-in');
  }

  // ---------- hit testing ----------
  const pt = (e: { clientX: number; clientY: number }) => gridPoint(e.clientX, e.clientY);
  function hit(x: number, y: number): Hit | null {
    const ti = trackAtY(y); if (ti < 0) return null;
    const P = rawOf(S.project), t = tops(), tr = P.tracks[ti], bw = U.bw, spb = 60 / P.bpm;
    const cs = P.clips;
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i]; if (c.track !== ti) continue;
      const cx = c.start * bw, cwid = Math.max(3, c.len * bw - 1), cy = t[ti] + 1;
      if (x < cx || x > cx + cwid || y < cy || y > cy + tr.h - 2) continue;
      return clipHit(c, x, y, cx, cwid, cy, spb);
    }
    return null;
  }

  /**
   * Empty space just outside a clip's start or end (EDGE_OUT px): that edge, so a trim needs no
   * pixel aim. Only a trim (and an automation point drawn there) uses it; a click, right-click or
   * double-click there still lands on empty space.
   */
  function nearEdge(x: number, y: number): { c: Clip; edge: 'l' | 'r' } | null {
    if (!editable()) return null;
    const ti = trackAtY(y); if (ti < 0) return null;
    const t = tops(), tr = S.project.tracks[ti], bw = U.bw, cy = t[ti] + 1;
    if (y < cy || y > cy + tr.h - 2) return null;
    let best: { c: Clip; edge: 'l' | 'r' } | null = null, bd = EDGE_OUT + 1;
    for (const c of rawOf(S.project).clips) {
      if (c.track !== ti) continue;
      const cx = c.start * bw, cwid = Math.max(3, c.len * bw - 1);
      const dl = cx - x, dr = x - (cx + cwid);
      if (dl > 0 && dl < bd) { bd = dl; best = { c, edge: 'l' }; }
      if (dr > 0 && dr < bd) { bd = dr; best = { c, edge: 'r' }; }
    }
    return best;
  }

  /** What a press inside clip `c` lands on: a fade or comp handle, a trim edge, its menu icon, or its body. */
  function clipHit(c: Clip, x: number, y: number, cx: number, cwid: number, cy: number, spb: number): Hit {
    const bw = U.bw;
    let edge: Hit['edge'] = null;
    {
      if ((c.kind === 'audio' || c.kind === 'comp') && editable() && cwid > 36 && y - cy >= 15 && y - cy <= 25) {
        const fi = cx + c.fadeIn / spb * bw, fo = cx + cwid - c.fadeOut / spb * bw;
        if (x >= fi - 1 && x <= fi + 8) edge = 'fi';
        else if (x >= fo - 8 && x <= fo + 1) edge = 'fo';
      }
      if (!edge && c.kind === 'comp' && editable() && y - cy >= 15) {
        const cp = compById(c.ref);
        if (cp && S.audition[cp.id] == null) {
          const bs = boundaries(cp.regions);
          for (let i = 0; i < bs.length; i++) {
            const bx = toTimeline(c, bs[i].at) * bw;
            if (Math.abs(x - bx) <= 4 && bx > cx + 3 && bx < cx + cwid - 3) return { c, edge: 'cb', bnd: i };
          }
        }
      }
      // narrow clips keep a body to grab: the trim zones shrink, and vanish on a sliver (the
      // zone outside the clip, EDGE_OUT, still trims it)
      const ez = cwid < 14 ? 0 : Math.min(EDGE_IN, cwid / 4);
      if (!edge) edge = x - cx < ez ? 'l' : cx + cwid - x < ez ? 'r' : null;
      // the icon in the clip's top-left corner opens its menu (FL), with either button
      if (!edge && cwid >= 36 && x - cx < 20 && y - cy < CLIP_HEAD) edge = 'menu';
    }
    return { c, edge, head: y - cy < CLIP_HEAD };
  }

  /** The take lane under a grid point, if any. */
  function laneHit(x: number, y: number): LaneHit | null {
    const ti = trackAtY(y); if (ti < 0) return null;
    const row = rows()[ti]; if (!row) return null;
    const dy = y - tops()[ti] - S.project.tracks[ti].h; if (dy < 0) return null;
    const k = Math.floor(dy / LANE_H), take = row.comp.takes[k]; if (!take) return null;
    return { ...row, ti, k, take, cb: toComp(row.clip, x / U.bw) };
  }
  // the clip-menu hint is said once: said on every clip it would wipe what the status line was telling
  let clipHinted = false;
  const hover = (e: PointerEvent) => {
    if (e.buttons) return;
    const p = pt(e), L = laneHit(p.x, p.y), h0 = L ? null : hit(p.x, p.y);
    const near = L || h0 ? null : nearEdge(p.x, p.y), h: Hit | null = h0 ?? near;
    if (L) { CA.compHover.clipId = L.clip.id; CA.compHover.cb = L.cb; }
    else if (h?.c.kind === 'comp') { CA.compHover.clipId = h.c.id; CA.compHover.cb = toComp(h.c, p.beat); }
    else CA.compHover.clipId = null;
    const bh = h?.edge === 'cb' ? { clipId: h.c.id, i: h.bnd! } : null, cur0 = bndHover();
    if ((bh?.clipId ?? -1) !== (cur0?.clipId ?? -1) || (bh?.i ?? -1) !== (cur0?.i ?? -1)) setBndHover(bh);
    if (L) { const c = editable() ? 'text' : toolCursor(); if (gridCv.style.cursor !== c) gridCv.style.cursor = c; return; }
    // an automation clip: its points and tension handles are live under the pointer (no edit mode)
    const prevEnv = envHover();
    if (h?.c.kind === 'auto' && editable()) {
      const hv = envAt(h.c, p.x, p.y);
      if (!prevEnv || prevEnv.clip !== h.c.id || !sameHit(prevEnv.hover, hv)) setEnvHover({ clip: h.c.id, hover: hv });
      if (!prevEnv || prevEnv.clip !== h.c.id) say(tl('a.pl.autoEditHint'));
      if (hv) { const c = hv.kind === 'point' ? 'move' : 'ns-resize'; if (gridCv.style.cursor !== c) gridCv.style.cursor = c; return; }
    } else if (prevEnv) setEnvHover(null);
    // the first time the pointer is on a clip: where its menu is and where a right-click deletes
    if (h0 && !clipHinted && h0.c.kind !== 'auto' && editable()) { clipHinted = true; say(tl('a.pl.clipRmbHint')); }
    let cur = toolCursor();
    if (h) {
      if (h.edge === 'menu') cur = 'pointer';
      else if (h.edge === 'fi' || h.edge === 'fo' || h.edge === 'cb') cur = 'col-resize';
      else if (h.edge) cur = editable() ? 'ew-resize' : toolCursor();
      else cur = editable() ? 'grab' : toolCursor();
    }
    if (gridCv.style.cursor !== cur) gridCv.style.cursor = cur;
  };

  // ---------- pointer interactions ----------
  const gridDown = (e: PointerEvent) => {
    if (e.button === 1) return; // the scroll view pans
    const modK = e.ctrlKey || e.metaKey;
    if (e.button === 2 && modK) return zoomBoxDrag(e);
    const p = pt(e), h = hit(p.x, p.y), id = h?.c.id ?? null;
    // right-click on a clip's name bar: its menu; on the rest of the clip: delete (FL)
    if (e.button === 2 && h?.head && h.edge !== 'cb') {
      e.preventDefault(); closeMenu();
      return openClipMenu(e.clientX, e.clientY, h.c, p);
    }
    if (h?.c.kind === 'auto' && editable() && (e.button === 0 || e.button === 2) && envDown(e, h.c, p.x, p.y)) return;
    const near = h || modK || laneHit(p.x, p.y) ? null : nearEdge(p.x, p.y);
    if (near && (e.button === 0 || e.button === 2)) {
      // an automation point drawn on the clip's edge reaches past it: the point, not a trim
      if (near.c.kind === 'auto' && envAt(near.c, p.x, p.y) && envDown(e, near.c, p.x, p.y)) return;
      if (e.button === 0 && U.tool !== 'erase' && U.tool !== 'mute' && U.tool !== 'slice') {
        e.preventDefault(); closeMenu();
        return resizeDrag(e, near.c, near.edge);
      }
    }
    if (U.autoSel && (!h || h.c.id !== U.autoSel.clip)) setU('autoSel', null);
    const L = laneHit(p.x, p.y);
    if (L) {
      e.preventDefault(); closeMenu();
      if (e.button === 2) { const sx = e.clientX, sy = e.clientY; track(() => {}, () => openTakeMenu(sx, sy, L, L.take)); return; }
      if (e.button === 0) return swipeDrag(e, L);
      return;
    }
    if (U.compSel && e.button === 0) setU('compSel', null);
    if (e.button === 2 && h?.edge === 'menu') { e.preventDefault(); closeMenu(); return openClipMenu(e.clientX, e.clientY, h.c, p); }
    if (e.button === 2) return rightDown(e, h, p);
    if (e.button !== 0) return;
    e.preventDefault(); closeMenu();
    A.songHere();
    const tool = U.tool;
    if (tool === 'erase') return eraseDrag(id);
    if (tool === 'mute') return muteDrag(id);
    if (tool === 'slice') return sliceDrag(e, p, id);
    if (modK || (tool === 'select' && id == null)) return marqueeDrag(e, p, id);
    if (h) {
      const clip = h.c;
      if (clip.kind !== 'comp') setU('cur', { kind: clip.kind, ref: clip.ref, clipId: clip.id });
      if (h.edge === 'menu') return openClipMenu(e.clientX, e.clientY, clip, p);
      if (h.edge === 'fi' || h.edge === 'fo') return fadeDrag(e, clip, h.edge);
      if (h.edge === 'cb') return boundaryDrag(e, clip, h.bnd!);
      if (h.edge === 'l' || h.edge === 'r') return resizeDrag(e, clip, h.edge);
      return moveDrag(e, clip, e.shiftKey);
    }
    if (p.track < 0) { setU('sel', []); return; }
    const cur = U.cur; if (!cur || !srcOf({ kind: cur.kind, ref: cur.ref } as Clip)) return;
    // Picking an existing clip chooses that region, not just its underlying source.
    // The ID is resolved at draw time, so trimming it after the first click is respected.
    const template = cur.clipId == null ? null : S.project.clips.find(c => c.id === cur.clipId && c.kind === cur.kind && c.ref === cur.ref);
    const len = template?.len ?? srcLenBeats(cur.kind, cur.ref);
    const start = clamp(snapFloor(p.beat, unit(e.altKey)), 0, TOTAL - Math.min(len, TOTAL));
    const nc: Clip = template
      ? placeClipCopy(plain(template), allocId(), p.track, start)
      : { ...newClip(allocId(), p.track, start, Math.min(len, TOTAL - start), cur.kind, cur.ref), ...(cur.kind === 'audio' ? sharedSound(S.project.clips, cur.ref) : {}) };
    const g = new Gesture(tool === 'paint' ? tl('a.pl.paintClips') : tl('a.pl.insertClip'));
    g.update([{ op: 'putClips', clips: [nc] }]);
    setU('sel', [nc.id]);
    if (tool === 'paint') return paintDrag(g, nc);
    moveDrag(e, nc, false, g);
  };

  function moveDrag(e: PointerEvent, clip: Clip, clone: boolean, fresh?: Gesture) {
    const g = fresh ?? new Gesture(clone ? tl('a.pl.copyClips') : tl('a.pl.moveClips'));
    const ids = U.sel.includes(clip.id) ? [...U.sel] : [clip.id];
    const idSet = new Set(ids);
    let orig = plain(S.project.clips.filter(c => idSet.has(c.id)));
    let lead = clip.id;
    setU('sel', ids);
    // a clip with others hidden under it ("×N"): say so before the drag reveals them
    const hidden = laneOverlaps(rawOf(S.project).clips.filter(c => c.track === clip.track)).covers.get(clip.id);
    if (hidden) say(tl('a.pl.stacked', { n: hidden + 1 }));
    const sx = e.clientX, sy = e.clientY, n = S.project.tracks.length, gx0 = sx - gridLeft();
    const t0 = trackAtYClamped(sy - gridEl.getBoundingClientRect().top);
    let moved = false, lastD = NaN, lastDt = NaN;
    trackEdge(ev => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
      if (!moved && clone) {
        const copies = orig.map(c => ({ ...c, id: allocId() }));
        lead = copies[orig.findIndex(c => c.id === clip.id)].id;
        orig = copies;
        g.update([{ op: 'putClips', clips: copies }]);
        setU('sel', copies.map(c => c.id));
      }
      moved = true;
      const o = orig.find(c => c.id === lead)!;
      const raw = (ev.clientX - gridLeft() - gx0) / U.bw;
      // snap the distance moved, not the start: a clip placed off the grid keeps its offset (as FL Studio does)
      const d0 = snapRound(raw, unit(ev.altKey));
      const dt0 = trackAtYClamped(ev.clientY - gridEl.getBoundingClientRect().top) - t0;
      const [d, dt] = clampMove(orig, d0, dt0, n);
      // most pointer moves land on the same snapped place: nothing to apply, send or repaint
      if (d === lastD && dt === lastDt) return;
      lastD = d; lastDt = dt;
      g.update([{ op: 'putClips', clips: moveClips(orig, d, dt) }]);
      const src = srcOf(o);
      say((clone ? tl('a.pl.copyPrefix') : '') + (src ? src.name : '') + ' → ' + fmtPos(o.start + d) + ' · ' + (S.project.tracks[o.track + dt]?.name ?? ''));
    }, () => g.end(), 'grabbing');
  }

  function resizeDrag(e: PointerEvent, clip: Clip, edge: 'l' | 'r') {
    if (U.stretchMode) {
      if (clip.kind === 'audio') return stretchDrag(e, clip, edge);
      // only audio stretches: anything else trims, and says why
      say(tl(clip.kind === 'comp' ? 'a.pl.stretchComp' : 'a.pl.stretchNotAudio'));
    }
    const g = new Gesture(tl('a.pl.resizeClip'));
    const o = plain(clip), sx = e.clientX, gx0 = sx - gridLeft();
    const srcLenOf = (c: Clip) => (c.kind === 'audio' || c.kind === 'comp' ? clipSrcLen(c) : Infinity);
    // the shortest a trim leaves a clip: one grid unit; with Alt (off the grid) a 64th, whatever the zoom
    const minOf = (alt: boolean) => (alt ? 1 / 16 : Math.max(1 / 16, snapRes(U.snap, U.bw) || 1 / 16));
    // the edge of a selected clip trims the whole selection by the same amount (FL / Ableton)
    const others = U.sel.includes(o.id) ? S.project.clips.filter(c => c.id !== o.id && U.sel.includes(c.id)).map(plain) : [];
    let last = [o, ...others].map(c => c.start + ':' + c.len).join('|'), moved = false;
    trackEdge(ev => {
      if (!moved && Math.abs(ev.clientX - sx) < 3) return; // a click on an edge is not a trim
      moved = true;
      const raw = (ev.clientX - gridLeft() - gx0) / U.bw, edge0 = edge === 'r' ? o.start + o.len : o.start;
      const minL = minOf(ev.altKey);
      const nc = resizeClip(o, edge, snapRound(edge0 + raw, unit(ev.altKey)), minL, srcLenOf(o));
      const delta = (edge === 'r' ? nc.start + nc.len : nc.start) - edge0;
      const all = [nc, ...resizeClips(others, edge, delta, minL, srcLenOf)];
      const key = all.map(c => c.start + ':' + c.len).join('|');
      if (key === last) return;
      last = key;
      g.update([{ op: 'putClips', clips: all }]);
      say(tl('a.pl.startLen', { pos: fmtPos(nc.start), len: nc.len.toFixed(2) }));
    }, () => g.end(), 'ew-resize', { x: true });
  }

  /** Stretch mode: the edge of an audio clip makes it play longer or shorter (the selected audio
   *  clips by the same factor); the other edge stays. */
  function stretchDrag(e: PointerEvent, clip: Clip, edge: 'l' | 'r') {
    const g = new Gesture(tl('a.pl.stretchClip'));
    const o = plain(clip), sx = e.clientX, gx0 = sx - gridLeft();
    // the shortest a trim leaves a clip: one grid unit; with Alt (off the grid) a 64th, whatever the zoom
    const minOf = (alt: boolean) => (alt ? 1 / 16 : Math.max(1 / 16, snapRes(U.snap, U.bw) || 1 / 16));
    const others = U.sel.includes(o.id) ? S.project.clips.filter(c => c.id !== o.id && c.kind === 'audio' && U.sel.includes(c.id)).map(plain) : [];
    let last = '', moved = false;
    trackEdge(ev => {
      if (!moved && Math.abs(ev.clientX - sx) < 3) return; // a click on an edge is not a stretch
      moved = true;
      const raw = (ev.clientX - gridLeft() - gx0) / U.bw, edge0 = edge === 'r' ? o.start + o.len : o.start;
      const target = snapRound(edge0 + raw, unit(ev.altKey));
      const minL = minOf(ev.altKey);
      const nc = stretchClip(o, edge, target, minL);
      const all = [nc, ...stretchClips(others, edge, nc.len / o.len, minL)];
      const key = all.map(c => c.start + ':' + c.len).join('|');
      if (key === last) return;
      last = key;
      g.update([{ op: 'putClips', clips: all }]);
      // the pointer went past what the stretch range (or the song) allows
      const want = edge === 'r' ? target - o.start : o.start + o.len - target;
      const capped = Math.abs(want - nc.len) > 1e-6 && (nc.stretch === STRETCH_MAX || nc.stretch === STRETCH_MIN);
      say(tl('a.pl.stretchLen', { k: (nc.stretch ?? 1).toFixed(2), len: nc.len.toFixed(2) }) + (capped ? ' · ' + tl('a.pl.stretchLimit') : ''));
    }, () => g.end(), 'ew-resize', { x: true });
  }

  function fadeDrag(e: PointerEvent, clip: Clip, which: 'fi' | 'fo') {
    const g = new Gesture(which === 'fi' ? 'Fade in' : 'Fade out');
    const o = plain(clip), sx = e.clientX, spb = 60 / S.project.bpm;
    // a fade handle of a selected clip fades every selected audio clip by the same amount
    const all = [o, ...(U.sel.includes(o.id) ? S.project.clips.filter(c => c.id !== o.id && U.sel.includes(c.id) && (c.kind === 'audio' || c.kind === 'comp')).map(plain) : [])];
    let moved = false;
    track(ev => {
      if (!moved && Math.abs(ev.clientX - sx) < 3) return; // a click on the handle is not a fade
      moved = true;
      const d = (ev.clientX - sx) / U.bw * spb;
      const out = all.map(c => { const max = c.len * spb; return which === 'fi' ? { ...c, fadeIn: clamp(c.fadeIn + d, 0, max - c.fadeOut) } : { ...c, fadeOut: clamp(c.fadeOut - d, 0, max - c.fadeIn) }; });
      const nc = out[0];
      g.update([{ op: 'putClips', clips: out }]);
      say((which === 'fi' ? 'Fade in ' : 'Fade out ') + Math.round((which === 'fi' ? nc.fadeIn : nc.fadeOut) * 1000) + ' ms');
    }, () => g.end(), 'ew-resize');
  }

  /** Paint (FL): a clip under the pointer wherever it goes — left or right, and onto other lanes. */
  function paintDrag(g: Gesture, first: Clip) {
    const taken = new Set<string>([first.track + ':0']);
    let lastBeat = first.start, lastTrack = first.track;
    trackEdge(ev => {
      const q = pt(ev), tr = q.track < 0 ? lastTrack : q.track, add: Clip[] = [];
      // every cell along the line from the last pointer sample to this one (beat and lane both), so a
      // fast sweep leaves no gaps and a diagonal one paints the lanes it crosses, not only the last
      const steps = Math.max(1, Math.ceil(Math.abs(q.beat - lastBeat) / first.len), Math.abs(tr - lastTrack));
      for (let k = 1; k <= steps; k++) {
        const b = lastBeat + (q.beat - lastBeat) * k / steps, lane = Math.round(lastTrack + (tr - lastTrack) * k / steps);
        for (const cell of paintCells(first, b, lane, S.project.tracks.length, TOTAL, taken)) {
          taken.add(cell.key);
          add.push({ ...first, id: allocId(), start: cell.start, track: cell.track });
        }
      }
      lastBeat = q.beat; lastTrack = tr;
      if (add.length) { g.update([{ op: 'putClips', clips: add }]); setU('sel', [...U.sel, ...add.map(c => c.id)]); }
    }, () => g.end(), 'copy');
  }

  /**
   * Slice (FL): a click cuts the clip under the pointer; dragged down or up, the line cuts every
   * clip it crosses on the lanes in between, as one undo step.
   */
  function sliceDrag(e: PointerEvent, p: { beat: number; track: number; x: number; y: number }, id: Id | null) {
    const b = snapRound(p.beat, unit(e.altKey)), x = b * U.bw, t0 = p.track;
    let t1 = t0, dragged = false;
    trackEdge(ev => {
      const q = pt(ev);
      if (!dragged && Math.abs(ev.clientY - e.clientY) < 4) return;
      dragged = true;
      if (q.track >= 0) t1 = q.track;
      setU('marquee', { x0: x, y0: p.y, x1: x, y1: q.y });
      const n = sliceAcross(rawOf(S.project).clips, b, t0, t1, () => 0).length / 2;
      say(tl('a.pl.sliceLine', { pos: fmtPos(b), n }));
    }, ev => {
      setU('marquee', null);
      if (ev.type !== 'pointerup') return;
      if (!dragged) { if (id) A.sliceAt(id, b, false); return; }
      if (t0 < 0) return;
      const cut = sliceAcross(S.project.clips.map(plain), b, t0, t1, allocId);
      if (!cut.length) return;
      commit([{ op: 'putClips', clips: cut }], tl('a.pl.sliceClips'));
      say(tl('a.pl.sliceLine', { pos: fmtPos(b), n: cut.length / 2 }));
    }, 'col-resize', { y: true });
  }

  function eraseDrag(id: Id | null) {
    const g = new Gesture(tl('a.pl.deleteClips'));
    const del = (cid: Id | null | undefined) => {
      if (cid == null || !S.project.clips.some(c => c.id === cid)) return;
      g.update([{ op: 'removeClips', ids: [cid] }]);
      if (U.sel.includes(cid)) setU('sel', U.sel.filter(x => x !== cid));
    };
    del(id);
    track(ev => { const p = pt(ev); del(hit(p.x, p.y)?.c.id); }, () => g.end(), 'not-allowed');
  }

  function muteDrag(id: Id | null) {
    if (id == null) return;
    const g = new Gesture(tl('a.pl.muteClips'));
    const val = !S.project.clips.find(c => c.id === id)!.muted;
    const set = (cid: Id | undefined) => {
      const c = S.project.clips.find(x => x.id === cid);
      if (c && c.muted !== val) g.update([{ op: 'putClips', clips: [{ ...plain(c), muted: val }] }]);
    };
    set(id);
    track(ev => { const p = pt(ev); set(hit(p.x, p.y)?.c.id); }, () => g.end());
  }

  function marqueeDrag(e: PointerEvent, p: { x: number; y: number }, clickId: Id | null) {
    const initial = [...U.sel];
    const base = e.shiftKey ? initial : [];
    const x0 = p.x, y0 = p.y;
    // Over a clip, wait for drag movement so a plain Ctrl+click can still toggle it.
    let dragging = clickId == null;
    if (dragging) setU({ marquee: { x0, y0, x1: x0, y1: y0 }, sel: base });
    const update = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 3) return;
      dragging = true;
      const q = pt(ev), bw = U.bw, t = tops();
      const ax = Math.min(x0, q.x), bx = Math.max(x0, q.x), ay = Math.min(y0, q.y), by = Math.max(y0, q.y);
      const clips = rawOf(S.project).clips;
      const hits = clips.filter(c => c.start * bw < bx && (c.start + c.len) * bw > ax && t[c.track] < by && t[c.track + 1] > ay).map(c => c.id);
      const sel = [...new Set([...base, ...hits])], cur = U.sel;
      // the box moves every frame, the selection only when it crosses a clip
      const same = sel.length === cur.length && sel.every((id, i) => id === cur[i]);
      setU(same ? { marquee: { x0, y0, x1: q.x, y1: q.y } } : { marquee: { x0, y0, x1: q.x, y1: q.y }, sel });
    };
    trackEdge(update, ev => {
      if (ev.type === 'pointerup' && clickId != null && !dragging) {
        update(ev);
        if (!dragging) setU('sel', initial.includes(clickId) ? initial.filter(id => id !== clickId) : [...initial, clickId]);
      }
      setU('marquee', null);
      say(tl('a.pl.selected', { n: U.sel.length }));
    }, 'crosshair');
  }

  function rightDown(e: PointerEvent, h: Hit | null, p: { beat: number; track: number }) {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let g: Gesture | null = null;
    const del = (cid: Id | undefined) => {
      if (cid == null || !g || !S.project.clips.some(c => c.id === cid)) return;
      g.update([{ op: 'removeClips', ids: [cid] }]);
      if (U.sel.includes(cid)) setU('sel', U.sel.filter(x => x !== cid));
    };
    // FL: a right-click on a clip's body deletes it at once and a right-drag deletes what it crosses
    // (one undo step). Its name bar opens the menu (handled before this); a comp boundary keeps its menu.
    const start = () => { g = new Gesture(tl('a.pl.deleteClips')); dragCursor('not-allowed'); del(h?.c.id); };
    if (h && h.edge !== 'cb') start();
    track(ev => {
      if (!g && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) start();
      if (g) { const q = pt(ev); del(hit(q.x, q.y)?.c.id); }
    }, () => {
      dragCursor(null);
      if (g) { g.end(); return; }
      if (h?.edge === 'cb') openBoundaryMenu(sx, sy, h.c, h.bnd!);
      // FL: a right-click on empty space only drops the selection, no menu
      else if (!h && U.sel.length) setU('sel', []);
    });
  }

  const gridDbl = (e: MouseEvent) => {
    const p = pt(e), h = hit(p.x, p.y); if (!h) return;
    if (h.c.kind === 'comp') { if (!U.sel.includes(h.c.id)) setU('sel', [h.c.id]); CA.toggleTakes(h.c.track); return; }
    // the envelope handles its own double-clicks (add / delete a point, straighten); on the header: every point
    if (h.c.kind === 'auto') {
      const a = autoById(h.c.ref);
      if (a && p.y < envGeom(h.c).by) { setU('autoSel', { clip: h.c.id, idx: a.points.map((_, i) => i) }); say(tl('a.pl.ptsSelected', { n: a.points.length })); }
      return;
    }
    setU('cur', { kind: h.c.kind, ref: h.c.ref, clipId: h.c.id });
    if (h.c.kind === 'audio') A.openEditor(h.c.id);
    if (h.c.kind === 'pat') openPattern(h.c.ref);
  };

  // ---------- automation envelope editing (inline, after a double-click on an automation clip) ----------
  const envGeom = (c: Clip) => {
    const t = tops(), tr = S.project.tracks[c.track], cy = t[c.track] + 1, by = cy + 15, bh = tr.h - 2 - 15, pad = 3;
    return { by, bh, X: (tt: number) => (c.start + tt - c.offset) * U.bw, Y: (v: number) => by + pad + (1 - v) * (bh - 2 * pad), T: (x: number) => x / U.bw - c.start + c.offset, V: (y: number) => clamp(1 - (y - by - pad) / (bh - 2 * pad), 0, 1) };
  };
  /** `envGeom` with the points where they are drawn: one on the clip's edge just inside it. */
  const pickGeom = (c: Clip) => insetGeom(envGeom(c), c.start * U.bw, c.start * U.bw + Math.max(3, c.len * U.bw - 1));
  const sameHit = (a: EnvHit | null, b: EnvHit | null) => a === b || (!!a && !!b && a.kind === b.kind && a.i === b.i);
  /** The point or handle of automation clip `c` under (x, y): none on its header or beyond its envelope. */
  const envAt = (c: Clip, x: number, y: number): EnvHit | null => {
    const a = autoById(c.ref); if (!a) return null;
    const G = pickGeom(c); if (y < G.by || G.bh < 14) return null;
    return hitEnv(a.points, G, x, y);
  };
  const putEnv = (a: Automation, points: AutoPoint[]): Op => ({ op: 'putAutomation', automation: { ...plain(a), points } });
  const withTension = (q: AutoPoint, k: number): AutoPoint => { const { tension: _t, ...r } = q; return Math.abs(k) < 1e-3 ? r : { ...r, tension: k }; };
  const valText = (a: Automation, v: number) => autoValueText(rawOf(S.project), S.catalog, a.target, v);
  /** Straightens the segments ending at `idx` (tension back to 0). */
  const straighten = (a: Automation, idx: number[]) => {
    commit([putEnv(a, plain(a.points).map((q, i) => (idx.includes(i) ? withTension(q, 0) : q)))], tl('a.pl.straighten'));
    say(tl('a.pl.straighten'));
  };
  /**
   * A press on an automation clip's envelope (below its header). Points and handles work without
   * an edit mode, as in FL: drag a point (Shift locks the value, Ctrl the time, Alt skips the
   * snap); drag a handle to bend (Ctrl: finer); double-click a point to delete it, a handle to
   * straighten, empty envelope to add a point; Ctrl+drag selects points; right-click adds a point
   * (held: placed by the drag), opens a point's menu, or straightens a handle. False: not ours
   * (the clip moves as any clip).
   */
  const envDown = (e: PointerEvent, c: Clip, x: number, y: number): boolean => {
    const a = autoById(c.ref); if (!a) return false;
    const G = envGeom(c);
    if (y < G.by || G.bh < 14) return false;
    if (e.button === 0 && (U.tool === 'erase' || U.tool === 'mute' || U.tool === 'slice')) return false;
    const pts = plain(a.points), hit = hitEnv(pts, pickGeom(c), x, y), modK = e.ctrlKey || e.metaKey;
    e.preventDefault(); closeMenu();
    if (!U.sel.includes(c.id)) setU('sel', [c.id]);
    if (e.button === 2) {
      if (hit?.kind === 'point') { const sx = e.clientX, sy = e.clientY, i = hit.i; track(() => {}, () => openPointMenu(sx, sy, c, i)); return true; }
      if (hit?.kind === 'handle') { straighten(a, [hit.i]); return true; }
      addAndDrag(e, c, a, G, x, y);
      return true;
    }
    if (hit?.kind === 'point') {
      if (dblCheck('ap' + c.id + ':' + hit.i)) {
        const left = deletePoints(pts, new Set([hit.i]));
        if (!left) { say(tl('a.pl.autoMinPoint')); return true; }
        commit([putEnv(a, left)], tl('a.pl.deletePoint')); setU('autoSel', null); say(tl('a.pl.pointDeleted'));
        return true;
      }
      const cur = U.autoSel?.clip === c.id ? U.autoSel.idx : [];
      if (e.shiftKey && !modK) {
        // Shift+click: add to / take from the selection
        const next = cur.includes(hit.i) ? cur.filter(i => i !== hit.i) : [...cur, hit.i].sort((p, q) => p - q);
        setU('autoSel', next.length ? { clip: c.id, idx: next } : null);
        say(tl('a.pl.ptsSelected', { n: next.length }));
        return true;
      }
      const sel = cur.includes(hit.i) ? cur : [hit.i];
      setU('autoSel', { clip: c.id, idx: sel });
      pointDrag(e, c, a, G, pts, sel, hit.i, new Gesture(tl('a.pl.movePoint')));
      return true;
    }
    if (hit?.kind === 'handle') {
      if (dblCheck('ah' + c.id + ':' + hit.i)) { straighten(a, [hit.i]); return true; }
      tensionDrag(e, a, pts, hit.i);
      return true;
    }
    if (modK) { pointMarquee(e, c, a, G, e.shiftKey); return true; }
    if (dblCheck('ab' + c.id)) { addAndDrag(e, c, a, G, x, y); return true; }
    setU('autoSel', null);
    return false;
  };
  /** Envelope time at grid x, on the playlist's snap (Alt: free). */
  const envT = (c: Clip, G: ReturnType<typeof envGeom>, x: number, free: boolean) => snapRound(G.T(x) + c.start - c.offset, unit(free)) - c.start + c.offset;
  function pointDrag(e: PointerEvent, c: Clip, a: Automation, G: ReturnType<typeof envGeom>, pts0: AutoPoint[], sel: number[], lead: number, g: Gesture) {
    const set = new Set(sel), l = pts0[lead], sx = e.clientX, sy = e.clientY;
    let moved = false;
    track(ev => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      const q = pt(ev);
      // the point under the pointer snaps; the rest of the selection follows by as much
      const dt = ev.ctrlKey || ev.metaKey ? 0 : envT(c, G, q.x, ev.altKey) - l.t;
      const dv = ev.shiftKey ? 0 : G.V(q.y) - l.v;
      const m = movePoints(pts0, set, dt, dv);
      g.update([putEnv(a, m.points)]);
      const p = m.points[lead];
      say(a.name + ' · ' + valText(a, p.v) + ' · ' + fmtPos(c.start + p.t - c.offset) + (sel.length > 1 ? ' · ' + tl('a.pl.ptsSelected', { n: sel.length }).split(' · ')[0] : ''));
    }, () => g.end(), 'grabbing');
  }
  function tensionDrag(e: PointerEvent, a: Automation, pts0: AutoPoint[], i: number) {
    const A0 = pts0[i - 1], B0 = pts0[i], k0 = B0.tension ?? 0, sy = e.clientY;
    const g = new Gesture(tl('a.pl.bend'));
    track(ev => {
      const k = dragTension(k0, ev.clientY - sy, A0, B0, ev.ctrlKey || ev.metaKey);
      g.update([putEnv(a, pts0.map((q, j) => (j === i ? withTension(q, k) : q)))]);
      say(B0.shape === 'stairs' ? tl('a.pl.steps', { n: stairsOf(k) }) : B0.shape === 'pulse' || B0.shape === 'wave' ? tl('a.pl.cycles', { n: cyclesOf(k) }) : tl('a.pl.bend') + ' · ' + Math.round(k * 100) + '%');
    }, () => g.end(), 'ns-resize');
  }
  /** Adds a point at the press and keeps it under the pointer until release (FL's right-click). */
  function addAndDrag(e: PointerEvent, c: Clip, a: Automation, G: ReturnType<typeof envGeom>, x: number, y: number) {
    const { points, i } = addPoint(plain(a.points), Math.max(0, envT(c, G, x, e.altKey)), G.V(y));
    const g = new Gesture(tl('a.pl.addPoint'));
    g.update([putEnv(a, points)]);
    setU('autoSel', { clip: c.id, idx: [i] });
    say(a.name + ' · ' + valText(a, points[i].v) + ' · ' + fmtPos(c.start + points[i].t - c.offset));
    pointDrag(e, c, a, G, points, [i], i, g);
  }
  /** Ctrl+drag on an envelope: a box that selects its points (Shift adds to the selection). */
  function pointMarquee(e: PointerEvent, c: Clip, a: Automation, G: ReturnType<typeof envGeom>, additive: boolean) {
    const p0 = pt(e), base = additive && U.autoSel?.clip === c.id ? U.autoSel.idx : [];
    setU({ marquee: { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y }, autoSel: base.length ? { clip: c.id, idx: base } : null });
    track(ev => {
      const q = pt(ev);
      const idx = [...new Set([...base, ...pointsInBox(a.points, G, p0.x, p0.y, q.x, q.y)])].sort((m, n) => m - n);
      setU({ marquee: { x0: p0.x, y0: p0.y, x1: q.x, y1: q.y }, autoSel: idx.length ? { clip: c.id, idx } : null });
    }, () => {
      setU('marquee', null);
      const n = U.autoSel?.clip === c.id ? U.autoSel.idx.length : 0;
      say(n ? tl('a.pl.ptsSelected', { n }) : tl('a.pl.autoEditHint'));
    }, 'crosshair');
  }
  /** A point's menu: its value, the curve of the segment(s) ending at it, delete. Acts on the
   *  whole selection when the point is in it. */
  function openPointMenu(x: number, y: number, c: Clip, i: number) {
    const a = autoById(c.ref); if (!a || !a.points[i]) return;
    const sel = U.autoSel?.clip === c.id && U.autoSel.idx.includes(i) ? [...U.autoSel.idx] : [i];
    const segs = sel.filter(j => j > 0), q = a.points[i];
    const shapes: [CurveShape, string][] = [['curve', 'a.pl.shape.curve'], ['double', 'a.pl.shape.double'], ['hold', 'a.pl.shape.hold'], ['stairs', 'a.pl.shape.stairs'],
      ['pulse', 'a.pl.shape.pulse'], ['wave', 'a.pl.shape.wave'], ['halfSine', 'a.pl.shape.halfSine']];
    const shapeOf = (j: number) => a.points[j].shape ?? 'curve';
    const items: MenuItem[] = [
      { t: 'title', label: valText(a, q.v) + ' · ' + fmtPos(c.start + q.t - c.offset) + (sel.length > 1 ? ' · ×' + sel.length : '') },
      { t: 'item', label: tl('a.pl.typeValue'), act: () => openRename(x, y, valText(a, q.v), txt => {
        const v = parseAutoValue(rawOf(S.project), S.catalog, a.target, txt);
        if (v == null) { say(tl('a.pl.badValue', { v: txt })); return; }
        const cur = autoById(c.ref); if (!cur) return;
        commit([putEnv(cur, plain(cur.points).map((p, j) => (sel.includes(j) ? { ...p, v } : p)))], tl('a.pl.movePoint'));
        say(cur.name + ' · ' + valText(cur, v));
      }, tl('a.pl.valueTitle')) },
      { t: 'sep' },
      { t: 'sec', label: tl('a.pl.curveType') },
      ...shapes.map(([sh, key]): MenuItem => ({
        t: 'item', label: tl(key as Parameters<typeof tl>[0]), disabled: !segs.length, checked: segs.length > 0 && segs.every(j => shapeOf(j) === sh),
        act: () => { commit([putEnv(a, setShape(plain(a.points), segs, sh))], tl('a.pl.curveType') + ' · ' + tl(key as Parameters<typeof tl>[0])); },
      })),
      { t: 'item', label: tl('a.pl.straighten'), disabled: !segs.some(j => a.points[j].tension), act: () => straighten(a, segs) },
      { t: 'sep' },
      { t: 'item', label: tl('a.pl.deletePoint') + (sel.length > 1 ? ' ×' + sel.length : ''), kbd: 'Del', danger: true, act: () => { setU('autoSel', { clip: c.id, idx: sel }); A.deleteAutoPoints(); } },
    ];
    openMenu(x, y, items, 40 + items.length * 26);
  }

  // ---------- menus ----------
  // ---------- swipe comping ----------
  /** Dragging across a take lane writes that range of the take into the comp. */
  function swipeDrag(e: PointerEvent, L: LaneHit) {
    const clip = plain(L.clip), comp = plain(L.comp), take = plain(L.take);
    const lo = Math.max(take.start, clip.offset), hi = Math.min(takeEnd(take), clip.offset + clip.len);
    if (hi <= lo) { say(tl('a.pl.takeOutside', { name: take.name })); return; }
    const at = (ev: PointerEvent) => clamp(toComp(clip, snapRound(pt(ev).beat, unit(ev.altKey))), lo, hi);
    const a = at(e), sx = e.clientX;
    let g: Gesture | null = null;
    track(ev => {
      if (!g && Math.abs(ev.clientX - sx) < 3) return;
      const b = at(ev), from = Math.min(a, b), to = Math.max(a, b);
      if (to - from < 1e-6) return;
      if (!g) g = new Gesture('Comping');
      g.update([{ op: 'putComp', comp: { ...comp, regions: writeRange(comp, take.id, from, to) } }]);
      setU('compSel', { clipId: clip.id, from, to });
      say(take.name + ' · ' + fmtPos(toTimeline(clip, from)) + ' – ' + fmtPos(toTimeline(clip, to)) + tl('a.pl.takeHint'));
    }, () => {
      if (g) { g.end(); return; }
      setU('compSel', null);
      say(tl('a.pl.swipeHint'));
    }, 'text');
  }
  function boundaryDrag(e: PointerEvent, clip: Clip, i: number) {
    const cp = compById(clip.ref); if (!cp) return;
    const comp = plain(cp), c = plain(clip), b = boundaries(comp.regions)[i]; if (!b) return;
    const g = new Gesture(tl('a.pl.compBoundary')), sx = e.clientX;
    track(ev => {
      if (Math.abs(ev.clientX - sx) < 2) return;
      const cb = toComp(c, snapRound(pt(ev).beat, unit(ev.altKey)));
      const regions = moveBoundary(comp, b, cb, 1 / 32);
      g.update([{ op: 'putComp', comp: { ...comp, regions } }]);
      const r = b.left >= 0 ? regions[b.left].to : regions[b.right].from;
      say(tl('a.pl.compBoundaryAt', { pos: fmtPos(toTimeline(c, r)) }));
    }, () => g.end(), 'col-resize');
  }
  function openBoundaryMenu(x: number, y: number, clip: Clip, i: number) {
    const comp = compById(clip.ref); if (!comp) return;
    const b = boundaries(comp.regions)[i]; if (!b) return;
    const cur = boundaryXfade(comp, b), own = (b.right >= 0 ? comp.regions[b.right] : comp.regions[b.left])?.xfade;
    const set = (v: number | null, label: string) => { CA.putComp({ ...plain(comp), regions: setBoundaryXfade(comp, b, v) }, tl('a.pl.boundaryXfade')); say(label); };
    openMenu(x, y, [
      { t: 'title', label: tl('a.pl.boundaryTitle', { pos: fmtPos(toTimeline(clip, b.at)), ms: Math.round(cur * 1000) }) },
      { t: 'chips', label: 'Crossfade', options: XF.map(v => v * 1000 + ' ms'), active: XF.findIndex(v => Math.abs(v - cur) < 1e-6), pick: k => set(XF[k], tl('a.pl.boundaryXfadeMs', { ms: XF[k] * 1000 })) },
      { t: 'item', label: tl('a.pl.compDefault', { ms: Math.round(comp.xfade * 1000) }), disabled: own == null, act: () => set(null, tl('a.pl.boundaryXfadeDef')) },
    ], 130);
  }

  function openClipMenu(x: number, y: number, c: Clip, p: { beat: number }) {
    if (!U.sel.includes(c.id)) setU('sel', [c.id]);
    if (c.kind === 'comp') return openCompMenu(x, y, c, p);
    const src = srcOf(c), isPat = c.kind === 'pat';
    // Rename and the swatches change what the clip plays (the pattern, sample or automation): every
    // clip of it follows. The menu says so, with how many clips that is (FL: "Rename / color pattern")
    const copies = S.project.clips.filter(v => v.kind === c.kind && v.ref === c.ref).length;
    const what = (k: 'pat' | 'audio' | 'auto') => tl(k === 'pat' ? 'a.pl.whatPat' : k === 'audio' ? 'a.pl.whatAudio' : 'a.pl.whatAuto');
    const scopeLabel = (k: 'pat' | 'audio' | 'auto') => copies > 1 ? tl('a.pl.colourOfN', { what: what(k), n: copies }) : tl('a.pl.colourOf', { what: what(k) });
    const scopeTip = (k: 'pat' | 'audio' | 'auto') => copies > 1 ? tl('a.pl.scopeTipN', { what: what(k), n: copies }) : tl('a.pl.scopeTip', { what: what(k) });
    if (c.kind === 'auto') {
      const a = autoById(c.ref);
      openMenu(x, y, [
        { t: 'title', label: tl('a.pl.autoPrefix') + (a?.name ?? '') },
        { t: 'item', label: tl('a.pl.renameAuto'), title: scopeTip('auto'), act: () => openRename(x, y, a?.name ?? '', v => A.setSrcProp(c, { name: v })) },
        { t: 'sec', label: scopeLabel('auto') },
        { t: 'swatches', current: a?.color, pick: col => A.setSrcProp(c, { color: col }) },
        { t: 'sep' },
        { t: 'item', label: c.muted ? tl('a.pl.unmute') : tl('a.pl.mute'), kbd: 'Alt+M', act: A.toggleMuteSel },
        { t: 'item', label: tl('a.pl.duplicate'), kbd: 'Ctrl+B', act: A.duplicate },
        { t: 'item', label: tl('a.pl.splitHere'), act: () => A.sliceAt(c.id, snapRound(p.beat, unit(false))) },
        { t: 'item', label: tl('a.pl.selAllAuto'), act: () => setU('sel', S.project.clips.filter(v => v.kind === 'auto' && v.ref === c.ref).map(v => v.id)) },
        { t: 'sep' },
        { t: 'item', label: tl('a.pl.deleteClip'), kbd: 'Del', danger: true, act: () => A.delIds(U.sel.includes(c.id) ? [...U.sel] : [c.id]) },
        { t: 'item', label: tl('a.pl.deleteAutoAll'), danger: true, act: () => { commit([{ op: 'removeAutomation', id: c.ref }], tl('a.pl.deleteAuto')); setU('autoSel', null); } },
      ], 380);
      return;
    }
    const all = () => setU('sel', S.project.clips.filter(v => v.kind === c.kind && v.ref === c.ref).map(v => v.id));
    const items: MenuItem[] = [
      { t: 'title', label: (isPat ? 'Pattern · ' : 'Audio · ') + (src?.name ?? '') },
      { t: 'item', label: tl(isPat ? 'a.pl.renamePat' : 'a.pl.renameAudio'), title: scopeTip(isPat ? 'pat' : 'audio'), act: () => openRename(x, y, src?.name ?? '', v => A.setSrcProp(c, { name: v })) },
      { t: 'sec', label: scopeLabel(isPat ? 'pat' : 'audio') },
      { t: 'swatches', current: (src as { color?: string } | undefined)?.color, pick: col => A.setSrcProp(c, { color: col }) },
      { t: 'sec', label: tl('a.pl.secEdit') },
      { t: 'item', label: c.muted ? tl('a.pl.unmute') : tl('a.pl.mute'), kbd: 'Alt+M', act: A.toggleMuteSel },
      { t: 'item', label: tl('a.pl.duplicate'), kbd: 'Ctrl+B', act: A.duplicate },
      { t: 'sub', label: tl('a.pl.clipboard'), items: [
        { t: 'item', label: tl('a.pl.copy'), kbd: 'Ctrl+C', act: A.copy },
        { t: 'item', label: tl('a.pl.cut'), kbd: 'Ctrl+X', act: A.cut },
      ] },
      { t: 'sub', label: tl('a.pl.split'), items: [
        { t: 'item', label: tl('a.pl.splitHere'), act: () => A.sliceAt(c.id, snapRound(p.beat, unit(false))) },
        { t: 'item', label: tl('a.pl.splitAtHead'), act: () => A.sliceAt(c.id, curBeat()) },
      ] },
      ...(isPat ? [
        { t: 'sec', label: 'Pattern' } as MenuItem,
        { t: 'item', label: tl('a.pl.editPattern'), kbd: tl('a.pl.dblClick'), act: () => openPattern(c.ref) } as MenuItem,
        { t: 'item', label: tl('a.pl.makeUnique'), act: () => A.makeUnique(c) } as MenuItem,
      ] : [
        { t: 'sec', label: 'Audio' } as MenuItem,
        { t: 'gain', clipId: c.id } as MenuItem,
        ...(c.kind === 'audio' ? [
          ...(c.ref in S.missing ? [{ t: 'item', label: tl('d.miss.menu'), title: S.missing[c.ref], act: () => setU('missingOpen', true) } as MenuItem] : []),
          { t: 'item', label: tl('a.pl.makeUnique'), title: tl('a.pl.makeUniqueAudioTip'), act: () => A.makeUnique(c) } as MenuItem,
          { t: 'item', label: tl('a.pl.editSample'), kbd: tl('a.pl.dblClick'), act: () => A.openEditor(c.id) } as MenuItem,
          ...(FORK.vocal ? [{ t: 'item', label: tl('a.pl.editPitch'), kbd: c.tune?.notes.length ? tl('a.pl.edited') : '', act: () => A.openPitchEditor(c.id) } as MenuItem] : []),
          // a playlist drop plays the source directly; this adds the rack entry for it (FL's audio clip channel)
          { t: 'item', label: tl('a.pl.toSampler'), title: tl(hasSamplerOf(c.ref) ? 'a.pl.toSamplerHave' : 'a.pl.toSamplerTip'), disabled: hasSamplerOf(c.ref), act: () => addSampler(c.ref) } as MenuItem,
          // how a stretch plays (the clip's stretch factor in the label: set it in Stretch mode)
          { t: 'chips', label: tl('a.pl.stretchMethod', { k: (c.stretch ?? 1).toFixed(2) }), options: [tl('a.pl.keepPitch'), tl('a.pl.resample')], active: c.resample ? 1 : 0, pick: (i: number) => A.setStretchMethod(c, i === 1) } as MenuItem,
          ...(S.stretching[c.id] ? [{ t: 'item', label: tl('a.pl.stretchFailed'), title: S.stretching[c.id], disabled: true, act: () => {} } as MenuItem] : []),
          { t: 'item', label: tl('a.pl.detectTempoKey'), act: () => A.openMusicAnalysis({ clipId: c.id }) } as MenuItem,
          { t: 'item', label: tl('a.pl.trimRegion'), title: tl('d.smp.trim.tip'), act: () => void A.trimClip(c.id) } as MenuItem,
          ...(FORK.analysis ? [{ t: 'item', label: tl('a.pl.extractStems'), title: tl('a.pl.extractStemsTip'), act: () => openStems(c.id) } as MenuItem] : []),
          ...(FORK.vocal ? [{ t: 'sub', label: tl('a.pl.autoVocal'), items: [
            { t: 'item', label: tl('a.pl.autoVocalSing'), act: () => void A.autoVocal(c.id, 'natural'), title: tl('a.pl.autoVocalSingTip') },
            { t: 'item', label: tl('a.pl.autoVocalRap'), act: () => void A.autoVocal(c.id, 'hard'), title: tl('a.pl.autoVocalRapTip') },
          ] } as MenuItem] : []),
        ] : []),
      ]),
      { t: 'sec', label: tl('a.pl.secMix') },
      { t: 'item', label: tl('a.pl.inPlace'), kbd: 'Ctrl+Alt+E', title: tl('a.pl.inPlaceTip'), act: () => void A.exportInPlace(c) },
      ...(S.project.loop ? [{ t: 'item', label: tl('a.pl.inPlaceRange'), title: tl('a.pl.inPlaceRangeTip'), disabled: !A.rangeInPlaceClips().length, act: () => void A.exportRangeInPlace() } as MenuItem] : []),
      { t: 'item', label: tl('a.pl.mixerChannel'), act: () => openRouteMenu(c.track, x, y) },
      { t: 'item', label: tl('a.pl.selAllSource'), act: all },
      { t: 'sep' },
      { t: 'item', label: tl('a.pl.delete'), kbd: 'Del', danger: true, act: () => A.delIds(U.sel.includes(c.id) ? [...U.sel] : [c.id]) },
    ];
    openMenu(x, y, items, 420);
  }
  function openCompMenu(x: number, y: number, c: Clip, p: { beat: number }) {
    const comp = compById(c.ref); if (!comp) return;
    const tr = S.project.tracks[c.track], open = !!(tr && U.takesOpen[tr.id]);
    const aud = S.audition[comp.id], unused = unusedTakes(comp).length;
    openMenu(x, y, [
      { t: 'title', label: comp.name + ' · ' + CA.takesLabel(comp.takes.length) },
      { t: 'item', label: open ? tl('a.pl.hideTakes') : tl('a.pl.showTakes'), kbd: tl('a.pl.dblClick'), act: () => CA.toggleTakes(c.track) },
      ...(aud != null ? [{ t: 'item', label: tl('a.pl.endSoloPrev'), act: () => CA.audition(comp.id, null) } as MenuItem] : []),
      { t: 'item', label: tl('a.pl.rename'), act: () => openRename(x, y, comp.name, v => CA.renameComp(comp, v)) },
      { t: 'chips', label: 'Crossfade', options: XF.map(v => v * 1000 + ' ms'), active: XF.findIndex(v => Math.abs(v - comp.xfade) < 1e-6), pick: k => CA.setXfade(comp, XF[k]) },
      { t: 'sep' },
      { t: 'item', label: c.muted ? tl('a.pl.unmute') : tl('a.pl.mute'), kbd: 'Alt+M', act: A.toggleMuteSel },
      { t: 'item', label: tl('a.pl.duplicate'), kbd: 'Ctrl+B', act: A.duplicate, title: tl('a.pl.dupCompTip') },
      { t: 'item', label: tl('a.pl.copy'), kbd: 'Ctrl+C', act: A.copy },
      { t: 'item', label: tl('a.pl.cut'), kbd: 'Ctrl+X', act: A.cut },
      { t: 'item', label: tl('a.pl.splitHere'), act: () => A.sliceAt(c.id, snapRound(p.beat, unit(false))) },
      { t: 'gain', clipId: c.id },
      { t: 'item', label: tl('a.pl.mixerChannel'), act: () => openRouteMenu(c.track, x, y) },
      { t: 'sep' },
      { t: 'item', label: tl('a.pl.removeUnused') + (unused ? ' (' + unused + ')' : ''), disabled: !unused, act: () => CA.removeUnused(comp) },
      { t: 'item', label: tl('a.pl.flattenComp'), title: tl('a.pl.flattenTip'), act: () => CA.flatten(c.id) },
      ...(FORK.vocal ? [{ t: 'sub', label: tl('a.pl.autoVocal'), items: [
        { t: 'item', label: tl('a.pl.autoVocalSing'), title: tl('a.pl.autoVocalCompTip'), act: () => void A.autoVocalComp(c.id, 'natural') },
        { t: 'item', label: tl('a.pl.autoVocalRap'), act: () => void A.autoVocalComp(c.id, 'hard') },
      ] } as MenuItem] : []),
      { t: 'sep' },
      { t: 'item', label: tl('a.pl.delete'), kbd: 'Del', danger: true, act: () => A.delIds(U.sel.includes(c.id) ? [...U.sel] : [c.id]) },
    ], 470);
  }

  // ---------- ruler (ui/timeRuler: the same gestures in the Piano roll and the Pitch editor) ----------
  const ruler: RulerHost = {
    // the grid's live rect: the view may scroll under the drag (edge auto-scroll)
    beatAt: x => (x - gridLeft()) / U.bw,
    bw: () => U.bw,
    unit: alt => unit(alt),
    max: () => TOTAL,
    loop: () => S.project.loop ?? null,
    edit: label => { const g = new Gesture(label); return { set: r => g.update([{ op: 'setLoop', loop: { a: r.a, b: r.b } }]), end: () => g.end() }; },
    clear: () => { A.setLoop(null, tl('a.pl.deleteLoop')); say(tl('a.pl.loopDeleted')); },
    seek: b => A.seekSong(b),
    drawn: r => A.seekSong(r.a),
    track: (m, u, c) => trackEdge(m, u, c, { x: true }),
    key: 'ruler',
    menu: e => timelineMenu(e),
  };
  const rulerHover = (e: PointerEvent) => { (e.currentTarget as HTMLElement).style.cursor = rulerCursor(ruler, e); };
  const rulerDown = (e: PointerEvent) => { if (e.button === 0) closeMenu(); rulerPress(ruler, e); };
  /** Right-click (no drag) on the ruler or an empty part of the marker strip: add a marker there (FL). The ruler opens it on release (`ruler.menu`); the keyboard's menu key still reaches it here. */
  const timelineMenu = (e: MouseEvent) => {
    e.preventDefault();
    const at = clamp(snapRound(ruler.beatAt(e.clientX), unit(e.altKey)), 0, TOTAL);
    openMenu(e.clientX, e.clientY, [
      { t: 'title', label: fmtPos(at) },
      { t: 'item', label: tl('a.mk.addHere'), act: () => void MK.addMarker(at) },
      { t: 'item', label: tl('a.mk.add'), kbd: 'Alt+T', title: tl('a.mk.addTip'), act: () => void MK.addMarker() },
    ], 110);
  };

  // ---------- markers (FL's time markers): a strip above the ruler while the song has any ----------
  /** The marker under client x, from the layout as it is drawn now. */
  const markerAt = (clientX: number): Id | null => markerAtX(markerBoxes(shownMarkers(), U.bw), clientX - gridLeft());
  MK.setMarkerAnchor(id => {
    const m = S.project.markers?.find(x => x.id === id), r = mkRow?.getBoundingClientRect(), sr = scrollEl?.getBoundingClientRect();
    if (!m || !r || !sr) return null;
    return { x: clamp(r.left + m.at * U.bw, sr.left + U.headW, sr.right - 240), y: r.top + MARKER_H + 2 };
  });
  onCleanup(() => MK.setMarkerAnchor(null));
  const markerHover = (e: PointerEvent) => {
    if (mkDrag()) return;
    const id = markerAt(e.clientX);
    if (id !== mkHover()) setMkHover(id);
    (e.currentTarget as HTMLElement).style.cursor = id != null ? 'grab' : rulerCursor(ruler, e);
  };
  const markerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    closeMenu();
    const id = markerAt(e.clientX), m = id != null ? S.project.markers?.find(x => x.id === id) : undefined;
    if (!m) {
      // an empty part of the strip: double-click adds a marker, otherwise it is the ruler
      if (dblCheck('mkstrip')) { e.preventDefault(); MK.addMarker(clamp(snapRound(ruler.beatAt(e.clientX), unit(e.altKey)), 0, TOTAL)); return; }
      rulerPress(ruler, e);
      return;
    }
    e.preventDefault();
    // FL: double-click a marker = the section up to the next one (here: looped)
    if (dblCheck('mk' + m.id)) { MK.loopSection(m.id); return; }
    const x0 = e.clientX, from = m.at;
    let lifted = false, cancelled = false, at = from;
    const esc = escCancels(() => lifted, () => { cancelled = true; setMkDrag(null); say(tl('a.mk.moveCancel')); });
    trackEdge(ev => {
      if (cancelled) return;
      if (!lifted) { if (Math.abs(ev.clientX - x0) < 4) return; lifted = true; }
      const b = clamp(snapRound(from + (ev.clientX - x0) / U.bw, unit(ev.altKey)), 0, TOTAL);
      if (b === at && mkDrag()) return;
      at = b; setMkDrag({ id: m.id, at });
      say(`${m.name || tl('a.mk.unnamed')} · ${fmtPos(at)}`);
    }, () => {
      esc.off();
      setMkDrag(null);
      if (!lifted) { MK.jumpTo(m.id); return; }
      if (cancelled || at === from) return;
      const cur = S.project.markers?.find(x => x.id === m.id);
      if (cur) commit([{ op: 'putMarker', marker: { ...plain(cur), at } }], tl('a.mk.undoMove'));
    }, 'grabbing', { x: true });
  };
  const markerMenu = (e: MouseEvent) => {
    const id = markerAt(e.clientX), m = id != null ? S.project.markers?.find(x => x.id === id) : undefined;
    if (!m) return timelineMenu(e);
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { t: 'title', label: (m.name || tl('a.mk.unnamed')) + ' · ' + fmtPos(m.at) },
      { t: 'item', label: tl('a.mk.jumpHere'), act: () => MK.jumpTo(m.id) },
      { t: 'item', label: tl('a.mk.loop'), kbd: tl('a.mk.dblClick'), title: tl('a.mk.loopTip'), act: () => MK.loopSection(m.id) },
      { t: 'item', label: tl('a.mk.rename'), act: () => MK.renameMarker(m.id) },
      { t: 'sep' },
      { t: 'item', label: tl('a.mk.delete'), danger: true, act: () => MK.deleteMarker(m.id) },
    ], 200);
  };

  // ---------- header splitter ----------
  const headSplit = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, w0 = U.headW;
    track(ev => setU('headW', clamp(w0 + ev.clientX - sx, 150, 360)), null, 'col-resize');
  };

  const mq = () => { const m = U.marquee; return m && { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0) }; };

  // ---------- overview bar (FL-style: on top, a minimap of the song under the view's thumb) ----------
  /** Beats the overview spans: the song plus some room, at least what is visible. */
  // memos: this was a walk over every clip through the store on each scroll / zoom step
  const songEnd = createMemo(() => {
    arrVersion();
    let end = 0;
    for (const c of rawOf(S.project).clips) end = Math.max(end, c.start + c.len);
    return end;
  });
  const ovRange = createMemo(() => Math.min(TOTAL, Math.max(64, songEnd() * 1.15 + 16, (scroll().x + cw()) / U.bw)));
  // repainted when the frame loop says the arrangement changed (a drag changes it on every move)
  const [ovVer, setOvVer] = createSignal(0);
  const bumpOv = () => setOvVer(v => v + 1);
  const ovView = (): ZRange => ({ pos: scroll().x / U.bw, len: cw() / U.bw });
  const ovLimits = () => ({ total: ovRange(), minLen: cw() / A.BW_MAX, maxLen: cw() / A.BW_MIN });
  const ovChange = (r: ZRange) => {
    holdFollow();
    const bw = clamp(cw() / r.len, A.BW_MIN, A.BW_MAX);
    queueView(bw, Math.max(0, r.pos * bw), viewNow().y);
  };
  // FL: the vertical scrollbar zooms the lanes too — drag it to scroll, drag an end to make every
  // lane taller or shorter (they keep their proportions), Ctrl+wheel over it zooms. Its unit is the
  // average lane, so a position stays put while the lanes change height. Heights are view state
  // (no undo step), like Alt+wheel.
  const laneAvg = () => { const t = S.project.tracks; return t.length ? t.reduce((a, x) => a + x.h, 0) / t.length : 56; };
  const vRange = (): ZRange => { const a = laneAvg(); return { pos: scroll().y / a, len: ch() / a }; };
  const vLimits = () => { const a = laneAvg(); return { total: Math.max(gridH() + 40, ch()) / a, minLen: ch() / LANE_H_MAX, maxLen: ch() / LANE_H_MIN }; };
  const setV = (r: ZRange) => {
    const a = laneAvg(), want = clamp(ch() / r.len, LANE_H_MIN, LANE_H_MAX);
    if (S.project.tracks.length && Math.abs(want - a) > 0.25) {
      const f = want / a;
      wheelEdit('heights', tl('a.pl.trackHeights'), S.project.tracks.map(t => ({ op: 'putTrack', track: { ...plain(t), h: clamp(t.h * f, LANE_H_MIN, LANE_H_MAX) } }) as Op));
    }
    const place = () => { scrollEl.scrollTop = Math.max(0, r.pos * laneAvg()); syncScroll(); };
    place(); requestAnimationFrame(place); // the taller lanes are laid out by the next frame
  };
  function paintOverview(g: CanvasRenderingContext2D, W: number, H: number, span: number) {
    const P = rawOf(S.project), n = Math.max(1, P.tracks.length);
    const lh = Math.max(1, (H - 4) / n);
    for (const c of P.clips) {
      const t = P.tracks[c.track]; if (!t) continue;
      g.globalAlpha = c.muted ? 0.25 : 0.75; g.fillStyle = t.color;
      g.fillRect(c.start / span * W, 2 + c.track * lh, Math.max(1, c.len / span * W), Math.max(1, lh - (lh > 2 ? 0.5 : 0)));
    }
    g.globalAlpha = 1;
  }

  return (
    <div class="plwrap" onPointerDown={() => A.playlistFront()}>
      <div class="ovrow tools">
        <PlaylistTools />
        <ZoomScrollbar orient="h" class="ov" range={ovView} limits={ovLimits} onChange={ovChange} title={tl('a.pl.ovTip')}
          paint={paintOverview} paintKey={ovVer} />
      </div>
      <div class="plbody">
      <div ref={scrollEl} class="plscroll" onPointerDown={panDown} onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
        onPointerMove={e => { lastPtr = { x: e.clientX, y: e.clientY }; }} onPointerLeave={() => { lastPtr = null; }}>
        <div style={{ width: U.headW + gridW() + 'px', position: 'relative' }}>
          <div class="rulerRow" style={{ height: rowH() + 'px' }}>
            <div class="plhead" style={{ width: U.headW + 'px' }}>
              <Show when={mkH()}><div class="mkhead" style={{ height: MARKER_H + 'px' }}>{tl('a.mk.menu')}</div></Show>
            </div>
            <div ref={mkRow} style={{ position: 'relative', width: gridW() + 'px', height: rowH() + 'px', flex: 'none' }}>
              <div class="phtile"><div ref={phRuler} class="phead" style={{ height: rowH() + 'px' }} /></div>
              <Show when={mkH()}>
                <canvas ref={el => { mkCv = el; dirtyRuler = true; }} class="ruler mkstrip" title={tl('a.mk.stripTip')} style={{ height: MARKER_H + 'px' }}
                  onPointerDown={markerDown} onPointerMove={markerHover} onPointerLeave={() => setMkHover(null)} onContextMenu={markerMenu} />
              </Show>
              <canvas ref={rulerCv} class="ruler" title={tl('a.pl.rulerTip')} style={{ top: mkH() + 'px' }}
                onPointerDown={rulerDown} onPointerMove={rulerHover} onContextMenu={e => { e.preventDefault(); if (e.button !== 2) timelineMenu(e); }} />

            </div>
          </div>
          <div style={{ display: 'flex', position: 'relative' }}>
            <Show when={laneDrag()}>{d => <div class="laneDropLine" style={{ top: d().y - 1 + 'px', width: U.headW + gridW() + 'px' }} />}</Show>
            <div class="lanesCol" style={{ width: U.headW + 'px' }}>
              <For each={S.project.tracks}>{(t, i) => <><LaneHeader t={t} i={i()} auto={laneIcons()[i()] ?? null} /><TakeHeaders i={i()} /></>}</For>
              <button class="addTrack" onClick={A.addTrack}>{tl('a.pl.addTrack')}</button>
              <div class="hsplit" onPointerDown={headSplit} title={tl('a.pl.headSplitTip')} />
            </div>
            <div ref={gridEl} class="gridArea" style={{ width: gridW() + 'px', height: gridH() + 'px' }}>
              <div class="phtile"><div ref={phGrid} class="phead" style={{ height: gridH() + 'px' }} /></div>
              <canvas ref={gridCv} class="gridCanvas" style={{ cursor: toolCursor() }}
                onPointerDown={gridDown} onPointerMove={hover} onDblClick={gridDbl} onContextMenu={e => e.preventDefault()} />
              <canvas ref={fadeCv} class="gridCanvas gridOverlay" />
              <Show when={mq()}>{m => <div class="marquee" style={{ left: m().x + 'px', top: m().y + 'px', width: m().w + 'px', height: m().h + 'px' }} />}</Show>
              <Show when={zbox()}>{z => <div class="zoombox" style={{ left: Math.min(z().x0, z().x1) + 'px', top: Math.min(z().y0, z().y1) + 'px', width: Math.abs(z().x1 - z().x0) + 'px', height: Math.abs(z().y1 - z().y0) + 'px' }} />}</Show>
            </div>
          </div>
        </div>
      </div>
        <ZoomScrollbar orient="v" class="plv" range={vRange} limits={vLimits} onChange={setV} title={tl('a.pl.vbarTip')} />
      </div>
      <Show when={U.dragOver}>
        <div class="dropHint"><span>{tl('a.pl.dropHint')}</span></div>
      </Show>
    </div>
  );
}

// ---------- lane headers & routing ----------
export function openRouteMenu(i: number, x: number, y: number) {
  const t = S.project.tracks[i]; if (!t) return;
  openMenu(x, y, [{ t: 'title', label: tl('a.pl.toMixer', { name: t.name }) }, ...routeItems(i)], 340);
}
/** Where track `i` plays: the master (the default) or a mixer insert the user picks. */
function routeItems(i: number): MenuItem[] {
  const t = S.project.tracks[i]; if (!t) return [];
  return S.project.inserts.map(m => {
    // the label is captured at menu build: the row's toast matches what the row showed,
    // even if the insert was renamed (or replaced in the array) while the menu was open
    const label = insName(m);
    return { t: 'item', label, kbd: t.insert === m.id ? '●' : '', act: () => {
      A.setTrack(i, { insert: m.id }, 'Routing'); A.selectInsert(m.id); say(t.name + ' → ' + label);
    } } as MenuItem;
  });
}

function openLaneMenu(x: number, y: number, i: number) {
  const t = S.project.tracks[i];
  openMenu(x, y, [
    { t: 'title', label: t.name },
    { t: 'item', label: tl('a.pl.rename'), act: () => openRename(x, y, t.name, v => A.setTrack(i, { name: v }, tl('a.pl.trackName'))) },
    { t: 'swatches', current: t.color, pick: col => A.setTrack(i, { color: col }, tl('a.pl.trackColor')) },
    { t: 'icons', current: t.icon, color: t.color, pick: id => A.setTrack(i, { icon: id }, tl('a.pl.trackIcon')) },
    { t: 'sep' },
    { t: 'item', label: t.muted ? tl('a.pl.unmute') : tl('a.pl.mute'), act: () => A.toggleTrackMute(i) },
    { t: 'item', label: t.solo ? tl('a.pl.soloOff') : 'Solo', act: () => A.toggleTrackSolo(i) },
    { t: 'item', label: t.arm ? tl('a.pl.disarm') : tl('a.pl.arm'), act: () => A.armTrack(i) },
    { t: 'sub', label: tl('a.pl.routeItem'), items: routeItems(i) },
    { t: 'item', label: tl('a.pl.selTrackClips'), act: () => setU('sel', S.project.clips.filter(c => c.track === i).map(c => c.id)) },
    ...(CA.activeComp(i) ? [
      { t: 'item', label: U.takesOpen[t.id] ? tl('a.pl.hideTakes') : tl('a.pl.showTakes'), kbd: CA.takesLabel(CA.activeComp(i)!.comp.takes.length), act: () => CA.toggleTakes(i) } as MenuItem,
      { t: 'item', label: tl('a.pl.flattenComp'), title: tl('a.pl.flattenTip'), act: () => CA.flatten(CA.activeComp(i)!.clip.id) } as MenuItem,
    ] : []),
    { t: 'item', label: tl('a.pl.heightDefault'), act: () => A.setTrack(i, { h: 56 }, tl('a.pl.height')) },
    { t: 'sep' },
    { t: 'item', label: tl('a.pl.moveUp'), disabled: i === 0, act: () => A.moveTrack(i, -1) },
    { t: 'item', label: tl('a.pl.moveDown'), disabled: i >= S.project.tracks.length - 1, act: () => A.moveTrack(i, 1) },
    { t: 'item', label: tl('a.pl.insertAbove'), act: () => A.insertTrack(i) },
    { t: 'item', label: tl('a.pl.insertBelow'), act: () => A.insertTrack(i + 1) },
    { t: 'item', label: tl('a.pl.deleteTrack'), danger: true, disabled: S.project.tracks.length < 2, act: () => A.removeTrack(t.id) },
  ], 400);
}

/** Set by the Playlist: a press on a lane header that may become a drag to reorder (FL / every DAW). */
let laneDragStart: ((e: PointerEvent, from: number) => void) | null = null;
const [laneDrag, setLaneDrag] = createSignal<{ from: number; to: number; y: number } | null>(null);

function LaneHeader(props: { t: Track; i: number; auto: string | null }) {
  const t = () => props.t;
  const icon = () => trackIcon(t()) ?? props.auto;
  const audible = () => !t().muted && (!anyTrackSolo() || t().solo);
  const routeIdx = () => S.project.inserts.findIndex(m => m.id === t().insert);
  const down = (e: PointerEvent) => {
    if (e.button === 2) { e.preventDefault(); return openLaneMenu(e.clientX, e.clientY, props.i); }
    if (e.button === 0) { A.selectInsert(t().insert); laneDragStart?.(e, props.i); }
  };
  const resize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const g = new Gesture(tl('a.pl.trackHeight'));
    const sy = e.clientY, h0 = t().h;
    track(ev => {
      const h = clamp(Math.round(h0 + ev.clientY - sy), 28, 220);
      g.update([{ op: 'putTrack', track: { ...plain(t()), h } }]);
      say(tl('a.pl.nameHeight', { name: t().name, h }));
    }, () => g.end(), 'row-resize');
  };
  const volTarget = () => ({ kind: 'trackVol' as const, id: t().id });
  const shownVol = () => autoDisplay(volTarget()) ?? t().vol;
  const vol = (e: PointerEvent) => {
    if (e.button === 2) { e.preventDefault(); e.stopPropagation(); paramMenu(e.clientX, e.clientY, volTarget(), () => A.setTrack(props.i, { vol: VOL_UNITY }, tl('a.pl.volume')), t().color); return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (e.altKey || dblCheck('lvol' + props.i)) { A.setTrack(props.i, { vol: VOL_UNITY }, tl('a.pl.volume')); say(t().name + ' · 0.0 dB'); return; }
    const w = (e.currentTarget as HTMLElement).getBoundingClientRect().width;
    const g = autoTweak(volTarget(), tl('a.pl.trackVolume'), n => [{ op: 'putTrack', track: { ...plain(t()), vol: n } }]);
    let v = shownVol(), lx = e.clientX;
    track(ev => {
      v = clamp(v + (ev.clientX - lx) / w * fineMul(ev), 0, 1); lx = ev.clientX;
      g.move(v);
      say(t().name + ' · ' + volText(v));
    }, () => g.end(), 'ew-resize');
  };
  const stop = (e: Event) => e.stopPropagation();
  // tracks play into the master unless the user sends one to a mixer channel (lane menu); only then is it shown.
  // It sits beside the volume, so the name has the whole first row; a track too low for a second row keeps it up there.
  // one click opens the route menu, a double-click shows that insert in the mixer instead (the menu
  // waits for the second click: opened at once, it covered the button and swallowed the double-click)
  let routeTimer = 0;
  onCleanup(() => clearTimeout(routeTimer));
  const routeClick = (e: MouseEvent) => {
    if (routeTimer) { clearTimeout(routeTimer); routeTimer = 0; closeMenu(); showInsert(t().insert ?? 0); return; }
    const x = e.clientX, y = e.clientY;
    routeTimer = window.setTimeout(() => { routeTimer = 0; openRouteMenu(props.i, x, y); }, 250);
  };
  const route = () => (
    <Show when={routeIdx() > 0}>
              <button class="mini route" title={tl('a.pl.routeTip', { out: 'Insert ' + routeIdx() })} onPointerDown={stop} onClick={routeClick}>{'Ins ' + routeIdx()}</button>
            </Show>
  );
  return (
    <div class={['lane', { armrec: t().arm && S.transport.rec, dimmed: !audible(), lifted: laneDrag()?.from === props.i }]} style={{ height: t().h + 'px' }} onPointerDown={down}
      title={tl('a.pl.dragTrackTip')}>
      <div class="stripe" style={{ background: t().color }} />
      <div class="body">
        <div class="row" style={{ gap: '6px', 'min-width': 0 }}>
          {/* FL: double-click on a track's icon shows the mixer insert it plays into */}
          <Show when={icon()}>
            <span class="laneicon" style={{ color: t().color }} title={tl('a.pl.trackTip', { n: props.i + 1 }) + ' · ' + tl('a.pl.numTip')}
              onDblClick={() => showInsert(t().insert ?? 0)}><InstIcon id={icon()} size={13} /></span>
          </Show>
          <span class="nm" style={{ color: audible() ? 'var(--fg-hi)' : 'var(--fg4)' }} title={tl('a.pl.nameTip')}
            onDblClick={e => openRename(e.clientX, e.clientY, t().name, v => A.setTrack(props.i, { name: v }, tl('a.pl.trackName')))}>{t().name}</span>
          <div class="row" style={{ gap: '2px', flex: 'none' }}>
            <Show when={CA.activeComp(props.i)}>{r => (
              <button class={['mini tk', { on: !!U.takesOpen[t().id] }]} onPointerDown={stop} onClick={() => CA.toggleTakes(props.i)}
                title={tl('a.pl.takesTip', { n: CA.takesLabel(r().comp.takes.length) })}>
                <svg width="7" height="7" viewBox="0 0 8 8" style={{ transform: U.takesOpen[t().id] ? 'rotate(90deg)' : 'none' }}><path d="M2 1l4 3-4 3z" fill="currentColor" /></svg>{r().comp.takes.length}
              </button>
            )}</Show>
            <Show when={t().h < 50}>{route()}</Show>
            <MuteSolo muted={t().muted} solo={t().solo} muteTip={tl('a.pl.muteTip')} soloTip={tl('a.pl.soloTip')}
              onMute={() => A.toggleTrackMute(props.i)} onSolo={add => A.toggleTrackSolo(props.i, add)} />
            {/* recordings go to the first free track (FL); only a track picked with "Record into this track" shows it */}
            <Show when={t().arm}>
              <button class="mini r on" title={tl('a.pl.armedTip')} onPointerDown={stop} onClick={() => A.armTrack(props.i)}>
                <svg width="7" height="7" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3.5" fill="currentColor" /></svg>
              </button>
            </Show>
          </div>
        </div>
        <Show when={t().h >= 50}>
          <div class="row" style={{ gap: '6px', 'padding-left': '20px' }}>
            <div class={['lvol', { auto: isAutomated(volTarget()) }]} onPointerDown={vol} onContextMenu={e => e.preventDefault()} title={tl('a.pl.volTip')}>
              <div class="track">
                <div class="fill" style={{ width: shownVol() * 100 + '%', background: audible() ? 'var(--fg5)' : 'var(--line2)' }} />
                <div class="thumb" style={{ left: shownVol() * 100 + '%' }} />
              </div>
            </div>
            <span class={['mono lvtxt', { unity: Math.abs(shownVol() - VOL_UNITY) < 1e-4 }]}>{volText(shownVol())}</span>
            {route()}
          </div>
        </Show>
      </div>
      <div class="lresize" onPointerDown={resize} title={tl('a.pl.resizeTip')} />
    </div>
  );
}

// ---------- take lanes ----------
/** Crossfade choices at a comp boundary, seconds. */
const XF = [0.005, 0.01, 0.02, 0.05];

function openTakeMenu(x: number, y: number, row: TakeRow, take: Take) {
  const comp = row.comp, used = usedBeats(comp, take.id), aud = S.audition[comp.id] === take.id, unused = unusedTakes(comp).length;
  openMenu(x, y, [
    { t: 'title', label: tl(used > 0 ? 'a.pl.takeTitleUsed' : 'a.pl.takeTitleUnused', { name: take.name }) },
    { t: 'item', label: tl('a.pl.useWholeTake'), kbd: tl('a.pl.clickName'), act: () => CA.useWholeTake(row, take) },
    { t: 'item', label: aud ? tl('a.pl.endSoloPrev') : tl('a.pl.soloPrev'), kbd: '▶', act: () => CA.audition(comp.id, aud ? null : take.id) },
    { t: 'item', label: tl('a.pl.rename'), act: () => openRename(x, y, take.name, v => CA.renameTake(comp, take.id, v)) },
    { t: 'sep' },
    { t: 'item', label: tl('a.pl.deleteTake'), danger: true, act: () => askDeleteTake(x, y, comp, take) },
    { t: 'item', label: tl('a.pl.removeUnused') + (unused ? ' (' + unused + ')' : ''), disabled: !unused, act: () => CA.removeUnused(comp) },
    { t: 'sep' },
    { t: 'item', label: tl('a.pl.flattenComp'), title: tl('a.pl.flattenTip'), act: () => CA.flatten(row.clip.id) },
  ], 290);
}

/** Deleting a take the comp plays asks first (its regions go silent). */
function askDeleteTake(x: number, y: number, comp: Comp, take: Take) {
  const used = usedBeats(comp, take.id);
  if (used <= 0) return CA.deleteTake(comp, take.id);
  openMenu(x, y, [
    { t: 'title', label: tl('a.pl.takePlays', { name: take.name, n: Math.round(used * 100) / 100 }) },
    { t: 'item', label: tl('a.pl.deleteTakeParts'), danger: true, act: () => CA.deleteTake(comp, take.id) },
    { t: 'item', label: tl('a.pl.cancel'), act: () => {} },
  ], 110);
}

/** Lane headers of the takes under track `i` (when expanded). */
function TakeHeaders(props: { i: number }) {
  const row = () => takeRow(props.i);
  const t = () => S.project.tracks[props.i];
  const stop = (e: Event) => e.stopPropagation();
  return (
    <Show when={row()}>{r => (
      <div class="takes" style={{ '--tc': t()?.color ?? 'var(--fg5)' }}>
        <For each={r().comp.takes}>{take => {
          const used = () => usedBeats(r().comp, take.id);
          const pct = () => Math.round(used() / Math.max(1e-9, take.len) * 100);
          const aud = () => S.audition[r().comp.id] === take.id;
          return (
            <div class={['takeLane', { used: used() > 0, aud: aud() }]} style={{ height: LANE_H + 'px' }}
              title={tl('a.pl.takeLaneTip')}
              onPointerDown={e => { stop(e); if (e.button === 2) { e.preventDefault(); openTakeMenu(e.clientX, e.clientY, r(), take); } else if (e.button === 0) CA.useWholeTake(r(), take); }}
              onContextMenu={e => e.preventDefault()}>
              <span class="tkbar" />
              <span class="tknm">{take.name}</span>
              <span class="tkuse" title={tl('a.pl.takeUseTip')}>{used() > 0 ? pct() + '%' : '—'}</span>
              <button class={['mini tka', { on: aud() }]} title={aud() ? tl('a.pl.endSoloPrev') : tl('a.pl.takeSoloTip')}
                onPointerDown={stop} onClick={() => CA.audition(r().comp.id, aud() ? null : take.id)}>
                <svg width="7" height="7" viewBox="0 0 8 8"><path d="M1.5 0.5l6 3.5-6 3.5z" fill="currentColor" /></svg>
              </button>
              <button class="xbtn" title={tl('a.pl.deleteTake')} onPointerDown={stop} onClick={e => askDeleteTake(e.clientX, e.clientY, r().comp, take)}>×</button>
            </div>
          );
        }}</For>
      </div>
    )}</Show>
  );
}
