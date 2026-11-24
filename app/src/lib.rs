#![recursion_limit = "512"]
//! Synkopa desktop app: Tauri commands around the engine, the audio device, the
//! sample library, VST3 plugins and the live session the `wave` CLI talks to.

mod actions;
mod boot;
mod chords_actions;
mod cli_shim;
mod fx_chains;
mod headless;
mod keys;
mod library;
mod links;
#[cfg(test)]
mod markers_tests;
mod midi_actions;
mod models;
mod pitch_actions;
#[cfg(target_os = "linux")]
mod plugin_loop;
mod plugins;
mod project_launch;
mod recovery;
mod settings;
mod stems_actions;
#[cfg(test)]
mod ui_prefixes_tests;
mod updater;
#[cfg(test)]
mod watch_tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use wave_audio_io::{AudioConfig, AudioIo, AudioStatus, LatencyReport};
use wave_engine::{Engine, Op, Project, StateDto};
use wave_midi_in::{MidiDevice, MidiInput, MidiStatus};

pub use cli_shim::CliStatus;

pub struct App {
    pub engine: Arc<Engine>,
    pub audio: AudioIo,
    pub midi: Arc<MidiInput>,
    pub plugins: Arc<plugins::Plugins>,
    pub settings: Mutex<settings::Settings>,
    pub status: Mutex<AudioStatus>,
    pub cli: Mutex<CliStatus>,
    /// Set while an offline bounce is running; flipped by `export_cancel`.
    pub export_cancel: AtomicBool,
    /// Set to stop a running stem extraction or model download; flipped by `stems_cancel`.
    pub stems_cancel: AtomicBool,
    /// Why the installed RMVPE model could not be used, if it could not.
    pub model_error: Mutex<Option<String>>,
    session: Mutex<Option<wave_session::Server>>,
    /// Synkopa Instruments piano: where it is and whether it is loaded.
    pub keys: keys::Keys,
    /// The update found by the last check and its downloaded installer.
    pub updater: updater::State,
    /// Set once the window exists (events to the UI).
    pub handle: std::sync::OnceLock<AppHandle>,
    /// Crash-recovery copy of a project that was never saved.
    pub recovery: recovery::Recovery,
    /// Startup progress: the UI's first state reply waits for the last project here.
    pub boot: Arc<boot::Boot>,
}

impl App {
    pub fn audio_status(&self) -> AudioStatus {
        let s = self.audio.status();
        *self.status.lock() = s.clone();
        s
    }
}

impl actions::Host for App {
    fn engine(&self) -> &Arc<Engine> {
        &self.engine
    }
    fn plugins(&self) -> &Arc<plugins::Plugins> {
        &self.plugins
    }
    fn live(&self) -> bool {
        true
    }
    fn audio_json(&self) -> Value {
        json!(self.audio_status())
    }
    fn cli_json(&self) -> Value {
        json!(*self.cli.lock())
    }
    fn model_error(&self) -> Option<String> {
        self.model_error.lock().clone()
    }
    fn set_model_error(&self, e: Option<String>) {
        *self.model_error.lock() = e;
    }
    fn wait_keys(&self) -> R<()> {
        keys::wait(self)
    }
    fn keys_installed(&self) -> bool {
        keys::piano_installed(self)
    }
}

/// `Synkopa --cli …`: the `synkopa` command. Commands go to the running app, or with
/// `--project FILE` run here, on the file, with no window and no audio device.
pub fn cli_main(args: Vec<String>) -> std::process::ExitCode {
    wave_cli::run_cli_with(args, Some(&headless::Files))
}

type St<'a> = State<'a, Arc<App>>;
type R<T> = Result<T, String>;

fn es<E: ToString>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- project & undo

#[tauri::command]
async fn get_state(app: St<'_>) -> R<StateDto> {
    // the first call is the UI booting: hold it until the last project has been reopened
    let boot = app.boot.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !boot.wait(std::time::Duration::from_secs(60)) {
            log::warn!("the last project is still loading; starting without it");
        }
        boot.mark("first state served to the UI");
    })
    .await
    .map_err(es)?;
    Ok(app.engine.state())
}

#[tauri::command]
async fn apply_ops(app: St<'_>, ops: Vec<Op>, transient: Option<bool>, label: Option<String>) -> R<Value> {
    let rev = app.engine.apply_labeled(&ops, transient.unwrap_or(false), None, label.as_deref()).map_err(es)?;
    Ok(json!({ "revision": rev }))
}

#[tauri::command]
async fn begin_gesture(app: St<'_>, label: Option<String>) -> R<()> {
    app.engine.begin_gesture(label);
    Ok(())
}

#[tauri::command]
async fn end_gesture(app: St<'_>, label: Option<String>) -> R<()> {
    let _ = label; // already sent with begin_gesture; this one is ignored
    app.engine.end_gesture();
    Ok(())
}

#[tauri::command]
async fn undo(app: St<'_>) -> R<StateDto> {
    app.engine.undo();
    Ok(app.engine.state())
}

#[tauri::command]
async fn redo(app: St<'_>) -> R<StateDto> {
    app.engine.redo();
    Ok(app.engine.state())
}

#[tauri::command]
async fn fx_catalog() -> R<wave_engine::catalog::Catalog> {
    Ok(wave_engine::catalog::catalog())
}

// ---------------------------------------------------------------- transport & telemetry

#[tauri::command]
async fn transport_play(app: St<'_>, from_beat: f64) -> R<()> {
    app.engine.play(from_beat);
    Ok(())
}

#[tauri::command]
async fn transport_stop(app: St<'_>) -> R<()> {
    let a = app.inner().clone();
    let (written, st) = tauri::async_runtime::spawn_blocking(move || {
        // the transport stops even when the take could not be written: the input is
        // released either way, and only then is the write failure reported
        let written = a.engine.stop();
        let t = a.engine.state().transport;
        (written, (!t.rec && !t.monitor).then(|| a.audio.set_input(false)))
    })
    .await
    .map_err(es)?;
    if let Some(st) = st {
        *app.status.lock() = st;
    }
    written.map(|_| ()).map_err(es)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // one optional argument per transport setting
async fn transport_set(
    app: St<'_>,
    metro: Option<bool>,
    count_in: Option<bool>,
    rec: Option<bool>,
    monitor: Option<bool>,
    start_beat: Option<f64>,
    rec_audio: Option<bool>,
    rec_notes: Option<bool>,
    rec_quantize: Option<f64>,
    rec_automation: Option<bool>,
    rec_auto_latch: Option<bool>,
) -> R<wave_engine::TransportDto> {
    // audio recording and input monitoring are not part of this build: the mic never opens
    let (rec_audio, monitor) = (rec_audio.map(|_| false), monitor.map(|_| false));
    let e = app.engine.clone();
    let t = tauri::async_runtime::spawn_blocking(move || {
        if let Some(b) = start_beat {
            e.set_start(b);
        }
        if rec_audio.is_some() || rec_notes.is_some() || rec_automation.is_some() || rec_auto_latch.is_some() {
            e.set_rec_filter(rec_audio, rec_notes, rec_automation, rec_auto_latch);
        }
        if let Some(q) = rec_quantize {
            e.set_rec_quantize(q);
        }
        e.set_transport(metro, count_in, rec, monitor)
    })
    .await
    .map_err(es)?;
    // the mic is opened only while recording or monitoring is on (Bluetooth headphones
    // drop to the low-quality headset profile whenever a mic stream is open). It opens and
    // closes without touching the output, so a punch-in keeps the song playing; closing
    // still waits for the transport to stop (a punch-out may be followed by another punch-in).
    // (notes-only recording needs no mic)
    if rec.is_some() || monitor.is_some() || rec_audio.is_some() {
        let need = t.rec && t.rec_audio || t.monitor;
        if need || !t.playing {
            let a = app.inner().clone();
            let st = tauri::async_runtime::spawn_blocking(move || a.audio.set_input(need)).await.map_err(es)?;
            *app.status.lock() = st;
        }
    }
    Ok(t)
}

#[tauri::command]
async fn telemetry_subscribe(app: St<'_>, channel: Channel<InvokeResponseBody>) -> R<()> {
    app.engine.set_frame_sink(Some(Box::new(move |bytes| {
        let _ = channel.send(InvokeResponseBody::Raw(bytes));
    })));
    Ok(())
}

#[tauri::command]
async fn watch_fx(app: St<'_>, ids: Vec<u64>) -> R<()> {
    app.engine.watch_fx(&ids);
    Ok(())
}

// ---------------------------------------------------------------- audio sources

#[tauri::command]
async fn import_audio(app: St<'_>, paths: Vec<String>, track: Option<u32>, beat: Option<f64>, step: Option<bool>) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        actions::import(&*a, &json!({ "paths": paths, "track": track, "beat": beat, "step": step.unwrap_or(true) }))
    })
    .await
    .map_err(es)?
}

/// Candidate slice points of a source: [pos, strength] f32 pairs (see `slices::onsets`).
#[tauri::command]
async fn source_onsets(app: St<'_>, id: u64) -> R<Response> {
    let e = app.engine.clone();
    let o = tauri::async_runtime::spawn_blocking(move || e.source_onsets(id)).await.map_err(es)?.ok_or("no such source")?;
    let mut b = Vec::with_capacity(o.len() * 8);
    for x in o {
        b.extend_from_slice(&x.pos.to_le_bytes());
        b.extend_from_slice(&x.strength.to_le_bytes());
    }
    Ok(Response::new(b))
}

#[tauri::command]
async fn source_peaks(app: St<'_>, id: u64, norm: Option<bool>, rev: Option<bool>) -> R<Response> {
    let p = app.engine.source_peaks(id, norm.unwrap_or(false), rev.unwrap_or(false)).ok_or("no such source")?;
    let mut b = Vec::with_capacity(p.len() * 4);
    for x in p {
        b.extend_from_slice(&x.to_le_bytes());
    }
    Ok(Response::new(b))
}

#[tauri::command]
async fn pitch_analyze(app: St<'_>, clip_id: u64) -> R<std::sync::Arc<wave_engine::pitch::PitchAnalysis>> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::pitch_analysis(&*a, clip_id)).await.map_err(es)?
}

#[tauri::command]
async fn melody_channels(app: St<'_>, clip_id: u64) -> R<Value> {
    let e = app.engine.clone();
    tauri::async_runtime::spawn_blocking(move || crate::actions::melody_channels(&e, clip_id)).await.map_err(es)?
}

#[tauri::command]
async fn melody_reference(app: St<'_>, clip_id: u64, channel: u64, span: Option<[f64; 2]>) -> R<Value> {
    let e = app.engine.clone();
    tauri::async_runtime::spawn_blocking(move || crate::actions::melody_reference(&e, clip_id, channel, span)).await.map_err(es)?
}

#[tauri::command]
async fn pitch_target(
    app: St<'_>,
    clip_id: u64,
    reference: Option<wave_engine::RefTune>,
) -> R<std::sync::Arc<wave_engine::reference::PitchTarget>> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::pitch_target(&*a, clip_id, reference)).await.map_err(es)?
}

#[tauri::command]
async fn f0_model_status(app: St<'_>) -> R<models::ModelStatus> {
    Ok(models::status(&app.engine, app.model_error.lock().clone()))
}

#[tauri::command]
async fn f0_model_install(app: St<'_>, handle: AppHandle) -> R<models::ModelStatus> {
    let a = app.inner().clone();
    let h = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        // progress streams as model-progress events; a failure is announced the same way
        actions::f0_model_install(&*a, &|done, total| {
            let _ = h.emit("model-progress", json!({ "id": "rmvpe", "done": done, "total": total }));
        })
    })
    .await
    .map_err(es)?;
    if let Err(e) = &res {
        let _ = handle.emit("model-progress", json!({ "id": "rmvpe", "done": 0, "total": 0, "error": e }));
    }
    res
}

#[tauri::command]
async fn music_analyze(app: St<'_>, clip_id: Option<u64>, exclude_fx: Option<u64>) -> R<wave_engine::music::MusicAnalysis> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::music_analysis(&*a, clip_id, exclude_fx)).await.map_err(es)?
}

/// "Auto wokal": measures a vocal clip (and the beat's key) and returns the calibrated
/// insert chain for its track. Read-only: the UI applies the chain with `apply_ops`.
/// `bake_rider: true`: the rider is left out of `chain` and returned as `riderBake`, for
/// `bake_rider` (then the chain goes on the insert with no live look-ahead delay).
#[tauri::command]
async fn auto_vocal_plan(
    app: St<'_>,
    clip_id: u64,
    beat_clip_id: Option<u64>,
    style: Option<wave_engine::autovocal::Style>,
    bake_rider: Option<bool>,
) -> R<wave_engine::autovocal::AutoVocalPlan> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        actions::vocal_plan(&*a, clip_id, beat_clip_id, style.unwrap_or_default(), bake_rider.unwrap_or(false))
    })
    .await
    .map_err(es)?
}

/// Renders the Vocal Rider (`params`, e.g. a plan's `riderBake.params`) into an audio clip's
/// audio as a new source and swaps the clip onto it (one undo step; the original source stays).
#[tauri::command]
async fn bake_rider(app: St<'_>, clip_id: u64, params: std::collections::BTreeMap<String, f64>) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::bake_rider(&*a, clip_id, &params, None)).await.map_err(es)?
}

/// "Auto wokal" as one command — the whole journey `synkopa auto-vocal` runs
/// ([`actions::auto_vocal`]): measure the clip, bake the rider unless already baked or
/// `noBake`, put the calibrated chain on its insert. `label` names the chain's undo step.
/// Progress arrives as `auto-vocal` `{clipId, stage}` events ("plan", "bake", "chain").
#[tauri::command]
async fn auto_vocal(
    app: St<'_>,
    handle: AppHandle,
    clip_id: u64,
    beat_clip_id: Option<u64>,
    style: Option<wave_engine::autovocal::Style>,
    no_bake: Option<bool>,
    label: Option<String>,
) -> R<Value> {
    let a = app.inner().clone();
    let h = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = |stage: &str| {
            let _ = h.emit("auto-vocal", json!({ "clipId": clip_id, "stage": stage }));
        };
        actions::auto_vocal(
            &*a,
            clip_id,
            beat_clip_id,
            style.unwrap_or_default(),
            no_bake.unwrap_or(false),
            None,
            label.as_deref(),
            &progress,
        )
    })
    .await
    .map_err(es)?
}

#[tauri::command]
async fn clip_peaks(app: St<'_>, clip_id: u64) -> R<Response> {
    let e = app.engine.clone();
    let p = tauri::async_runtime::spawn_blocking(move || e.clip_peaks(clip_id)).await.map_err(es)?.ok_or("no such clip")?;
    let mut b = Vec::with_capacity(p.len() * 4);
    for x in p {
        b.extend_from_slice(&x.to_le_bytes());
    }
    Ok(Response::new(b))
}

#[tauri::command]
async fn trim_clip(app: St<'_>, clip_id: u64) -> R<Value> {
    let e = app.engine.clone();
    let id = tauri::async_runtime::spawn_blocking(move || e.trim_clip(clip_id)).await.map_err(es)?.map_err(es)?;
    Ok(json!({ "sourceId": id }))
}

/// "Sidechain to ▸" as one command — the same action `synkopa sidechain` runs
/// ([`actions::sidechain`]): with `fx_id`, that Compressor listens to `from` (`off`: back to
/// its own input); with `from`/`to`, the target's first free Compressor is keyed or a ducking
/// one is added. `label` names the undo step; the engine validates every key.
#[tauri::command]
async fn sidechain(
    app: St<'_>,
    fx_id: Option<u64>,
    from: Option<u64>,
    to: Option<u64>,
    off: Option<bool>,
    if_revision: Option<u64>,
    label: Option<String>,
) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        actions::sidechain(&*a, fx_id, from, to, off.unwrap_or(false), if_revision, label.as_deref())
    })
    .await
    .map_err(es)?
}

/// FX chain presets (`fx_chains.rs`): list, save, load onto an insert, rename, delete.
#[tauri::command]
async fn fx_chain(app: St<'_>, cmd: String, args: Value) -> R<Value> {
    if !fx_chains::COMMANDS.contains(&cmd.as_str()) {
        return Err(format!("not an FX chain command: {cmd}"));
    }
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::control(&*a, &cmd, &args, None, None)).await.map_err(es)?
}

/// `midi_inspect` / `midi_import` / `midi_export` (`midi_actions.rs`), off the UI thread.
#[tauri::command]
async fn midi(app: St<'_>, cmd: String, args: Value) -> R<Value> {
    if !midi_actions::COMMANDS.contains(&cmd.as_str()) {
        return Err(format!("not a MIDI command: {cmd}"));
    }
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::control(&*a, &cmd, &args, None, None)).await.map_err(es)?
}

#[tauri::command]
async fn missing_sources(app: St<'_>) -> R<Value> {
    Ok(actions::missing(app.inner().as_ref()))
}

#[tauri::command]
async fn relink_sources(app: St<'_>, args: Value) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::relink(&*a, &args)).await.map_err(es)?
}

#[tauri::command]
async fn relink_search(app: St<'_>, args: Value) -> R<Value> {
    let a = app.inner().clone();
    let folder = args.get("folder").and_then(Value::as_str).ok_or("`folder` is required")?.to_string();
    tauri::async_runtime::spawn_blocking(move || actions::relink(&*a, &json!({ "folder": folder }))).await.map_err(es)?
}

#[tauri::command]
async fn make_unique(app: St<'_>, clip_ids: Vec<u64>) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::make_unique(&*a, &clip_ids)).await.map_err(es)?
}

#[tauri::command]
async fn flatten_comp(app: St<'_>, clip_id: u64) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::flatten_comp(&*a, clip_id)).await.map_err(es)?
}

/// FL's *Export in place*: the selected clips (or, with `range`, the part of the arrangement in
/// that time selection) rendered to one audio clip on a new track below them (originals muted,
/// one undo step). Off the IPC thread; `export_cancel` stops it.
#[tauri::command]
async fn export_in_place(app: St<'_>, clip_ids: Vec<u64>, range: Option<(f64, f64)>) -> R<Value> {
    app.export_cancel.store(false, Ordering::Relaxed);
    let a = app.inner().clone();
    // the shared action waits for the piano; a cancelled bounce comes back as ERR_CANCELLED
    let r = tauri::async_runtime::spawn_blocking(move || actions::export_in_place(&*a, &clip_ids, range, &a.export_cancel, &mut |_| {}))
        .await
        .map_err(es)?;
    match r {
        Ok(v) => Ok(v),
        Err(e) if e == wave_engine::errors::ERR_CANCELLED => Ok(json!({ "cancelled": true })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn chords_model_status() -> R<chords_actions::ChordModelStatus> {
    Ok(chords_actions::status())
}

/// Downloads the chord model (`model-progress` with id "chordmini").
#[tauri::command]
async fn chords_model_install(handle: AppHandle) -> R<chords_actions::ChordModelStatus> {
    let h = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        models::fetch(&chords_actions::download(), None, |done, total| {
            let _ = h.emit("model-progress", json!({ "id": chords_actions::MODEL_ID, "done": done, "total": total }));
        })
    })
    .await
    .map_err(es)?;
    match res {
        Ok(()) => Ok(chords_actions::status()),
        Err(e) => {
            let _ = handle.emit("model-progress", json!({ "id": chords_actions::MODEL_ID, "done": 0, "total": 0, "error": e }));
            Err(e)
        }
    }
}

/// The chords of an audio clip, off the IPC thread (the first analysis of a source takes a second or two).
#[tauri::command]
async fn chords_analyze(app: St<'_>, clip_id: u64, detail: Option<String>) -> R<Value> {
    let e = app.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let d = chords_actions::detail_arg(&json!({ "detail": detail }))?;
        chords_actions::analyze(&e, clip_id, d).map(|a| json!(a))
    })
    .await
    .map_err(es)?
}

/// "Send to piano roll": see `chords_actions::to_pattern`.
#[tauri::command]
async fn chords_to_pattern(app: St<'_>, args: Value) -> R<Value> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || chords_actions::to_pattern(&*a, &args, None)).await.map_err(es)?
}

#[tauri::command]
async fn stems_model_status() -> R<stems_actions::StemModelStatus> {
    Ok(stems_actions::status())
}

/// Downloads the stem model (`model-progress` with id "htdemucs"); `stems_cancel` stops it.
#[tauri::command]
async fn stems_model_install(app: St<'_>, handle: AppHandle) -> R<Value> {
    app.stems_cancel.store(false, Ordering::Relaxed);
    let a = app.inner().clone();
    let h = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        models::fetch(&stems_actions::download(), Some(&a.stems_cancel), |done, total| {
            let _ = h.emit("model-progress", json!({ "id": stems_actions::MODEL_ID, "done": done, "total": total }));
        })
    })
    .await
    .map_err(es)?;
    match res {
        Ok(()) => Ok(json!(stems_actions::status())),
        Err(e) if e == models::DOWNLOAD_CANCELLED => Ok(json!({ "cancelled": true })),
        Err(e) => {
            let _ = handle.emit("model-progress", json!({ "id": stems_actions::MODEL_ID, "done": 0, "total": 0, "error": e }));
            Err(e)
        }
    }
}

/// "Extract stems" on an audio clip, off the IPC thread: `stems-progress {clipId, stage, frac}`
/// as it goes, `{cancelled: true}` after `stems_cancel`. See `stems_actions::extract`.
#[tauri::command]
async fn extract_stems(app: St<'_>, handle: AppHandle, clip_id: u64, stems: Vec<String>) -> R<Value> {
    app.stems_cancel.store(false, Ordering::Relaxed);
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // throttled: the separator reports once per 5.85 s segment, the other stages once
        let progress = |stage: &'static str, frac: f64| {
            let _ = handle.emit("stems-progress", json!({ "clipId": clip_id, "stage": stage, "frac": frac }));
        };
        match stems_actions::extract(&a.engine, clip_id, &stems, &a.stems_cancel, &progress)? {
            Some(p) => Ok(stems_actions::placed_json(&p, a.engine.revision())),
            None => Ok(json!({ "cancelled": true })),
        }
    })
    .await
    .map_err(es)?
}

#[tauri::command]
async fn stems_cancel(app: St<'_>) -> R<()> {
    app.stems_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn comp_audition(app: St<'_>, comp_id: u64, take_id: Option<u64>) -> R<()> {
    app.engine.audition(comp_id, take_id).map_err(es)
}

#[tauri::command]
async fn preview_clip(app: St<'_>, clip_id: u64, from: Option<f64>) -> R<()> {
    let e = app.engine.clone();
    // a start inside the clip may render its pitch edits first: off the IPC thread
    tauri::async_runtime::spawn_blocking(move || e.preview_clip(clip_id, from)).await.map_err(es)?.map_err(es)
}

/// The sample editor's keyboard on an audio clip: its sample at `key` (see `Engine::preview_clip_key`).
#[tauri::command]
async fn preview_clip_key(app: St<'_>, clip_id: u64, key: u8, vel: Option<f32>) -> R<()> {
    let e = app.engine.clone();
    // the clip's pitch edits may render first: off the IPC thread
    tauri::async_runtime::spawn_blocking(move || e.preview_clip_key(clip_id, key, vel.unwrap_or(0.8))).await.map_err(es)?.map_err(es)
}

#[tauri::command]
async fn preview_file(app: St<'_>, path: String) -> R<wave_engine::PreviewWave> {
    let e = app.engine.clone();
    tauri::async_runtime::spawn_blocking(move || e.preview_file(&PathBuf::from(path))).await.map_err(es)?.map_err(es)
}

#[tauri::command]
async fn preview_source(app: St<'_>, id: u64) -> R<wave_engine::PreviewWave> {
    app.engine.preview_source(id).map_err(es)
}

/// A second Stop: cut every tail still ringing (voices, effect tails, the preview).
#[tauri::command]
async fn transport_silence(app: St<'_>) -> R<()> {
    app.engine.silence();
    Ok(())
}

#[tauri::command]
async fn note_audition(app: St<'_>, ch: u64, key: Option<u8>, vel: Option<f32>, pattern: Option<u64>) -> R<()> {
    app.engine.note_audition(ch, key, vel.unwrap_or(0.8), pattern).map_err(es)
}

/// Computer keyboard as a piano: key down / up on a Channel Rack channel.
#[tauri::command]
async fn typing_note(app: St<'_>, ch: u64, key: u8, vel: Option<f32>, on: bool) -> R<()> {
    app.engine.typing_note(ch, key, vel.unwrap_or(0.8), on);
    Ok(())
}

#[tauri::command]
async fn pattern_play(app: St<'_>, pattern: Option<u64>, from: Option<f64>, range: Option<(f64, f64)>) -> R<()> {
    app.engine.pattern_play(pattern, from.unwrap_or(0.0), range).map_err(es)
}

#[tauri::command]
async fn pattern_loop(app: St<'_>, range: Option<(f64, f64)>) -> R<()> {
    app.engine.pattern_loop(range).map_err(es)
}

#[tauri::command]
async fn preview_stop(app: St<'_>) -> R<()> {
    app.engine.preview_stop();
    Ok(())
}

// ---------------------------------------------------------------- audio device

#[tauri::command]
async fn audio_hosts() -> R<Vec<wave_audio_io::HostInfo>> {
    Ok(wave_audio_io::hosts())
}

#[tauri::command]
async fn audio_devices(host: String) -> R<wave_audio_io::DeviceList> {
    tauri::async_runtime::spawn_blocking(move || wave_audio_io::devices(&host)).await.map_err(es)
}

#[tauri::command]
async fn audio_get_config(app: St<'_>) -> R<AudioStatus> {
    Ok(app.audio_status())
}

#[tauri::command]
async fn audio_set_config(app: St<'_>, mut config: AudioConfig) -> R<AudioStatus> {
    let a = app.inner().clone();
    let st = tauri::async_runtime::spawn_blocking(move || {
        let mut s = a.settings.lock();
        // a config sent without `recOffsetMs` keeps the calibration (a device change does
        // not lose it); changing only the offset does not restart the streams
        if config.rec_offset_ms.is_none() {
            config.rec_offset_ms = s.audio.rec_offset_ms;
        }
        let st = a.audio.start(config.clone());
        s.audio = config;
        s.save();
        *a.status.lock() = st.clone();
        st
    })
    .await
    .map_err(es)?;
    Ok(st)
}

/// Measures the recording round trip with clicks played on the output and recorded back
/// (microphone at the speaker, or a loopback cable). Opens the input for the ~6 s it takes
/// and closes it again unless recording or monitoring needs it. The suggested offset is
/// what `recOffsetMs` should be; nothing is saved here.
#[tauri::command]
async fn audio_measure_latency(app: St<'_>) -> R<LatencyReport> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if a.engine.state().transport.playing {
            return Err("Stop playback before measuring the latency.".to_string());
        }
        *a.status.lock() = a.audio.set_input(true);
        let res = a.audio.measure_latency();
        let t = a.engine.state().transport;
        if !t.rec && !t.monitor {
            *a.status.lock() = a.audio.set_input(false);
        }
        res
    })
    .await
    .map_err(es)?
}

// ---------------------------------------------------------------- MIDI keyboard

/// The input ports the OS lists right now (rescanned on every call).
#[tauri::command]
async fn midi_list_devices(app: St<'_>) -> R<Vec<MidiDevice>> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.midi.list()).await.map_err(es)
}

/// Chooses the keyboard (`None` = none) and opens it; the choice is saved and reopened at startup.
#[tauri::command]
async fn midi_select_device(app: St<'_>, id: Option<String>) -> R<MidiStatus> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = a.midi.select(id.as_deref(), None);
        let mut s = a.settings.lock();
        s.midi_device = st.selected.clone();
        s.save();
        st
    })
    .await
    .map_err(es)
}

#[tauri::command]
async fn midi_status(app: St<'_>) -> R<MidiStatus> {
    Ok(app.midi.status())
}

/// Plays every key at one velocity (`None` = the keyboard's own); saved and restored at startup.
#[tauri::command]
async fn midi_set_velocity(app: St<'_>, fixed: Option<u8>) -> R<MidiStatus> {
    let st = app.midi.set_fixed_velocity(fixed);
    let mut s = app.settings.lock();
    s.midi_fixed_velocity = st.fixed_velocity;
    s.save();
    Ok(st)
}

/// Which Channel Rack channel (instrument) the keyboard plays; `None` = the first pitched one.
#[tauri::command]
async fn midi_set_target(app: St<'_>, channel: Option<u64>) -> R<MidiStatus> {
    let st = app.midi.set_target(channel);
    app.engine.midi_configure(channel, st.connected.is_some());
    Ok(st)
}

// ---------------------------------------------------------------- library

#[tauri::command]
async fn library_list(app: St<'_>) -> R<Value> {
    Ok(json!({ "kits": library::kits(), "folders": app.settings.lock().folders }))
}

/// Synkopa Instruments: is the piano on this computer, and is it loaded?
#[tauri::command]
async fn keys_status(app: St<'_>) -> R<keys::KeysStatus> {
    Ok(keys::status(&app))
}

/// Synkopa Instruments: loads a missing or failed instrument again (the Keys window's Retry).
#[tauri::command]
async fn keys_retry(app: St<'_>, id: String) -> R<keys::KeysStatus> {
    keys::retry(app.inner(), &id);
    Ok(keys::status(&app))
}

#[tauri::command]
async fn library_install(app: St<'_>, handle: AppHandle, id: String) -> R<()> {
    let h = handle.clone();
    let kid = id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        library::install(&kid, |done, total| {
            let _ = h.emit("library-progress", json!({ "id": kid, "done": done, "total": total }));
        })
    })
    .await
    .map_err(es)?;
    if let Err(e) = &res {
        let _ = handle.emit("library-progress", json!({ "id": id, "done": 0, "total": 0, "error": e }));
    } else if wave_engine::keys::CATALOG.iter().any(|i| i.kit == id) {
        // an instrument just arrived: Keys channels that play it start playing
        keys::retry(app.inner(), &id);
    }
    res
}

#[tauri::command]
async fn library_files(kit: Option<String>, folder: Option<String>) -> R<library::Listing> {
    tauri::async_runtime::spawn_blocking(move || match (kit, folder) {
        (Some(k), _) => library::kit_files(&k),
        (None, Some(f)) => Ok(library::folder_files(&PathBuf::from(f))),
        _ => Err("pass `kit` or `folder`".to_string()),
    })
    .await
    .map_err(es)?
}

#[tauri::command]
async fn library_add_folder(app: St<'_>, handle: AppHandle) -> R<Vec<String>> {
    let picked = handle.dialog().file().blocking_pick_folder();
    let mut s = app.settings.lock();
    if let Some(p) = picked.and_then(|p| p.into_path().ok()) {
        let p = p.display().to_string();
        if !s.folders.contains(&p) {
            s.folders.push(p);
            s.save();
        }
    }
    Ok(s.folders.clone())
}

#[tauri::command]
async fn library_remove_folder(app: St<'_>, path: String) -> R<Vec<String>> {
    let mut s = app.settings.lock();
    s.folders.retain(|f| *f != path);
    s.save();
    Ok(s.folders.clone())
}

// ---------------------------------------------------------------- project files

struct ProjectOpenRequests(Mutex<Vec<String>>);

#[tauri::command]
fn take_project_open_requests(requests: State<'_, ProjectOpenRequests>) -> Vec<String> {
    std::mem::take(&mut *requests.0.lock())
}

#[tauri::command]
async fn project_new(app: St<'_>, demo: Option<bool>) -> R<StateDto> {
    // clear crash recovery only once the reset really happened: a refused reset (recording)
    // must keep the still-unsaved project's recovery copy, like open/save do
    app.engine.new_project(if demo.unwrap_or(false) { Project::demo() } else { Project::empty() }).map_err(es)?;
    app.recovery.clear();
    Ok(app.engine.state())
}

/// `project_open`'s reply: the opened project's whole state (the UI replaces its own with it)
/// and the sources that could not be loaded.
fn open_reply(state: StateDto, warnings: Vec<String>) -> Value {
    json!({ "state": state, "warnings": warnings })
}

#[tauri::command]
async fn project_open(app: St<'_>, handle: AppHandle, path: Option<String>, if_revision: Option<u64>) -> R<Value> {
    let revision = if_revision.unwrap_or_else(|| app.engine.revision());
    let path = match path {
        Some(p) => Some(PathBuf::from(p)),
        None => {
            handle.dialog().file().add_filter("Synkopa project", &["synkopa", "wave"]).blocking_pick_file().and_then(|p| p.into_path().ok())
        }
    };
    let Some(path) = path else { return Ok(json!({ "cancelled": true })) };
    let e = app.engine.clone();
    let p2 = path.clone();
    let warnings = tauri::async_runtime::spawn_blocking(move || e.open_at_revision(&p2, Some(revision))).await.map_err(es)?.map_err(es)?;
    app.recovery.clear();
    let mut s = app.settings.lock();
    s.remember(&path.display().to_string());
    s.save();
    Ok(open_reply(app.engine.state(), warnings))
}

/// File → Open recent: the projects opened or saved lately, newest first, each with whether
/// the file is still there.
#[tauri::command]
async fn recent_projects(app: St<'_>) -> R<Value> {
    let list = app.settings.lock().recent.clone();
    let rows: Vec<Value> = list
        .iter()
        .map(|p| {
            let path = std::path::Path::new(p);
            let name = path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone());
            let dir = path.parent().map(|d| d.display().to_string()).unwrap_or_default();
            json!({ "path": p, "name": name, "dir": dir, "exists": path.is_file() })
        })
        .collect();
    Ok(json!(rows))
}

/// Takes a project off File → Open recent (`path` absent: clears the list).
#[tauri::command]
async fn recent_forget(app: St<'_>, path: Option<String>) -> R<()> {
    let mut s = app.settings.lock();
    s.forget(path.as_deref());
    s.save();
    Ok(())
}

#[tauri::command]
async fn project_save(app: St<'_>, handle: AppHandle, save_as: Option<bool>, version: Option<bool>) -> R<Value> {
    let cur = app.engine.state().path.map(PathBuf::from);
    let path = match (cur, save_as.unwrap_or(false)) {
        // save new version: the next free `Name_N` beside the current file; the project then continues there
        (Some(p), false) if version.unwrap_or(false) => Some(actions::next_version_path(&p, |q| q.exists())),
        (Some(p), false) => Some(p),
        (cur, _) => {
            // start from the project's own name and folder, not a fixed "Song"
            let mut dialog = handle.dialog().file().add_filter("Synkopa project", &["synkopa", "wave"]);
            let name = cur.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
            dialog = dialog.set_file_name(name.unwrap_or_else(|| "Song.synkopa".into()));
            if let Some(dir) = cur.as_ref().and_then(|p| p.parent()).filter(|d| d.is_dir()) {
                dialog = dialog.set_directory(dir);
            }
            dialog.blocking_save_file().and_then(|p| p.into_path().ok())
        }
    };
    let Some(mut path) = path else { return Ok(json!({ "cancelled": true })) };
    if path.extension().is_none() {
        path.set_extension("synkopa");
    }
    let e = app.engine.clone();
    let p2 = path.clone();
    tauri::async_runtime::spawn_blocking(move || e.save(&p2)).await.map_err(es)?.map_err(es)?;
    app.recovery.clear();
    let mut s = app.settings.lock();
    s.remember(&path.display().to_string());
    s.save();
    Ok(json!({ "path": path.display().to_string() }))
}

#[tauri::command]
async fn project_export_zip(app: St<'_>, handle: AppHandle, if_revision: u64) -> R<Value> {
    let suggested = app
        .engine
        .state()
        .path
        .as_deref()
        .and_then(|p| PathBuf::from(p).file_stem().map(|s| format!("{}.zip", s.to_string_lossy())))
        .unwrap_or_else(|| "Song.zip".into());
    let path = handle.dialog().file().add_filter("ZIP", &["zip"]).set_file_name(suggested).blocking_save_file();
    let Some(path) = path.and_then(|p| p.into_path().ok()) else { return Ok(json!({ "cancelled": true })) };
    let engine = app.engine.clone();
    tauri::async_runtime::spawn_blocking(move || actions::export_project_zip(&engine, &path, Some(if_revision))).await.map_err(es)?
}

/// Autosave tick for a project that was never saved: writes (or, once it has a file or
/// nothing to lose, removes) the crash-recovery copy. `true` when a copy was written.
#[tauri::command]
async fn recovery_write(app: St<'_>) -> R<bool> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || a.recovery.write(&a.engine)).await.map_err(es)?
}

/// Unsaved projects left behind by a Synkopa that crashed or was killed, newest first.
#[tauri::command]
async fn recovery_list(app: St<'_>) -> R<Vec<recovery::Orphan>> {
    Ok(app.recovery.orphans())
}

/// Opens a recovered project as an unsaved project; replies like `project_open`.
#[tauri::command]
async fn recovery_restore(app: St<'_>, id: String) -> R<Value> {
    let a = app.inner().clone();
    let warnings = tauri::async_runtime::spawn_blocking(move || a.recovery.restore(&a.engine, &id)).await.map_err(es)??;
    Ok(open_reply(app.engine.state(), warnings))
}

/// Deletes a recovered project the user does not want back.
#[tauri::command]
async fn recovery_discard(app: St<'_>, id: String) -> R<()> {
    app.recovery.discard(&id)
}

/// The beat range of an export: pattern `pattern` alone (PAT mode's export, FL Studio's), the
/// project loop (`use_loop`), or the song. A loop is needed to wrap the tail.
fn export_span(project: &Project, use_loop: bool, wrap: bool, pattern: Option<u64>) -> R<(f64, f64)> {
    if let Some(id) = pattern {
        if wrap {
            return Err("wrap tail is for a loop of the song, not a pattern export".into());
        }
        return Engine::pattern_range(project, id).ok_or_else(|| "that pattern no longer exists".into());
    }
    if wrap && (!use_loop || project.loop_range.is_none_or(|l| l.b <= l.a)) {
        return Err("select a loop to wrap its tail".into());
    }
    Ok(Engine::export_range(project, use_loop))
}

/// Bounce the master mix to a 32-bit float or 16/24-bit PCM stereo WAV, or a CBR MP3 (`format: "mp3"`,
/// `mp3_kbps` 128/192/256/320, default 320), song or loop + tail.
///
/// Opens a native save dialog first. The render runs off the UI thread so playback
/// keeps going; it emits `export-progress` as it goes. Call `export_cancel` to abort before a
/// file is written.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn export_audio(
    app: St<'_>,
    handle: AppHandle,
    use_loop: bool,
    pattern: Option<u64>,
    tail: f64,
    sample_rate: u32,
    format: Option<String>,
    mp3_kbps: Option<u32>,
    wav_bits: Option<u32>,
    dither: Option<bool>,
    wrap_tail: Option<bool>,
) -> R<Value> {
    let fmt = actions::ExportFormat::parse(format.as_deref(), mp3_kbps, wav_bits, dither.unwrap_or(false))?;
    let wrap = wrap_tail.unwrap_or(false);
    fmt.check_wrap(wrap)?;
    let ext = fmt.extension();
    if !(sample_rate == 44_100 || sample_rate == 48_000) {
        return Err("sample rate must be 44100 or 48000".into());
    }
    if !(tail == 0.0 || tail == 2.0 || tail == 8.0) {
        return Err("tail must be 0, 2 or 8 seconds".into());
    }
    let st = app.engine.state();
    let (from, to) = export_span(&st.project, use_loop, wrap, pattern)?;
    let bounce = actions::Bounce { from, to, tail, rate: sample_rate, wrap, pattern };
    let suggested = st
        .path
        .as_deref()
        .and_then(|p| PathBuf::from(p).file_stem().map(|s| format!("{}.{ext}", s.to_string_lossy())))
        .unwrap_or_else(|| format!("Song.{ext}"));
    let picked = handle
        .dialog()
        .file()
        .add_filter(if ext == "mp3" { "MP3 audio" } else { "WAV audio" }, &[ext])
        .set_file_name(&suggested)
        .blocking_save_file()
        .and_then(|p| p.into_path().ok());
    let Some(mut path) = picked else {
        return Ok(json!({ "cancelled": true }));
    };
    if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(ext)) != Some(true) {
        path.set_extension(ext);
    }
    app.export_cancel.store(false, Ordering::Relaxed);
    let a = app.inner().clone();
    let out = path.clone();
    let h = handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let progress = |s: &actions::ExportStatus| {
            let _ = h.emit("export-progress", s);
        };
        actions::render_to_file(a.as_ref(), &out, bounce, &a.export_cancel, fmt, &progress)
    })
    .await
    .map_err(es)?;
    match result {
        Ok(v) => Ok(v),
        Err(e) if e == "cancelled" => Ok(json!({ "cancelled": true })),
        Err(e) => Err(e),
    }
}

/// Export one WAV or MP3 per mixer insert with sound, plus the optional master mix,
/// into a native folder selection. Emits `export-progress` as files render.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn export_stems(
    app: St<'_>,
    handle: AppHandle,
    use_loop: bool,
    pattern: Option<u64>,
    tail: f64,
    sample_rate: u32,
    include_master: bool,
    format: Option<String>,
    mp3_kbps: Option<u32>,
    wav_bits: Option<u32>,
    dither: Option<bool>,
    wrap_tail: Option<bool>,
) -> R<Value> {
    let fmt = actions::ExportFormat::parse(format.as_deref(), mp3_kbps, wav_bits, dither.unwrap_or(false))?;
    let wrap = wrap_tail.unwrap_or(false);
    fmt.check_wrap(wrap)?;
    if !(sample_rate == 44_100 || sample_rate == 48_000) {
        return Err("sample rate must be 44100 or 48000".into());
    }
    if !(tail == 0.0 || tail == 2.0 || tail == 8.0) {
        return Err("tail must be 0, 2 or 8 seconds".into());
    }
    let project = app.engine.project();
    let (from, to) = export_span(&project, use_loop, wrap, pattern)?;
    let bounce = actions::Bounce { from, to, tail, rate: sample_rate, wrap, pattern };
    let Some(dir) = handle.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()) else {
        return Ok(json!({ "cancelled": true }));
    };
    app.export_cancel.store(false, Ordering::Relaxed);
    let a = app.inner().clone();
    let h = handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let progress = |s: &actions::ExportStatus| {
            let _ = h.emit("export-progress", s);
        };
        // a stem export must not start while the piano is still loading (its stems would be silent)
        keys::wait(&a)?;
        actions::render_stems_to_dir(&a.engine, &dir, bounce, &a.export_cancel, include_master, fmt, &progress)
    })
    .await
    .map_err(es)?;
    match result {
        Ok(v) => Ok(v),
        Err(e) if e == "cancelled" => Ok(json!({ "cancelled": true })),
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn export_cancel(app: St<'_>) -> R<()> {
    app.export_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

// ---------------------------------------------------------------- plugins

#[tauri::command]
async fn plugin_scan(app: St<'_>, rescan: bool) -> R<plugins::ScanResult> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::plugin_scan(&*a, rescan)).await.map_err(es)?
}

#[tauri::command]
async fn plugin_add(
    app: St<'_>,
    insert_id: u64,
    format: Option<String>,
    path: Option<String>,
    cid: String,
    index: Option<usize>,
) -> R<Value> {
    let format = format.unwrap_or_else(|| wave_engine::PluginRef::VST3.into());
    let (id, rev) = actions::plugin_add(&**app, insert_id, &format, path.as_deref().unwrap_or(""), &cid, index)?;
    Ok(json!({ "fxId": id, "revision": rev }))
}

/// Open or close a plugin's own window. `title` / `subtitle`: what Synkopa's header above it
/// says (the UI's names, in its language); `pinned`: kept on top of the app. The header's
/// gear emits `plugin-settings`, its pin `plugin-pin`.
#[tauri::command]
async fn plugin_editor(
    app: St<'_>,
    handle: AppHandle,
    fx_id: u64,
    open: bool,
    title: Option<String>,
    subtitle: Option<String>,
    pinned: Option<bool>,
) -> R<()> {
    let label = plugins::Label { title: title.unwrap_or_default(), subtitle: subtitle.unwrap_or_default(), tag: fx_id };
    app.plugins.editor(&handle, fx_id, open, label, pinned.unwrap_or(false))
}

/// "Load anyway": the effect or plugin channel `fx_id` loads although Synkopa's safety check
/// refused it (see `plugin_probe`).
#[tauri::command]
async fn plugin_load_anyway(app: St<'_>, fx_id: u64) -> R<()> {
    actions::plugin_load_anyway(&**app, fx_id)
}

#[tauri::command]
async fn plugin_editor_open(app: St<'_>, fx_id: u64) -> R<bool> {
    app.plugins.editor_open(fx_id)
}

/// The plugins that were loaded when the last session ended without exiting: the UI asks
/// once at start, and offers to keep them out of future scans.
#[tauri::command]
async fn plugin_crash_suspects(app: St<'_>) -> R<Vec<plugins::CrashSuspect>> {
    Ok(app.plugins.crash_suspects())
}

/// Keep a plugin's module out of future scans (the follow-up to `plugin_crash_suspects`).
#[tauri::command]
async fn plugin_block(app: St<'_>, format: String, path: String) -> R<()> {
    app.plugins.block(&format, &path)
}

#[tauri::command]
async fn plugin_params(app: St<'_>, fx_id: u64) -> R<Vec<plugins::ParamInfo>> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::plugin_params(&*a, fx_id)).await.map_err(es)?
}

#[tauri::command]
async fn plugin_state(app: St<'_>, fx_id: u64) -> R<String> {
    app.plugins.state(fx_id)
}

#[tauri::command]
async fn plugin_set_param(app: St<'_>, fx_id: u64, id: u32, value: f64) -> R<()> {
    let a = app.inner().clone();
    tauri::async_runtime::spawn_blocking(move || actions::plugin_set_param(&*a, fx_id, id, value)).await.map_err(es)?
}

/// Whether automation `id` drives its target while playing (false = re-enable it): a manual
/// tweak on an automated control overrides the envelope until re-enabled or stopped.
#[tauri::command]
async fn automation_override(app: St<'_>, id: u64, on: bool) -> R<wave_engine::TransportDto> {
    let e = app.engine.clone();
    tauri::async_runtime::spawn_blocking(move || e.automation_override(id, on)).await.map_err(es)
}

#[tauri::command]
async fn app_info(app: St<'_>, handle: AppHandle) -> R<updater::AppInfo> {
    let s = app.settings.lock();
    Ok(updater::AppInfo {
        version: handle.package_info().version.to_string(),
        seen_version: s.seen_version.clone(),
        auto_update: !s.no_auto_update,
        plugin_editors: false,
        plugin_editors_why: Some(plugins::NOT_HOSTED.to_string()),
    })
}

#[tauri::command]
async fn update_set_auto(app: St<'_>, on: bool) -> R<()> {
    let mut s = app.settings.lock();
    s.no_auto_update = !on;
    s.save();
    Ok(())
}

/// Remembers that the release notes of `version` were shown.
#[tauri::command]
async fn update_mark_seen(app: St<'_>, version: String) -> R<()> {
    let mut s = app.settings.lock();
    s.seen_version = Some(version);
    s.save();
    Ok(())
}

/// Asks GitHub for a newer release. `None` = this is the newest.
#[tauri::command]
async fn update_check(app: St<'_>, handle: AppHandle) -> R<Option<updater::UpdateInfo>> {
    updater::check(&handle, &app.updater).await
}

/// Downloads and verifies the update found by `update_check` (progress: `update-progress`).
#[tauri::command]
async fn update_download(app: St<'_>, handle: AppHandle) -> R<()> {
    updater::download(&handle, &app.updater).await
}

/// Installs the downloaded update and restarts the app. On Windows the installer takes over
/// and the process ends; it does not return then.
#[tauri::command]
async fn update_install(app: St<'_>, handle: AppHandle) -> R<()> {
    let a = app.inner().clone();
    let h = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let ready = updater::ready(&a.updater)?;
        // the installer may end the process without a normal exit: detach plugin editors and stop audio first
        shutdown(&h, &a);
        ready.update.install(ready.bytes.as_slice()).map_err(es)
    })
    .await
    .map_err(es)?;
    match res {
        Ok(()) => handle.restart(),
        Err(e) => {
            // the old version keeps running: audio comes back
            let a = app.inner().clone();
            let st = tauri::async_runtime::spawn_blocking(move || {
                let settings = a.settings.lock();
                a.audio.start(settings.audio.clone())
            })
            .await
            .map_err(es)?;
            *app.status.lock() = st;
            Err(e)
        }
    }
}

#[tauri::command]
async fn open_release_page(version: Option<String>) -> R<()> {
    updater::open_release(version.as_deref())
}

/// "Ask AI": opens `service` in the system browser, with `prompt` when the service takes one.
#[tauri::command]
async fn open_ask(service: links::AskService, prompt: Option<String>) -> R<()> {
    links::open_browser(&links::ask_url(service, prompt.as_deref())?)
}

/// Help ▸ Join the Discord: opens the community server in the system browser.
#[tauri::command]
async fn open_discord() -> R<()> {
    links::open_browser(links::DISCORD_URL)
}

#[tauri::command]
async fn cli_status(app: St<'_>) -> R<CliStatus> {
    Ok(app.cli.lock().clone())
}

// ---------------------------------------------------------------- boot

fn shutdown(_h: &AppHandle, app: &App) {
    app.audio.stop();
    // a normal exit: the user already answered the unsaved-changes question
    app.recovery.close();
    // nothing is suspect when Synkopa left the front door
    app.plugins.clean_exit();
}

/// Keeps `LC_NUMERIC` in the C locale. `gtk_init` runs `setlocale(LC_ALL, "")`,
/// so on comma-decimal locales (de, da, pl, …) every C-side text parse of a
/// VST3 preset — `atof` inside DPF-style state restore — reads `0.4` as `0`,
/// which some plugins turn into division-by-zero NaNs. Hosts keep numeric
/// formatting themselves (the UI formats for the user), so nothing else sees
/// the change. Call once before any plugin work and again after `gtk_init`.
pub fn ensure_c_numeric_locale() {
    // SAFETY: `setlocale` with a valid category and NUL-terminated string; the
    // returned locale string is ignored. `LC_NUMERIC` and "C" are C-ABI constants.
    unsafe extern "C" {
        fn setlocale(category: i32, locale: *const std::ffi::c_char) -> *mut std::ffi::c_char;
    }
    unsafe {
        setlocale(libc::LC_NUMERIC, c"C".as_ptr());
    }
}

pub fn run(project_arg: Option<&str>) {
    // WebKitGTK's DMA-BUF renderer lets the Playlist's scroll lag its canvases while zooming
    #[cfg(target_os = "linux")]
    plugin_loop::webkit_renderer();
    let boot = boot::Boot::new();
    boot.mark("run() entered");
    let setup_boot = boot.clone();
    let cwd = std::env::current_dir().ok();
    let launch_project = project_arg.and_then(|arg| project_launch::project_path(arg, cwd.as_deref()));
    let reopen_last = launch_project.is_none();
    let requests = ProjectOpenRequests(Mutex::new(launch_project.into_iter().collect()));

    let builder = tauri::Builder::default().manage(requests);
    // The automation bridge (journey tools over WebSocket) — debug builds, and only when the
    // rig asks for it: no socket, no driver surface by default. Loopback only, so no other
    // host on the network reaches it either.
    #[cfg(debug_assertions)]
    let builder = if std::env::var_os("SYNKOPA_MCP_BRIDGE").is_some() {
        builder.plugin(tauri_plugin_mcp_bridge::init_with_config(tauri_plugin_mcp_bridge::Config::localhost_only()))
    } else {
        builder
    };
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let cwd = std::path::Path::new(&cwd);
        if let Some(path) = args.get(1).and_then(|arg| project_launch::project_path(arg, Some(cwd))) {
            app.state::<ProjectOpenRequests>().0.lock().push(path);
            let _ = app.emit("project-open-requested", ());
        }
    }));

    let tapp = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |tapp| {
            start_app(tapp, setup_boot, reopen_last);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            apply_ops,
            begin_gesture,
            end_gesture,
            undo,
            redo,
            fx_catalog,
            auto_vocal,
            sidechain,
            transport_play,
            transport_stop,
            transport_silence,
            transport_set,
            automation_override,
            telemetry_subscribe,
            watch_fx,
            import_audio,
            source_peaks,
            source_onsets,
            clip_peaks,
            pitch_analyze,
            pitch_target,
            melody_channels,
            melody_reference,
            f0_model_status,
            f0_model_install,
            chords_model_status,
            chords_model_install,
            chords_analyze,
            chords_to_pattern,
            stems_model_status,
            stems_model_install,
            extract_stems,
            stems_cancel,
            music_analyze,
            auto_vocal_plan,
            bake_rider,
            trim_clip,
            make_unique,
            missing_sources,
            relink_sources,
            relink_search,
            midi,
            fx_chain,
            flatten_comp,
            export_in_place,
            comp_audition,
            preview_clip,
            preview_clip_key,
            preview_file,
            preview_source,
            preview_stop,
            note_audition,
            typing_note,
            pattern_play,
            pattern_loop,
            audio_hosts,
            audio_devices,
            audio_get_config,
            audio_set_config,
            audio_measure_latency,
            midi_list_devices,
            midi_select_device,
            midi_status,
            midi_set_target,
            midi_set_velocity,
            library_list,
            library_install,
            keys_status,
            keys_retry,
            library_files,
            library_add_folder,
            library_remove_folder,
            project_new,
            project_open,
            take_project_open_requests,
            project_save,
            recent_projects,
            recent_forget,
            project_export_zip,
            recovery_write,
            recovery_list,
            recovery_restore,
            recovery_discard,
            export_audio,
            export_stems,
            export_cancel,
            plugin_scan,
            plugin_add,
            plugin_editor,
            plugin_editor_open,
            plugin_crash_suspects,
            plugin_block,
            plugin_load_anyway,
            plugin_params,
            plugin_state,
            plugin_set_param,
            cli_status,
            app_info,
            update_set_auto,
            update_mark_seen,
            update_check,
            update_download,
            update_install,
            open_release_page,
            open_ask,
            open_discord
        ])
        .build(tauri::generate_context!())
        .expect("error while building Synkopa");
    boot.mark("tauri built, entering the event loop");
    tapp.run(|h, ev| {
        if let tauri::RunEvent::Exit = ev {
            if let Some(app) = h.try_state::<Arc<App>>() {
                shutdown(h, &app);
            }
        }
    });
}

fn start_app(tapp: &mut tauri::App, boot: Arc<boot::Boot>, reopen_last: bool) {
    // gtk_init pulled the user locale back over LC_NUMERIC; plugin state
    // text parsing must stay in the C locale (see ensure_c_numeric_locale)
    ensure_c_numeric_locale();
    let plugins = plugins::Plugins::new();
    // the plugins the installer ships (Synkopa Demo Synth): listed without a rescan
    plugins::register_bundled(tapp.path().resource_dir().ok());
    let settings = settings::Settings::load();
    // reopened on a thread of its own once the window exists (decoding its audio is slow)
    let last_project = settings.last_project.as_ref().filter(|p| reopen_last && std::path::Path::new(p).is_file()).cloned();
    let engine = Engine::new(Project::empty(), plugins.factory());
    // Record captures notes and automation only (see `transport_set`)
    engine.set_rec_filter(Some(false), Some(true), None, None);
    let startup_revision = engine.revision();
    let loading = boot.loading();
    let events: Arc<std::sync::OnceLock<AppHandle>> = Arc::new(std::sync::OnceLock::new());
    // Audio status changes are published in the order processed by the audio thread.
    let audio = {
        let ev = events.clone();
        AudioIo::spawn_watched(engine.clone(), move |st| {
            if let Some(h) = ev.get() {
                let _ = h.emit("audio-status", st);
            }
        })
    };
    let midi = {
        let (e1, e2, ev1, ev2) = (engine.clone(), engine.clone(), events.clone(), events.clone());
        MidiInput::start(
            Arc::new(wave_midi_in::MidirBackend),
            wave_midi_in::Hooks {
                message: Arc::new(move |m| e1.midi_event(m)),
                status: Arc::new(move |st: &MidiStatus| {
                    // a device appearing or vanishing switches live notes on/off (and releases them)
                    e2.midi_configure(st.target, st.connected.is_some());
                    if let Some(h) = ev1.get() {
                        let _ = h.emit("midi-status", st);
                    }
                }),
                note: Arc::new(move |n| {
                    if let Some(h) = ev2.get() {
                        let _ = h.emit("midi-note", n);
                    }
                }),
            },
        )
    };
    let app = Arc::new(App {
        engine: engine.clone(),
        audio,
        midi,
        plugins,
        status: Mutex::new(AudioStatus::default()),
        settings: Mutex::new(settings),
        cli: Mutex::new(cli_shim::install()),
        export_cancel: AtomicBool::new(false),
        stems_cancel: AtomicBool::new(false),
        model_error: Mutex::new(None),
        session: Mutex::new(None),
        keys: keys::Keys::default(),
        updater: updater::State::default(),
        handle: std::sync::OnceLock::new(),
        recovery: recovery::Recovery::start(recovery::default_dir()),
        boot: boot.clone(),
    });
    boot.mark("app state built");
    // the pitch model loads in the background; analysis uses YIN until it is ready
    let a = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = models::activate(&a.engine) {
            log::warn!("{e}");
            *a.model_error.lock() = Some(e);
        }
    });

    tapp.manage(app.clone());
    let _ = events.set(tapp.handle().clone());
    // open the audio device off the UI thread
    let a = app.clone();
    std::thread::spawn(move || {
        let settings = a.settings.lock();
        let st = a.audio.start(settings.audio.clone());
        *a.status.lock() = st;
    });
    let _ = app.handle.set(tapp.handle().clone());
    keys::ensure(&app);
    // reopen the saved keyboard (it may be unplugged: the status says so, and it opens when it returns)
    let a = app.clone();
    a.midi.set_fixed_velocity(a.settings.lock().midi_fixed_velocity);
    std::thread::spawn(move || {
        let saved = a.settings.lock().midi_device.clone();
        if let Some(d) = saved {
            a.midi.select(Some(&d.id), Some(&d.name));
        }
    });
    let h = tapp.handle().clone();
    let a = app.clone();
    engine.on_change(move |dto| {
        // the core lock is released before listeners run: the loader may read the engine
        keys::ensure(&a);
        let _ = h.emit("state", dto);
    });
    if let Some(w) = tapp.get_webview_window("main") {
        let _ = w.set_title("Synkopa");
    }
    app.boot.mark("tauri setup done");
    // the last project and the CLI session come in off the critical path: the UI's first
    // state reply (see `get_state`) is the only thing that waits for them
    let a = app.clone();

    std::thread::Builder::new()
        .name("wave-boot".into())
        .spawn(move || {
            let _loading = loading; // released when this thread ends, however it ends
            if let Some(p) = last_project {
                match a.engine.open_at_revision(std::path::Path::new(&p), Some(startup_revision)) {
                    Ok(_) => {}
                    Err(e) => log::warn!("could not reopen {p}: {e}"),
                }
                a.boot.mark("last project loaded");
            }
            let weak = Arc::downgrade(&a);
            let handler: Arc<wave_session::Handler> = Arc::new(move |req: &wave_session::Request| {
                let Some(app) = weak.upgrade() else { return Err(wave_session::ErrorBody::new("GONE", "the app is closing")) };
                let res = actions::control(app.as_ref(), &req.command, &req.args, req.if_revision, req.label.as_deref());
                let rev = app.engine.revision();
                res.map(|d| (d, rev)).map_err(|m| {
                    let code = m
                        .split(':')
                        .next()
                        .filter(|c| c.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_') && c.len() > 2)
                        .unwrap_or("REFUSED")
                        .to_string();
                    wave_session::ErrorBody::new(&code, m)
                })
            });
            match wave_session::Server::start(handler) {
                Ok(s) => *a.session.lock() = Some(s),
                Err(e) => log::warn!("CLI session unavailable: {e}"),
            }
            a.boot.mark("CLI session up");
        })
        .expect("spawn boot thread");
}

#[cfg(test)]
mod tests {
    use super::open_reply;
    use std::sync::Arc;
    use wave_engine::{Engine, NoPlugins, Project};

    /// The UI replaces its whole state with `state` after an open: it must be a full StateDto
    /// (a reply with only `warnings` crashed the UI on every open).
    #[test]
    fn open_reply_carries_the_opened_state() {
        let dir = std::env::temp_dir().join(format!("wave-open-reply-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Song.wave");
        Engine::new(Project::sketch(), Arc::new(NoPlugins)).save(&path).unwrap();

        let e = Engine::new(Project::empty(), Arc::new(NoPlugins));
        let warnings = e.open(&path).unwrap();
        let v = open_reply(e.state(), warnings);
        std::fs::remove_dir_all(&dir).ok();

        let state = &v["state"];
        assert!(state["project"]["clips"].as_array().is_some_and(|c| !c.is_empty()), "{v}");
        assert!(state["revision"].is_u64());
        assert_eq!(state["dirty"], false);
        assert!(state["path"].as_str().is_some_and(|p| p.ends_with("Song.wave")));
        assert!(v["warnings"].is_array());
        assert!(v.get("cancelled").is_none());
    }
}

#[cfg(test)]
mod locale_tests {
    use super::ensure_c_numeric_locale;

    /// `gtk_init` pulls `LC_NUMERIC` to the user's locale; plugin preset text
    /// (`atof` in state restore) must keep parsing `0.4` as 0.4 regardless.
    /// Skips when no comma-decimal locale is installed (Windows, macOS, a bare
    /// local Linux) — except on Linux CI (`CI` set), whose workflow generates
    /// `de_DE.UTF-8`: there a missing locale fails instead of passing untested.
    ///
    /// The locale swap runs in a dedicated child process: `setlocale` is
    /// process-global and glibc documents it as thread-unsafe, and the test
    /// harness runs tests on parallel threads, so unrelated tests or native
    /// dependencies must not observe the temporary comma locale.
    #[test]
    fn numeric_parsing_survives_the_user_locale() {
        const CHILD_ENV: &str = "WAVE_LOCALE_TEST_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            // parent: rerun this binary for just this test with the child
            // marker set (keep the --exact name in sync with the fn name)
            let exe = std::env::current_exe().expect("test executable path");
            let out = std::process::Command::new(exe)
                .args(["--exact", "locale_tests::numeric_parsing_survives_the_user_locale", "--nocapture"])
                .env(CHILD_ENV, "1")
                .output()
                .expect("spawn the locale test child process");
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success() && stdout.contains("1 passed"), "locale child process failed: {}\n{stdout}", out.status);
            return;
        }

        // child process only from here on: the swap stays out of the shared
        // test process
        // SAFETY: setlocale/strtod with valid NUL-terminated strings; this
        // test is all the child runs, so no other thread reads the locale.
        unsafe extern "C" {
            fn setlocale(category: i32, locale: *const std::ffi::c_char) -> *mut std::ffi::c_char;
            fn strtod(s: *const std::ffi::c_char, end: *mut *mut std::ffi::c_char) -> f64;
        }
        let parse = |s: &str| unsafe {
            let c = std::ffi::CString::new(s).unwrap();
            strtod(c.as_ptr(), std::ptr::null_mut())
        };

        // find an installed comma-decimal locale; the machine's own locale set
        // decides, the test only needs one
        let mut found = None;
        for loc in ["de_DE.UTF-8", "da_DK.UTF-8", "fr_FR.UTF-8", "pl_PL.UTF-8"] {
            let c = std::ffi::CString::new(loc).unwrap();
            let set = unsafe { setlocale(libc::LC_NUMERIC, c.as_ptr()) };
            if !set.is_null() && parse("0.4") != 0.4 {
                found = Some(loc);
                break;
            }
        }
        let Some(loc) = found else {
            // Linux CI generates de_DE.UTF-8 (.github/workflows/ci.yml): a silent
            // skip there would mean the guard is never tested
            assert!(
                !(cfg!(target_os = "linux") && std::env::var_os("CI").is_some()),
                "no comma-decimal locale on Linux CI: generate one (sudo locale-gen de_DE.UTF-8)"
            );
            return; // no comma-decimal locale installed: nothing to guard against
        };

        ensure_c_numeric_locale();
        assert_eq!(parse("0.4"), 0.4, "after ensure_c_numeric_locale, {loc} must not break decimal parsing");
    }
}
