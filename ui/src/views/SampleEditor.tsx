// One floating sample editor for Playlist audio clips and Channel Rack sampler channels.
import { createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { captureOn, createSignal, effect, onCleanup, onMount } from '../lib/reactive';
import { be } from '../api/backend';
import { CLIP_PITCH, SAMPLE_ROOT, SAMPLER, samplerDefault, type AutoTarget, type Channel, type Clip, type Id, type Op, type SamplerState, type Source } from '../api/types';
import { FIT_BEATS, fitClip, putSoundClips, TOTAL } from '../lib/clipOps';
import { baseName, clamp, dbg, dbText, panText } from '../lib/format';
import { t, type TranslationKey } from '../lib/i18n';
import { envelopeGraph, msText, STAGES, TENSION_KEY, type Bent, type Stage } from '../lib/sampler';
import * as A from '../state/actions';
import { autoDisplay, autoTweak, autoWheel, controlMenu, isAutomated, isOverridden, paramMenu, type Tweak } from '../state/automation';
import { openStems } from '../state/stems';
import { commit, Gesture } from '../state/edit';
import { audition, chanById, chanOp, chanSource, replaceWithFile } from '../state/pattern';
import { getPeaks, peakRange, peaksVersion } from '../state/peaks';
import { insName, plain, S } from '../state/store';
import { tele } from '../state/telemetry';
import { say, setU, U, type SampleTarget } from '../state/ui';
import { showInsert } from '../state/mixView';
import { track } from '../ui/drag';
import { addFrameTask, fitCanvas, Layer } from '../ui/frameLoop';
import { channelIcon, InstIcon, sampleIcon } from '../ui/instIcons';
import { InsertPicker } from '../ui/InsertPicker';
import { Knob } from '../ui/Knob';
import { PianoKeys, type KeyPlayer } from '../ui/PianoKeys';
import { noteName } from '../lib/pitch';
import { rgba, T, theme } from '../ui/theme';
import { chanHeardInsert, ChannelLevelKnobs } from './ChannelWindow';
import { outerZ } from '../state/winOrder';
import { moveWindow } from './FxWindow';
import { PitchCorrectButton } from './PitchCorrectButton';
import { SlicePanel } from './SlicePanel';
import { PanelBoundary, WindowBoundary } from '../ui/PanelBoundary';
import { FORK } from '../fork';

type SampleChannel = Extract<Channel, { kind: 'sample' }>;
type Fade = 'fadeIn' | 'fadeOut';
type Handle = 'start' | 'end' | Fade;

export function SampleEditor() {
  // Remount controls when the target changes, so an in-progress gesture keeps its original target.
  const target = createMemo(() => {
    const ed = U.editor;
    return ed ? { kind: ed.kind, id: ed.id } : null;
  });
  // a failure of the window itself (its title bar, its body) keeps a frame that moves and closes
  return (
    <Show when={target()} keyed>{ed => (
      <WindowBoundary name={t('d.ui.pn.sample')} class="chanwin smpwin" geom={() => U.editor} z={outerZ(U.editor?.z ?? 0)} front={() => A.editorFront()} close={A.closeEditor}
        closeTip={t('d.smp.close')} move={(x, y) => setU('editor', e => e && { ...e, x, y })}>
        <EditorTarget target={ed} />
      </WindowBoundary>
    )}</Show>
  );
}

function EditorTarget(props: { target: SampleTarget }) {
  const id = props.target.id;
  if (props.target.kind === 'clip') {
    const clip = () => S.project.clips.find(c => c.id === id && c.kind === 'audio');
    const source = () => {
      const ref = clip()?.ref;
      return S.project.sources.find(s => s.id === ref);
    };
    return <Show when={clip() && source()}><ClipSample clip={() => clip()!} source={() => source()!} /></Show>;
  }
  const channel = () => { const c = chanById(id); return c?.kind === 'sample' ? c : undefined; };
  return <Show when={channel()}>{c => <ChannelSample channel={c} />}</Show>;
}

type WaveRegion = { start: number; end: number; fadeIn: number; fadeOut: number };
type DragEdit = { op: Op; status: string };
interface WaveProps {
  source: () => Source | undefined;
  color: () => string;
  normalized: () => boolean;
  reversed: () => boolean;
  gain?: () => number;
  region: () => WaveRegion;
  preview: () => void;
  previewPosition?: () => number | null;
  title: TranslationKey;
  drag: (handle: Handle) => (delta: number) => DragEdit | undefined;
  reset?: (handle: Handle) => void;
}

function EditorFrame(props: {
  name: string; description: string; color: string; icon: JSX.Element; wave: WaveProps;
  fileInfo: JSX.Element; fileAction?: JSX.Element; header: JSX.Element; channelId?: number;
  /** The mixer insert this sound is heard through: a double-click on the header shows it in the mixer. */
  insert: () => Id | null | undefined;
  toggle: (key: 'reverse' | 'norm') => void;
  pitch: JSX.Element; level: JSX.Element; fades: JSX.Element; details: JSX.Element;
  /** A sampler's volume envelope: a second page, behind Sample | Envelope tabs (FL's SMP and INS pages). */
  envelope?: { on: () => boolean; page: () => JSX.Element };
  /** A sampler's slice mode: a third page (FL Slicex, Simpler's Slice); `on` while the channel has slices. */
  slices?: { on: () => boolean; page: () => JSX.Element };
  /** The keyboard at the bottom (FL Channel settings): plays the sample; right-click a key sets its root. */
  keys: { player: KeyPlayer; root: () => number; setRoot: (key: number) => void };
}) {
  const editor = () => U.editor!;
  const move = (x: number, y: number) => setU('editor', ed => ed && { ...ed, x, y });
  const resize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = editor().w, sx = e.clientX;
    track(ev => {
      const max = window.innerWidth - 20;
      const w = clamp(start + ev.clientX - sx, Math.min(520, max), max);
      setU('editor', ed => ed && { ...ed, w, x: clamp(ed.x, 0, window.innerWidth - w) });
    }, null, 'ew-resize');
  };

  return (
    <div class="win chanwin smpwin" data-editor data-channel-window={props.channelId}
      style={{ left: editor().x + 'px', top: editor().y + 'px', width: editor().w + 'px', 'z-index': outerZ(editor().z) }}
      ref={captureOn('pointerdown', () => A.editorFront())}>
      <div class="winhd" onPointerDown={e => moveWindow(e, editor, move)} title={t('b.cw.headTip')}
        onDblClick={e => { if (!(e.target as HTMLElement).closest('button, select, input')) showInsert(props.insert()); }}>
        <span class="chicon" style={{ color: props.color }}>{props.icon}</span>
        <span class="title ell" style={{ 'min-width': '0', flex: '0 1 auto' }} title={props.name}>{props.name}</span>
        <span class="sub ell">{props.description}</span>
        <div style={{ flex: 1 }} />
        {props.header}
        <button class="iconbtn" aria-label={t('b.cw.previewTitle')} title={t('b.cw.previewTitle')} onClick={() => (props.channelId == null && U.previewing ? void be().previewStop() : props.wave.preview())}
          disabled={!props.wave.source()}>{props.channelId == null && U.previewing ? '■' : '▶'}</button>
        <button class="closebtn" aria-label={t('d.smp.close')} title={t('d.smp.close')} onClick={A.closeEditor}>×</button>
      </div>
      {/* the body behind an error boundary: a failure shows in the window, whose title bar still moves and closes it */}
      <PanelBoundary name={t('d.ui.pn.sample')}>
      <Show when={props.envelope}>{env => (
        <div class="seg smptabs" role="tablist" aria-label={t('b.sm.tabs')}>
          <button role="tab" aria-selected={page() === 'sample' ? 'true' : 'false'} class={{ on: page() === 'sample' }} onClick={() => setPage('sample')}>{t('b.sm.tabSample')}</button>
          <button role="tab" aria-selected={page() === 'env' ? 'true' : 'false'} class={{ on: page() === 'env' }} onClick={() => setPage('env')}
            title={t(env().on() ? 'b.sm.tabEnvOn' : 'b.sm.tabEnvOff')}>
            {t('b.sm.tabEnv')}<i class={['envdot', { lit: env().on() }]} />
          </button>
          <Show when={props.slices}>{sl => (
            <button role="tab" aria-selected={page() === 'slice' ? 'true' : 'false'} class={{ on: page() === 'slice' }} onClick={() => setPage('slice')}
              title={t(sl().on() ? 'd.sl.tabOn' : 'd.sl.tabOff')}>
              {t('d.sl.tab')}<i class={['envdot', { lit: sl().on() }]} />
            </button>
          )}</Show>
        </div>
      )}</Show>
      <Show when={props.slices && page() === 'slice'}>{props.slices!.page()}</Show>
      <Show when={!(props.slices && page() === 'slice')}>
      <Show when={props.envelope && page() === 'env'} fallback={<>
        <SampleWave {...props.wave} />
        <div class="chsrc">
          <span class="ell" title={props.wave.source()?.path ?? ''}>{baseName(props.wave.source()?.path ?? '') || t('b.cw.noFile')}</span>
          <span class="mono">{props.fileInfo}</span>
          {props.fileAction}
        </div>
        <div class="smprow">
          <button class={['smptog', { on: props.wave.reversed() }]} aria-pressed={props.wave.reversed() ? 'true' : 'false'}
            title={t('b.sm.reverseTitle')} onClick={() => props.toggle('reverse')}>{t('b.sm.reverse')}</button>
          <button class={['smptog', { on: props.wave.normalized() }]} aria-pressed={props.wave.normalized() ? 'true' : 'false'}
            title={t('b.sm.normTitle')} onClick={() => props.toggle('norm')}>{t('b.sm.norm')}</button>
        </div>
        <div class="smpknobs">
          <div class="smpgrp">{props.pitch}</div>
          <div class="smpgrp">{props.level}</div>
          <div class="smpgrp">{props.fades}</div>
        </div>
        {props.details}
      </>}>{props.envelope!.page()}</Show>
      </Show>
      <div class="pkhead">
        <span>{t('b.pk.root')}</span>
        <b class="mono">{noteName(props.keys.root())}</b>
        <span class="hint">{t('b.pk.rootHint')}</span>
      </div>
      <PianoKeys player={props.keys.player} lo={36} hi={96} root={props.keys.root()} onRoot={props.keys.setRoot} />
      </PanelBoundary>
      <div class="resizer" onPointerDown={resize} title={t('d.smp.resize')} />
    </div>
  );
}

const HANDLE_LABELS = { start: 'd.smp.regstart', end: 'd.smp.regend', fadeIn: 'd.smp.fadein.tip', fadeOut: 'd.smp.fadeout.tip' } as const;
const FADE_LABELS = { fadeIn: 'd.smp.k.fadein', fadeOut: 'd.smp.k.fadeout' } as const;
const HANDLES = ['start', 'end', 'fadeIn', 'fadeOut'] as const;

function SampleWave(props: WaveProps) {
  let box!: HTMLDivElement, canvas!: HTMLCanvasElement, line!: HTMLDivElement;
  const layer = new Layer();
  let dirty = true, epoch = -1;

  effect(() => {
    props.source(); props.color(); props.normalized(); props.reversed(); props.gain?.();
    props.region(); peaksVersion();
    dirty = true;
  });
  onMount(() => {
    const observer = new ResizeObserver(() => { dirty = true; });
    observer.observe(box);
    const stop = addFrameTask(() => {
      if (epoch !== theme.epoch) { epoch = theme.epoch; dirty = true; }
      if (dirty) { dirty = false; draw(); }
      if (!props.previewPosition) return;
      const pos = props.previewPosition();
      line.style.opacity = pos == null ? '0' : '1';
      if (pos != null) line.style.transform = `translateX(${pos * box.clientWidth}px)`;
    });
    onCleanup(() => { observer.disconnect(); stop(); });
  });

  const draw = () => {
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    fitCanvas(canvas, w, h);
    const g = canvas.getContext('2d')!, dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const src = props.source(), norm = props.normalized(), rev = props.reversed();
    const peaks = src && getPeaks(src.id, norm, rev), gain = props.gain?.() ?? 1, color = props.color();
    const key = [src?.id, norm, rev, gain, color, peaksVersion()].join('|');
    const image = layer.get(w, h, key, (l, lw, lh) => {
      l.fillStyle = T.viz; l.fillRect(0, 0, lw, lh);
      l.fillStyle = T.vizGrid2; l.fillRect(0, Math.floor(lh / 2), lw, 1);
      if (!peaks) return;
      const bins = peaks.length / 2, mid = lh / 2, amp = mid * 0.95;
      l.fillStyle = color; l.beginPath();
      for (let x = 0; x < lw; x++) {
        const a = Math.floor(x / lw * bins), b = Math.floor((x + 1) / lw * bins);
        const [mn, mx] = peakRange(peaks, a, b);
        const y1 = mid - clamp(mx * gain, 0, 1) * amp, y2 = mid - clamp(mn * gain, -1, 0) * amp;
        l.rect(x, y1, 1, Math.max(0.6, y2 - y1));
      }
      l.fill();
    });
    g.drawImage(image, 0, 0, w, h);
    if (!src) return;

    const { start, end, fadeIn, fadeOut } = props.region();
    const a = start * w, b = end * w, fi = fadeIn * w, fo = fadeOut * w;
    g.fillStyle = T.shade; g.beginPath();
    g.moveTo(a, h); g.lineTo(a + fi, 0); g.lineTo(a, 0); g.closePath();
    g.moveTo(b - fo, 0); g.lineTo(b, h); g.lineTo(b, 0); g.closePath(); g.fill();
    g.strokeStyle = T.ink; g.lineWidth = 1.5; g.beginPath();
    if (fi) { g.moveTo(a, h); g.lineTo(a + fi, 0); }
    if (fo) { g.moveTo(b - fo, 0); g.lineTo(b, h); }
    g.stroke();
    g.fillStyle = rgba(T.viz, 0.78); g.fillRect(0, 0, a, h); g.fillRect(b, 0, w - b, h);

    g.fillStyle = T.fgHi;
    g.fillRect(Math.round(a), 0, 1, h); g.fillRect(Math.round(a), 0, 6, 6);
    g.fillRect(Math.round(b) - 1, 0, 1, h); g.fillRect(Math.round(b) - 6, h - 6, 6, 6);
  };

  const handleAt = (e: MouseEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-sample-handle]')?.dataset.sampleHandle as Handle | undefined;
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !props.source()) return;
    const handle = handleAt(e);
    if (!handle) { props.preview(); return; }
    e.preventDefault(); e.stopPropagation();
    const edit = props.drag(handle), sx = e.clientX, width = box.clientWidth;
    const gesture = new Gesture(t(HANDLE_LABELS[handle]));
    track(ev => {
      const next = edit((ev.clientX - sx) / width);
      if (next) { gesture.update([next.op]); say(next.status); }
    }, () => gesture.end(), 'ew-resize');
  };
  const position = (handle: Handle) => {
    const { start, end, fadeIn, fadeOut } = props.region();
    switch (handle) {
      case 'start': return start;
      case 'end': return end;
      case 'fadeIn': return start + fadeIn;
      case 'fadeOut': return end - fadeOut;
    }
  };

  return (
    <div ref={box} class="smpwave" title={t(props.title)} onPointerDown={down}
      // only on a marker: two clicks on the waveform are two auditions (FL), never a reset of the trim
      onDblClick={e => { const h = handleAt(e); if (h) props.reset?.(h); }}>
      <canvas ref={canvas} />
      <Show when={props.source()}>
        <For each={HANDLES}>{handle => <div data-sample-handle={handle} title={t(HANDLE_LABELS[handle])}
          style={{ left: position(handle) * 100 + '%' }} />}</For>
      </Show>
      <Show when={props.previewPosition}><div ref={line} class="smppreview" /></Show>
    </div>
  );
}

interface SampleKnobProps {
  id: string; label: TranslationKey; title?: TranslationKey; position: () => number; display: () => string;
  op: (position: number) => Op; wheelOp?: (position: number) => Op; zero?: number; defaultPosition: number;
  target?: () => AutoTarget; color?: () => string; arc?: string; menuTip?: TranslationKey;
}

function SampleKnob(props: SampleKnobProps) {
  let gesture: Tweak | null = null;
  const label = () => t(props.label);
  const reset = () => commit([props.op(props.defaultPosition)], label());
  const staticOps = (v: number) => [props.op(v)];
  return <Knob key={props.id} color={props.arc} label={label()} title={t(props.title ?? 'd.smp.knob.tip')}
    t={props.position} text={props.display} zero={props.zero == null ? undefined : () => props.zero!}
    automated={() => !!props.target && isAutomated(props.target())}
    overridden={() => !!props.target && isOverridden(props.target())}
    onMenu={props.target || props.menuTip ? (x, y) => {
      if (props.target) paramMenu(x, y, props.target(), reset, props.color?.());
      else if (props.menuTip) controlMenu(x, y, label(), reset, t(props.menuTip));
    } : undefined}
    onStart={() => { gesture = autoTweak(props.target?.() ?? null, label(), staticOps); }}
    onChange={v => { gesture?.move(v); say(label() + ' ' + props.display()); }}
    onEnd={() => { gesture?.end(); gesture = null; }}
    onReset={reset}
    onWheel={v => autoWheel(props.target?.() ?? null, props.id, label(), v, staticOps)} />;
}

function FadeKnobs(props: {
  id: string; value: (fade: Fade) => number; limit: (fade: Fade) => number;
  op: (fade: Fade, ms: number) => Op; title: TranslationKey; menuTip?: TranslationKey;
}) {
  const scale = (fade: Fade) => Math.max(1, props.limit(fade));
  return <For each={['fadeIn', 'fadeOut'] as const}>{fade => (
    <SampleKnob id={props.id + fade} label={FADE_LABELS[fade]} title={props.title}
      position={() => Math.cbrt(clamp(props.value(fade) / scale(fade), 0, 1))}
      display={() => Math.round(props.value(fade) * 10) / 10 + ' ms'} defaultPosition={0}
      op={v => props.op(fade, Math.min(props.limit(fade), v ** 3 * scale(fade)))}
      menuTip={props.menuTip} />
  )}</For>;
}

const fitLabel = (b: number) => b < 4 ? t(b === 1 ? 'd.smp.fit.beat' : 'd.smp.fit.beats', { n: b }) : t(b === 4 ? 'd.smp.fit.bar' : 'd.smp.fit.bars', { n: b / 4 });
const fileFormat = (src: Source) => Math.round(src.sr / 100) / 10 + ' kHz · ' + (src.ch === 1 ? 'mono' : 'stereo');
const pitchText = (v: number, unit: string) => (v > 0 ? '+' : '') + v + ' ' + unit;

function ClipSample(props: { clip: () => Clip; source: () => Source }) {
  const c = props.clip, src = props.source;
  const id = 'clip' + c().id;
  const spb = () => 60 / S.project.bpm, stretch = () => c().stretch ?? 1;
  const durB = () => src().dur / spb() * stretch();
  const seconds = (b: number) => b * spb() / stretch();
  const trackInsert = () => S.project.tracks[c().track]?.insert ?? 0;
  // the clip's own insert (every clip of the sample shares it), else its track's
  const insert = () => { const own = c().insert; return own != null && S.project.inserts.some(m => m.id === own) ? own : trackInsert(); };
  const busy = () => c().id in S.stretching;
  // the sound (volume, pan, pitch, normalize, reverse) is the sample's: every clip of it follows (FL)
  const siblings = () => S.project.clips.filter(x => x.kind === 'audio' && x.ref === c().ref);
  const put = (patch: Partial<Clip>): Op => putSoundClips(siblings().map(x => plain(x)), plain(c()), patch);
  // every click on the waveform plays from the top (FL); the header's ■ stops
  // not a Browser preview: the status line must not keep showing the last sample's waveform
  const preview = () => { setU('previewPath', null); void be().previewClip(c().id).catch(e => say(String(e))); };
  const previewPosition = () => {
    const f = tele.frame;
    if (!f.previewing || f.previewPos < 0) return null;
    const rendered = (c().pitch || (stretch() !== 1 && !c().resample)) && !busy();
    return clamp(f.previewPos / (src().dur * (rendered && !c().resample ? stretch() : 1)), 0, 1);
  };
  const drag = (handle: Handle) => {
    const old = plain(c()), beatSec = spb(), duration = durB();
    return (delta: number) => {
      const d = delta * duration, next = { ...old };
      if (handle === 'start') {
        next.offset = clamp(old.offset + d, Math.max(0, old.offset - old.start), old.offset + old.len - 1 / 16);
        next.start += next.offset - old.offset;
        next.len -= next.offset - old.offset;
      } else if (handle === 'end') {
        next.len = clamp(old.len + d, 1 / 16, Math.min(duration - old.offset, TOTAL - old.start));
      } else {
        const other = handle === 'fadeIn' ? old.fadeOut : old.fadeIn;
        next[handle] = clamp(old[handle] + d * beatSec * (handle === 'fadeIn' ? 1 : -1), 0, Math.max(0, old.len * beatSec - other));
      }
      const status = handle === 'fadeIn' || handle === 'fadeOut' ? t(FADE_LABELS[handle]) + ' ' + msText(next[handle] * 1000)
        : seconds(next.offset).toFixed(3) + ' – ' + seconds(next.offset + next.len).toFixed(3) + ' s';
      return { op: { op: 'putClips' as const, clips: [next] }, status };
    };
  };
  const semi = () => Math.trunc(Math.round((c().pitch ?? 0) * 100) / 100);
  const fine = () => Math.round(((c().pitch ?? 0) - semi()) * 100);
  const pitch = (s: number, f: number) => put({ pitch: Math.round(clamp(s + f / 100, -CLIP_PITCH, CLIP_PITCH) * 100) / 100 });
  const level = (key: 'gain' | 'pan') => {
    const gain = key === 'gain', lo = gain ? -24 : -1, hi = gain ? 12 : 1;
    const target = () => ({ kind: gain ? 'clipGain' as const : 'clipPan' as const, id: c().id });
    const v = () => autoDisplay(target()) ?? c()[key];
    return <SampleKnob id={id + key} label={gain ? 'd.smp.k.vol' : 'd.smp.k.pan'}
      position={() => (v() - lo) / (hi - lo)} display={() => gain ? dbText(v()) : panText(v())} zero={-lo / (hi - lo)}
      defaultPosition={-lo / (hi - lo)} op={x => put({ [key]: lo + x * (hi - lo) })} target={target} color={() => src().color} arc={gain ? undefined : 'var(--pan)'} />;
  };
  const fit = (b: number) => {
    const n = fitClip(plain(c()), b); if (!n) return;
    commit([{ op: 'putClips', clips: [n] }], t('d.smp.fit.op'));
    say(t('d.smp.fit.say', { len: fitLabel(b), k: (n.stretch ?? 1).toFixed(2) }) + (n.resample ? '' : t('d.smp.fit.keep')));
  };

  return <EditorFrame name={src().name} description={t('d.smp.kind', { track: S.project.tracks[c().track]?.name ?? '' }) + (siblings().length > 1 ? ' · ' + t('d.smp.shared', { n: siblings().length }) : '')} insert={() => insert() ?? 0}
    color={src().color} icon={<InstIcon id={sampleIcon(src()) ?? 'sample'} size={14} />}
    wave={{
      source: src, color: () => src().color, normalized: () => c().norm, reversed: () => c().rev,
      gain: () => dbg(c().gain), preview, previewPosition, title: 'd.smp.waveTip', drag,
      region: () => {
        const duration = durB();
        return { start: c().offset / duration, end: (c().offset + c().len) / duration,
          fadeIn: c().fadeIn / spb() / duration, fadeOut: c().fadeOut / spb() / duration };
      },
    }}
    fileInfo={seconds(c().offset).toFixed(2) + '–' + seconds(c().offset + c().len).toFixed(2) + ' / ' + src().dur.toFixed(2) + ' s · ' + fileFormat(src())}
    header={<>
      <InsertPicker value={c().insert != null && S.project.inserts.some(m => m.id === c().insert) ? c().insert! : null} master
        nullLabel={t('d.smp.likeTrack', { name: insName(S.project.inserts.find(m => m.id === trackInsert()) ?? S.project.inserts[0]) })}
        ops={insert => [put({ insert })]} free={{ name: src().name, color: src().color }}
        label={t('d.smp.routing')} wheelKey={id + 'route'} title={t('d.smp.mixer.tip', { track: S.project.tracks[c().track]?.name ?? '' })} />
      <Show when={FORK.vocal}><button class="smallbtn" title={t('d.smp.pitchEd.tip')} onClick={() => { const cid = c().id; A.stopSamplePreview(); A.openPitchEditor(cid); }}>
        {t('d.smp.pitchEd')}{c().tune ? ' •' : ''}
      </button></Show>
      <Show when={FORK.analysis}><button class="smallbtn" title={t('a.pl.extractStemsTip')} onClick={() => openStems(c().id)} data-smp-stems>{t('d.smp.stems')}</button></Show>
      <PitchCorrectButton insert={() => insert() ?? null} />
    </>}
    toggle={key => {
      const k = key === 'reverse' ? 'rev' : 'norm';
      const on = !c()[k];
      commit([put({ [k]: on })], t(key === 'reverse' ? 'b.sm.reverse' : 'b.sm.norm'));
      say(t(key === 'reverse' ? (on ? 'd.smp.rev.on' : 'd.smp.rev.off') : (on ? 'd.smp.norm.on' : 'd.smp.norm.off')));
    }}
    pitch={<>
      <SampleKnob id={id + 'semi'} label="d.smp.k.pitch" title="d.smp.k.pitchTip" position={() => (semi() + CLIP_PITCH) / (2 * CLIP_PITCH)}
        display={() => pitchText(semi(), 'st')} defaultPosition={0.5} zero={0.5}
        op={v => pitch(Math.round((2 * v - 1) * CLIP_PITCH), fine())}
        wheelOp={v => {
          const delta = (2 * v - 1) * CLIP_PITCH - semi();
          return pitch(semi() + Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta))), fine());
        }} menuTip="d.smp.noAutoPitch" />
      <SampleKnob id={id + 'fine'} label="d.smp.k.fine" title="d.smp.k.fineTip" position={() => (fine() + 100) / 200}
        display={() => pitchText(fine(), 'ct')} defaultPosition={0.5} zero={0.5}
        op={v => pitch(semi(), Math.round(v * 200 - 100))} menuTip="d.smp.noAutoPitch" />
    </>}
    level={<>{level('gain')}{level('pan')}</>}
    keys={{
      player: { play: (key, vel, on) => { if (!on) return undefined; setU('previewPath', null); return be().previewClipKey({ clipId: c().id, key, vel }); } },
      root: () => c().root ?? SAMPLE_ROOT,
      setRoot: key => { commit([put({ root: key })], t('d.smp.rootCh')); say(t('b.pk.rootSay', { name: src().name, note: noteName(key) })); },
    }}
    fades={<FadeKnobs id={id} value={k => c()[k] * 1000} limit={k => Math.max(0, c().len * spb() - c()[k === 'fadeIn' ? 'fadeOut' : 'fadeIn']) * 1000}
      op={(k, v) => put({ [k]: v / 1000 })} title="d.smp.knob.tip" menuTip="a.au.noFade" />}
    details={<>
      <div class="smprow">
        <div class="seg smpmode" role="radiogroup" aria-label={t('d.smp.method')} title={t('d.smp.methodTip')}>
          <button role="radio" aria-checked={!c().resample ? 'true' : 'false'} class={{ on: !c().resample }} onClick={() => A.setStretchMethod(c(), false)}>{t('a.pl.keepPitch')}</button>
          <button role="radio" aria-checked={c().resample ? 'true' : 'false'} class={{ on: !!c().resample }} onClick={() => A.setStretchMethod(c(), true)}>{t('a.pl.resample')}</button>
        </div>
        <span class={['smpstat mono', { bad: !!S.stretching[c().id] }]} title={S.stretching[c().id] || ''}>
          {busy() ? (S.stretching[c().id] ? t('d.smp.renderFail') : t('d.smp.rendering')) : stretch() !== 1 ? '×' + stretch().toFixed(2) : ''}
        </span>
      </div>
      <div class="smprow smpfit">
        <span class="tag9">{t('d.smp.fit')}</span>
        <div class="seg"><For each={FIT_BEATS}>{b => {
          const allowed = () => !!fitClip(plain(c()), b);
          return <button class={{ on: Math.abs(c().len - b) < 1e-6 }} disabled={!allowed()}
            title={t(allowed() ? 'd.smp.fit.tip' : 'd.smp.fit.no', { len: fitLabel(b) })} onClick={() => fit(b)}>{fitLabel(b)}</button>;
        }}</For></div>
      </div>
    </>}
  />;
}

function ChannelSample(props: { channel: () => SampleChannel }) {
  const c = props.channel, id = 'channel' + c().id;
  const s = () => c().sampler ?? samplerDefault();
  const src = () => chanSource(c()), duration = () => src()?.dur ?? 0;
  const put = (patch: Partial<SamplerState>) => chanOp(c(), { sampler: { ...s(), ...patch } });
  const set = (patch: Partial<SamplerState>, label: TranslationKey, heard: string) => {
    commit([put(patch)], t(label)); say(c().name + ' · ' + heard);
  };
  const fadeKey = { fadeIn: 'fadeInMs', fadeOut: 'fadeOutMs' } as const;
  const fadeValue = (key: Fade) => s()[fadeKey[key]] ?? 0;
  const fadeLimit = () => Math.min(SAMPLER.fadeMaxMs, (s().end - s().start) * duration() * 1000);
  const region = (): WaveRegion => {
    const st = s(), len = st.end - st.start, ms = duration() * 1000;
    return { start: st.reverse ? 1 - st.end : st.start, end: st.reverse ? 1 - st.start : st.end,
      fadeIn: ms ? Math.min(len, fadeValue('fadeIn') / ms) : 0, fadeOut: ms ? Math.min(len, fadeValue('fadeOut') / ms) : 0 };
  };
  const drag = (handle: Handle) => {
    const initial = region(), reverse = s().reverse;
    return (delta: number) => {
      if (!src()) return;
      if (handle === 'fadeIn' || handle === 'fadeOut') {
        const f = initial[handle] + delta * (handle === 'fadeIn' ? 1 : -1);
        const ms = clamp(f * duration() * 1000, 0, fadeLimit());
        return { op: put({ [fadeKey[handle]]: ms }), status: t(FADE_LABELS[handle]) + ' · ' + msText(ms) };
      }
      const position = initial[handle] + delta;
      const key = reverse ? (handle === 'start' ? 'end' : 'start') : handle;
      const fraction = Math.round((reverse ? 1 - position : position) * 1000) / 1000;
      const value = key === 'start' ? clamp(fraction, 0, s().end - SAMPLER.minSpan) : clamp(fraction, s().start + SAMPLER.minSpan, 1);
      return { op: put({ [key]: value }), status: t(handle === 'start' ? 'b.sm.startSay' : 'b.sm.endSay', { pct: Math.round((reverse ? 1 - value : value) * 100) }) };
    };
  };
  const reset = (handle: Handle) => {
    if (handle === 'fadeIn' || handle === 'fadeOut') {
      if (fadeValue(handle)) commit([put({ [fadeKey[handle]]: 0 })], t(FADE_LABELS[handle]));
    } else if (s().start !== 0 || s().end !== 1) commit([put({ start: 0, end: 1 })], t('b.sm.region'));
  };
  const samplerKnob = (key: 'semi' | 'fine', unit: string) => {
    const { min, max } = SAMPLER[key];
    return <SampleKnob id={id + key} label={key === 'semi' ? 'd.smp.k.pitch' : 'd.smp.k.fine'}
      title={key === 'semi' ? 'b.sm.pitchTitle' : 'b.sm.fineTitle'} position={() => (s()[key] - min) / (max - min)}
      display={() => pitchText(Math.round(s()[key]), unit)} defaultPosition={0.5} zero={0.5}
      op={v => put({ [key]: Math.round(min + v * (max - min)) })} />;
  };

  return <EditorFrame name={c().name} description={t('b.cw.kSampler')} channelId={c().id} insert={() => chanHeardInsert(c()) ?? 0}
    color={c().color} icon={<InstIcon id={channelIcon(c(), (id: number) => S.project.sources.find(s => s.id === id))} size={14} />}
    wave={{
      source: src, color: () => c().color, normalized: () => s().norm, reversed: () => s().reverse, region,
      preview: () => { if (src()) audition(c().id, c().root, 0.9, true); }, title: 'b.sm.waveTitle', drag, reset,
    }}
    fileInfo={<Show when={src()}>{file => (file().dur * (s().end - s().start)).toFixed(2) + ' s · ' + fileFormat(file())}</Show>}
    fileAction={<button class="smallbtn" onClick={() => void replaceWithFile(c())} title={t('b.cw.changeSampleTitle')}>{t('b.cw.changeSampleBtn')}</button>}
    header={<>
      <InsertPicker value={c().insert} nullLabel={t('b.cw.likeClipTrack')} ops={insert => [chanOp(c(), { insert })]} free={{ name: c().name, color: c().color }}
        label={t('d.smp.routing')} wheelKey={id + 'route'} title={t('b.cw.mixerTip')} />
      <PitchCorrectButton insert={() => chanHeardInsert(c())} />
    </>}
    toggle={key => {
      const on = !s()[key];
      set({ [key]: on }, key === 'reverse' ? 'b.sm.reverse' : 'b.sm.norm',
        t(key === 'reverse' ? (on ? 'b.sm.reverseOn' : 'b.sm.reverseOff') : (on ? 'b.sm.normOn' : 'b.sm.normOff')));
    }}
    pitch={<>{samplerKnob('semi', 'st')}{samplerKnob('fine', 'ct')}</>}
    level={<ChannelLevelKnobs channel={c()} sample />}
    fades={<FadeKnobs id={id} value={fadeValue} limit={fadeLimit} op={(k, v) => put({ [fadeKey[k]]: v })} title="b.sm.fadeTip" />}
    details={<>
      <div class="smprow">
        <label class="chip smpcut" title={t('b.sm.cutTitle')}>
          {t('b.sm.cut')}
          <select value={String(s().cut)} onChange={e => {
            const cut = +e.currentTarget.value;
            set({ cut }, 'b.sm.cut', cut ? t('b.sm.cutSay', { n: cut }) : t('b.sm.cutNoneSay'));
          }}>
            <option value="0">{t('b.sm.cutNone')}</option>
            <For each={Array.from({ length: SAMPLER.cutGroups }, (_, i) => i + 1)}>{n => <option value={String(n)}>{n}</option>}</For>
          </select>
        </label>
      </div>
    </>}
    envelope={{ on: () => s().env, page: () => <EnvelopePanel id={id} name={() => c().name} color={() => c().color} s={s} put={put} /> }}
    slices={{ on: () => !!c().slices?.length, page: () => <SlicePanel channel={c} source={src} /> }}
    keys={{
      player: { ch: c().id },
      root: () => c().root,
      setRoot: key => { commit([chanOp(c(), { root: key })], t('b.cw.rootCh')); say(t('b.pk.rootSay', { name: c().name, note: noteName(key) })); },
    }}
  />;
}

/** Which page of a sampler's editor is open: the sample, its volume envelope (FL's SMP and INS pages) or its slices. */
const [page, setPage] = createSignal<'sample' | 'env' | 'slice'>('sample');

const STAGE_LABELS = {
  delay: ['b.sm.delay', 'b.sm.delayTitle'], attack: ['b.sm.attack', 'b.sm.attackTitle'], hold: ['b.sm.hold', 'b.sm.holdTitle'],
  decay: ['b.sm.decay', 'b.sm.decayTitle'], release: ['b.sm.release', 'b.sm.releaseTitle'],
} as const satisfies Record<Stage, [TranslationKey, TranslationKey]>;
const BEND_LABELS = { attack: 'b.sm.attackTension', decay: 'b.sm.decayTension', release: 'b.sm.releaseTension' } as const satisfies Record<Bent, TranslationKey>;
const stageDefault = (stage: Stage) => stage === 'release' ? SAMPLER.release.def : 0;
const tensionText = (k: number) => k ? (k > 0 ? '+' : '') + Math.round(k * 100) + ' %' : '0';
const GRAPH_H = 112, GRAPH_PAD = 7;

/**
 * The sampler's volume envelope page (FL Studio's Channel settings ▸ Volume): the Envelope switch, a
 * DAHDSR graph whose points and curves drag, and the same values on knobs. Only the switch turns the
 * envelope on (FL); while it is off the graph is dimmed and the hint says the shape is not heard.
 */
function EnvelopePanel(props: { id: string; name: () => string; color: () => string; s: () => SamplerState; put: (patch: Partial<SamplerState>) => Op }) {
  const s = props.s;
  // FL: the Envelope switch alone arms it. A knob turned while it is off only prepares the shape, so a one-shot is not cut short by a stray touch
  const edit = (patch: Partial<SamplerState>) => props.put(patch);
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));
    observer.observe(box);
    setWidth(box.clientWidth);
    onCleanup(() => observer.disconnect());
  });
  const graph = createMemo(() => envelopeGraph(s(), Math.max(60, width()), GRAPH_H, GRAPH_PAD));
  const range = GRAPH_H - 2 * GRAPH_PAD;
  const stageText = (stage: Stage) => msText(s()[stage]);

  const toggle = () => {
    const on = !s().env;
    commit([props.put({ env: on })], t('b.sm.env'));
    say(props.name() + ' · ' + t(on ? 'b.sm.envOn' : 'b.sm.envOff'));
  };
  /** Drags a stage's point: sideways is its time (on its knob's scale); the decay point also moves the sustain ↕. */
  const dragPoint = (e: PointerEvent, stage: Stage) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const scale = STAGES.find(x => x.key === stage)!, start = scale.toT(s()[stage]), sustain = s().sustain;
    const sx = e.clientX, sy = e.clientY, travel = graph().travel, label = t(STAGE_LABELS[stage][0]);
    const gesture = new Gesture(label);
    track(ev => {
      const patch: Partial<SamplerState> = { [stage]: scale.fromT(start + (ev.clientX - sx) / travel) };
      let status = label + ' ' + msText(patch[stage]!);
      if (stage === 'decay') {
        patch.sustain = Math.round(clamp(sustain - (ev.clientY - sy) / range, 0, 1) * 100) / 100;
        status += ' · ' + t('b.sm.sustain') + ' ' + Math.round(patch.sustain * 100) + ' %';
      }
      gesture.update([edit(patch)]); say(status);
    }, () => gesture.end(), stage === 'decay' ? 'move' : 'ew-resize');
  };
  /** Drags a curve's dot ↕: up bows the segment up, down bows it down. */
  const dragBend = (e: PointerEvent, stage: Bent) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const key = TENSION_KEY[stage], start = s()[key], sy = e.clientY, label = t(BEND_LABELS[stage]);
    const gesture = new Gesture(label);
    track(ev => {
      const k = Math.round(clamp(start - (ev.clientY - sy) / (range / 2), -1, 1) * 100) / 100;
      gesture.update([edit({ [key]: k })]); say(label + ' ' + tensionText(k));
    }, () => gesture.end(), 'ns-resize');
  };
  const resetStage = (stage: Stage) => {
    const patch: Partial<SamplerState> = { [stage]: stageDefault(stage), ...(stage === 'decay' ? { sustain: 1 } : {}) };
    commit([edit(patch)], t(STAGE_LABELS[stage][0]));
  };

  const stageKnob = (stage: Stage) => {
    const scale = STAGES.find(x => x.key === stage)!;
    return <SampleKnob id={props.id + stage} label={STAGE_LABELS[stage][0]} title={STAGE_LABELS[stage][1]} position={() => scale.toT(s()[stage])}
      display={() => stageText(stage)} defaultPosition={scale.toT(stageDefault(stage))} op={v => edit({ [stage]: scale.fromT(v) })} />;
  };
  const bendKnob = (stage: Bent) => {
    const key = TENSION_KEY[stage];
    return <SampleKnob id={props.id + key} label={BEND_LABELS[stage]} title="b.sm.tensionTitle" position={() => (s()[key] + 1) / 2}
      display={() => tensionText(s()[key])} defaultPosition={0.5} zero={0.5} op={v => edit({ [key]: Math.round((v * 2 - 1) * 100) / 100 })} />;
  };

  return <>
    <div class="smprow">
      <button class={['smptog', { on: s().env }]} aria-pressed={s().env ? 'true' : 'false'} title={t('b.sm.envTitle')} onClick={toggle}>{t('b.sm.env')}</button>
      <span class="envhint">{t(s().env ? 'b.sm.envOnHint' : 'b.sm.envOffHint')}</span>
    </div>
    <div ref={box} class={['envgraph', { off: !s().env }]} title={t('b.sm.graphTitle')}>
      <svg width={width()} height={GRAPH_H} aria-hidden="true">
        <line class="envoff" x1={graph().noteOff} x2={graph().noteOff} y1={2} y2={GRAPH_H - 2} />
        <text class="envofftext" x={graph().noteOff - 4} y={GRAPH_H - 6} text-anchor="end">{t('b.sm.noteOff')}</text>
        <path class="envfill" d={graph().path + ` L${GRAPH_PAD},${GRAPH_H - GRAPH_PAD} Z`} style={{ fill: props.color() }} />
        <path class="envline" d={graph().path} style={{ stroke: props.color() }} />
        <For each={graph().bends}>{b => (
          <circle class="envbend" cx={b.x} cy={b.y} r={4} onPointerDown={e => dragBend(e, b.stage)}
            onDblClick={() => commit([edit({ [TENSION_KEY[b.stage]]: 0 })], t(BEND_LABELS[b.stage]))}>
            <title>{t(BEND_LABELS[b.stage]) + ' ' + tensionText(s()[TENSION_KEY[b.stage]]) + ' · ' + t('b.sm.bendTip')}</title>
          </circle>
        )}</For>
        <For each={STAGES.map(x => x.key)}>{stage => (
          <rect class={['envpt', { sus: stage === 'decay' }]} x={graph().points[stage].x - 5} y={graph().points[stage].y - 5} width={10} height={10} rx={2}
            onPointerDown={e => dragPoint(e, stage)} onDblClick={() => resetStage(stage)}>
            <title>{t(STAGE_LABELS[stage][0]) + ' ' + stageText(stage) + (stage === 'decay' ? ' · ' + t('b.sm.sustain') + ' ' + Math.round(s().sustain * 100) + ' %' : '') + ' · ' + t(stage === 'decay' ? 'b.sm.decayPointTip' : 'b.sm.pointTip')}</title>
          </rect>
        )}</For>
      </svg>
    </div>
    <div class="smpknobs">
      <div class="smpgrp">
        {stageKnob('delay')}{stageKnob('attack')}{stageKnob('hold')}{stageKnob('decay')}
        <SampleKnob id={props.id + 'sustain'} label="b.sm.sustain" title="b.sm.sustainTitle" position={() => s().sustain}
          display={() => Math.round(s().sustain * 100) + ' %'} defaultPosition={1} op={v => edit({ sustain: Math.round(v * 100) / 100 })} />
        {stageKnob('release')}
      </div>
    </div>
    <div class="smpknobs envbends">
      <div class="smpgrp">{bendKnob('attack')}{bendKnob('decay')}{bendKnob('release')}</div>
    </div>
  </>;
}
