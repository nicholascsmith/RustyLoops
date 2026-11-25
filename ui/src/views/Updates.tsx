// Update dialog, "What's new" dialog, the toolbar button and the Settings → Updates rows.
import { createMemo, For, Match, Show, Switch } from 'solid-js';
import { createSignal, onCleanup } from '../lib/reactive';
import { lang, t } from '../lib/i18n';
import { parseNotes, type Block, type Inline } from '../lib/changelog';
import type { Release } from '../lib/changelog';
import { projectNew } from '../state/actions';
import { checkUpdates, closeUpdateDialog, closeWelcome, closeWhatsNew, installUpdate, openReleasePage, openUpdateDialog, setAutoUpdate, showWhatsNew, startUpdate, upd } from '../state/updates';
import { DialogBoundary } from '../ui/PanelBoundary';
import { FORK } from '../fork';

const mb = (n: number) => (n / 1e6).toFixed(n >= 1e8 ? 0 : 1);

function Inl(p: { parts: Inline[] }) {
  return <For each={p.parts}>{x => x.t === 'b' ? <b>{x.s}</b> : x.t === 'code' ? <code>{x.s}</code> : x.s}</For>;
}

type Group = { t: 'h'; s: string } | { t: 'ul'; items: Inline[][] } | { t: 'p'; inl: Inline[] };
const group = (blocks: Block[]): Group[] => {
  const out: Group[] = [];
  for (const b of blocks) {
    if (b.t === 'li') { const last = out[out.length - 1]; if (last?.t === 'ul') last.items.push(b.inl); else out.push({ t: 'ul', items: [b.inl] }); } else out.push(b);
  }
  return out;
};

/** Added / Changed / Fixed / Removed headings get their own colour (Keep a Changelog's sections). */
const kindOf = (h: string) => /^(added|new)/i.test(h) ? 'added' : /^(fixed|fix)/i.test(h) ? 'fixed' : /^(removed|deprecated)/i.test(h) ? 'removed' : /^(changed|improved)/i.test(h) ? 'changed' : '';

/** Release notes: headings, bullets, **bold** and `code`. Built from text nodes only, never from HTML. */
function Notes(p: { md: string | null; class?: string }) {
  const groups = createMemo(() => group(parseNotes(p.md ?? '')));
  return (
    <div class={'notes ' + (p.class ?? '')}>
      <Show when={groups().length} fallback={<p class="muted">{t('d.upd.nonotes')}</p>}>
        <For each={groups()}>{g => g.t === 'h' ? <h4 class={kindOf(g.s)}>{g.s}</h4> : g.t === 'ul' ? <ul><For each={g.items}>{i => <li><Inl parts={i} /></li>}</For></ul> : <p><Inl parts={g.inl} /></p>}</For>
      </Show>
    </div>
  );
}

/** `2026-11-19` as "19 Nov 2026" in the UI language; anything else as written. */
const fmtDate = (d: string | null) => {
  const m = d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
  if (!m) return d ?? '';
  try { return new Intl.DateTimeFormat(lang() === 'pl' ? 'pl-PL' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(+m[1], +m[2] - 1, +m[3])); } catch { return d ?? ''; }
};

const pct = () => { const s = upd(); return s.total > 0 ? Math.min(100, Math.floor(s.done * 100 / s.total)) : null; };

/** Button beside the menus while an update is found, downloading or waiting for the restart. */
export function UpdateChip() {
  const s = () => upd();
  const label = () => {
    switch (s().phase) {
      case 'available': return t('d.upd.chip.available', { v: s().info?.version ?? '' });
      case 'downloading': return pct() == null ? t('d.upd.chip.downloading0') : t('d.upd.chip.downloading', { pct: pct()! });
      case 'ready': return t('d.upd.chip.ready');
      default: return t('d.upd.chip.installing');
    }
  };
  // "Restart to update" restarts straight away (after the unsaved-changes question); the notes open after the restart.
  const click = async () => {
    if (s().phase !== 'ready') { openUpdateDialog(); return; }
    await installUpdate();
    if (upd().error) openUpdateDialog();
  };
  const tip = () => s().phase === 'ready' ? t('d.upd.chip.ready.tip', { v: s().info?.version ?? '' }) : t('d.upd.chip.tip');
  return (
    <Show when={s().phase !== 'idle' && s().phase !== 'checking' && !(s().phase === 'downloading' && s().quiet)}>
      <button class={['updchip', { ready: s().phase === 'ready', busy: s().phase === 'downloading' || s().phase === 'installing' }]} title={tip()}
        disabled={s().phase === 'installing'} style={{ '--p': (pct() ?? 0) + '%' }} onClick={() => void click()}>{label()}</button>
    </Show>
  );
}

function ReleaseLink(p: { version: string | null }) {
  return <button class="smallbtn" title={t('d.upd.btn.page.tip')} onClick={() => void openReleasePage(p.version)}>{t('d.upd.btn.page')}</button>;
}

export function Updates() {
  return <><UpdateDialog /><WhatsNewDialog /><WelcomeDialog /></>;
}

function UpdateDialog() {
  const s = () => upd();
  const open = () => s().dialog && (s().phase === 'available' || s().phase === 'downloading' || s().phase === 'ready' || s().phase === 'installing');
  return (
    <Show when={open()}>
      <DialogBoundary name={t('d.ui.pn.update')} close={() => closeUpdateDialog()} z={250}>
      <div class="overlay" style={{ 'z-index': 250 }} onPointerDown={() => closeUpdateDialog()}>
        <div class="dialog upddlg" role="dialog" aria-modal="true" aria-label={t('d.upd.title.available')} onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') closeUpdateDialog(); }}>
          <div class="hd"><span>{s().phase === 'ready' || s().phase === 'installing' ? t('d.upd.title.ready') : t('d.upd.title.available')}</span><button aria-label={t('d.upd.btn.close')} onClick={() => closeUpdateDialog()}>×</button></div>
          <div class="updver">
            <b>{t('d.upd.versions', { v: s().info?.version ?? '', cur: s().current })}</b>
            <Show when={s().info?.date}><span>{s().info!.date}</span></Show>
          </div>
          <Notes md={s().info?.notes ?? null} />
          <Switch>
            <Match when={s().phase === 'downloading'}>
              <div class="updbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct() ?? undefined}><i style={{ width: (pct() ?? 0) + '%' }} /></div>
              <div class="updmsg">{s().total > 0 ? t('d.upd.dl', { done: mb(s().done), total: mb(s().total) }) : t('d.upd.dl.unknown', { done: mb(s().done) })}</div>
              <div class="updmsg muted">{t('d.upd.dl.keep')}</div>
            </Match>
            <Match when={s().phase === 'ready'}><div class="updmsg">{t('d.upd.ready.body')}</div></Match>
            <Match when={s().phase === 'installing'}><div class="updmsg">{t('d.upd.installing')}</div></Match>
          </Switch>
          <Show when={s().error}><div class="updmsg err" role="alert">{t('d.upd.fail', { err: s().error! })}</div></Show>
          <div class="updfoot">
            <ReleaseLink version={s().info?.version ?? null} />
            <div style={{ flex: 1 }} />
            <Show when={s().phase !== 'installing'}>
              <button class="smallbtn" onClick={() => closeUpdateDialog()}>{s().phase === 'downloading' ? t('d.upd.btn.close') : t('d.upd.btn.later')}</button>
            </Show>
            <Switch>
              <Match when={s().phase === 'available'}>
                <button class="smallbtn primary" ref={el => setTimeout(() => el.focus())} onClick={() => void startUpdate()}>{s().error ? t('d.upd.btn.retry') : t('d.upd.btn.download')}</button>
              </Match>
              <Match when={s().phase === 'ready'}>
                <button class="smallbtn primary" ref={el => setTimeout(() => el.focus())} onClick={() => void installUpdate()}>{s().error ? t('d.upd.btn.retry') : t('d.upd.btn.restart')}</button>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
      </DialogBoundary>
    </Show>
  );
}

/**
 * What's new: the notes of every version since the one the user had. One release reads as a letter;
 * several get a larger window with a list of versions to jump between (the one in view is marked).
 */
function WhatsNewDialog() {
  return <Show when={FORK.whatsNew && upd().news}>{news => <DialogBoundary name={t('d.news.title')} close={() => void closeWhatsNew()} z={250}><WhatsNew news={news()} from={upd().newsFrom} /></DialogBoundary>}</Show>;
}

function WhatsNew(p: { news: Release[]; from: string | null }) {
  const multi = () => p.news.length > 1;
  const [active, setActive] = createSignal(p.news[0]?.version ?? '');
  let body!: HTMLDivElement;
  const secs = new Map<string, HTMLElement>();
  const spy = () => {
    const top = body.getBoundingClientRect().top + 24;
    let cur = p.news[0]?.version ?? '';
    for (const r of p.news) { const el = secs.get(r.version); if (el && el.getBoundingClientRect().top <= top) cur = r.version; }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) cur = p.news[p.news.length - 1].version;
    setActive(cur);
  };
  const jump = (v: string) => {
    const el = secs.get(v);
    if (el) body.scrollTo({ top: el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 4, behavior: 'smooth' });
    setActive(v);
  };
  onCleanup(() => secs.clear());
  const sub = () => multi()
    ? (p.from ? t('d.news.since', { n: p.news.length, v: p.from }) : t('d.news.count', { n: p.news.length }))
    : [t('d.news.ver', { v: p.news[0].version }), fmtDate(p.news[0].date)].filter(Boolean).join(' · ');
  return (
    <div class="overlay" style={{ 'z-index': 250 }} onPointerDown={() => void closeWhatsNew()}>
      <div class={['dialog newsdlg', { multi: multi() }]} role="dialog" aria-modal="true" aria-label={t('d.news.title')} onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') void closeWhatsNew(); }}>
        <header class="newshd">
          <div>
            <h2>{t('d.news.title')}</h2>
            <div class="newssub">{sub()}</div>
          </div>
          <button class="newsx" aria-label={t('d.upd.btn.close')} onClick={() => void closeWhatsNew()}>×</button>
        </header>
        <div class="newsmain">
          <Show when={multi()}>
            <nav class="newsrail" aria-label={t('d.news.versions')}>
              <For each={p.news}>{(r, i) => (
                <button class={{ on: active() === r.version }} aria-current={active() === r.version ? 'true' : undefined} onClick={() => jump(r.version)}>
                  <b>{r.version}</b>
                  <span>{i() === 0 ? t('d.news.latest') : fmtDate(r.date)}</span>
                </button>
              )}</For>
            </nav>
          </Show>
          <div class="newsbody" ref={body} onScroll={spy}>
            <For each={p.news}>{(r, i) => (
              <section class="newsrel" ref={el => secs.set(r.version, el)}>
                <Show when={multi()}>
                  <div class="newsver">
                    <b>{t('d.news.ver', { v: r.version })}</b>
                    <Show when={i() === 0}><span class="newstag">{t('d.news.latest')}</span></Show>
                    <span class="newsdate">{fmtDate(r.date)}</span>
                  </div>
                </Show>
                <Notes md={r.notes} class="big" />
              </section>
            )}</For>
          </div>
        </div>
        <footer class="newsfoot">
          <ReleaseLink version={active() || (p.news[0]?.version ?? null)} />
          <Show when={lang() === 'pl'}><span class="newsen">{t('d.news.enonly')}</span></Show>
          <div style={{ flex: 1 }} />
          <button class="smallbtn primary" ref={el => setTimeout(() => el.focus())} onClick={() => void closeWhatsNew()}>{t('d.news.ok')}</button>
        </footer>
      </div>
    </div>
  );
}

/** Settings → General → Updates. `OnOff` is the Settings dialog's own switch. */
export function UpdatesSettings(p: { OnOff: (a: { on: () => boolean; set: (v: boolean) => void; title?: string }) => unknown }) {
  const s = () => upd();
  return (
    <>
      <div class="sechd">{t('d.upd.sec')}</div>
      <div class="form">
        <label>{t('d.upd.version')}</label>
        <div class="updrow"><b>{s().current || '—'}</b><Show when={FORK.whatsNew}><button class="smallbtn" onClick={() => showWhatsNew()}>{t('d.upd.whatsnew')}</button></Show></div>
        <Show when={FORK.updates}>
        <label>{t('d.upd.auto')}</label>
        {p.OnOff({ on: () => s().autoUpdate, set: v => void setAutoUpdate(v), title: t('d.upd.auto.tip') }) as never}
        <label />
        <div class="updrow">
          <button class="smallbtn" disabled={s().phase !== 'idle' && s().phase !== 'available'} onClick={() => void checkUpdates(true)}>{s().phase === 'checking' ? t('d.upd.checking') : t('d.upd.check')}</button>
          <Switch>
            <Match when={s().phase === 'available'}>
              <span>{t('d.upd.found', { v: s().info?.version ?? '' })}</span><button class="smallbtn primary" onClick={() => openUpdateDialog()}>{t('d.upd.view')}</button>
            </Match>
            <Match when={s().phase === 'downloading' || s().phase === 'ready' || s().phase === 'installing'}>
              <button class="smallbtn primary" onClick={() => openUpdateDialog()}>{t('d.upd.view')}</button>
            </Match>
            <Match when={s().error}><span class="err" role="alert">{t('d.upd.err', { err: s().error! })}</span></Match>
            <Match when={s().upToDateAt != null}><span class="muted">{t('d.upd.uptodate')}</span></Match>
          </Switch>
        </div>
        </Show>
      </div>
    </>
  );
}

/** The first start of a fresh install: start on the demo song or on the empty project that is already open. */
function WelcomeDialog() {
  const openDemo = () => { closeWelcome(); void projectNew(true); };
  return (
    <Show when={upd().welcome}>
      <DialogBoundary name={t('d.welcome.title')} close={() => closeWelcome()} z={250}>
      <div class="overlay" style={{ 'z-index': 250 }} onPointerDown={() => closeWelcome()}>
        <div class="dialog upddlg" role="dialog" aria-modal="true" aria-label={t('d.welcome.title')} onPointerDown={e => e.stopPropagation()}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') closeWelcome(); }}>
          <div class="hd"><span>{t('d.welcome.title')}</span><button aria-label={t('d.upd.btn.close')} onClick={() => closeWelcome()}>×</button></div>
          <div class="updmsg">{t('d.welcome.body')}</div>
          <div class="updmsg muted">{t('d.welcome.later')}</div>
          <div class="updfoot">
            <div style={{ flex: 1 }} />
            <button class="smallbtn" onClick={() => closeWelcome()}>{t('d.welcome.empty')}</button>
            <button class="smallbtn primary" ref={el => setTimeout(() => el.focus())} onClick={openDemo}>{t('d.welcome.demo')}</button>
          </div>
        </div>
      </div>
      </DialogBoundary>
    </Show>
  );
}
