import { isFullscreen, setFullscreen, toggleFullscreen } from '../state/fullscreen';
import { curPat, newPattern, openRack, patMode, rackFloating, rollFloating, scrollPattern, toggleRackShown, toggleRollShown } from '../state/pattern';
import { patternMenu } from './patternShared';
import { APP_GLYPH as G } from '../ui/menuIcons';
import { forgetRecent, recent, recentLabels, refreshRecent } from '../state/recent';
import { samePath } from '../lib/paths';
import { t, type TranslationKey } from '../lib/i18n';
import { setTypingOn, typingBase, typingOn } from '../state/typingKeys';
import { noteName } from '../lib/pitch';
import { prefs } from '../state/prefs';
import { For, Show } from 'solid-js';
import { createSignal, effect, onCleanup, onMount, watch } from '../lib/reactive';
import { be } from '../api/backend';
import { notify } from '../state/notice';
import { clamp, fmtPos, TapTracker } from '../lib/format';
import { snapLabel } from '../lib/snap';
import * as A from '../state/actions';
import * as MK from '../state/markers';
import { commit, Gesture, wheelEdit } from '../state/edit';
import { S } from '../state/store';
import { tele } from '../state/telemetry';
import { closeMenu, openMenu, say, setU, U, type MenuItem, type Tool } from '../state/ui';
import { anyTucked } from '../state/winOrder';
import { checkUpdates, showWhatsNew } from '../state/updates';
import { toggleMixer, toggleMixView } from '../state/mixView';
import { dockMenu, resetLayout } from '../state/docking';
import { midiFlash, midiStatus } from '../state/midi';
import { track } from '../ui/drag';
import { addFrameTask } from '../ui/frameLoop';
import { Icon } from '../ui/icons';
import { UpdateChip } from './Updates';
import { AskButton, askChatGPT } from './Ask';
import { setCommandMenus, setPaletteOpen } from './Palette';
import { MissingChip } from './MissingAudio';
import { MiniKnob } from '../ui/Knob';
import { VOL_UNITY } from '../api/types';
import { volText } from '../lib/format';
import { autoDisplay, autoTweak, autoWheel, isAutomated, isOverridden, paramMenu, type Tweak } from '../state/automation';
import { masterClip, masterClipTip, resetMasterClip } from '../state/masterClip';
import { cpuBand, cpuText, resetUnderruns, underrunFlash, underruns } from '../state/underruns';
import { audioStatus, openAudioSettings } from '../state/audioWatch';
import { fitLevel, FIT_MAX, gridFits } from '../lib/toolbarFit';
import { KeyBadge } from './KeyBadge';
import { PosReadout, PreviewLine, SongPos } from './ToolbarParts';
import { shownPreview } from '../state/previewWave';
import { ChipBoundary, DialogBoundary } from '../ui/PanelBoundary';
import { FORK } from '../fork';

export const TOOLS: [Tool, string, TranslationKey][] = [
  ['draw', 'P', 'a.tb.toolDraw'], ['paint', 'B', 'a.tb.toolPaint'], ['erase', 'D', 'a.tb.toolErase'], ['mute', 'T', 'a.tb.toolMute'], ['slice', 'C', 'a.tb.toolSlice'], ['select', 'E', 'a.tb.toolSelect'],
];
export const TOOL_HINT: Record<Tool, TranslationKey> = { draw: 'a.tb.hint_draw', paint: 'a.tb.hint_paint', erase: 'a.tb.hint_erase', mute: 'a.tb.hint_mute', slice: 'a.tb.hint_slice', select: 'a.tb.hint_select' };

const clampBpm = (v: number) => clamp(Math.round(v * 100) / 100, 20, 999);

export function Toolbar() {
  let inEl!: HTMLDivElement, barEl!: HTMLDivElement, gridEl!: HTMLDivElement;
  // the fit (lib/toolbarFit.ts): measured again when the bar's width or what it shows changes
  onMount(() => {
    const apply = (n: number) => { for (let i = 1; i <= FIT_MAX; i++) barEl.classList.toggle('f' + i, i <= n); };
    const fits = () => gridFits(gridEl);
    let raf = 0;
    const refit = () => { raf = 0; if (barEl.isConnected && barEl.clientWidth > 0) fitLevel(apply, fits); };
    const later = () => { if (!raf) raf = requestAnimationFrame(refit); };
    // what ticks while playing (the position, the status line, the meters) never changes what fits
    const ticking = (n: Node) => !!(n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('.clock, .tbstatus, .cpumeter, .inmeter, .songpos');
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(later) : null;
    ro?.observe(barEl);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(rs => { if (rs.some(r => !ticking(r.target))) later(); }) : null;
    mo?.observe(barEl, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(later);
    later();
    onCleanup(() => { ro?.disconnect(); mo?.disconnect(); cancelAnimationFrame(raf); });
  });
  let inHold = 0;
  onMount(() => {
    const stop = addFrameTask(() => {
      if (!inEl) return;
      inHold = Math.max(tele.frame.inLevel, inHold * 0.9);
      inEl.style.transform = `scaleX(${Math.min(1, Math.sqrt(inHold))})`;
      inEl.style.background = inHold > 0.89 ? 'var(--red)' : inHold > 0.5 ? 'var(--amber)' : 'var(--green)';
    });
    onCleanup(stop);
  });
  const bpmDown = (e: PointerEvent) => {
    if (e.button !== 0) return; e.preventDefault();
    const g = new Gesture('Tempo');
    let v = S.project.bpm, lx = e.clientX, ly = e.clientY;
    track(ev => {
      const d = (ev.clientX - lx) + (ly - ev.clientY); lx = ev.clientX; ly = ev.clientY;
      v = clamp(v + d * (ev.shiftKey ? 0.05 : 0.5), 20, 999);
      const b = clampBpm(ev.shiftKey ? v : Math.round(v));
      if (b !== S.project.bpm) g.update([{ op: 'setBpm', bpm: b }]);
      say('Tempo ' + b.toFixed(2) + ' BPM');
    }, () => g.end(), 'ns-resize');
  };
  const bpmWheel = (e: WheelEvent) => {
    const d = e.deltaY || e.deltaX; if (!d) return;
    e.preventDefault();
    const b = clampBpm(S.project.bpm + (d < 0 ? 1 : -1) * (e.shiftKey ? 0.01 : 1));
    wheelEdit('bpm', 'Tempo', [{ op: 'setBpm', bpm: b }]);
    say('Tempo ' + b.toFixed(2) + ' BPM');
  };
  const tapper = new TapTracker();
  const [tapping, setTapping] = createSignal(false);
  let tapTimer = 0;
  onCleanup(() => clearTimeout(tapTimer));
  const doTap = (e?: MouseEvent) => {
    const r = tapper.tap(performance.now(), !e?.shiftKey);
    setTapping(true);
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => setTapping(false), 2000);
    if (r.bpm != null) {
      wheelEdit('tap-bpm', 'Tap tempo', [{ op: 'setBpm', bpm: r.bpm }]);
      say(`Tap tempo · ${r.bpm.toFixed(2)} BPM (${r.count}×)`);
    } else {
      say(t('a.tb.tapKeep'));
    }
  };
  const recDest = () => {
    const pat = A.patRecords() ? curPat() : undefined;
    if (pat) return { label: pat.name, tip: t('d.rec.destPat', { name: pat.name }) };
    const dest = A.recTargetName(U.start);
    return { label: dest, tip: t('d.rec.dest', { what: A.recFilterName(), dest }) };
  };
  // FL: right-click on Record chooses what a recording captures
  const recMenu = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    openMenu(e.clientX, e.clientY, [
      { t: 'title', label: t('a.tb.recWhat') },
      ...(FORK.audioRecording ? [{ t: 'item', label: t('a.tb.recAudio'), title: t('a.tb.recAudioTip'), checked: T().recAudio, act: () => void A.setRecFilter('audio', !T().recAudio) } as MenuItem] : []),
      { t: 'item', label: t('a.tb.recNotes'), title: t('a.tb.recNotesTip'), checked: T().recNotes, act: () => void A.setRecFilter('notes', !T().recNotes) },
      { t: 'item', label: t('a.tb.recAutomation'), title: t('a.tb.recAutomationTip'), checked: T().recAutomation, act: () => void A.setRecAutomation(!T().recAutomation) },
      { t: 'item', label: t('a.tb.recAutoLatch'), title: t('a.tb.recAutoLatchTip'), disabled: !T().recAutomation, checked: T().recAutoLatch, act: () => void A.setRecAutoLatch(!T().recAutoLatch) },
      { t: 'sep' },
      { t: 'sub', label: t('a.tb.recQuantize'), items: A.REC_QUANTIZE.map(q => ({ t: 'item' as const, label: t(q.label), checked: T().recQuantize === q.beats, act: () => void A.setRecQuantize(q.beats) })) },
      { t: 'item', label: t('a.tb.recTyping'), kbd: 'Ctrl+T', title: t('a.tb.typOff'), checked: typingOn(), act: () => setTypingOn(!typingOn()) },
    ]);
  };
  const bpmMenu = (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const b = S.project.bpm;
    const setB = (nb: number, label = 'Tempo') => {
      const c = clampBpm(nb);
      commit([{ op: 'setBpm', bpm: c }], label);
      say('Tempo ' + c.toFixed(2) + ' BPM');
    };
    const hasAudio = S.project.clips.some(c => c.kind === 'audio');
    openMenu(e.clientX, e.clientY, [
      { t: 'title', label: 'Tempo · ' + b.toFixed(2) + ' BPM' },
      { t: 'item', label: t('a.tb.tapMenu'), kbd: t('a.tb.tapKbd'), act: () => doTap() },
      { t: 'item', label: t('a.tb.detectProj'), disabled: !hasAudio, act: () => A.openMusicAnalysis({}) },
      { t: 'sep' },
      { t: 'item', label: t('a.tb.halfTempo', { bpm: clampBpm(b / 2).toFixed(1) }), disabled: b / 2 < 20, act: () => setB(b / 2, t('a.tb.halfLabel')) },
      { t: 'item', label: t('a.tb.doubleTempo', { bpm: clampBpm(b * 2).toFixed(1) }), disabled: b * 2 > 999, act: () => setB(b * 2, t('a.tb.doubleLabel')) },
      { t: 'sep' },
      { t: 'chips', label: t('a.tb.quickPick'), options: ['80', '90', '100', '110', '120', '128', '140', '160'], active: [80, 90, 100, 110, 120, 128, 140, 160].indexOf(Math.round(b)), pick: i => setB([80, 90, 100, 110, 120, 128, 140, 160][i]) },
    ], 260);
  };
  const T = () => S.transport;
  // custom title bar: empty toolbar areas and the project name drag the window, 2× click maximises
  const win = be().win;
  const [maxed, setMaxed] = createSignal(false);
  onMount(() => {
    if (!win) return;
    const upd = () => win.isMaximized().then(setMaxed).catch(() => {});
    upd();
    let off: (() => void) | null = null;
    win.onResized(upd).then(u => { off = u; });
    onCleanup(() => off?.());
  });
  let lastDown = 0;
  const dragDown = (e: MouseEvent) => {
    if (!win || e.button !== 0) return;
    const el = e.target as HTMLElement;
    // Drag only from the bar itself or an element marked data-drag, never from a
    // child of one (the cells hold every button: closest() swallowed their clicks).
    if (el !== e.currentTarget && !el.hasAttribute('data-drag')) return;
    const now = performance.now();
    if (isFullscreen()) return; // nothing to drag or maximize: the window is the screen
    if (now - lastDown < 350) { lastDown = 0; void win.toggleMaximize(); return; }
    lastDown = now;
    void win.startDragging();
  };
  const wins = () => U.plugs.length + (rackFloating() ? 1 : 0) + (rollFloating() ? 1 : 0);
  const hint = () => t('a.tb.statusHint', { tool: t(TOOLS.find(x => x[0] === U.tool)![2]), hint: t(TOOL_HINT[U.tool]), snap: U.alt ? 'off' : snapLabel(U.snap, U.bw).replace('Snap: ', '') });
  // Two rows on shared columns (FL's bar): row 1 holds what is used all the time — menus, transport,
  // tempo and key, pattern, output, panels — at one height; row 2, quieter, holds what belongs to
  // the control above it: the status line under the menus, the song position under the transport,
  // the time under the tempo, the transport's switches under the pattern, loop and follow on the right.
  // Each part sits behind its own error boundary: a failed part says so in its place; the others,
  // the window buttons (outside every part) and the drag areas keep working.
  return (
    <div ref={barEl} class={['toolbar', { native: !!win }]} onMouseDown={dragDown}>
      <div ref={gridEl} class="tbgrid" data-drag>
        <div class="tbc tbmenus" data-drag>
          <ChipBoundary name={t('d.ui.pn.menus')}>
            <MenuBar />
            <button class="cmdbtn" title={t('a.cmd.title') + ' (Ctrl+K)'} aria-label={t('a.cmd.title')} onClick={() => setPaletteOpen(true)}>
              <Icon d="M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z M20 20l-4-4" size={13} /><kbd>Ctrl K</kbd>
            </button>
            <AskButton />
            <MissingChip />
            {/* the project's name is the window's (taskbar) title; here only the unsaved mark, with the path on hover */}
            <Show when={S.dirty}><span data-drag class="projName" title={(S.path ?? t('a.tb.unsavedProj')) + t('a.tb.unsavedChanges')}><span data-drag class="dirty">•</span></span></Show>
          </ChipBoundary>
        </div>
        {/* the status line (FL's hint bar): the Browser's preview while it plays, else what the last action did and what the tool does */}
        <div class="tbc tbstatus" data-drag>
          <ChipBoundary name={t('d.ui.pn.menus')}>
            <span class="hled" style={{ background: S.transport.rec && U.playing ? 'var(--red)' : U.playing ? 'var(--green)' : 'var(--fg6)' }} />
            <Show when={shownPreview()} fallback={<>
              <span class="readout" data-readout title={U.readout}>{U.readout}</span>
              <Show when={prefs().hints}><span class="hinttxt">{hint()}</span></Show>
            </>}>
              <PreviewLine />
            </Show>
            <Show when={U.alt}><span class="offgrid">OFF GRID</span></Show>
            {/* Record armed: where the recording goes (the first free track, a new one, the looping pattern) */}
            <Show when={T().rec}>
              <span class="recdest" title={recDest().tip}>● {recDest().label}</span>
            </Show>
            <div class="row inrow" title={t('a.tb.inLevel')} style={{ gap: '6px', display: FORK.audioRecording && (T().rec || T().monitor) ? 'flex' : 'none' }}>
              <span class="tag9">IN</span>
              <div class="inmeter"><div ref={inEl} /></div>
            </div>
            {/* a found, downloading or downloaded update: the status line, where it never crowds the menus */}
            <UpdateChip />
          </ChipBoundary>
        </div>
        <div class="tbc tbtransport">
          <ChipBoundary name={t('d.ui.pn.transport')}>
            <div class="seg patsong" title={t('a.tb.patSongTip')}>
              <button class={['pat', { on: patMode() }]} onClick={() => A.switchMode(true)}>PAT</button>
              <button class={['song', { on: !patMode() }]} onClick={() => A.switchMode(false)}>SONG</button>
            </div>
            <div class="seg tport">
              <button title={patMode() ? t('a.tb.playPat') : t('a.tb.playSong')} data-act="play" class={{ play: U.playing || U.patPlaying }} onClick={() => void A.togglePlay()}>
                <svg width="11" height="11" viewBox="0 0 14 14"><path d="M3 1.5v11l9-5.5z" fill="currentColor" /></svg>
              </button>
              <button title={t('a.tb.stopTip')} onClick={() => void A.stop(!(U.playing || U.patPlaying))}><svg width="10" height="10" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="currentColor" /></svg></button>
              <button title={t('a.tb.recTip', { what: A.recFilterName() })} class={['rec', { armed: T().rec }]} onClick={A.toggleRec} onContextMenu={recMenu}>
                <svg width="10" height="10" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="currentColor" /></svg>
              </button>
            </div>
          </ChipBoundary>
        </div>
        <div class="tbc tbpos"><ChipBoundary name={t('d.ui.pn.transport')}><SongPos /></ChipBoundary></div>
        <div class="tbc tbtempo">
          <ChipBoundary name={t('d.ui.pn.transport')}>
            <div class="clockbox" onContextMenu={bpmMenu}>
              <span class="bpm" title={t('a.tb.bpmTip')} onPointerDown={bpmDown} onWheel={bpmWheel}>{S.project.bpm.toFixed(2)}</span>
              <span class="tag9">BPM</span>
              <button class={['tapbtn', { on: tapping() }]} data-tap title={t('a.tb.tapTip')} onClick={e => doTap(e)}>TAP</button>
            </div>
            <KeyBadge />
          </ChipBoundary>
        </div>
        <div class="tbc tbtime" data-drag><PosReadout /></div>
        <div class="tbc tbpat"><ChipBoundary name={t('d.ui.pn.transport')}><PatSelector /></ChipBoundary></div>
        {/* the transport's switches, under the pattern: plain icons, lit when on */}
        <div class="tbc tbtoggles">
          <ChipBoundary name={t('d.ui.pn.transport')}>
            <Show when={FORK.audioRecording}><button title={t('a.tb.monTip')} class={['tsw monbtn', { on: T().monitor }]} aria-pressed={T().monitor ? 'true' : 'false'} onClick={A.toggleMonitor}>
              <Icon d="M4 15v-3a8 8 0 0 1 16 0v3 M3 14h4v7H3z M17 14h4v7h-4z" size={13} />
            </button></Show>
            <button title={t('a.tb.metroTip')} class={['tsw metrobtn', { on: T().metro }]} aria-pressed={T().metro ? 'true' : 'false'} onClick={() => void A.setTransportFlag('metro', !T().metro)}>
              <Icon d="M9 3h6l4 18H5z M12 16l6-9" size={13} />
            </button>
            <button class={['tsw count', { on: T().countIn }]} aria-pressed={T().countIn ? 'true' : 'false'} title={t('a.tb.countTip')} onClick={() => void A.setTransportFlag('countIn', !T().countIn)}>1 BAR</button>
            {/* an input mode, like record and monitor: with the transport's switches */}
            <button class={['tsw typkb', { on: typingOn() }]} aria-pressed={typingOn() ? 'true' : 'false'} title={typingOn() ? t('a.tb.typOn', { z: noteName(typingBase()), q: noteName(typingBase() + 12) }) : t('a.tb.typOff')}
              onClick={() => setTypingOn(!typingOn())}>
              <Icon d="M3 6h18v12H3z M7 6v7 M11 6v7 M15 6v7 M19 6v7 M3 13h18" size={13} />
              <span class="lbl">{t('a.tb.typLabel')}</span>
              <Show when={typingOn()}><span class="mono typoct">{noteName(typingBase())}</span></Show>
            </button>
          </ChipBoundary>
        </div>
        <div class="tbc tbfill" data-drag />
        {/* the output: main volume, the master's level (and clip latch), the engine's load */}
        <div class="tbc tbout">
          <ChipBoundary name={t('d.ui.pn.transport')}>
            <MainVolume />
            <MasterOut />
            <Show when={prefs().cpuMeter}><CpuMeter /></Show>
          </ChipBoundary>
        </div>
        <div class="tbc tbpanels">
          <ChipBoundary name={t('d.ui.pn.panels')}>
            <Show when={wins()}>
              <button class={['tbtn icon winsbtn', { on: !anyTucked() }]} onClick={() => (anyTucked() ? A.showPlugs() : A.playlistFront())}
                title={anyTucked() ? t('a.tb.showWins', { n: wins() }) : t('a.tb.hideWins')} aria-label={t('a.tb.windows', { n: wins() })}>
                <Icon d="M4 7h12v12H4z M8 3h12v12" size={14} /><span class="cnt mono">{wins()}</span>
              </button>
            </Show>
            {/* FL's window buttons: what is open is lit; a click brings a closed (or buried) window back. The Piano
                roll opens from a channel or a clip (F7, View menu): a button for it would open whichever channel is selected */}
            <div class="panelstrip">
              <button class={['tbtn icon panelbtn', { on: U.pickOpen }]} onClick={() => setU('pickOpen', !U.pickOpen)} title={t('a.tb.browserTip')} aria-label={t('a.mn.browser')} aria-pressed={U.pickOpen ? 'true' : 'false'}>
                <Icon d="M3 5h18v14H3z M9 5v14 M5 9h2 M5 12h2 M5 15h2" size={14} />
                <span class="lbl">{t('a.mn.browser')}</span>
              </button>
              <button class={['tbtn icon panelbtn', { on: !!U.rackWin }]} onClick={toggleRackShown} title={t('a.tb.rackTip')} aria-label={t('a.mn.rack')} aria-pressed={U.rackWin ? 'true' : 'false'}>
                <Icon d="M3 5h4v4H3z M10 5h4v4h-4z M17 5h4v4h-4z M3 15h4v4H3z M10 15h4v4h-4z M17 15h4v4h-4z" size={14} />
                <span class="lbl">{t('a.mn.rack')}</span>
              </button>
              <button class={['tbtn icon panelbtn', { on: !U.mixMin }]} onClick={toggleMixer} title={t('a.tb.mixerTip')} aria-label={t('a.mn.mixer')} aria-pressed={!U.mixMin ? 'true' : 'false'}>
                <Icon d="M5 21v-7M5 10V3M12 21v-9M12 8V3M19 21v-5M19 12V3M2 14h6M9 8h6M16 16h6" size={14} />
                <span class="lbl">{t('a.mn.mixer')}</span>
              </button>
            </div>
            <Show when={midiStatus()?.selected}>
              <button class="ibtn midibtn" onClick={() => setU('settings', true)}
                title={midiStatus()?.connected ? t('a.tb.midiOn', { name: midiStatus()!.connected!.name }) : t('a.tb.midiOff')}>
                <span class={['midiled', { on: !!midiStatus()?.connected, hit: midiFlash() }]} /><span class="tag9">MIDI</span>
              </button>
            </Show>
          </ChipBoundary>
        </div>
        {/* under the output and the panels: the loop range (when there is one) and Follow (F) */}
        <div class="tbc tbview" data-drag>
          <ChipBoundary name={t('d.ui.pn.panels')}>
            <Show when={S.project.loop}>{l => (
              <span data-drag class="loopText" title={t('a.tb.loopTip')}
                onContextMenu={e => { e.preventDefault(); openMenu(e.clientX, e.clientY, [{ t: 'item', label: t('a.pl.deleteLoop'), act: () => { A.setLoop(null, t('a.pl.deleteLoop')); say(t('a.pl.loopDeleted')); } }]); }}>
                LOOP {fmtPos(l().a)} – {fmtPos(l().b)}
              </span>
            )}</Show>
            <button class={['tsw follow', { on: U.follow }]} aria-pressed={U.follow ? 'true' : 'false'} title={t('a.tb.followTip')} onClick={() => setU('follow', !U.follow)}>
              <Icon d="M5 4v16 M9 8l10 4-10 4z" size={12} />
              <span class="lbl">{t('a.tb.follow')}</span>
            </button>
          </ChipBoundary>
        </div>
      </div>
      <Show when={win}>
        <div class="winbtns">
          <button title={t('a.tb.minimize')} aria-label={t('a.tb.minimize')} onClick={() => void win!.minimize()}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" /></svg></button>
          <Show when={isFullscreen()}>
            <button title={t('a.tb.exitFull')} aria-label={t('a.tb.exitFull')} onClick={() => void setFullscreen(false)}>
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 .5v3h-3 M6.5 .5v3h3 M3.5 9.5v-3h-3 M6.5 9.5v-3h3" fill="none" stroke="currentColor" /></svg>
            </button>
          </Show>
          <button hidden={isFullscreen()} title={maxed() ? t('a.tb.restore') : t('a.tb.maximize')} aria-label={maxed() ? t('a.tb.restore') : t('a.tb.maximize')} onClick={() => void win!.toggleMaximize()}>
            <Show when={maxed()} fallback={<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>}>
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5V.5h7v7h-2 M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" /></svg>
            </Show>
          </button>
          <button class="close" title={t('a.tb.close')} aria-label={t('a.tb.close')} onClick={() => void win!.close()}><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1.1" /></svg></button>
        </div>
      </Show>
    </div>
  );
}

/**
 * The application menus. A press opens one under its title; while one is open, pressing or
 * moving over another title switches to it in one step (dismissal of presses elsewhere is
 * handled at the document level — see ContextMenu — so nothing covers the bar).
 */
function MenuBar() {
  const [open, setOpen] = createSignal(-1);
  effect(() => { if (!U.menu) setOpen(-1); });
  const win = be().win;
  const none = () => !U.sel.length;
  const wins = () => U.plugs.length + (rackFloating() ? 1 : 0) + (rollFloating() ? 1 : 0);
  onMount(() => void refreshRecent());
  /** File → Open recent: newest first, the open project ticked, a moved or deleted file shown but not openable. */
  const recentItems = (): MenuItem[] => {
    const list = recent();
    if (!list.length) return [{ t: 'item', label: t('a.mn.recentNone'), disabled: true, act: () => {} }];
    const labels = recentLabels(list);
    const items: MenuItem[] = list.map((r, i) => r.exists
      ? { t: 'item', label: labels[i], title: r.path, checked: samePath(r.path, S.path), disabled: U.openingProject, act: () => void A.projectOpen(r.path) }
      : { t: 'item', label: t('a.mn.recentMissing', { name: labels[i] }), title: t('a.mn.recentMissingTip', { path: r.path }), disabled: true, act: () => {} });
    items.push({ t: 'sep' });
    if (list.some(r => !r.exists)) {
      items.push({ t: 'item', label: t('a.mn.recentPrune'), act: () => { void (async () => { for (const r of list.filter(x => !x.exists)) await forgetRecent(r.path); })(); } });
    }
    items.push({ t: 'item', label: t('a.mn.recentClear'), act: () => void forgetRecent() });
    return items;
  };
  /** Edit › Markers: add at the song position, jump, and every marker of the song (the palette finds them by name). */
  const markerItems = (): MenuItem[] => {
    const ms = MK.markers(), none = !ms.length;
    const items: MenuItem[] = [
      { t: 'item', label: t('a.mk.add'), kbd: 'Alt+T', title: t('a.mk.addTip'), act: () => void MK.addMarker() },
      { t: 'item', label: t('a.mk.prev'), kbd: 'Alt+←', disabled: none, act: () => MK.jump(-1) },
      { t: 'item', label: t('a.mk.next'), kbd: 'Alt+→', disabled: none, act: () => MK.jump(1) },
    ];
    if (none) return items;
    items.push({ t: 'sec', label: t('a.mk.inSong', { n: ms.length }) });
    for (const m of ms) items.push({ t: 'item', label: (m.name || t('a.mk.unnamed')) + ' · ' + fmtPos(m.at), title: t('a.mk.jumpTip'), act: () => MK.jumpTo(m.id) });
    return items;
  };
  const menus: [TranslationKey, () => MenuItem[]][] = [
    ['a.mn.file', () => [
      { t: 'item', label: t('a.mn.new'), glyph: G.new, kbd: 'Ctrl+Shift+N', disabled: U.openingProject, act: () => void A.projectNew() },
      { t: 'item', label: t('a.mn.open'), glyph: G.open, kbd: 'Ctrl+O', disabled: U.openingProject, act: () => void A.projectOpen() },
      { t: 'sub', label: t('a.mn.openRecent'), glyph: G.open, items: recentItems() },
      { t: 'item', label: t('a.mn.openDemo'), glyph: G.open, title: t('a.mn.openDemoTip'), disabled: U.openingProject, act: () => void A.projectNew(true) },
      { t: 'sep' },
      { t: 'item', label: t('a.mn.save'), glyph: G.save, kbd: 'Ctrl+S', act: () => void A.projectSave(false) },
      { t: 'item', label: t('a.mn.saveAs'), glyph: G.saveAs, kbd: 'Ctrl+Shift+S', act: () => void A.projectSave(true) },
      { t: 'item', label: t('a.mn.saveVersion'), glyph: G.saveAs, kbd: 'Ctrl+N', title: t('a.mn.saveVersionTip'), act: () => void A.projectSave(false, true) },
      { t: 'sep' },
      { t: 'item', label: t('a.mn.export'), glyph: G.export, kbd: 'Ctrl+Shift+R', act: () => setU('exportOpen', true) },
      { t: 'item', label: t('a.pl.inPlace'), glyph: G.export, kbd: 'Ctrl+Alt+E', title: t('a.pl.inPlaceTip'), disabled: !S.project.clips.some(c => U.sel.includes(c.id) && c.kind !== 'auto') && !S.project.loop, act: () => void A.exportInPlace() },
      { t: 'item', label: t('a.pl.inPlaceRange'), glyph: G.export, title: S.project.loop ? t('a.pl.inPlaceRangeTip') : t('d.act.inPlaceNoRange'), disabled: !A.rangeInPlaceClips().length, act: () => void A.exportRangeInPlace() },
      ...(FORK.projectZip ? [{ t: 'item', label: t('a.mn.exportProjectZip'), glyph: G.exportZip, disabled: U.projectZipBusy || U.openingProject, act: () => void A.projectExportZip() } as MenuItem] : []),
      { t: 'sep' },
      { t: 'item', label: t('d.midi.mnImport'), glyph: G.midiImport, act: () => void A.midiImport() },
      ...(FORK.midiExport ? [{ t: 'item', label: t('d.midi.mnExport'), glyph: G.midiExport, disabled: !S.project.clips.some(c => c.kind === 'pat' && !c.muted), act: () => void A.midiExport() } as MenuItem] : []),
      { t: 'sep' },
      { t: 'item', label: t('a.mn.settings'), glyph: G.settings, act: () => setU('settings', true) },
      ...(win ? [{ t: 'sep' } as MenuItem, { t: 'item', label: t('a.mn.exit'), glyph: G.exit, kbd: 'Alt+F4', act: () => void win.close() } as MenuItem] : []),
    ]],
    ['a.mn.edit', () => [
      { t: 'item', label: S.undoLabel ? `${t('a.mn.undo')}: ${S.undoLabel}` : t('a.mn.undo'), glyph: G.undo, kbd: 'Ctrl+Z', disabled: !S.canUndo, act: () => void A.undo() },
      { t: 'item', label: S.redoLabel ? `${t('a.mn.redo')}: ${S.redoLabel}` : t('a.mn.redo'), glyph: G.redo, kbd: 'Ctrl+Shift+Z', disabled: !S.canRedo, act: () => void A.redo() },
      { t: 'sep' },
      { t: 'item', label: t('a.mn.cut'), glyph: G.cut, kbd: 'Ctrl+X', disabled: none(), act: A.cut },
      { t: 'item', label: t('a.mn.copy'), glyph: G.copy, kbd: 'Ctrl+C', disabled: none(), act: A.copy },
      { t: 'item', label: t('a.mn.paste'), glyph: G.paste, kbd: 'Ctrl+V', disabled: !A.hasClipboard(), act: () => A.paste() },
      { t: 'item', label: t('a.mn.dup'), glyph: G.dup, kbd: 'Ctrl+B', disabled: none(), act: A.duplicate },
      { t: 'item', label: t('a.mn.del'), glyph: G.del, kbd: 'Del', disabled: none(), act: () => A.delIds([...U.sel]) },
      { t: 'sep' },
      { t: 'item', label: t('a.mn.selAll'), glyph: G.selAll, kbd: 'Ctrl+A', disabled: !S.project.clips.length, act: A.selectAll },
      { t: 'sep' },
      { t: 'sub', label: t('a.mk.menu'), items: markerItems() },
    ]],
    ['a.mn.view', () => [
      { t: 'item', label: t('a.mn.browser'), kbd: 'Alt+F8', checked: U.pickOpen, act: () => setU('pickOpen', !U.pickOpen) },
      { t: 'item', label: t('a.mn.mixer'), kbd: 'F9', checked: !U.mixMin, act: toggleMixer },
      { t: 'item', label: t('a.mn.mixMax'), checked: U.mixView, title: t('a.mn.mixMaxTip'), act: toggleMixView },
      { t: 'item', label: t('a.mn.rack'), kbd: 'F6', checked: !!U.rackWin, act: toggleRackShown },
      { t: 'item', label: t('a.mn.roll'), kbd: 'F7', checked: !!U.rollWin, act: toggleRollShown },
      { t: 'sub', label: t('a.mn.layout'), glyph: G.windows, items: [
        { t: 'sec', label: t('a.mn.rack') }, ...dockMenu('rack'),
        { t: 'sec', label: t('a.mn.roll') }, ...dockMenu('roll'),
        { t: 'sec', label: t('a.mn.mixer') }, ...dockMenu('mix'),
        { t: 'sep' },
        { t: 'item', label: t('a.mn.layoutReset'), title: t('a.mn.layoutResetTip'), act: resetLayout },
      ] },
      { t: 'item', label: t(anyTucked() ? 'a.mn.winsShow' : 'a.mn.winsHide'), glyph: G.windows, kbd: 'F5', disabled: !wins(), act: () => (anyTucked() ? A.showPlugs() : A.playlistFront()) },
      { t: 'sep' },
      // the transport toggles the toolbar hides first on a narrow window
      { t: 'item', label: t('a.mn.metro'), kbd: 'Ctrl+M', checked: S.transport.metro, act: () => void A.setTransportFlag('metro', !S.transport.metro) },
      { t: 'item', label: t('a.mn.countIn'), checked: S.transport.countIn, act: () => void A.setTransportFlag('countIn', !S.transport.countIn) },
      ...(FORK.audioRecording ? [{ t: 'item', label: t('a.mn.monitor'), checked: S.transport.monitor, act: A.toggleMonitor } as MenuItem] : []),
      { t: 'item', label: t('a.mn.typing'), checked: typingOn(), act: () => setTypingOn(!typingOn()) },
      { t: 'sep' },
      { t: 'item', label: t('a.mn.follow'), kbd: 'F', checked: U.follow, act: () => setU('follow', !U.follow) },
      { t: 'item', label: t('a.mn.zoomIn'), glyph: G.zoomIn, kbd: 'Ctrl+=', act: () => A.zoomAt(1.25) },
      { t: 'item', label: t('a.mn.zoomOut'), glyph: G.zoomOut, kbd: 'Ctrl+−', act: () => A.zoomAt(0.8) },
      { t: 'sep' },
      { t: 'item', label: t('a.mn.fullscreen'), kbd: 'F11', checked: isFullscreen(), act: () => void toggleFullscreen() },
    ]],
    ['a.mn.help', () => [
      ...(FORK.ask ? [{ t: 'item', label: t('d.ask.button'), glyph: G.ask, kbd: 'F1', act: () => void askChatGPT() } as MenuItem] : []),
      { t: 'item', label: t('a.cmd.title'), glyph: G.shortcuts, kbd: 'Ctrl+K', act: () => setPaletteOpen(true) },
      { t: 'item', label: t('a.mn.shortcuts'), glyph: G.shortcuts, kbd: '?', act: () => setU('help', true) },
      ...(FORK.updates || FORK.whatsNew || FORK.discord ? [{ t: 'sep' } as MenuItem] : []),
      ...(FORK.updates ? [{ t: 'item', label: t('a.mn.updates'), glyph: G.updates, act: () => void checkUpdates() } as MenuItem] : []),
      ...(FORK.whatsNew ? [{ t: 'item', label: t('a.mn.whatsNew'), glyph: G.whatsNew, act: () => void showWhatsNew() } as MenuItem] : []),
      ...(FORK.discord ? [{ t: 'sep' } as MenuItem, { t: 'item', label: t('a.mn.discord'), glyph: G.discord, act: () => void be().openDiscord().catch(e => notify(t('a.mn.discordFailed', { error: String(e) }))) } as MenuItem] : []),
    ]],
  ];
  setCommandMenus(menus);
  // whether the open menu was opened by a press on its own title (vs a hover switch): a press
  // on the open title toggles closed only then — a press on a hover-switched title keeps it,
  // so "click Edit while File is open" ends with Edit's menu open either way
  let byPress = false;
  const show = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    closeMenu(); // remount: an open panel keeps the position it was mounted at
    openMenu(r.left, r.bottom + 3, menus[i][1](), 340);
    setOpen(i);
  };
  return (
    <div class={['menubar', { open: open() >= 0 }]} role="menubar">
      <For each={menus}>
        {([key], i) => (
          <button class={['mbtn', { on: open() === i() }]} role="menuitem" aria-haspopup="menu" aria-expanded={open() === i() ? 'true' : 'false'}
            onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); if (open() === i()) { if (byPress) closeMenu(); } else { byPress = true; show(i(), e.currentTarget); } }}
            onPointerEnter={e => { if (open() >= 0 && open() !== i()) { byPress = false; show(i(), e.currentTarget); } }}>{t(key)}</button>
        )}
      </For>
    </div>
  );
}

/**
 * FL's pattern selector: the current pattern (number, colour, name). Click = the patterns menu
 * (pick, new, clone, rename, split, delete); wheel = previous / next; + = new pattern.
 */
function PatSelector() {
  const n = () => { const p = curPat(); return p ? S.project.patterns.indexOf(p) + 1 : 0; };
  let acc = 0;
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    acc += e.deltaY || e.deltaX;
    if (Math.abs(acc) < 40) return;
    scrollPattern(acc > 0 ? 1 : -1); acc = 0;
  };
  return (
    <div class="patselbox" data-patsel>
      {/* the name shows the pattern in the Channel Rack; the arrow (or a right-click) lists the patterns */}
      <button class="patselbtn" title={t('b.ps.title')} onWheel={wheel} onClick={() => openRack()}
        onContextMenu={e => { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); patternMenu(r.left, r.bottom + 4, true); }}>
        <Show when={curPat()} fallback={<span class="ell" style={{ color: 'var(--fg5)' }}>—</span>}>
          {p => <>
            <span class="num mono">{n()}</span>
            <span class="sw" style={{ background: p().color }} />
            <span class="ell">{p().name}</span>
          </>}
        </Show>
      </button>
      <button class="patselarrow" title={t('b.ps.list')} aria-label={t('b.ps.list')}
        onClick={e => { const r = (e.currentTarget.previousElementSibling as HTMLElement).getBoundingClientRect(); patternMenu(r.left, r.bottom + 4, true); }}>
        <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
      </button>
      <button class="patselnew" title={t('b.pat.new')} onClick={() => { newPattern(); openRack(); }}><Icon d="M12 5v14 M5 12h14" size={11} /></button>
    </div>
  );
}

const shortcuts = (): [string, string][] => [
  ['Play / Stop', t('a.sc.1')],
  [t('d.ask.button'), 'F1'],
  [t('a.sc.2'), 'F9'],
  [t('a.sc.routeCh'), 'Ctrl+L'],
  [t('a.sc.spreadCh'), 'Shift+Ctrl+L'],
  [t('a.sc.selCh'), t('a.sc.selChKeys')],
  [t('a.sc.3'), 'F5'],
  [t('a.sc.4'), t('a.sc.5')],
  [t('a.sc.107'), 'F7'],
  [t('a.sc.108'), 'F4 · F2'],
  [t('a.sc.109'), 'Num 1–9 · Num + −'],
  [t('a.sc.110'), 'Shift+Ctrl+C'],
  [t('a.sc.111'), 'G'],
  [t('a.sc.6'), 'Shift+F9'],
  [t('a.sc.7'), t('a.sc.8')],
  [t('a.sc.9'), 'R'],
  [t('a.sc.164'), 'Ctrl+T'],
  [t('a.sc.160'), t('a.sc.161')],
  [t('a.sc.162'), t('a.sc.163')],
  [t('a.sc.10'), 'F'],
  [t('a.sc.11'), 'Home'],
  ['Browser', 'Alt+F8'],
  [t('a.sc.12'), 'F8'],
  [t('a.mn.fullscreen'), 'F11'],
  [t('a.sc.13'), t('a.sc.14')],
  [t('a.sc.15'), t('a.sc.16')],
  [t('a.sc.17'), 'Esc'],
  [t('a.sc.18'), 'P · B · D'],
  [t('a.sc.19'), 'T · C · E'],
  [t('a.sc.20'), t('a.sc.21')],
  [t('a.sc.22'), t('a.sc.23')],
  [t('a.sc.24'), 'Ctrl+A'],
  [t('a.sc.25'), 'Esc'],
  [t('a.sc.26'), t('a.sc.27')],
  [t('a.sc.28'), t('a.sc.29')],
  [t('a.sc.30'), 'Ctrl+B'],
  [t('a.sc.deselect'), 'Ctrl+D'],
  [t('a.sc.31'), 'Ctrl+C · X · V'],
  [t('a.sc.32'), 'Del'],
  [t('a.sc.33'), 'Alt+M'],
  [t('a.sc.mkAdd'), 'Alt+T'],
  [t('a.sc.mkJump'), 'Alt + ← → · Alt+Num / *'],
  [t('a.sc.mkStrip'), t('a.sc.mkStripKeys')],
  [t('a.mn.metro'), 'Ctrl+M'],
  [t('a.sc.stretchMode'), 'Shift+M'],
  [t('a.sc.34'), 'Shift + ← →'],
  [t('a.sc.35'), 'Shift + ↑ ↓'],
  [t('a.sc.36'), 'Ctrl+Z · Ctrl+Shift+Z'],
  [t('a.sc.37'), t('a.sc.38')],
  [t('a.sc.39'), t('a.sc.40')],
  [t('a.sc.41'), t('a.sc.14')],
  [t('a.sc.42'), t('a.sc.43')],
  [t('a.sc.44'), t('a.sc.45')],
  [t('a.sc.46'), t('a.sc.47')],
  [t('a.sc.48'), t('a.sc.49')],
  [t('a.sc.50'), t('a.sc.51')],
  [t('a.sc.52'), t('a.sc.53')],
  [t('a.sc.54'), t('a.sc.55')],
  [t('a.sc.56'), 'Ctrl+Shift+N · Ctrl+O'],
  [t('a.mn.saveVersion'), 'Ctrl+N'],
  [t('a.sc.57'), 'Ctrl+S · Ctrl+Shift+S'],
  [t('a.sc.58'), 'Ctrl+Shift+R'],
  [t('a.sc.59'), t('a.sc.60')],
  [t('a.sc.61'), t('a.sc.62')],
  ['Comping (swipe)', t('a.sc.63')],
  [t('a.sc.64'), t('a.sc.65')],
  [t('a.sc.66'), 'Ctrl + ↑ ↓'],
  [t('a.sc.67'), t('a.sc.68')],
  [t('a.sc.69'), t('a.sc.70')],
  [t('a.sc.71'), t('a.sc.72')],
  [t('a.sc.73'), t('a.sc.74')],
  [t('a.sc.75'), '1–6'],
  [t('a.sc.76'), 'F'],
  [t('a.sc.77'), t('a.sc.78')],
  [t('a.sc.79'), t('a.sc.80')],
  [t('a.sc.81'), t('a.sc.82')],
  [t('a.sc.83'), t('a.sc.84')],
  [t('a.sc.85'), t('a.sc.86')],
  ['Velocity', t('a.sc.87')],
  [t('a.sc.88'), 'P · B · E · D'],
  [t('a.sc.89'), 'Shift + ↑ ↓ · Ctrl + ↑ ↓'],
  [t('a.sc.90'), 'Ctrl+B'],
  [t('a.sc.91'), 'Ctrl+C · X · V'],
  [t('a.sc.112'), t('a.sc.113')],
  [t('a.sc.170'), t('a.sc.171')],
  [t('a.sc.172'), t('a.sc.173')],
  [t('a.sc.174'), t('a.sc.175')],
  [t('a.sc.176'), t('a.sc.177')],
  [t('a.sc.178'), t('a.sc.179')],
  [t('a.sc.180'), t('a.sc.181')],
  [t('a.sc.182'), t('a.sc.183')],
  [t('a.sc.184'), t('a.sc.185')],
  [t('a.sc.186'), t('a.sc.187')],
  [t('a.sc.188'), t('a.sc.189')],
  [t('a.sc.114'), t('a.sc.115')],
  [t('a.sc.140'), t('a.sc.141')],
  [t('a.sc.142'), 'PgUp · PgDn'],
  [t('a.sc.143'), 'Shift+1 2 3 · Shift+4'],
  [t('a.sc.144'), t('a.sc.145')],
  [t('a.sc.146'), t('a.sc.147')],
  [t('a.sc.148'), t('a.sc.149')],
  [t('a.sc.150'), 'Alt + ↑ ↓'],
  [t('a.sc.151'), 'Ctrl+C · X · V'],
  [t('a.sc.152'), t('a.sc.153')],
  [t('a.sc.92'), t('a.sc.93')],
  [t('a.sc.94'), t('a.sc.95')],
  [t('a.sc.96'), t('a.sc.97')],
  [t('a.sc.98'), t('a.sc.29')],
  [t('a.sc.99'), t('a.sc.100')],
  [t('a.sc.101'), t('a.sc.102')],
  [t('a.sc.103'), t('a.sc.104')],
  [t('a.sc.105'), t('a.sc.106')],
];

/**
 * One alternative of a shortcut. A key combination ("Shift+Ctrl+L", "Ctrl + wheel") is drawn as key caps;
 * a gesture described in words ("double-click an audio clip") stays plain text: a cap around a sentence reads as a button.
 */
function KeyCombo(props: { k: string }) {
  // "Num + −" names two numpad keys, plus and minus: its "+" is a key, not a joiner
  const parts = () => (props.k.startsWith('Num ') ? [props.k] : props.k.split('+').map(x => x.trim()).filter(Boolean));
  const keys = () => parts().length > 0 && parts().every(x => x.length <= 9);
  return (
    <Show when={keys()} fallback={<span class="gesture">{props.k}</span>}>
      <span class="combo"><For each={parts()}>{x => <kbd>{x}</kbd>}</For></span>
    </Show>
  );
}

export function Help() {
  // the list is for reading; finding a command by a word is the command palette's job (Ctrl+K), linked from the title
  const close = () => setU('help', false);
  return (
    <Show when={U.help}>
      <DialogBoundary name={t('a.tb.helpTitle')} close={close}>
      <div class="overlay" onPointerDown={close}>
        <div class="dialog helpdlg" onPointerDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <div class="hd"><span>{t('a.tb.helpTitle')}</span>
            <button class="chip helpcmd" onClick={() => { close(); setPaletteOpen(true); }}>{t('a.cmd.title')}<kbd>Ctrl K</kbd></button>
            <button aria-label={t('a.tb.close')} onClick={close}>×</button></div>
          <div class="helplist">
            <For each={shortcuts()}>
              {([a, k]) => <div class="sc"><span class="a">{a}</span><span class="k">{k.split(' · ').map(x => <KeyCombo k={x} />)}</span></div>}
            </For>
          </div>
        </div>
      </div>
      </DialogBoundary>
    </Show>
  );
}

/**
 * FL's main volume knob next to the transport: the Master insert's volume (the same value as
 * the mixer's Master fader, saved with the project and undone like it). Drag ↕ (Shift = fine),
 * wheel, double-click = unity, right-click = automation menu.
 */
/** Meter position (0..1) of a linear peak: −60 … +6 dBFS, the mixer meters' scale. */
const meterPos = (v: number) => clamp(((v > 1e-5 ? 20 * Math.log10(v) : -90) + 60) / 66, 0, 1);
/** Where 0 dBFS sits on that scale. */
const FULL_POS = meterPos(1);

/** The master's output level (FL Studio's toolbar peak meter) and its clip latch: red with how far
 *  over 0 dBFS the mix went, until clicked, because an export clips exactly there. */
function MasterOut() {
  let l!: HTMLDivElement, r!: HTMLDivElement;
  let hl = -1, hr = -1;
  onMount(() => onCleanup(addFrameTask(() => {
    const e = tele.frame.ins.get(0);
    const nl = Math.max(e?.l ?? 0, hl * 0.9), nr = Math.max(e?.r ?? 0, hr * 0.9);
    if (nl === hl && nr === hr) return;
    hl = nl < 1e-5 ? 0 : nl; hr = nr < 1e-5 ? 0 : nr;
    l.style.transform = `scaleX(${1 - meterPos(hl)})`;
    r.style.transform = `scaleX(${1 - meterPos(hr)})`;
  })));
  // a clip belongs to the mix it happened in
  watch(() => S.path, () => resetMasterClip(), { defer: true });
  return (
    <button class={['masterout', { clip: !!masterClip() }]} title={masterClipTip()} aria-label={masterClipTip()}
      onClick={() => { if (masterClip()) { resetMasterClip(); say(t('a.tb.clipReset')); } }}>
      <span class="mobars" style={{ '--full': FULL_POS }}>
        <span class="mobar"><span ref={l} /></span>
        <span class="mobar"><span ref={r} /></span>
      </span>
      <Show when={masterClip()}>{c => <span class="moclip"><span class="cliplbl">{t('a.tb.clip')} </span>+{c().overDb.toFixed(1)}</span>}</Show>
    </button>
  );
}

function MainVolume() {
  const master = () => S.project.inserts.find(m => m.id === 0);
  const target = { kind: 'insertVol' as const, id: 0 };
  const vol = () => autoDisplay(target) ?? master()?.vol ?? VOL_UNITY;
  let g: Tweak | null = null;
  const put = (v: number) => A.insertOp(0, { vol: clamp(v, 0, 1) });
  const staticOps = (v: number) => { const op = put(v); return op ? [op] : null; };
  const tell = (v: number) => say(t('a.tb.mainVol') + ' · ' + volText(v));
  // Alt-click / double-click reset is a tweak too: it records while capturing, overrides while playing
  const resetOnce = () => { const tw = autoTweak(target, t('a.tb.mainVol'), staticOps); tw.move(VOL_UNITY); tw.end(); tell(VOL_UNITY); };
  return (
    <Show when={master()}>
      <div class="mainvol" title={t('a.tb.mainVolTip', { v: volText(vol()) })}>
        <MiniKnob t={vol} key="mainvol" title={t('a.tb.mainVolTip', { v: volText(vol()) })} automated={() => isAutomated(target)} overridden={() => isOverridden(target)}
          onStart={() => { g = autoTweak(target, t('a.tb.mainVol'), staticOps); }}
          onChange={v => { g?.move(v); tell(v); }}
          onEnd={() => { g?.end(); g = null; }}
          onReset={() => resetOnce()}
          onWheel={v => { autoWheel(target, 'mainvol', t('a.tb.mainVol'), v, staticOps); tell(v); }}
          onMenu={(x, y) => paramMenu(x, y, target, () => resetOnce())} />
      </div>
    </Show>
  );
}

/** How often the CPU percentage is reprinted: a figure that changes 60 times a second is unreadable. */
const CPU_TEXT_MS = 250;

/**
 * FL Studio's toolbar CPU meter: how much of each audio buffer's time the engine spends rendering
 * it (near 100 % the output crackles), with the underrun count of its Audio settings. It flashes
 * red when the output runs dry; a click resets the count (like the master clip latch), or, with
 * nothing to reset, opens the audio settings where the buffer size is. Shown only when turned on
 * in Settings → Audio (the bar is short on room); the count is always there.
 */
function CpuMeter() {
  let bar!: HTMLSpanElement;
  let hold = 0, shownW = -1, textAt = 0;
  const [load, setLoad] = createSignal(0);
  const off = () => audioStatus()?.running === false;
  onMount(() => onCleanup(addFrameTask(now => {
    const c = Math.max(0, tele.frame.cpu || 0);
    // the engine already peak-holds per callback; this keeps a spike visible between frames
    hold = Math.max(c, hold * 0.92);
    const w = Math.min(1, hold);
    if (Math.abs(w - shownW) > 0.004) { shownW = w; bar.style.transform = `scaleX(${w})`; }
    if (now - textAt >= CPU_TEXT_MS) { textAt = now; setLoad(hold); }
  })));
  const tip = () => off() ? t('a.tb.cpuOff') : t('a.tb.cpuTip', {
    pct: cpuText(load()), n: underruns(),
    act: underruns() ? t('a.tb.cpuActReset') : t('a.tb.cpuActOpen'),
  });
  const click = () => {
    if (underruns() && !off()) { resetUnderruns(); say(t('a.tb.underrunReset')); }
    else openAudioSettings();
  };
  return (
    <button class={['cpumeter ' + cpuBand(load()), { flash: underrunFlash(), xrun: underruns() > 0, off: off() }]}
      title={tip()} aria-label={tip()} onClick={click}>
      <span class="cpuval mono">{off() ? '—' : cpuText(load())}</span>
      <span class="cpubar"><span ref={bar} /></span>
      <Show when={underruns() > 0 && !off()}><span class="cpuxr mono">{underruns() > 99 ? '99+' : underruns()}</span></Show>
    </button>
  );
}
