import { createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { createSignal, effect, onCleanup, onMount } from '../lib/reactive';
import { ICONS } from '../ui/icons';
import { kept } from '../ui/keptValue';
import { be } from '../api/backend';
import { PLUGIN_FORMAT_LABEL, type AudioConfig, type AudioDevices, type AudioHost, type AudioStatus, type CliStatus, type MidiDevice, type PluginInfo, type PluginScan } from '../api/types';
import * as A from '../state/actions';
import { resetUnderruns, underruns } from '../state/underruns';
import { applyAudioConfig, audioApplyError, audioBusy, audioStatus, audioTabRequested, refreshAudioStatus, switchToWasapi, takeAudioTabRequest } from '../state/audioWatch';
import { DEFAULT_FIXED_VELOCITY, keyName, midiFlash, midiFollow, midiStatus, selectMidiDevice, setMidiFollow, setMidiTarget, setMidiVelocity } from '../state/midi';
import { S } from '../state/store';
import { say, setU, U } from '../state/ui';
import { Segmented } from '../ui/Knob';
import { prefs, resetPrefs, setPref } from '../state/prefs';
import { RACK_SPACINGS, type RackSpacing } from '../state/pattern';
import { setTheme, THEMES, themeMode, themeName, type ThemeDef } from '../ui/theme';
import { mix } from '../lib/color';
import { t } from '../lib/i18n';
import { UpdatesSettings } from './Updates';
import { setPluginScan } from './FxPicker';
import type { TranslationKey } from '../lib/i18n';
import { DialogBoundary } from '../ui/PanelBoundary';
import { FORK } from '../fork';

const RATES = [44100, 48000, 88200, 96000];
const BUFFERS = [32, 64, 128, 256, 512, 1024, 2048];

export function Settings() {
  return <Show when={U.settings}><DialogBoundary name={t('d.set.title')} close={() => setU('settings', false)}><SettingsDialog /></DialogBoundary></Show>;
}

function SettingsDialog() {
  const [hosts, setHosts] = createSignal<AudioHost[]>([]);
  const [devs, setDevs] = createSignal<AudioDevices>({ outputs: [], inputs: [] });
  const [cli, setCli] = createSignal<CliStatus | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  // the request itself is taken by the effect below (no write while rendering)
  if (audioTabRequested()) lastTab = 'audio';
  const [tab, setTab] = createSignal<Tab>(lastTab);
  const pickTab = (next: Tab) => { lastTab = next; setTab(next); };
  // "Audio settings" on a notice while Settings is already open switches it to the Audio tab
  effect(() => { if (audioTabRequested() && takeAudioTabRequest()) pickTab('audio'); });
  const cur = () => TABS.find(x => x.id === tab()) ?? TABS[0];
  const st = audioStatus;
  const busy = audioBusy;
  onMount(() => {
    void refreshAudioStatus();
    be().audioHosts().then(setHosts).catch(e => setErr(String(e)));
    be().cliStatus().then(setCli).catch(() => {});
  });
  const settingsHost = createMemo(() => tab() === 'audio' ? st()?.host : undefined);
  effect(() => {
    const host = settingsHost();
    if (host === undefined) return;
    let current = true;
    onCleanup(() => { current = false; });
    setDevs({ outputs: [], inputs: [] });
    setErr(null);
    be().audioDevices(host).then(devices => { if (current) setDevs(devices); })
      .catch(e => { if (current) setErr(String(e)); });
  });
  const apply = async (patch: Partial<AudioConfig>) => {
    const s = st(); if (!s) return;
    if (patch.host === 'wasapi' && s.host === 'asio' && s.unavailableOutput) return switchToWasapi();
    const cfg: AudioConfig = { host: s.host, output: s.output, input: s.input, sampleRate: s.sampleRate, bufferSize: s.bufferSize, inputChannel: s.inputChannel ?? null, ...patch };
    if (cfg.host !== s.host) { cfg.output = null; cfg.input = null; }
    return applyAudioConfig(cfg);
  };
  const opt = (v: string | number | null) => v == null ? '' : String(v);
  let hostSel!: HTMLSelectElement, outSel!: HTMLSelectElement, inSel!: HTMLSelectElement, chanSel!: HTMLSelectElement, rateSel!: HTMLSelectElement, bufSel!: HTMLSelectElement;
  return (
    <div class="overlay" onPointerDown={() => setU('settings', false)}>
      <div class="dialog setdlg" role="dialog" aria-modal="true" aria-label={t('d.set.title')} onPointerDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation(); }}>
        <nav class="settabs" role="tablist" aria-orientation="vertical" onKeyDown={e => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const i = TABS.findIndex(x => x.id === tab()), next = TABS[(i + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length];
          pickTab(next.id);
          (e.currentTarget.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus();
        }}>
          <div class="settitle"><TabIcon d={ICONS.gear} color="var(--fg3)" plain />{t('d.set.title')}</div>
          <For each={TABS}>{x => (
            <button role="tab" data-tab={x.id} aria-label={t(x.label)} aria-selected={tab() === x.id ? 'true' : 'false'} tabindex={tab() === x.id ? 0 : -1} class={{ on: tab() === x.id }} onClick={() => pickTab(x.id)}>
              <TabIcon d={x.icon} color={x.color} />
              <span>{t(x.label)}</span>
            </button>
          )}</For>
        </nav>
        <div class="setmain">
          <header class="setph">
            <TabIcon d={cur().icon} color={cur().color} big />
            <div class="setphtx"><h2>{t(cur().label)}</h2><p>{t(cur().desc)}</p></div>
            <button class="setx" aria-label={t('d.upd.btn.close')} title={t('d.upd.btn.close')} onClick={() => setU('settings', false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
          {/* keyed: each tab gets its own scroll box, so it starts at the top even while the old one
              is still finishing a smooth End / Page Down scroll (resetting scrollTop does not stop that) */}
          <Show when={tab()} keyed>{_tab => <div class="setpane" role="tabpanel" aria-label={t(cur().label)} tabindex="0">
            <Show when={tab() === 'general'}><GeneralSection /></Show>
            <Show when={tab() === 'look'}><LookSection /></Show>
            <Show when={tab() === 'updates'}><UpdatesSettings OnOff={OnOff} /></Show>
            <Show when={tab() === 'audio'}>
        <Show when={st()} fallback={<span class="note">{err() ?? t('d.set.loading')}</span>}>
          {s => (
            <>
            <div class="sechd">{t('d.set.sec.device')}</div>
            <div class="form">
              <label>{t('d.set.driver')}</label>
              <div class="row" style={{ gap: '8px' }}>
                <select ref={hostSel} class="sel" value={kept(hostSel, s().host)} disabled={busy()} onChange={e => apply({ host: e.currentTarget.value })}>
                  <Show when={!hosts().some(h => h.id === s().host)}><option value={s().host}>{s().host || t('d.set.default')}</option></Show>
                  <For each={hosts()}>{h => <option value={h.id}>{h.name}</option>}</For>
                </select>
              </div>
              <Show when={!s().asioCompiled}><span /><span class="note warn">{t('d.set.noasio')}</span></Show>
              <label>{t('d.set.output')}</label>
              <select ref={outSel} class="sel" value={kept(outSel, opt(s().output))} disabled={busy()} onChange={e => apply({ output: e.currentTarget.value || null })}>
                <option value="">{t('d.set.default')}</option>
                <Show when={s().output}>{output => <Show when={!devs().outputs.includes(output())}>
                  <option value={output()}>{output()}</option>
                </Show>}</Show>
                <For each={devs().outputs}>{d => <option value={d}>{d}</option>}</For>
              </select>
              <Show when={FORK.audioRecording}>
              <label>{t('d.set.input')}</label>
              <Show when={s().host !== 'asio'} fallback={<span class="note">{t('d.set.asio.sharedinput')}</span>}>
                <select ref={inSel} class="sel" value={kept(inSel, opt(s().input))} disabled={busy()} onChange={e => apply({ input: e.currentTarget.value || null })}>
                  <option value="">{t('d.set.defaultnone')}</option>
                  <For each={devs().inputs}>{d => <option value={d}>{d}</option>}</For>
                </select>
              </Show>
              <label>{t('d.set.inchan')}</label>
              <select ref={chanSel} class="sel" value={kept(chanSel, String(s().inputChannel ?? 0))} disabled={busy() || s().inputChannels < 2}
                title={s().inputChannels ? t('d.set.inchan.tip') : t('d.set.inchan.tip0')}
                onChange={e => apply({ inputChannel: +e.currentTarget.value })}>
                <For each={Array.from({ length: Math.max(s().inputChannels, (s().inputChannel ?? 0) + 1) }, (_, i) => i)}>{i => <option value={String(i)}>{t('d.set.inmono', { n: i + 1 })}</option>}</For>
              </select>
              </Show>
            </div>
            <div class="sechd">{t('d.set.sec.perf')}</div>
            <div class="form">
              <label>{t('d.set.rate')}</label>
              <select ref={rateSel} class="sel" value={kept(rateSel, opt(s().sampleRate))} disabled={busy() || serverFixed(s().host)} title={serverFixed(s().host) ? t('d.set.serverfixed') : ''} onChange={e => apply({ sampleRate: e.currentTarget.value ? +e.currentTarget.value : null })}>
                <option value="">{t('d.set.auto')}</option>
                <For each={RATES}>{r => <option value={String(r)}>{r} Hz</option>}</For>
              </select>
              <label>{t('d.set.buffer')}</label>
              <select ref={bufSel} class="sel" value={kept(bufSel, opt(s().bufferSize))} disabled={busy() || serverFixed(s().host)} title={serverFixed(s().host) ? t('d.set.serverfixed') : ''} onChange={e => apply({ bufferSize: e.currentTarget.value ? +e.currentTarget.value : null })}>
                <option value="">{t('d.set.auto')}</option>
                <For each={BUFFERS}>{b => <option value={String(b)}>{t('d.set.samples', { n: b })}</option>}</For>
              </select>
              {/* FL's "Underruns" sits by the buffer length: a larger buffer is the cure */}
              <label title={t('d.set.underruns.tip')}>{t('d.set.underruns')}</label>
              <span class="note underruns" title={t('d.set.underruns.tip')}>
                <span class={{ warn: underruns() > 0 }}>{underruns() ? t('d.set.underruns.note', { n: underruns() }) : t('d.set.underruns.none')}</span>
                <Show when={underruns() > 0}>
                  <button class="smallbtn" onClick={resetUnderruns}>{t('d.set.underruns.reset')}</button>
                </Show>
              </span>
              <label title={t('d.set.cpumeter.tip')}>{t('d.set.cpumeter')}</label>
              <span class="note" title={t('d.set.cpumeter.tip')}><OnOff on={() => prefs().cpuMeter} set={v => setPref('cpuMeter', v)} /></span>
              <label>{t('d.set.state')}</label>
              <span class="note mono" style={{ color: s().running ? 'var(--green)' : 'var(--danger)' }}>
                {t('d.set.statline', { state: s().running ? t('d.set.running') : t('d.set.stopped'), rate: s().actualRate, buf: s().actualBuffer, ms: s().latencyMs.toFixed(1), ch: s().inputChannels })}
              </span>
              <Show when={s().unavailableOutput}>{device => <><span /><div class="audio-warning" role="status">
                <span>{t('d.audio.unavailable', { device: device() })}</span>
                <Show when={s().host === 'asio'}>
                  <button class="smallbtn primary" disabled={busy()} onClick={() => apply({ host: 'wasapi' })}>{t('d.audio.wasapi')}</button>
                  <button class="smallbtn" disabled={busy()} onClick={() => apply({})}>{t('d.audio.retry')}</button>
                </Show>
              </div></>}</Show>
              <Show when={s().error}><span /><span class="note err">{s().host === 'wasapi' && s().error === 'no output device'
                ? t('d.audio.wasapi.nooutput') : s().error}</span></Show>
              <Show when={s().note}><span /><span class="note">{s().note}</span></Show>
              <Show when={audioApplyError() ?? err()}>{error => <><span /><span class="note err">{error()}</span></>}</Show>
            </div>
            <Show when={FORK.audioRecording}>
            <div class="sechd">{t('d.set.sec.rec')}</div>
            <div class="form">
              <label>{t('d.set.recoffset')}</label>
              <RecCalib st={s()} apply={apply} busy={busy()} />
              <Show when={s().inputUnderruns || s().inputOverruns}>
                <label>{t('d.set.dropouts')}</label>
                <span class="note warn">{t('d.set.dropouts.note', { n: (s().inputUnderruns ?? 0) + (s().inputOverruns ?? 0) })}</span>
              </Show>
            </div>
            </Show>
            <div class="sechd">{t('d.set.sec.cli')}</div>
            <div class="form">
              <label>{t('d.set.cli')}</label>
              <span class="note">
                <Show when={cli()} fallback="—">
                  {c => <><span class="mono" style={{ color: 'var(--fg-hi)' }}>{c().command}</span> · {c().installed ? t('d.set.inpath', { path: c().path ? ' (' + c().path + ')' : '' }) : t('d.set.notinpath')}{c().note ? ' · ' + c().note : ''}</>}
                </Show>
              </span>
            </div>
            </>
          )}
        </Show>
            </Show>
            <Show when={tab() === 'midi'}><MidiSection /></Show>
          </div>}</Show>
        </div>
      </div>
    </div>
  );
}

type Tab = 'general' | 'look' | 'audio' | 'midi' | 'updates';
interface TabDef { id: Tab; label: TranslationKey; desc: TranslationKey; icon: string; color: string }
const TABS: TabDef[] = [
  { id: 'general', label: 'd.set.tab.general', desc: 'd.set.tab.general.desc', icon: 'M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4', color: '#4f8ef7' },
  { id: 'look', label: 'd.set.tab.look', desc: 'd.set.tab.look.desc', icon: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z M7.5 11.5h.01 M10 7.5h.01 M14.5 7.5h.01 M17 11h.01', color: '#c77ddb' },
  { id: 'audio', label: 'd.set.tab.audio', desc: 'd.set.tab.audio.desc', icon: 'M4 9h4l5-4v14l-5-4H4z M16.5 8.5a5 5 0 0 1 0 7 M19.5 5.5a9 9 0 0 1 0 13', color: '#5fbf8a' },
  { id: 'midi', label: 'd.set.tab.midi', desc: 'd.set.tab.midi.desc', icon: 'M3 5h18v14H3z M8 5v8 M12 5v8 M16 5v8 M3 13h18', color: '#e0a44a' },
  { id: 'updates', label: 'd.upd.sec', desc: 'd.set.tab.updates.desc', icon: 'M20 12a8 8 0 1 1-2.35-5.65 M20 4v5h-5 M12 8v4l2.5 2.5', color: '#47b8a8' },
];
let lastTab: Tab = 'general';

/** A tab's icon on a tile tinted with the tab's colour (`plain`: no tile). */
function TabIcon(p: { d: string; color: string; big?: boolean; plain?: boolean }) {
  const size = p.big ? 18 : 14;
  return (
    <span class={['settile', { big: !!p.big, plain: !!p.plain }]} style={{ color: p.color, background: p.plain ? 'transparent' : `color-mix(in srgb, ${p.color} 18%, transparent)` }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d={p.d} /></svg>
    </span>
  );
}

/** One settings row: the label with an always-visible explanation, and its control. */
function Row(p: { label: string; desc?: string; children: JSX.Element }) {
  return (
    <>
      <div class="lab"><span>{p.label}</span><Show when={p.desc}><small>{p.desc}</small></Show></div>
      <div class="ctl">{p.children}</div>
    </>
  );
}

const OnOff = (p: { on: () => boolean; set: (v: boolean) => void; title?: string }) =>
  <Segmented options={[t('d.set.off'), t('d.set.on')]} value={() => (p.on() ? 1 : 0)} pick={i => p.set(i === 1)} title={p.title ?? ''} />;

/** JACK (and PipeWire's JACK) runs every client at the server's rate and period. */
const serverFixed = (host: string) => host === 'jack';
const AUTOSAVE = [0, 1, 2, 5, 10];
const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const RACK_SPACING_KEYS = Object.keys(RACK_SPACINGS) as RackSpacing[];

function GeneralSection() {
  return (
    <>
      <div class="form">
        <Row label={t('settings.language')}>
          <Segmented options={[t('settings.english'), t('settings.polish')]} value={() => prefs().lang === 'pl' ? 1 : 0}
            pick={i => setPref('lang', i === 1 ? 'pl' : 'en')} />
        </Row>
      </div>
      <div class="sechd">{t('d.set.sec.project')}</div>
      <div class="form">
        <Row label={t('d.set.autosave')} desc={t('d.set.autosave.tip')}>
          <Segmented options={AUTOSAVE.map(m => (m ? t('d.set.min', { n: m }) : t('d.set.off')))} value={() => AUTOSAVE.indexOf(prefs().autosaveMin)}
            pick={i => setPref('autosaveMin', AUTOSAVE[i])} />
        </Row>
      </div>
      <div class="sechd">{t('d.set.sec.edit')}</div>
      <div class="form">
        <Row label={t('d.set.audition')} desc={t('d.set.audition.tip')}><OnOff on={() => prefs().noteAudition} set={v => setPref('noteAudition', v)} /></Row>
        <Row label={t('d.set.hints')} desc={t('d.set.hints.tip')}><OnOff on={() => prefs().hints} set={v => setPref('hints', v)} /></Row>
      </div>
      <div class="sechd">{t('d.set.sec.rec')}</div>
      <div class="form">
        <Row label={t('d.set.metro')}><OnOff on={() => S.transport.metro} set={v => void A.setTransportFlag('metro', v)} /></Row>
        <Row label="Count-in" desc={t('d.set.countin.tip')}><OnOff on={() => S.transport.countIn} set={v => void A.setTransportFlag('countIn', v)} /></Row>
      </div>
      <div class="setfoot">
        <span class="note">{t('d.set.reset.note')}</span>
        <button class="smallbtn" onClick={() => { resetPrefs(); setTheme('dark'); say(t('d.set.reset.say')); }}>{t('d.set.reset')}</button>
      </div>
    </>
  );
}

const pickTheme = (id: string, name: string) => { setTheme(id); say(t('d.set.say.theme', { name })); };

/** A theme as a miniature of the app in its own colours: toolbar, browser, playlist lanes with clips. */
function ThemeCard(p: { th: ThemeDef }) {
  const k = () => p.th.t;
  return (
    <button class={['themecard', { on: themeMode() === p.th.id }]} role="radio" aria-checked={themeMode() === p.th.id ? 'true' : 'false'}
      onClick={() => pickTheme(p.th.id, themeName(p.th))} title={themeName(p.th)}>
      <span class="tprev" style={{ background: k().bg1, 'border-color': k().line }}>
        <span class="tbar" style={{ background: k().bg5 }}><i style={{ background: k().blue }} /><i style={{ background: k().fg5 }} /><i style={{ background: k().fg5 }} /></span>
        <span class="tbody">
          <span class="tside" style={{ background: k().bg3 }}><i style={{ background: k().fg4 }} /><i style={{ background: k().fg5 }} /><i style={{ background: k().fg5 }} /></span>
          <span class="tlanes" style={{ background: k().grid }}>
            <i style={{ background: mix(k().blue, 55, k().clipBase), left: '6%', width: '40%' }} />
            <i style={{ background: mix(k().green, 55, k().clipBase), left: '30%', width: '34%' }} />
            <i style={{ background: mix(k().amber, 55, k().clipBase), left: '14%', width: '56%' }} />
            <b style={{ background: k().playhead }} />
          </span>
        </span>
      </span>
      <span class="nm">
        <span class="ell">{themeName(p.th)}</span>
        <Show when={themeMode() === p.th.id}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg></Show>
      </span>
    </button>
  );
}

function LookSection() {
  const dark = THEMES.filter(x => !x.light), light = THEMES.filter(x => x.light);
  return (
    <>
      <div class="sechd">{t('d.set.sec.theme')}</div>
      <div class="themegroup" role="radiogroup" aria-label={t('d.set.sec.theme')}>
        <div class="tglab">{t('d.set.theme.darkgrp')}</div>
        <div class="themegrid"><For each={dark}>{th => <ThemeCard th={th} />}</For></div>
        <div class="tglab">{t('d.set.theme.lightgrp')}</div>
        <div class="themegrid"><For each={light}>{th => <ThemeCard th={th} />}</For></div>
        <button class={['themesys', { on: themeMode() === 'system' }]} role="radio" aria-checked={themeMode() === 'system' ? 'true' : 'false'}
          onClick={() => { setTheme('system'); say(t('d.set.say.theme.sys')); }}>
          <span class="sw" />
          <span class="systx"><b>{t('d.set.theme.sys')}</b><small>{t('d.set.theme.sys.tip')}</small></span>
        </button>
      </div>
      <div class="sechd">{t('d.set.sec.ui')}</div>
      <div class="form">
        <Row label={t('d.set.scale')} desc={t('d.set.scale.tip')}>
          <Segmented options={SCALES.map(z => Math.round(z * 100) + '%')} value={() => SCALES.indexOf(prefs().uiScale)}
            pick={i => setPref('uiScale', SCALES[i])} />
        </Row>
        <Row label={t('d.set.rackspacing')} desc={t('d.set.rackspacing.tip')}>
          <Segmented options={RACK_SPACING_KEYS.map(k => t(`d.set.rackspacing.${k}`))} value={() => RACK_SPACING_KEYS.indexOf(prefs().rackSpacing)}
            pick={i => setPref('rackSpacing', RACK_SPACING_KEYS[i])} />
        </Row>
        <Row label={t('d.set.clipicons')} desc={t('d.set.clipicons.tip')}><OnOff on={() => prefs().clipIcons} set={v => setPref('clipIcons', v)} /></Row>
        <Row label={t('d.set.fullscreen')} desc={t('d.set.fullscreen.tip')}><OnOff on={() => prefs().startFullscreen} set={v => setPref('startFullscreen', v)} /></Row>
      </div>
    </>
  );
}

function MidiSection() {
  const [devs, setDevs] = createSignal<MidiDevice[]>([]);
  const [err, setErr] = createSignal<string | null>(null);
  const refresh = () => be().midiListDevices().then(setDevs).catch(e => setErr(String(e)));
  onMount(refresh);
  const run = (p: Promise<void>) => { setErr(null); p.catch(e => setErr(String(e))); };
  const st = midiStatus;
  /** The value "Fixed" comes back with after "From keyboard" (this visit). */
  let lastFixed = st()?.fixedVelocity ?? DEFAULT_FIXED_VELOCITY;
  const pitched = () => (S.project.channels ?? []);
  const targetVal = () => (midiFollow() ? 'follow' : String(st()?.target ?? ''));
  let devSel!: HTMLSelectElement, targetSel!: HTMLSelectElement, velSel!: HTMLSelectElement, velIn!: HTMLInputElement;
  const pickTarget = (v: string) => {
    if (v === 'follow') { setMidiFollow(true); const ch = U.selCh; if (ch != null) run(setMidiTarget(ch)); return; }
    setMidiFollow(false); run(setMidiTarget(v === '' ? null : +v));
  };
  return (
    <>
      <div class="sechd">{t('d.set.sec.midi')}</div>
      <div class="form">
        <label>{t('d.set.device')}</label>
        <div class="row" style={{ gap: '8px' }}>
          <select ref={devSel} class="sel" style={{ flex: 1 }} value={kept(devSel, st()?.selected?.id ?? '')} onChange={e => run(selectMidiDevice(e.currentTarget.value || null))}>
            <option value="">{t('d.set.none')}</option>
            <Show when={st()?.selected && !devs().some(d => d.id === st()!.selected!.id)}>
              <option value={st()!.selected!.id}>{t('d.set.disconnected', { name: st()!.selected!.name })}</option>
            </Show>
            <For each={devs()}>{d => <option value={d.id}>{d.name}</option>}</For>
          </select>
          <button class="smallbtn" style={{ height: '26px' }} onClick={refresh} title={t('d.set.refresh.tip')}>{t('d.set.refresh')}</button>
        </div>
        <label>{t('d.set.playson')}</label>
        <select ref={targetSel} class="sel" value={kept(targetSel, targetVal())} onChange={e => pickTarget(e.currentTarget.value)}
          title={t('d.set.playson.tip')}>
          <option value="follow">{t('d.set.follow')}</option>
          <option value="">{t('d.set.firstinst')}</option>
          <For each={pitched()}>{c => <option value={String(c.id)}>{c.name}</option>}</For>
        </select>
        <label>{t('d.set.vel')}</label>
        <div class="row" style={{ gap: '8px' }} title={t('d.set.vel.tip')}>
          <select ref={velSel} class="sel" style={{ flex: 1 }} value={kept(velSel, st()?.fixedVelocity == null ? 'kbd' : 'fixed')}
            onChange={e => run(setMidiVelocity(e.currentTarget.value === 'fixed' ? lastFixed : null))}>
            <option value="kbd">{t('d.set.vel.kbd')}</option>
            <option value="fixed">{t('d.set.vel.fixed')}</option>
          </select>
          <Show when={st()?.fixedVelocity != null}>
            <input ref={velIn} class="textin" type="number" min="1" max="127" step="1" style={{ width: '64px' }} value={kept(velIn, st()!.fixedVelocity!)}
              aria-label={t('d.set.vel.fixed')}
              onChange={e => {
                const v = Math.round(+e.currentTarget.value);
                if (!Number.isFinite(v)) { e.currentTarget.value = String(st()!.fixedVelocity); return; }
                lastFixed = Math.min(127, Math.max(1, v)); e.currentTarget.value = String(lastFixed);
                run(setMidiVelocity(lastFixed));
              }} />
          </Show>
        </div>
        <label>{t('d.set.state')}</label>
        <span class="note mono row" style={{ gap: '6px' }}>
          <span class={['midiled', { on: !!st()?.connected, hit: midiFlash() }]} />
          <Show when={st()?.connected} fallback={<span style={{ color: 'var(--fg4)' }}>{st()?.selected ? t('d.set.waiting') : t('d.set.notchosen')}</span>}>
            {c => <span style={{ color: 'var(--green)' }}>{c().name}</span>}
          </Show>
          <Show when={st()?.lastNote}>{n => <span>{t('d.set.last', { key: keyName(n().key), vel: n().on ? ' v' + n().velocity : '' })}</span>}</Show>
        </span>
        <Show when={st()?.error || err()}><span /><span class="note err">{st()?.error ?? err()}</span></Show>
      </div>
    </>
  );
}

/** "Add plugin…" from the add-effect menu: a searchable list of scanned plugins (VST3; LV2 on Linux), with a rescan. */
export function VstPicker() {
  return <Show when={U.vstPicker}>{v => <DialogBoundary name={t('d.set.vst.title')} close={() => setU('vstPicker', null)}><PluginPickerDialog insId={v().insId} /></DialogBoundary>}</Show>;
}
function PluginPickerDialog(props: { insId: number }) {
  const [res, setRes] = createSignal<PluginScan | null>(null);
  const [q, setQ] = createSignal('');
  const [err, setErr] = createSignal<string | null>(null);
  const scan = (rescan: boolean) => {
    setRes(null); setErr(null);
    be().pluginScan(rescan).then(r => { setRes(r); if (rescan) setPluginScan(r); }).catch(e => { setErr(String(e)); setRes({ plugins: [], unavailable: {} }); });
  };
  onMount(() => scan(false));
  let input!: HTMLInputElement;
  onMount(() => setTimeout(() => input?.focus(), 0));
  const shown = () => { const s = q().toLowerCase(); return (res()?.plugins ?? []).filter(p => !s || (p.name + ' ' + p.vendor + ' ' + p.category + ' ' + p.format).toLowerCase().includes(s)); };
  const close = () => setU('vstPicker', null);
  const pick = (p: PluginInfo) => { if (A.addPlugin(props.insId, p)) close(); };
  return (
    <div class="overlay" onPointerDown={close}>
      <div class="dialog" style={{ width: 'min(480px,92vw)', display: 'flex', 'flex-direction': 'column', gap: '10px' }} onPointerDown={e => e.stopPropagation()}>
        <div class="hd" style={{ 'margin-bottom': 0 }}><span>{t('d.set.vst.title')}</span><button onClick={close}>×</button></div>
        <div class="row" style={{ gap: '8px' }}>
          <input ref={input} class="textin" style={{ flex: 1 }} placeholder={t('d.set.search')} value={q()} onInput={e => setQ(e.currentTarget.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') close(); const first = shown().find(p => !p.unsupported); if (e.key === 'Enter' && first) pick(first); }} />
          <button class="smallbtn" style={{ height: '26px' }} onClick={() => scan(true)} title={t('d.set.rescan.tip')}>{t('d.set.rescan')}</button>
        </div>
        <Show when={err()}><span class="note err">{err()}</span></Show>
        <For each={Object.values(res()?.unavailable ?? {})}>{s => <span class="note" title={s}>{s}</span>}</For>
        <div class="plist" style={{ height: '300px' }}>
          <Show when={res()} fallback={<span class="note">{t('d.set.scanning')}</span>}>
            <For each={shown()} fallback={<span class="note">{t('d.set.novst')}</span>}>
              {p => (
                <div class="pi" onClick={() => pick(p)} style={p.unsupported ? { opacity: 0.55 } : undefined}
                  title={p.unsupported ? t('c.picker.unsupportedTip', { why: p.unsupported }) : p.path || p.cid}>
                  <span class="tile" style={{ width: '20px', height: '20px', background: '#9a8cf026', color: '#9a8cf0' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 6h16v12H4z M8 10v4 M12 9v6 M16 11v2" /></svg>
                  </span>
                  <span class="ell" style={{ flex: 1, font: '500 12px var(--sans)', color: 'var(--fg-hi)' }}>{p.name}</span>
                  <span class="fxp-badge" style={{ flex: 'none' }}>{PLUGIN_FORMAT_LABEL[p.format]}</span>
                  <span class="ell" style={{ font: '11px var(--sans)', color: 'var(--fg4)', 'max-width': '140px' }}>{p.unsupported ? t('c.picker.unsupported') : p.vendor}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** Recording offset: measured with clicks through the speakers / headphones into the mic. */
function RecCalib(props: { st: AudioStatus; apply: (p: Partial<AudioConfig>) => Promise<void>; busy: boolean }) {
  const [meas, setMeas] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  const off = () => props.st.recOffsetMs ?? 0;
  let offIn!: HTMLInputElement;
  const set = (v: number) => void props.apply({ recOffsetMs: Math.round(Math.max(-200, Math.min(200, v)) * 10) / 10 });
  const measure = async () => {
    if (meas()) return;
    setMeas(true); setMsg(t('d.set.measuring'));
    try {
      const r = await be().audioMeasureLatency();
      if (r.confidence < 0.5) setMsg(t('d.set.unsure', { n: Math.round(r.confidence * 100) }));
      else { set(r.suggestedOffsetMs); setMsg(t('d.set.measured', { rt: r.roundTripMs.toFixed(1), rep: r.reportedMs.toFixed(1), off: r.suggestedOffsetMs.toFixed(1) })); }
    } catch (e) { setMsg(t('d.set.measfail', { err: String(e) })); }
    setMeas(false);
  };
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
      <div class="row" style={{ gap: '8px' }}>
        <input ref={offIn} class="textin" type="number" step="0.5" style={{ width: '80px' }} value={kept(offIn, off())} disabled={props.busy}
          title={t('d.set.offset.tip')}
          onChange={e => { const v = parseFloat(e.currentTarget.value); if (isFinite(v)) set(v); }} />
        <span class="note">ms</span>
        <button class="smallbtn primary" style={{ height: '26px' }} disabled={meas() || props.busy} onClick={measure}
          title={t('d.set.measure.tip')}>{meas() ? t('d.set.measuring.btn') : t('d.set.measure')}</button>
        <Show when={off() !== 0}><button class="smallbtn" style={{ height: '26px' }} onClick={() => set(0)}>{t('d.set.zero')}</button></Show>
      </div>
      <Show when={msg()}><span class="note">{msg()}</span></Show>
    </div>
  );
}
