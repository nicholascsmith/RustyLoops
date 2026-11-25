// The command palette (Ctrl+K): every menu command, found by typing what you want to do instead of
// knowing which menu holds it. It reads the app menus themselves, so a command added to a menu is
// here too, with the same shortcut, the same disabled state and the same action. A question that is
// not a command can be sent to ChatGPT from the palette.
import { createMemo, For, Show } from 'solid-js';
import { createSignal, effect } from '../lib/reactive';
import { matchCommand } from '../lib/commandMatch';
import { t, type TranslationKey } from '../lib/i18n';
import type { MenuItem } from '../state/ui';
import { Icon } from '../ui/icons';
import { APP_GLYPH, menuGlyph, type MenuGlyph } from '../ui/menuIcons';
import * as A from '../state/actions';
import { curPat } from '../state/pattern';
import { S } from '../state/store';
import { setU, U } from '../state/ui';
import { askChatGPT } from './Ask';
import { FORK } from '../fork';
import { patItems } from './patternShared';
import { DialogBoundary } from '../ui/PanelBoundary';

type MenuSource = [TranslationKey, () => MenuItem[]][];
let source: MenuSource = [];
/** The app bar's menus, registered by the menu bar when it mounts. */
export const setCommandMenus = (m: MenuSource) => { source = m; };
export const [paletteOpen, setPaletteOpen] = createSignal(false);

/** `menu`: the app menu it is in (or the context section); `sub`: the submenu path inside it, if any. */
interface Cmd { danger?: boolean; menu: string; sub: string; label: string; glyph: MenuGlyph | null; kbd?: string; disabled?: boolean; act: () => void }

function flatten(items: MenuItem[], menu: string, sub: string, out: Cmd[]) {
  for (const it of items) {
    if (it.t === 'item') out.push({ menu, sub, label: it.paletteLabel ?? it.label, danger: it.danger, glyph: it.glyph ?? menuGlyph(it.label) ?? null, kbd: it.kbd, disabled: it.disabled, act: it.act });
    else if (it.t === 'sub') flatten(it.items, menu, sub ? sub + ' › ' + it.label : it.label, out);
  }
}

export function Palette() {
  const [q, setQ] = createSignal('');
  const [at, setAt] = createSignal(0);
  let list!: HTMLDivElement;
  // read the menus when the palette opens: disabled states are those of this moment
  const all = createMemo(() => {
    const out: Cmd[] = []; if (!paletteOpen()) return out;
    // first, what can be done with what is selected right now: the Playlist selection, the current pattern
    for (const [name, , items] of context()) flatten(items, name, '', out);
    for (const [name, items] of source) flatten(items(), t(name), '', out);
    return out;
  });
  /** The context sections as [title, colour of its dot, commands]. A declaration (hoisted): `all` above reads it at once when the palette mounts already open. */
  function context(): [string, string, MenuItem[]][] {
    const out: [string, string, MenuItem[]][] = [];
    if (U.sel.length) out.push([t('a.cmd.ctxSel', { n: U.sel.length }), 'var(--blue)', [
      { t: 'item', label: t('a.mn.copy'), kbd: 'Ctrl+C', act: () => void A.copy() },
      { t: 'item', label: t('a.mn.cut'), kbd: 'Ctrl+X', act: () => void A.cut() },
      { t: 'item', label: t('a.cmd.muteSel'), kbd: 'Alt+M', act: () => void A.toggleMuteSel() },
      { t: 'item', label: t('a.cmd.deselect'), kbd: 'Ctrl+D', act: () => setU('sel', []) },
      { t: 'item', label: t('a.mn.del'), kbd: 'Del', danger: true, act: () => void A.delIds([...U.sel]) },
    ]]);
    const p = S.project.patterns.length ? curPat() : null;
    if (p) out.push([t('a.cmd.ctxPat', { name: p.name }), p.color, patItems(p, window.innerWidth / 2 - 120, 160)]);
    return out;
  }
  const dotOf = (menu: string) => context().find(c => c[0] === menu)?.[1];
  const shown = createMemo(() => all().filter(c => matchCommand(c.menu + ' ' + c.sub + ' ' + c.label, q())));
  /** The commands by menu, each with its place in the flat list the arrow keys walk. */
  const groups = createMemo(() => {
    const by = new Map<string, { c: Cmd; i: number }[]>();
    shown().forEach((c, i) => { if (!by.has(c.menu)) by.set(c.menu, []); by.get(c.menu)!.push({ c, i }); });
    return [...by.entries()];
  });
  // typed text can always be asked instead: the last row, and the only one when no command matches
  const typed = () => q().trim() !== '';
  const asks = () => FORK.ask && typed();
  const rows = () => shown().length + (asks() ? 1 : 0);
  effect(() => { if (!paletteOpen()) setQ(''); });
  effect(() => { q(); setAt(0); });
  const close = () => setPaletteOpen(false);
  const run = (c: Cmd | undefined) => { if (!c || c.disabled) return; close(); c.act(); };
  const ask = async () => {
    const text = q().trim();
    if (await askChatGPT(text) && q().trim() === text) close();
  };
  const enter = () => (at() < shown().length ? run(shown()[at()]) : asks() ? ask() : undefined);
  const move = (d: number) => {
    const n = rows(); if (!n) return;
    setAt(i => (i + d + n) % n);
    queueMicrotask(() => list?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }));
  };
  const key = (e: KeyboardEvent) => {
    // the palette owns the keyboard while it is open: no app shortcut fires from what is typed here
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (q()) setQ(''); else close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); enter(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); close(); }
  };
  return (
    <Show when={paletteOpen()}>
      <DialogBoundary name={t('a.cmd.title')} close={close}>
      <div class="overlay cmdover" onPointerDown={close}>
        <div class="dialog cmddlg" role="dialog" aria-modal="true" aria-label={t('a.cmd.title')} onPointerDown={e => e.stopPropagation()} onKeyDown={key}>
          <div class="cmdfind">
            <Icon d="M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M20 20l-4-4" size={16} />
            <input type="search" ref={el => queueMicrotask(() => el.focus())} value={q()} onInput={e => setQ(e.currentTarget.value)}
              placeholder={t('a.cmd.placeholder')} aria-label={t('a.cmd.title')} spellcheck="false" />
            <kbd>Esc</kbd>
          </div>
          <div class="cmdlist" ref={list} role="listbox">
            <For each={groups()}>{([menu, items]) => (
              <>
                <div class="cmdsec"><Show when={dotOf(menu)}>{c => <span class="dot" style={{ background: c() }} />}</Show>{menu}</div>
                <For each={items}>{({ c, i }) => (
                  <div role="option" aria-selected={at() === i ? 'true' : 'false'} aria-disabled={c.disabled == null ? undefined : c.disabled ? 'true' : 'false'} class={['cmd', { on: at() === i, dis: !!c.disabled, danger: !!c.danger }]}
                    onPointerMove={() => setAt(i)} onClick={() => run(c)}>
                    <span class="gl">{c.glyph && <svg width="14" height="14" viewBox={c.glyph.vb} aria-hidden="true"><path d={c.glyph.d} fill="currentColor" fill-rule={c.glyph.eo ? 'evenodd' : undefined} /></svg>}</span>
                    <span class="name ell">{c.label}</span>
                    <Show when={c.sub}><span class="badge">{c.sub}</span></Show>
                    <span class="fill" />
                    <Show when={c.kbd}><span class="keys"><For each={c.kbd!.split('+').map(x => x.trim()).filter(Boolean)}>{k => <kbd>{k}</kbd>}</For></span></Show>
                  </div>
                )}</For>
              </>
            )}</For>
            <Show when={typed()}>
              <Show when={!shown().length}><div class="cmdnone">{t('a.cmd.none', { q: q().trim() })}</div></Show>
              <Show when={FORK.ask}>
              <div class="cmdsec">{t('a.cmd.askSec')}</div>
              <div role="option" aria-selected={at() === shown().length ? 'true' : 'false'} class={['cmd ask', { on: at() === shown().length }]}
                onPointerMove={() => setAt(shown().length)} onClick={ask}>
                <svg width="14" height="14" viewBox={APP_GLYPH.ask.vb} aria-hidden="true"><path d={APP_GLYPH.ask.d} fill="currentColor" /></svg>
                <span class="name ell">{t('a.cmd.ask', { q: q().trim() })}</span>
                <span class="fill" />
                <kbd>Enter</kbd>
              </div>
              </Show>
            </Show>
          </div>
        </div>
      </div>
      </DialogBoundary>
    </Show>
  );
}
