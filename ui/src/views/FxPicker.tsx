// Add-effect picker (issue #18): opens at the slot it adds to, search-first and keyboard-complete
// (type, ↑↓←→, Enter adds, Shift+Enter / → on the preset column picks a preset, Esc closes).
// Category rail on the left, tiles with icon + one-line description + preset count, a preset
// column for the focused effect, Recent and Favourites at the top, built-in and VST3 separated.
// A tile can also be dragged onto any mixer strip or the effect rack to add it there.
import { createMemo, For, Show } from 'solid-js';
import { createSignal, effect, onCleanup, onMount } from '../lib/reactive';
import { PLUGIN_FORMAT_LABEL, type BuiltinKind, type Id, type PluginInfo } from '../api/types';
import { lang, t as tr, tName, type TranslationKey } from '../lib/i18n';
import { presetList } from '../lib/presets';
import * as A from '../state/actions';
import { S } from '../state/store';
import { ensurePluginScan, pluginScan, runPluginScan, setPluginScan } from '../state/pluginScan';
import { FORK, HIDDEN_FX } from '../fork';
import { say, setU, U } from '../state/ui';
import { openNotebook } from '../state/notebook';
import { NOTEBOOK_ICON } from './Notebook';
import { FX_ORDER, FXMETA, FxTile, Icon, ICONS } from '../ui/icons';
import { DialogBoundary } from '../ui/PanelBoundary';

/** What each built-in effect is for, in one line. */
const DESC: Record<BuiltinKind, TranslationKey> = {
  denoise: 'c.picker.desc.denoise',
  tune: 'c.picker.desc.tune',
  voice: 'c.picker.desc.voice',
  eq: 'c.picker.desc.eq',
  rider: 'c.picker.desc.rider',
  deess: 'c.picker.desc.deess',
  comp: 'c.picker.desc.comp',
  gate: 'c.picker.desc.gate',
  filter: 'c.picker.desc.filter',
  fet: 'c.picker.desc.fet',
  sat: 'c.picker.desc.sat',
  delay: 'c.picker.desc.delay',
  half: 'c.picker.desc.half',
  warp: 'c.picker.desc.warp',
  chorus: 'c.picker.desc.chorus',
  phaser: 'c.picker.desc.phaser',
  stereo: 'c.picker.desc.stereo',
  multiband: 'c.picker.desc.multiband',
  analyzer: 'c.picker.desc.analyzer',
  reverb: 'c.picker.desc.reverb',
  limit: 'c.picker.desc.limit',
};

/** Extra search words (names people type; the Polish UI also lists Polish ones). */
const KW: Record<BuiltinKind, TranslationKey> = {
  denoise: 'c.picker.kw.denoise', tune: 'c.picker.kw.tune', voice: 'c.picker.kw.voice',
  eq: 'c.picker.kw.eq', deess: 'c.picker.kw.deess', rider: 'c.picker.kw.rider', comp: 'c.picker.kw.comp', gate: 'c.picker.kw.gate', filter: 'c.picker.kw.filter',
  fet: 'c.picker.kw.fet', sat: 'c.picker.kw.sat', delay: 'c.picker.kw.delay', half: 'c.picker.kw.half', warp: 'c.picker.kw.warp',
  chorus: 'c.picker.kw.chorus', phaser: 'c.picker.kw.phaser',
  stereo: 'c.picker.kw.stereo', multiband: 'c.picker.kw.multiband', analyzer: 'c.picker.kw.analyzer',
  reverb: 'c.picker.kw.reverb', limit: 'c.picker.kw.limit',
};

type Cat = { id: string; label: TranslationKey; types?: BuiltinKind[] };
const CATS: Cat[] = [
  { id: 'all', label: 'c.picker.cat.all' },
  { id: 'recent', label: 'c.picker.cat.recent' },
  { id: 'fav', label: 'c.picker.cat.fav' },
  ...(FORK.vocal ? [
    { id: 'vocal', label: 'c.picker.cat.vocal', types: ['tune', 'voice', 'rider', 'deess'] },
    { id: 'repair', label: 'c.picker.cat.repair', types: ['denoise', 'gate', 'deess'] },
  ] as Cat[] : []),
  { id: 'dyn', label: 'c.picker.cat.dyn', types: ['rider', 'comp', 'fet', 'gate', 'multiband', 'limit'] },
  { id: 'tone', label: 'c.picker.cat.tone', types: ['eq', 'filter', 'sat'] },
  { id: 'mod', label: 'c.picker.cat.mod', types: ['chorus', 'phaser', 'filter'] },
  { id: 'space', label: 'c.picker.cat.space', types: ['delay', 'half', 'warp', 'reverb'] },
  { id: 'image', label: 'c.picker.cat.image', types: ['stereo', 'analyzer'] },
  ...(FORK.plugins ? [{ id: 'vst', label: 'c.picker.cat.vst' } as Cat] : []),
  { id: 'tools', label: 'c.picker.cat.tools' },
];

/**
 * The section an entry is listed under in "All": the first effect category holding it (an effect
 * in two categories is listed once), then hosted plugins (VST3, LV2), then project tools.
 */
const sectionOf = (e: { builtin?: BuiltinKind; plugin?: unknown; tool?: string }): string =>
  e.tool ? 'tools' : e.plugin ? 'vst' : CATS.find(c => c.types?.includes(e.builtin!))?.id ?? 'vst';

/** An entry in the grid: a built-in effect or a scanned plugin (one that cannot run here says why in `desc`). */
type Entry = { key: string; builtin?: BuiltinKind; plugin?: PluginInfo; tool?: 'notebook'; name: string; desc: string; presets: number };

// ---- per-user conveniences (best effort, never required)
const LS_RECENT = 'wave.fxpicker.recent', LS_FAV = 'wave.fxpicker.fav';
const load = (k: string): string[] => { try { const v = JSON.parse(localStorage.getItem(k) ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; } };
const save = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const [recent, setRecent] = createSignal<string[]>(load(LS_RECENT));
const [favs, setFavs] = createSignal<string[]>(load(LS_FAV));
const remember = (key: string) => { const r = [key, ...recent().filter(k => k !== key)].slice(0, 8); setRecent(r); save(LS_RECENT, r); };
const toggleFav = (key: string) => { const f = favs().includes(key) ? favs().filter(k => k !== key) : [...favs(), key]; setFavs(f); save(LS_FAV, f); };

// the plugin list is scanned once per session; "Rescan" in the Plugins category looks again
// (new or updated plugins: a VST3 rescan opens only modules it has not seen)
const scan = pluginScan;
const runScan = (rescan: boolean) => void runPluginScan(rescan);
const ensureScan = ensurePluginScan;
/** Lets "Add plugin…" share a fresh rescan with the picker. */
export { setPluginScan };

/** Project tools that open their own window instead of adding an effect. */
const tools = (): Entry[] => [{ key: 'tool:notebook', tool: 'notebook', name: tr('c.picker.notebook'), desc: tr('c.picker.notebookDesc'), presets: 0 }];

/** Recent/favourite key (VST3 keeps the key it had before LV2 support). */
const pluginKey = (p: PluginInfo) => (p.format === 'lv2' ? 'lv2:' : 'vst:') + p.cid;
/** "N presets": Polish has three forms, English two. */
const presetsWord = (n: number) => lang() === 'pl' ? tr(n === 1 ? 'c.picker.preset1' : n < 5 ? 'c.picker.preset2' : 'c.picker.preset5') : tr(n === 1 ? 'c.picker.preset1' : 'c.picker.preset5');

/** Opens the picker for an insert, anchored at (x, y) — or centred when no point is given (F8). */
export function openFxPicker(insId: Id, x?: number, y?: number) {
  setU('fxPicker', { insId, x: x ?? -1, y: y ?? -1 });
}

export function FxPickerHost() {
  return <Show when={U.fxPicker}>{p => <DialogBoundary name={tr('d.ui.pn.fxPicker')} close={() => setU('fxPicker', null)}><FxPicker insId={p().insId} x={p().x} y={p().y} /></DialogBoundary>}</Show>;
}

const W = 900, H = 520;

function FxPicker(props: { insId: Id; x: number; y: number }) {
  const [q, setQ] = createSignal('');
  const [cat, setCat] = createSignal('all');
  const [focus, setFocus] = createSignal(0);
  const [presetFocus, setPresetFocus] = createSignal(-1); // -1: grid has the keyboard
  let input!: HTMLInputElement, grid!: HTMLDivElement;
  const close = () => setU('fxPicker', null);
  onMount(() => { ensureScan(); setTimeout(() => input?.focus(), 0); });

  const insName = () => { const m = S.project.inserts.find(i => i.id === props.insId); return m ? (m.id === 0 ? 'Master' : m.name) : ''; };

  const builtins = createMemo<Entry[]>(() => FX_ORDER.filter(t => t !== 'fet' && !HIDDEN_FX.has(t) && S.catalog?.types[t]).map(t => ({
    key: t, builtin: t, name: t === 'comp' ? tr('c.picker.compressor') : tName(S.catalog!.types[t]!.name), desc: DESC[t] ? tr(DESC[t]) : tr(FXMETA[t].tag),
    presets: presetList(S.catalog, t).length + (t === 'comp' ? presetList(S.catalog, 'fet').length : 0),
  })));
  const plugins = createMemo<Entry[]>(() => (scan()?.plugins ?? []).map(p => ({
    key: pluginKey(p), plugin: p, name: p.name, presets: 0,
    desc: p.unsupported ? tr('c.picker.unsupported') : [p.vendor, p.category].filter(Boolean).join(' · '),
  })));
  /** Why a plugin format is missing on this machine (LV2 without liblilv), shown above the plugin list. */
  const unavailable = () => Object.values(scan()?.unavailable ?? {}).filter((s): s is string => !!s);

  const shown = createMemo(() => {
    const s = q().trim().toLowerCase();
    const c = CATS.find(x => x.id === cat())!;
    const all = [...builtins(), ...plugins(), ...tools()];
    let list: Entry[];
    if (s) list = all; // search always covers everything; the active category is shown as a chip
    else if (c.id === 'recent') list = recent().map(k => all.find(e => e.key === k)).filter((e): e is Entry => !!e);
    else if (c.id === 'fav') list = favs().map(k => all.find(e => e.key === k)).filter((e): e is Entry => !!e);
    else if (c.id === 'vst') list = plugins();
    else if (c.id === 'tools') list = tools();
    else if (c.types) list = builtins().filter(e => c.types!.includes(e.builtin!));
    else list = CATS.flatMap(sc => all.filter(e => sectionOf(e) === sc.id)); // All: in sections, in the rail's order
    if (!s) return list;
    const words = s.split(/\s+/);
    // rank: name, then keywords/tag, then description
    const score = (e: Entry) => {
      const name = e.name.toLowerCase(), kw = (e.builtin ? tr(FXMETA[e.builtin].tag) + ' ' + tr(KW[e.builtin]) : e.tool ? tr('c.picker.kwTool') : tr('c.picker.kwVst')).toLowerCase(), desc = e.desc.toLowerCase();
      let sc = 0;
      for (const w of words) {
        if (name.startsWith(w)) sc += 0; else if (name.includes(w)) sc += 1; else if (kw.includes(w)) sc += 2; else if (desc.includes(w)) sc += 4; else return -1;
      }
      return sc;
    };
    return list.map(e => [e, score(e)] as const).filter(([, sc]) => sc >= 0).sort((a, b) => a[1] - b[1]).map(([e]) => e);
  });
  effect(() => { shown(); setFocus(0); setPresetFocus(-1); });
  /** "All" without a search is drawn in sections, with a subtle divider (the section's name) before each. */
  const sectioned = () => cat() === 'all' && !q().trim();
  const sectionStart = (i: number) => sectioned() && (i === 0 || sectionOf(shown()[i]) !== sectionOf(shown()[i - 1]));
  const cur = () => shown()[Math.min(focus(), shown().length - 1)];
  // "Kompresor" covers both compressors: its preset list holds the clean ones and the FET (1176) ones
  const curPresets = () => {
    const e = cur(); if (!e?.builtin) return [];
    const one = (t: BuiltinKind) => presetList(S.catalog, t).map((p, i) => ({ name: tName(p.name), type: t, idx: i }));
    return e.builtin === 'comp' ? [...one('comp'), ...one('fet').map(p => ({ ...p, name: 'FET · ' + p.name }))] : one(e.builtin);
  };

  const add = (e: Entry | undefined, preset?: number) => {
    if (!e) return;
    if (e.tool === 'notebook') { openNotebook(); remember(e.key); close(); return; }
    if (e.builtin) { const p = preset != null ? curPresets()[preset] : undefined; A.addFx(props.insId, p?.type ?? e.builtin, p?.idx); }
    else if (e.plugin) { if (!A.addPlugin(props.insId, e.plugin)) return; say(tr('c.picker.added', { name: e.plugin.name })); }
    remember(e.key);
    close();
  };

  // arrow keys follow the tiles on screen (rows end early before a section divider)
  const tileRect = (i: number) => grid?.querySelector(`[data-i="${i}"]`)?.getBoundingClientRect();
  /** The tile in the row below (dir 1) or above (-1) nearest the current one horizontally; itself when there is none. */
  const vertical = (dir: 1 | -1) => {
    const r = tileRect(focus()); if (!r) return focus();
    let best = focus(), bestRow = Infinity, bestDx = Infinity;
    shown().forEach((_, i) => {
      const t = tileRect(i); if (!t) return;
      const dy = (t.top - r.top) * dir; if (dy < 4) return;
      const dx = Math.abs(t.left - r.left);
      if (dy < bestRow - 4 || (Math.abs(dy - bestRow) <= 4 && dx < bestDx)) { best = i; bestRow = dy; bestDx = dx; }
    });
    return best;
  };
  /** The current tile is the last one in its row. */
  const rowEnd = () => { const a = tileRect(focus()), b = tileRect(focus() + 1); return !a || !b || Math.abs(b.top - a.top) > 4; };
  const keep = (i: number) => { setFocus(i); queueMicrotask(() => grid?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' })); };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const n = shown().length;
    if (e.key === 'Escape') { e.preventDefault(); if (presetFocus() >= 0) return setPresetFocus(-1); return close(); }
    if (presetFocus() >= 0) {
      const np = curPresets().length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setPresetFocus(Math.min(np - 1, presetFocus() + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setPresetFocus(Math.max(0, presetFocus() - 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setPresetFocus(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); add(cur(), presetFocus()); }
      return;
    }
    if (!n) return;
    if (e.key === 'ArrowRight') {
      // at the end of a row, → steps into the preset column
      if (rowEnd() && curPresets().length) { e.preventDefault(); return setPresetFocus(0); }
      if (input.selectionStart === input.value.length) { e.preventDefault(); keep(Math.min(n - 1, focus() + 1)); }
    } else if (e.key === 'ArrowLeft') {
      if (input.selectionStart === 0 || !q()) { e.preventDefault(); keep(Math.max(0, focus() - 1)); }
    } else if (e.key === 'ArrowDown') { e.preventDefault(); keep(vertical(1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); keep(vertical(-1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey && curPresets().length) setPresetFocus(0); else add(cur());
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const i = CATS.findIndex(c => c.id === cat()); setCat(CATS[(i + (e.shiftKey ? CATS.length - 1 : 1)) % CATS.length].id); setQ('');
    }
  };

  // drag a tile onto a mixer strip / effect rack
  const [drag, setDrag] = createSignal<{ e: Entry; x: number; y: number; over: Id | null } | null>(null);
  const insAt = (x: number, y: number): Id | null => {
    const el = document.elementFromPoint(x, y)?.closest('[data-ins]') as HTMLElement | null;
    return el ? Number(el.dataset.ins) : null;
  };
  const tileDown = (ev: PointerEvent, e: Entry, i: number) => {
    if (ev.button !== 0) return;
    setFocus(i); setPresetFocus(-1);
    const x0 = ev.clientX, y0 = ev.clientY;
    let dragging = false;
    const mv = (m: PointerEvent) => {
      if (!dragging && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
      dragging = true;
      setDrag({ e, x: m.clientX, y: m.clientY, over: insAt(m.clientX, m.clientY) });
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      // find the drop target while the picker is still click-through, then end the drag
      const target = dragging ? insAt(u.clientX, u.clientY) : null;
      setDrag(null);
      if (!dragging) return add(e);
      if (e.tool) return;
      if (target != null) {
        if (e.builtin) A.addFx(target, e.builtin); else if (e.plugin && !A.addPlugin(target, e.plugin)) return;
        remember(e.key); close();
      }
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  onCleanup(() => setDrag(null));

  // centred over the app, like the command palette: wherever it was opened from (a slot, a strip,
  // the master), it is in the same place and never cut by a window edge
  const pos = () => {
    const vw = window.innerWidth, vh = window.innerHeight, m = 12;
    const w = Math.min(W, vw - 2 * m), h = Math.min(H, vh - 2 * m);
    return { left: (vw - w) / 2, top: Math.max(m, (vh - h) / 2.4), w, h };
  };
  const activeCat = () => CATS.find(c => c.id === cat())!;

  return (
    <div class="fxpick-veil" style={{ 'pointer-events': drag() ? 'none' : 'auto' }} onPointerDown={close}>
      <div class="fxpick" style={{ left: pos().left + 'px', top: pos().top + 'px', width: pos().w + 'px', height: pos().h + 'px', 'pointer-events': drag() ? 'none' : 'auto', opacity: drag() ? 0.35 : 1 }}
        onPointerDown={e => e.stopPropagation()}>
        <div class="fxp-hd">
          <span class="fxp-search">
            <Icon d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z M21 21l-5.2-5.2" size={14} />
            <input ref={input} placeholder={tr('c.picker.search')} value={q()} onInput={e => setQ(e.currentTarget.value)} onKeyDown={onKey} spellcheck="false" />
            <Show when={q()}><button class="fxp-clear" title={tr('c.picker.clear')} onClick={() => { setQ(''); input.focus(); }}>×</button></Show>
          </span>
          <span class="fxp-dest">{tr('c.picker.to')} <b>{insName()}</b></span>
          <button class="fxp-x" onClick={close} title={tr('c.fx.close')}>×</button>
        </div>
        <div class="fxp-body">
          <nav class="fxp-rail">
            <For each={CATS}>
              {(c, i) => (
                <>
                  <Show when={i() === 3 || i() === 8 || i() === 9}><div class="fxp-sep" /></Show>
                  <button class={{ on: cat() === c.id && !q() }} onClick={() => { setCat(c.id); setQ(''); input.focus(); }}>
                    <span>{tr(c.label)}</span>
                    <span class="n">{c.id === 'recent' ? recent().length || '' : c.id === 'fav' ? favs().length || '' : c.id === 'vst' ? (scan() ? plugins().length : '…') : c.id === 'tools' ? tools().length : c.types ? c.types.length : builtins().length + plugins().length + tools().length}</span>
                  </button>
                </>
              )}
            </For>
          </nav>
          <div class="fxp-main">
            <div class="fxp-title">
              <Show when={q()} fallback={<span>{tr(activeCat().label)}</span>}>
                <span>{tr('c.picker.results', { q: q() })}</span><span class="fxp-chip">{shown().length}</span>
              </Show>
            </div>
            <div class="fxp-grid" ref={grid}>
              <Show when={cat() === 'vst' && !q()}>
                <div class="row" style={{ 'grid-column': '1 / -1', gap: '8px', 'align-items': 'flex-start' }}>
                  <div style={{ flex: 1, 'min-width': 0 }}>
                    <For each={unavailable()}>{s => <div class="fxp-note" title={s}>{s}</div>}</For>
                  </div>
                  <button class="smallbtn" style={{ height: '24px', flex: 'none' }} disabled={!scan()} title={tr('d.set.rescan.tip')} onClick={() => runScan(true)}>{tr('d.set.rescan')}</button>
                </div>
              </Show>
              <For each={shown()} fallback={<div class="fxp-empty">{cat() === 'fav' && !q() ? tr('c.picker.emptyFav') : cat() === 'recent' && !q() ? tr('c.picker.emptyRecent') : cat() === 'vst' && !scan() ? tr('c.picker.scanning') : tr('c.picker.noMatch')}</div>}>
                {(e, i) => (<>
                  <Show when={sectionStart(i())}><div class="fxp-sect">{tr(CATS.find(c => c.id === sectionOf(e))!.label)}</div></Show>
                  <div class={['fxp-tile', { focus: i() === focus() && presetFocus() < 0, cur: i() === focus() }]} data-i={i()} style={e.plugin?.unsupported ? { opacity: 0.55 } : undefined}
                    onPointerDown={ev => tileDown(ev, e, i())} onPointerEnter={() => presetFocus() < 0 && setFocus(i())}
                    title={e.plugin ? (e.plugin.unsupported ? tr('c.picker.unsupportedTip', { why: e.plugin.unsupported }) : e.plugin.path || e.plugin.cid) : e.tool ? tr('c.picker.tipOpen') : tr('c.picker.tipAdd')}>
                    <Show when={e.builtin} fallback={<span class="tile" style={{ width: '40px', height: '40px', background: e.tool ? 'color-mix(in srgb, var(--blue) 18%, transparent)' : FXMETA.plugin.color + '26', color: e.tool ? 'var(--blue)' : FXMETA.plugin.color }}><Icon d={e.tool ? NOTEBOOK_ICON : ICONS.vst} size={20} /></span>}>
                      <FxTile type={e.builtin!} size={40} icon={20} />
                    </Show>
                    <div class="fxp-txt">
                      <div class="fxp-name"><span class="ell">{e.name}</span>{e.plugin && <span class="fxp-badge">{PLUGIN_FORMAT_LABEL[e.plugin.format]}</span>}</div>
                      <div class="fxp-desc">{e.desc}</div>
                      <Show when={e.presets}><div class="fxp-meta">{e.presets} {presetsWord(e.presets)}</div></Show>
                    </div>
                    <button class={['fxp-star', { on: favs().includes(e.key) }]} title={favs().includes(e.key) ? tr('c.picker.favRemove') : tr('c.picker.favAdd')}
                      onPointerDown={ev => { ev.stopPropagation(); }} onClick={ev => { ev.stopPropagation(); toggleFav(e.key); }}>{favs().includes(e.key) ? '★' : '☆'}</button>
                  </div>
                </>)}
              </For>
            </div>
          </div>
          <aside class="fxp-presets">
            <Show when={cur()} fallback={<div class="fxp-empty">—</div>}>
              {e => (
                <>
                  <div class="fxp-ph">
                    <Show when={e().builtin}><FxTile type={e().builtin!} size={22} icon={12} /></Show>
                    <span class="ell">{e().name}</span>
                  </div>
                  <Show when={curPresets().length} fallback={<div class="fxp-note">{e().plugin?.unsupported ? tr('c.picker.unsupportedTip', { why: e().plugin!.unsupported! }) : e().plugin ? tr('c.picker.pluginPresets') : tr('c.picker.noPresets')}</div>}>
                    <div class="fxp-plabel">{tr('c.picker.addWithPreset')}</div>
                    <For each={curPresets()}>
                      {(p, pi) => (
                        <button class={['fxp-pi', { focus: presetFocus() === pi() }]} onClick={() => add(e(), pi())} onPointerEnter={() => setPresetFocus(pi())} onPointerLeave={() => setPresetFocus(-1)}>
                          <span class="ell">{p.name}</span>{pi() === 0 && <span class="fxp-def">{tr('c.picker.default')}</span>}
                        </button>
                      )}
                    </For>
                  </Show>
                </>
              )}
            </Show>
          </aside>
        </div>
        <div class="fxp-ft">
          <span><kbd>↑↓←→</kbd> {tr('c.picker.kSelect')}</span><span><kbd>Enter</kbd> {tr('c.picker.kAdd')}</span><span><kbd>⇧ Enter</kbd> / <kbd>→</kbd> {tr('c.picker.kPresets')}</span><span><kbd>Tab</kbd> {tr('c.picker.kCategory')}</span><span><kbd>Esc</kbd> {tr('c.picker.kClose')}</span>
          <span class="grow" /><span>{tr('c.picker.dragHint')}</span>
        </div>
      </div>
      <Show when={drag()}>
        {d => (
          <div class="fxp-ghost" style={{ left: d().x + 12 + 'px', top: d().y + 8 + 'px' }}>
            <Show when={d().e.builtin} fallback={<Icon d={ICONS.vst} size={14} />}><FxTile type={d().e.builtin!} size={20} icon={11} /></Show>
            <span>{d().e.name}</span>
            <span class="to">{d().over != null ? '→ ' + (d().over === 0 ? 'Master' : S.project.inserts.find(i => i.id === d().over)?.name ?? '') : tr('c.picker.dropHere')}</span>
          </div>
        )}
      </Show>
    </div>
  );
}
