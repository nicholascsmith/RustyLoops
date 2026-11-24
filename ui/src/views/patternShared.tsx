// What the Channel Rack and the Piano roll windows share: sizing hooks, the window frame
// (move, resize and focus live in PanelFrame; here: keys that must not reach the playlist), channel and pattern menus.
import { createSignal, effect, onCleanup, onMount } from '../lib/reactive';
import { t, tName } from '../lib/i18n';
import type { Channel, LibFile, Note, Pattern } from '../api/types';
import { FACTORY_KIT, LIB_SCHEME } from '../lib/factory';
import { barsText, clearChannel, fillEvery, notesText, rotate, stepsOf } from '../lib/pattern';
import { cleanGroup, rackGroups } from '../lib/rackGroups';
import { libGroup, loadStdLib, stdLibGroups } from '../state/library';
import { ensurePluginScan, pluginScan, runPluginScan } from '../state/pluginScan';
import { FORK } from '../fork';
import { isTypingKey } from '../state/typingKeys';
import { commit } from '../state/edit';
import { pickInsert, type InsertChoice } from '../ui/InsertPicker';
import {
  addBar, addKeys, addMusicBox, addPlugin, addSampler, addSamplerFiles, addSynth, audition, chanKindLabel, chanOp, channels, clonePattern, cloneChannel, curPat, deleteChannel,
  deletePattern, type InstrumentPick, newPattern, nextEmptyPattern, openPattern, openRack, openRoll, putNotes, recolorPattern, removeBar, renamePattern, scrollPattern, replaceChannel, replaceWithFile, setChannel, setCurPattern, splitByChannel,
  rollMoved,
} from '../state/pattern';
import { arrVersion, insName, S } from '../state/store';
import { openMenu, openRename, say, setU, U, type MenuItem, type PatWin } from '../state/ui';
import { libGlyph, PICK_GLYPH, synthCategoryGlyph } from '../ui/menuIcons';
import { theme } from '../ui/theme';
import { midiExport, midiImport } from '../state/actions';

/** Size of an element, tracked. */
export function useSize(el: () => HTMLElement | undefined) {
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  onMount(() => {
    const ro = new ResizeObserver(() => { const e = el(); if (e) setSize({ w: e.clientWidth, h: e.clientHeight }); });
    const e = el(); if (e) ro.observe(e);
    onCleanup(() => ro.disconnect());
  });
  return size;
}

/** Bumped when anything the canvases show changes (pattern notes, channels, theme). */
export function useDataVersion() {
  const [v, setV] = createSignal(0);
  // arrVersion bumps on every arrangement change: no deep JSON walk of a 2000-note pattern per edit
  effect(() => { arrVersion(); curPat(); channels(); theme.epoch; setV(x => x + 1); });
  return v;
}

/**
 * Keys typed while a pattern window has the focus never edit the playlist behind it: selection,
 * delete, clipboard, mute (Alt+M) and nudge shortcuts stop here (Space, Ctrl+Z, Ctrl+M = metronome, F-keys and Esc stay global).
 * `own` handles the window's own keys first.
 */
export function guardKeys(e: KeyboardEvent, own?: (e: KeyboardEvent) => void) {
  if (isTypingKey(e)) return; // typing keyboard on: these keys play notes (App handles them)
  own?.(e);
  if (e.cancelBubble) return;
  const m = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === 'Delete' || e.key === 'Backspace' || e.key.startsWith('Arrow') || (m && !e.shiftKey && 'abcdxv'.includes(k) && k.length === 1) || (e.altKey && !m && e.code === 'KeyM')) { e.preventDefault(); e.stopPropagation(); }
  // the playlist's tool letters: a window that does not use one must not switch the tool behind it
  else if (!m && !e.altKey && k.length === 1 && 'pbdtce'.includes(k)) e.stopPropagation();
}

/** A pattern window's place, for `PanelFrame`. A move or resize by the user takes the Piano roll
 * out of full screen (it then stays where they put it). */
export function patGeom(key: 'rackWin' | 'rollWin') {
  return {
    geom: () => U[key]!,
    setGeom: (g: Partial<PatWin>) => { if (key === 'rollWin') rollMoved(); setU(key, o => o && { ...o, ...g }); },
  };
}

// ---------------------------------------------------------------- channel menus

export function insLabel(c: Channel): string {
  if (c.insert == null) return '—';
  const i = S.project.inserts.findIndex(m => m.id === c.insert);
  return i <= 0 ? 'M' : String(i);
}
export function insTitle(c: Channel): string {
  if (c.insert == null) return t('b.pe.insAuto');
  const m = S.project.inserts.find(x => x.id === c.insert);
  return t('b.pe.insTo', { name: m ? (m.id === 0 ? 'Master' : m.name) : '?' });
}
/** A channel's mixer box as an insert choice (the same one the channel window's MIXER picker makes). */
export function chanInsertChoice(c: Channel): InsertChoice {
  return { value: c.insert ?? null, nullLabel: t('b.cw.likeClipTrack'), ops: insert => [chanOp(c, { insert })], label: t('b.pe.mixCh'), wheelKey: 'cins' + c.id, free: { name: c.name, color: c.color } };
}

export function insertMenu(c: Channel, x: number, y: number) {
  const items: MenuItem[] = [{ t: 'title', label: t('b.pe.mixChName', { name: c.name }) },
    { t: 'item', label: t('b.pe.clipTrack'), kbd: c.insert == null ? '✓' : '', title: t('b.pe.clipTrackTitle'), act: () => pickInsert(chanInsertChoice(c), null) }, { t: 'sep' }];
  S.project.inserts.forEach(m => items.push({ t: 'item', label: insName(m), kbd: c.insert === m.id ? '✓' : '', act: () => pickInsert(chanInsertChoice(c), m.id) }));
  openMenu(x, y, items, Math.min(window.innerHeight - 20, 60 + items.length * 26));
}

/** Right-click on a channel: piano roll, step fills, rename / colour / clone / delete. */
export function chanMenu(c: Channel, x: number, y: number, clipboardItems: MenuItem[]) {
  const pt = curPat(); if (!pt) return;
  const steps = stepsOf(pt);
  const edit = (notes: Note[], label: string) => commit([putNotes(pt, notes)], label);
  openMenu(x, y, [
    { t: 'title', label: c.name + ' · ' + chanKindLabel(c) },
    { t: 'item', label: 'Piano roll', kbd: 'F7', act: () => openRoll(c.id) },
    { t: 'sub', label: t('b.pe.replace'), items: instrumentItems(p => replaceChannel(c, p), f => void replaceWithFile(c, f)) },
    ...clipboardItems,
    { t: 'item', label: t('d.midi.mnImportCh'), title: t('d.midi.mnImportChTip'), act: () => void midiImport({ into: { pattern: pt.id, ch: c.id } }) },
    { t: 'sep' },
    { t: 'item', label: t('b.pe.fill2'), act: () => edit(fillEvery(pt.notes, c.id, steps, 2), t('b.pe.fill')) },
    { t: 'item', label: t('b.pe.fill4'), act: () => edit(fillEvery(pt.notes, c.id, steps, 4), t('b.pe.fill')) },
    { t: 'item', label: t('b.pe.fill8'), act: () => edit(fillEvery(pt.notes, c.id, steps, 8), t('b.pe.fill')) },
    { t: 'item', label: t('b.pe.shiftL'), kbd: 'Shift+Ctrl+←', act: () => edit(rotate(pt.notes, c.id, steps, -1), t('b.pe.shiftSteps')) },
    { t: 'item', label: t('b.pe.shiftR'), kbd: 'Shift+Ctrl+→', act: () => edit(rotate(pt.notes, c.id, steps, 1), t('b.pe.shiftSteps')) },
    { t: 'item', label: t('b.pe.clear'), disabled: !pt.notes.some(n => n.ch === c.id), act: () => edit(clearChannel(pt.notes, c.id), t('b.pe.clearCh')) },
    { t: 'sep' },
    { t: 'item', label: t('b.pe.preview'), kbd: t('b.pe.ctrlClick'), act: () => audition(c.id, undefined, 0.8, true) },
    { t: 'item', label: t('b.pe.rename'), act: () => openRename(x, y, c.name, v => v.trim() && setChannel(c, { name: v.trim() }, t('b.pe.chName'))) },
    { t: 'sub', label: t('b.rk.groupMenu'), items: groupItems(c, x, y) },
    { t: 'swatches', current: c.color, pick: col => setChannel(c, { color: col }, t('b.pe.chColor')) },
    { t: 'item', label: t('b.pe.clone'), act: () => cloneChannel(c) },
    { t: 'sep' },
    { t: 'item', label: t('b.pe.delete'), danger: true, act: () => deleteChannel(c) },
  ], 520);
}

/** FL's filter groups: put the channel in an existing group, a new one, or none. */
function groupItems(c: Channel, x: number, y: number): MenuItem[] {
  const groups = rackGroups(channels());
  const put = (g: string | undefined) => {
    setChannel(c, { group: g }, t('b.rk.groupSetGest'));
    say(g ? t('b.rk.groupJoined', { name: c.name, group: g }) : t('b.rk.groupLeft', { name: c.name }));
  };
  return [
    ...groups.map((g): MenuItem => ({ t: 'item', label: g.name, checked: c.group === g.name, act: () => put(g.name) })),
    ...(groups.length ? [{ t: 'sep' } as MenuItem] : []),
    { t: 'item', label: t('b.rk.groupNew'), act: () => openRename(x, y, '', v => { const g = cleanGroup(v); if (g) put(g); }, t('b.rk.groupNewTitle')) },
    { t: 'item', label: t('b.rk.groupClear'), disabled: !c.group, act: () => put(undefined) },
  ];
}

/**
 * The instruments a channel can play, as menu items: `pick` adds a channel or replaces one;
 * `file` does it with a library file, or with nothing given a file picked from disk.
 */
function instrumentItems(pick: (p: InstrumentPick) => void, file: (f?: LibFile) => void): MenuItem[] {
  // samplers first: the samples that ship with the program, the project's own audio, a file
  const items: MenuItem[] = [{ t: 'title', label: t('b.pe.menuStdLib') }];
  void loadStdLib();
  for (const [g, fs] of stdLibGroups()) items.push({ t: 'sub', label: libGroup(g), glyph: libGlyph(g), items: fs.map(f => ({ t: 'item', label: f.name, glyph: libGlyph(g), act: () => file(f) }) as MenuItem) });
  // the project's audio that is not a standard-library sample (those are in the groups above)
  const own = S.project.sources.filter(s => !s.path.startsWith(LIB_SCHEME + FACTORY_KIT + '/'));
  if (own.length) {
    items.push({ t: 'sub', label: t('b.pe.menuSampler'), glyph: PICK_GLYPH.source, items: own.slice(0, 24).map(s => ({ t: 'item', label: s.name, glyph: PICK_GLYPH.source, kbd: s.dur.toFixed(1) + ' s', act: () => pick({ kind: 'sample', source: s.id }) }) as MenuItem) });
  }
  items.push({ t: 'item', label: t('b.pe.menuFile'), act: () => file() });
  const syn = S.catalog?.synth;
  if (syn) {
    items.push({ t: 'sep' }, { t: 'title', label: t('b.pe.menuSynth') });
    for (const g of syn.categories) {
      const ps = syn.presets.filter(p => p.category === g);
      const glyph = synthCategoryGlyph(g);
      if (ps.length) items.push({ t: 'sub', label: tName(g), glyph, items: ps.map(p => ({ t: 'item', label: tName(p.name), glyph, act: () => pick({ kind: 'synth', preset: p.name }) }) as MenuItem) });
    }
    items.push({ t: 'item', label: t('b.pe.menuSynthEmpty'), glyph: PICK_GLYPH.emptySynth, act: () => pick({ kind: 'synth', preset: null }) });
  }
  items.push({ t: 'sep' }, { t: 'title', label: t('b.pe.menuSampled') }, { t: 'item', label: t('b.pe.menuKeys'), glyph: PICK_GLYPH.keys, act: () => pick({ kind: 'keys' }) });
  if (FORK.analysis) items.push({ t: 'item', label: t('b.pe.menuMusicBox'), glyph: PICK_GLYPH.musicBox, act: () => pick({ kind: 'musicbox' }) });
  if (FORK.plugins) items.push({ t: 'sep' }, { t: 'title', label: t('b.pe.menuPlugins') }, ...pluginItems(pick));
  return items;
}

/** Most instruments listed directly; more are grouped by vendor. */
const FLAT_PLUGINS = 12;

/** The scanned VST3 instruments (FL's generators), and a rescan for new ones. */
function pluginItems(pick: (p: InstrumentPick) => void): MenuItem[] {
  const r = pluginScan();
  if (!r) { ensurePluginScan(); return [{ t: 'item', label: t('b.pe.menuPluginsScanning'), disabled: true, act: () => {} }]; }
  const list = r.instruments ?? [];
  const item = (p: (typeof list)[number]): MenuItem => ({
    t: 'item', label: p.name, glyph: PICK_GLYPH.plugin, title: [p.vendor, p.category, p.path].filter(Boolean).join(' · '),
    act: () => pick({ kind: 'plugin', plugin: p }),
  });
  const items: MenuItem[] = [];
  if (!list.length) items.push({ t: 'item', label: t('b.pe.menuPluginsNone'), title: t('b.pe.menuPluginsNoneTip'), disabled: true, act: () => {} });
  else if (list.length <= FLAT_PLUGINS) items.push(...list.map(item));
  else {
    const vendors = new Map<string, typeof list>();
    for (const p of list) { const v = p.vendor || '—'; vendors.set(v, [...(vendors.get(v) ?? []), p]); }
    for (const [v, ps] of [...vendors].sort((a, b) => a[0].localeCompare(b[0]))) items.push({ t: 'sub', label: v, glyph: PICK_GLYPH.plugin, items: ps.map(item) });
  }
  items.push({ t: 'item', label: t('b.pe.menuRescan'), title: t('b.pe.menuRescanTip'), act: () => {
    say(t('b.pe.rescanning'));
    void runPluginScan(true).then(s => say(t('b.pe.rescanDone', { n: (s.instruments ?? []).length })));
  } });
  return items;
}

export function addChannelMenu(x: number, y: number) {
  const add = (p: InstrumentPick) => {
    if (p.kind === 'synth') addSynth(p.preset);
    else if (p.kind === 'keys') addKeys();
    else if (p.kind === 'musicbox') addMusicBox();
    else if (p.kind === 'plugin') addPlugin(p.plugin);
    else addSampler(p.source);
  };
  const items = instrumentItems(add, f => void addSamplerFiles(f ? [f] : null));
  const h = Math.min(window.innerHeight - 20, 80 + items.length * 26);
  openMenu(x, Math.min(y, window.innerHeight - h - 8), items, h);
}

// ---------------------------------------------------------------- pattern menu

/** F2: rename the current pattern in a small box at (x, y). */
export function renameCurrent(x: number, y: number) {
  const pt = curPat(); if (!pt) return;
  openRename(x, y, pt.name, v => renamePattern(pt, v));
}


/** What can be done to one pattern: rename, clone, split by channel, length, colour, delete. */
export function patItems(p: Pattern, x: number, y: number): MenuItem[] {
  const last = S.project.patterns.length < 2;
  return [
    { t: 'item', label: t('b.pm.rename'), kbd: p.id === curPat()?.id ? 'F2' : undefined, act: () => openRename(x, y, p.name, v => renamePattern(p, v)) },
    { t: 'item', label: t('b.pm.clone'), kbd: p.id === curPat()?.id ? 'Shift+Ctrl+C' : undefined, act: () => clonePattern(p) },
    { t: 'item', label: t('b.pm.split'), disabled: new Set(p.notes.map(n => n.ch)).size < 2, title: t('b.pm.splitTitle'), act: () => splitByChannel(p) },
    { t: 'item', label: t('d.midi.mnExportPat'), disabled: !p.notes.length, act: () => void midiExport(p.id) },
    { t: 'item', label: t('b.pm.addBar'), kbd: barsText(p.len / 4), act: () => addBar(p) },
    { t: 'item', label: t('b.pm.removeBar'), disabled: p.len <= 4, title: t('b.pm.removeBarTitle'), act: () => removeBar(p) },
    { t: 'swatches', current: p.color, pick: col => recolorPattern(p, col) },
    { t: 'sep' },
    { t: 'item', label: t('b.pm.delete'), danger: true, disabled: last, title: last ? t('b.pm.lastOne') : '', act: () => deletePattern(p) },
  ];
}
/** Right-click on a pattern in the browser (FL's picker panel): open it, then everything in `patItems`. */
export function patternItemMenu(p: Pattern, x: number, y: number) {
  const items: MenuItem[] = [{ t: 'title', label: p.name }, { t: 'item', label: t('b.pm.open'), act: () => openPattern(p.id) }, { t: 'sep' }, ...patItems(p, x, y)];
  openMenu(x, y, items, 40 + items.length * 26);
}

/** The pattern selector's menu (toolbar and Channel Rack title): pick, new, clone, rename, colour, split, delete. */
/** The pattern picker. From the toolbar (`showRack`), picking or making a pattern also opens the
 *  Channel Rack, where a pattern is edited; from the rack or the Piano roll it only switches. */
export function patternMenu(x: number, y: number, showRack = false) {
  const cur = curPat();
  const andRack = (f: () => void) => () => { f(); if (showRack) openRack(); };
  const items: MenuItem[] = [{ t: 'title', label: t('b.pm.title') }];
  S.project.patterns.forEach((p, i) => items.push({
    t: 'item', label: (i < 9 ? i + 1 + ' · ' : '') + p.name, icon: 'M5 5h14v14H5z', iconColor: p.color,
    kbd: p.id === cur?.id ? '✓' : p.notes.length ? barsText(p.len / 4) : t('b.pm.empty'),
    act: andRack(() => setCurPattern(p.id)),
  }));
  items.push({ t: 'sep' },
    { t: 'item', label: t('b.pat.new'), act: andRack(newPattern) },
    { t: 'item', label: t('b.pm.nextEmpty'), kbd: 'F4', act: andRack(nextEmptyPattern) });
  if (cur) items.push({ t: 'sep' }, { t: 'title', label: cur.name }, ...patItems(cur, x, y));
  const h = Math.min(window.innerHeight - 20, 40 + items.length * 26);
  openMenu(x, y, items, h);
}

/** "3 notes · 2 bars" for status lines. */
export const patSummary = () => { const pt = curPat(); return pt ? notesText(pt.notes.length) + ' · ' + barsText(pt.len / 4) : ''; };

/** The pattern an editor window shows, as a chip: its colour and name; a click lists the patterns. One for the Channel rack and the Piano roll. */
export function PatternChip(props: { pat: Pattern }) {
  // the wheel over the chip steps through the patterns, past the last one into a new blank one (FL)
  let acc = 0;
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    acc += e.deltaY || e.deltaX;
    if (Math.abs(acc) < 40) return;
    scrollPattern(acc > 0 ? 1 : -1); acc = 0;
  };
  return (
    <button class="patname" title={t('b.rk.patTitle')} onWheel={wheel} onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); patternMenu(r.left, r.bottom + 4); }}>
      <span class="sw" style={{ background: props.pat.color }} /><span class="ell">{props.pat.name}</span>
      <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
    </button>
  );
}
