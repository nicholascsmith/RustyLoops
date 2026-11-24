//! `synkopa` — the command line: the project open in a running Synkopa app, or (with `--project`,
//! given a [`Files`] provider by the app binary) a project file with no app running.
//!
//! stdout is only the JSON result; diagnostics go to stderr.
//! Exit codes: 0 ok, 1 usage, 2 no session / connection, 3 the app refused the request.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{json, Value};
use wave_session as ws;

mod watch;

const HELP: &str = r#"synkopa — edit, render and inspect Synkopa projects
docs: https://github.com/miskibin/synkopa/blob/main/docs/cli.md

USAGE
  synkopa <command> [options]              the project open in the running app (--session ID if several are open)
  synkopa -p song.synkopa <command> [options]  a project file, no app needed: load, run, save back if it changed
                                           [--save-as FILE] [--dry-run: save nothing] [--force: even if the app has it open]
  synkopa new song.synkopa [--template empty|sketch|demo] [--bpm N]   create a project file

FOR SCRIPTS AND AGENTS
  stdout is one JSON value, messages go to stderr. Exit: 0 ok, 1 usage, 2 app not running/unreachable,
  3 refused ("CODE: message", e.g. BAD_OPS, REVISION_CONFLICT, NEEDS_APP, FILE_OPEN).
  Read `context` first, then `schema` (ops for `apply`) and `catalog` (effect params, presets).
  Units: time in beats (4 = 1 bar), note step/len in 16ths, vol 0.7937 = 0 dB, clip gain dB, pan -1..1.
  New ids: count up from context.nextId. One `apply` batch is atomic: prefer it for related edits.
  Check a result without listening: `render --out x.wav` returns peak/RMS/crest/clipping per file.
  On a file, play/stop/undo/redo/auditions are refused (NEEDS_APP); edits to a file the app has
  open are refused (FILE_OPEN) because the app would overwrite them on its next save.

SCRIPTS
  script FILE|-                            one command per line ('…'/"…" quote, # comments, a leading
                                           `synkopa` is ignored); stops at the first failing line. With -p:
                                           one load and one save, nothing written if a line fails
  watch FILE [--render OUT.wav] [--once] [--force]
                                           live coding: the script FILE describes the song. On every save
                                           it runs on a copy of the project as it was when the watch
                                           started and the result replaces the open project as one undo
                                           step while the loop plays (a failing line changes nothing).
                                           One JSON line per save on stdout. --render: bounce it each time;
                                           --once: apply and exit. With -p FILE: on the file, never saved

READ
  sessions                                 list running Synkopa apps
  status                                   transport, revision, file, audio device
  context [--full]                         project summary (--full: every clip, note and parameter)
  catalog                                  effect types, parameters and presets
  schema                                   every op `apply` accepts, with an example
  analyze [--clip ID] [--exclude-fx ID]    detect tempo (BPM) and musical key
  chords --clip ID [--simple]              the chords of an audio clip on the project's beats (ChordMini;
                                           --simple: major and minor only)
  chords --clip ID --to-pattern [--from B --to B] [--channel ID] [--simple]
                                           those chords as block chords in a new pattern on the Playlist
                                           (default: the whole clip, on a new piano channel; one undo step)
  chords [--install]                       chord model install state (--install: downloads ~17 MB, MIT,
                                           SHA-256 checked)

EDIT  (all edits are one undo step each; --if-revision N refuses to act if the project moved on)
  apply --file ops.json | --json '[...]'   apply a batch of ops atomically   [--label TEXT]
  undo | redo                              (running app only)
  bpm <value>
  add-fx --insert ID --type eq|comp|gate|filter|sat|delay|half|warp|chorus|phaser|stereo|multiband|analyzer|reverb|limit|... [--preset N]
  route --from ID --to ID [--gain 0..2] [--only]   mixer routing: insert FROM sends to TO (post-fader;
                                                  --only: no longer to the master; --to 0: to the master again)
  unroute --from ID --to ID                       remove that send (--to 0: stop going to the master)
  sidechain --from ID --to ID [--off]             insert FROM ducks insert TO: keys TO's compressor, or adds one
                                                  set up for ducking (--off: back to its own input)   [--label TEXT]
  sidechain --fx ID --from ID | --off             what that compressor, gate or filter listens to
  set-param --fx ID --param NAME --value V
  preset --fx ID --index N
  import <file>... [--track N --beat B]    load audio, optionally place it
  missing                                  sources whose audio file is missing (they play silence)
  relink --folder DIR                      find missing files in DIR (and below) by name; relinks each
                                           unambiguous match of the remembered length, lists the rest
  relink --source ID --path FILE           point a source at another file (one undo step)
  make-unique --clip ID[,ID...]            give audio clips (one sample, one track) their own copy of the
                                           sample on a new track below, routed to a free mixer insert
  export-in-place --clip ID[,ID...]        render clips (with their mixer effects) to one audio clip on a new
                                           track below them; the originals are muted (one undo step)
  export-in-place --from B --to B [--clip ID[,ID...]]
                                           only that time selection: the given clips, or every clip that plays
                                           there; clips crossing its edges are split, the inside part muted
  stems --clip ID [--only drums,bass,other,vocals]
                                           extract stems (HTDemucs) from an audio clip: one new track per
                                           stem right below it, same place and length; the clip is muted
                                           (one undo step; about 25 s per minute of audio on 6 cores)
  stems [--install]                        stem model install state (--install: downloads ~90 MB, MIT,
                                           SHA-256 checked)

MARKERS  (Playlist time markers: named points like Intro / Hook / Drop; never played)
  markers                                  id, name, position (beats and bar) of every marker
  markers --add NAME [--bar N | --at B]    add one (default: at the start position)
  markers --marker ID|NAME --name NEW      rename; with --bar N / --at B: move
  markers --remove ID|NAME                 delete
  markers --loop ID|NAME                   loop the section from the marker to the next one (or the song end)

PATTERNS & CHANNELS  (steps: x = on, 1-9 = velocity 10-90 %, . = off; spaces and | are ignored)
  channels                                 Channel Rack: ids, instrument/sample, volume, pan, insert
  channels --add kick-808|snare|marimba…   add a sampler of a standard-library sample (--sample SOURCE_ID: of a project source)
  channels --keys [--instrument ID]        add Synkopa Instruments (default the grand piano; instruments in `catalog`)
  channels --ch C --instrument ID          switch a Keys channel's instrument; --articulation NAME picks one (strings)
  channels --musicbox                      add the Music Box, the modeled tine instrument
  channels --plugin "NAME|CID"             add a scanned VST3 instrument (name, start of a name, or class id)
  channels --synth "PRESET"                add a synth channel ("" = blank patch); --ch C --preset NAME loads one
  channels --ch C --param ID --value V     one knob of a synth (ids in `catalog`), of Synkopa Instruments (release ms, 0 = the
                                           instrument's; dynamics %)
                                           or of the Music Box (ring, brightness, body, mechanical, spread %; release ms)
  channels --remove ID|NAME                remove a channel and its notes
  pattern [--id N]                         a pattern as step strings per channel
  pattern --id N --ch C --steps "x... x... x... x..." [--vel 0.8]   replace channel C's notes with step triggers
  pattern --id N --ch C --notes '[{"step":0,"len":4,"p":36,"v":0.9}]'  piano-roll notes (p = MIDI key, optional trig = true for a trigger)
  pattern --id N --ch C --clear            remove channel C's notes from the pattern
  pattern --id N [--bars N (minimum)] [--swing 0..100] [--name TEXT]      (--new instead of --id: a new pattern)
  pattern --id N --play [--from B] [--loop A:B] | --stop
                                           loop the pattern on its own (stops the song), from
                                           beat B, only beats A..B of it

TAKES & COMPING  (times in timeline beats; add --clip ID when a track has several comps)
  takes --track N                          takes, comp regions and crossfades of the track
  comp --track N --set '[{"take":ID,"from":B,"to":B,"xfadeMs":20},...]'   replace the comp
  comp --track N --take ID                 play one whole take
  comp --track N --xfade MS                default crossfade at region boundaries
  comp --track N --remove-unused           drop takes the comp does not play
  comp --track N --flatten                 render the comp to one audio clip (removes the takes)
  comp --track N --audition ID|off         play one take instead of the comp (not an edit)

TRANSPORT  (running app only)
  play [--from BEAT] | stop

FILES
  render --out file.wav|.mp3 [--from B --to B --tail SEC --rate HZ --format wav|mp3 --kbps 128|192|256|320]
                                           bounce offline (mp3 chosen by .mp3 extension); prints level stats
  render --stems --out FOLDER [--no-master] [--from B --to B --tail SEC --rate HZ --format wav|mp3 --kbps 128|192|256|320]
                                           one file per mixer insert with sound, plus the optional master mix
  WAV options: --wav-bits 16|24|32 (default 32-bit float); --dither (16/24-bit PCM only)
               --wrap-tail (carry effects into the start of the loop)
  --pattern P: render pattern P alone, as PAT mode plays it (an empty Playlist is fine)
  save [--path FILE] | open <FILE>          (app; with -p the file is saved for you, --save-as copies)
  export-project --out FILE.zip            package the project and its audio sources for sharing

MIDI FILES  (standard .mid, format 0 and 1)
  midi inspect FILE                        parts (track, channel, instrument, notes) and what each becomes
  midi import FILE [--parts 0,2] [--tempo] [--beat B] [--track N]
                                           a new pattern, one Channel Rack channel per part (GM drums:
                                           library samplers, one per drum), placed on the Playlist;
                                           --tempo takes the file's BPM
  midi import FILE --parts I --pattern P --ch C [--replace]
                                           one part's notes into channel C of pattern P
  midi export --out FILE.mid [--pattern P] the song (pattern clips as placed) or one pattern, with tempo

FX CHAIN PRESETS  (a mixer insert's effects, in your library, for any project)
  fxchain list                             names and the effects in each
  fxchain save NAME --insert ID [--force]  the insert's effects in order (--force replaces a preset)
  fxchain load NAME --insert ID [--mode replace|append]
                                           onto an insert, one undo step; an insert with effects
                                           needs --mode; volume, pan and routing stay as they are
  fxchain rename NAME --to NEW | fxchain delete NAME

PITCH  (Tune to Reference: pull a vocal take onto another performance of the same melody)
  tune-ref --clip ID --reference SOURCE | --melody CHANNEL [--correction 0..100 --vibrato 0..100
           --influence 0..100 --speed 0..1000 --octave auto|-24..24 --key 0..11 --scale 0..4]
                                           switch a clip to it (--off: manual); --melody: the notes that
                                           channel plays over the clip in the playlist (taken again each time)
  melody-channels --clip ID                channels playing notes over the clip, best fit to the singing first
  pitch-target --clip ID [--full]          the computed target: score, octave, notes (--full: curves)
  f0-model [--install]                     pitch detector in use; RMVPE model install state
                                           (--install: downloads ~345 MB after printing its licence note,
                                           SHA-256 checked, then switches the detector to it)

PITCH EDITING  (the pitch editor's notes for scripts and agents; indices come from `pitch inspect`)
  pitch inspect --clip ID [--full [--from S --to S]] [--all]
                                           notes: sung pitch, cents off, kind (stable/vibrato/glide/short/unsure),
                                           confidence, edits, resulting pitch; `base` = segmentation fingerprint
                                           (--full: frame curves; --all: notes outside the clip's region too)
  pitch compare --clip ID --source SRC | --ref-clip ID
                                           read-only: interval (any, not only octaves), note matches (match/merged/
                                           split/extra), ornaments, timing, similarity, unmatched stretches
  pitch suggest --clip ID [--source SRC] [--max-cents 60 --min-cents 15 --strength 100 --key C --scale major
                --tuning CENTS]            a cautious proposal with a reason per note and a ready `op`; read-only
  pitch edit --clip ID [--base FP] [--note I (--shift C | --cents C | --target MIDI) [--drift % --formant C
             --gain dB --speed MS|none]] [--split I@SEC] [--merge I] [--reset I,J] [--clear]
             [--json EDIT | --file edit.json] [--max-cents C]      one undo step (the editTune op)
  pitch render --clip ID --out take.wav [--original]   the clip alone with its edits (or without), 32-bit WAV
  tune-file --take u.wav --reference r.wav --out o.wav [--json target.json]
            [--model rmvpe.onnx | --yin] [same options as tune-ref]   headless; needs no running app

AUTO VOCAL  (one call: measure the take, bake the rider into the audio, put the tuned chain on the insert)
  auto-vocal --clip ID [--style natural|hard] [--beat-clip ID] [--no-bake] [--plan] [--label TEXT]
                                           the calibrated chain (tune, rider, fet comp, deess, reverb, limit)
                                           replaces the insert's effects of the same kinds; the key comes from
                                           the beat clip or the other tracks. Default renders the rider into
                                           the clip's audio first (two undo steps, the original source stays);
                                           --no-bake keeps it live on the insert; --plan only prints the
                                           plan, read-only (riderBake holds the rider's params)

PLUGINS  (VST3 everywhere, LV2 on Linux)
  plugins [--rescan]                       installed effects of every format and VST3 instruments ({plugins, instruments, unavailable})
  plugin-add --insert ID --cid C [--format vst3|lv2] [--path P]
                                           put a plugin on an insert (VST3: --path and class id;
                                           LV2: --cid is the plugin URI)
  plugin-params --fx ID [--query TEXT]     parameters of a plugin instance: an effect, or a plugin channel by its id (LV2: real range and unit too)
  plugin-set --fx ID --id PARAM --value 0..1
  plugin-load-anyway --fx ID               load a plugin Synkopa's safety check refused (it crashed or hung
                                           when tried in a separate process); from now on, every project
  vst3 [--rescan] | vst3-add | vst3-params | vst3-set    the same, VST3 only (older names)
  auto-add [--fx ID --param ID | --target mix --fx ID | --target insertVol|insertPan|trackVol|chanVol|chanPan --id ID] [--points "0:0.2,4:0.8" | --value V] [--track N --name TEXT]
                                           automate a hosted plugin parameter (adds the playlist clip too)

NOTES  (deterministic transforms and generators for a pattern's notes)
  notes humanize --pattern ID [--timing 0..1 --velocity 0..1]
  notes quantize --pattern ID [--grid 1|2|4 --amount 0..1 --scale]
  notes euclid --pattern ID --ch CH --k K --n N [--rotate INT --vel 0..1]
  notes strum --pattern ID [--width STEPS --ramp VEL]
  notes drums --pattern ID --bars N --seed S --voice "CH:K:N[:ROT[:VEL]]" (repeatable)
  notes melody --pattern ID --ch CH [--bars N --density 0..1 --repeat N --seed S]
  notes chord --pattern ID [--type diatonic|maj|min|7|maj7|min7]        harmonize single notes
  notes progression --pattern ID --ch CH [--bars 1..32 --template pop|pop2|minloop|trap|iivI|doowop|
           andalusian|blues|canon|chance --seed S --degrees "0:5:2:6" --no-voice-lead]
           one diatonic 7th chord per bar; --degrees replaces template+bars; inversions are
           voice-led to move the least unless --no-voice-lead
  notes stamp --pattern ID --ch CH --step S --root R --type maj|min|…|5 [--inv 0..3 --len STEPS]
           write one chord rooted at R (MIDI key or note name like A3); replaces that step
  notes … [--select "FROM:TO[@CH]" | --indices "1,2,5"]                limit the notes a verb touches
  key [NOTE] [SCALE] [--off]                            project key/scale (major minor pent…) for scale-aware tools

  call <command> [--args JSON]             raw request (see `catalog`)
  --pretty                                 indent JSON output
"#;

/// Opens and creates project files in this process: what `--project` and `new` need.
/// The app binary provides it; the standalone `synkopa` binary only talks to a running app.
pub trait Files {
    /// Loads a project file; the warnings name audio that could not be loaded.
    fn open(&self, path: &Path) -> Result<(Box<dyn Doc>, Vec<String>), String>;
    /// A new, unsaved project from a template: `empty`, `sketch` or `demo`.
    fn create(&self, template: &str) -> Result<Box<dyn Doc>, String>;
}

/// A project held by this process.
pub trait Doc {
    /// The same request the running app answers; an error is `CODE: message` or a message.
    fn call(&self, command: &str, args: &Value, if_revision: Option<u64>) -> Result<Value, String>;
    fn revision(&self) -> u64;
    /// Changed since it was loaded or saved.
    fn dirty(&self) -> bool;
    fn save(&self, path: &Path) -> Result<(), String>;
}

/// Options that are only present or absent; they never take the word after them as a value.
const SWITCHES: &[&str] = &[
    "all",
    "clear",
    "dither",
    "dry-run",
    "flatten",
    "force",
    "once",
    "full",
    "help",
    "install",
    "keys",
    "musicbox",
    "new",
    "no-bake",
    "no-master",
    "no-voice-lead",
    "off",
    "original",
    "plan",
    "play",
    "pretty",
    "remove-unused",
    "replace",
    "rescan",
    "simple",
    "stems",
    "stop",
    "tempo",
    "to-pattern",
    "wrap-tail",
    "yin",
];

#[derive(Clone)]
struct Args {
    pos: Vec<String>,
    opts: Vec<(String, Option<String>)>,
}

impl Args {
    fn parse(raw: Vec<String>) -> Self {
        let mut pos = vec![];
        let mut opts = vec![];
        let mut it = raw.into_iter().peekable();
        while let Some(a) = it.next() {
            let key = match a.as_str() {
                "-p" => Some("project"),
                _ => a.strip_prefix("--"),
            };
            if let Some(k) = key {
                // a switch never takes the next word: `--dry-run -p f.wave` or `-p f --dry-run bpm 90`
                // would otherwise turn the file or the command into its value
                let is_opt = |n: &str| (n.starts_with("--") || n == "-p") && n.parse::<f64>().is_err();
                let v = match it.peek() {
                    Some(n) if !SWITCHES.contains(&k) && !is_opt(n) => it.next(),
                    _ => None,
                };
                opts.push((k.to_string(), v));
            } else {
                pos.push(a);
            }
        }
        Self { pos, opts }
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.opts.iter().find(|(n, _)| n == k).and_then(|(_, v)| v.as_deref())
    }
    fn get_all(&self, k: &str) -> Vec<&str> {
        self.opts.iter().filter(|(n, _)| n == k).filter_map(|(_, v)| v.as_deref()).collect()
    }
    fn has(&self, k: &str) -> bool {
        self.opts.iter().any(|(n, _)| n == k)
    }
    fn num(&self, k: &str) -> Result<Option<f64>, String> {
        self.get(k).map(|v| v.parse::<f64>().map_err(|_| format!("--{k} must be a number, got {v}"))).transpose()
    }
    fn need(&self, k: &str) -> Result<&str, String> {
        self.get(k).ok_or_else(|| format!("missing --{k}"))
    }
}

#[derive(Debug)]
enum Fail {
    Usage(String),
    Conn(String),
    App(String),
}

/// Where requests go: the running app (`doc` = None) or a project held here.
struct Cx<'a> {
    doc: Option<&'a dyn Doc>,
}

/// Decimal places kept in printed numbers. The engine stores many values as `f32`, so a step of
/// 0.47 prints as 0.4699999988079071 without this; four places keep triplet positions
/// (28.3333) and fader values (0.7937 = 0 dB) exact enough to send back.
const PRINT_DECIMALS: i32 = 4;

/// Rounds every non-integer number in a reply to [`PRINT_DECIMALS`] places (integers and ids untouched).
fn tidy_numbers(v: &mut Value) {
    match v {
        Value::Number(n) if !n.is_i64() && !n.is_u64() => {
            if let Some(f) = n.as_f64() {
                let k = 10f64.powi(PRINT_DECIMALS);
                let r = (f * k).round() / k;
                if let Some(m) = serde_json::Number::from_f64(if r == 0.0 { 0.0 } else { r }) {
                    *n = m;
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(tidy_numbers),
        Value::Object(o) => o.values_mut().for_each(tidy_numbers),
        _ => {}
    }
}

/// Runs the CLI with `raw` arguments (without the program name), against the running app only.
pub fn run_cli(raw: Vec<String>) -> ExitCode {
    run_cli_with(raw, None)
}

/// Runs the CLI; with `files`, `--project FILE` and `new` work without a running app.
pub fn run_cli_with(raw: Vec<String>, files: Option<&dyn Files>) -> ExitCode {
    let a = Args::parse(raw);
    let pretty = a.has("pretty");
    let Some(cmd) = a.pos.first().cloned() else {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    };
    if cmd == "help" || a.has("help") {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }
    match dispatch(&cmd, &a, files) {
        Ok(mut v) => {
            tidy_numbers(&mut v);
            let s = if pretty { serde_json::to_string_pretty(&v) } else { serde_json::to_string(&v) };
            println!("{}", s.unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(Fail::Usage(m)) => {
            eprintln!("synkopa: {m}\n(run `synkopa help`)");
            ExitCode::from(1)
        }
        Err(Fail::Conn(m)) => {
            eprintln!("synkopa: {m}");
            ExitCode::from(2)
        }
        Err(Fail::App(m)) => {
            eprintln!("synkopa: {m}");
            ExitCode::from(3)
        }
    }
}

fn dispatch(cmd: &str, a: &Args, files: Option<&dyn Files>) -> Result<Value, Fail> {
    if cmd == "watch" {
        watch::watch(files, a)
    } else if cmd == "new" {
        new_file(files, a)
    } else if a.has("project") {
        on_file(files, cmd, a)
    } else {
        run(&Cx { doc: None }, cmd, a)
    }
}

/// One command, as [`run_cli_with`] runs it, with the result returned instead of printed
/// (the message of a failure). For embedders and tests; `watch` without `--once` never returns.
pub fn execute(raw: Vec<String>, files: Option<&dyn Files>) -> Result<Value, String> {
    let a = Args::parse(raw);
    let cmd = a.pos.first().cloned().ok_or("no command")?;
    dispatch(&cmd, &a, files).map_err(|e| match e {
        Fail::Usage(m) | Fail::Conn(m) | Fail::App(m) => m,
    })
}

fn need_files(files: Option<&dyn Files>) -> Result<&dyn Files, Fail> {
    files.ok_or_else(|| {
        Fail::Usage(
            "this `synkopa` binary only talks to a running app; project files need the `synkopa` the Synkopa app installs (it runs `Synkopa --cli`)"
                .into(),
        )
    })
}

fn abs(p: &str) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| PathBuf::from(p))
}

/// The same file, also when one of them does not exist yet (case-insensitive on Windows and macOS).
fn same_file(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let p = std::fs::canonicalize(p).unwrap_or_else(|_| abs(&p.to_string_lossy()));
        let s = p.to_string_lossy().trim_start_matches(r"\\?\").replace('\\', "/");
        if cfg!(any(windows, target_os = "macos")) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

/// Refuses to write a file a running app has open: its next save would silently undo this edit.
fn not_open_in_app(path: &Path, a: &Args) -> Result<(), Fail> {
    if a.has("force") {
        return Ok(());
    }
    match open_in_session(path) {
        Some(id) => Err(Fail::App(format!(
            "FILE_OPEN: {} is open in Synkopa (session {id}). Edit it there (drop --project; the edit joins the app's undo history), close it in the app first, or add --force (the app overwrites the file on its next save)",
            path.display(),
        ))),
        None => Ok(()),
    }
}

/// The (short) id of a running app that has `path` open.
fn open_in_session(path: &Path) -> Option<String> {
    ws::sessions().into_iter().find_map(|ep| {
        let rep = ws::call(&ep, "status", json!({}), None, None).ok()?;
        let open = rep.data.get("path").and_then(Value::as_str).map(PathBuf::from)?;
        same_file(&open, path).then(|| ep.session_id[..ep.session_id.len().min(8)].to_string())
    })
}

/// `synkopa --project FILE <command>`: load, run, save if it changed.
fn on_file(files: Option<&dyn Files>, cmd: &str, a: &Args) -> Result<Value, Fail> {
    let files = need_files(files)?;
    let given = a.get("project").ok_or_else(|| Fail::Usage("--project needs a file: --project song.synkopa".into()))?;
    let path = abs(given);
    if a.has("session") {
        return Err(Fail::Usage("--session talks to a running app and --project works on a file; pick one".into()));
    }
    if a.has("save-as") && a.get("save-as").is_none() {
        return Err(Fail::Usage("--save-as needs a file".into()));
    }
    if !path.is_file() {
        return Err(Fail::Usage(format!("{given} does not exist (create it with `synkopa new {given}`)")));
    }
    let (doc, warnings) = files.open(&path).map_err(|e| Fail::App(format!("OPEN_FAILED: {e}")))?;
    for w in &warnings {
        eprintln!("synkopa: warning: {w}");
    }
    let cx = Cx { doc: Some(&*doc) };
    let mut out = run(&cx, cmd, a)?;
    let save_as = a.get("save-as").or(if cmd == "save" { a.get("path") } else { None }).map(abs);
    let target = save_as.clone().unwrap_or(path);
    let wanted = doc.dirty() || save_as.is_some() || cmd == "save";
    let dry = a.has("dry-run");
    let saved = if wanted && !dry {
        not_open_in_app(&target, a)?;
        doc.save(&target).map_err(|e| Fail::App(format!("SAVE_FAILED: {}: {e}", target.display())))?;
        Some(target.display().to_string())
    } else {
        None
    };
    if let Value::Object(m) = &mut out {
        m.insert("saved".into(), json!(saved));
        if dry {
            m.insert("dryRun".into(), json!({ "changed": doc.dirty(), "wouldSave": wanted.then(|| target.display().to_string()) }));
        }
        if !warnings.is_empty() {
            m.insert("loadWarnings".into(), json!(warnings));
        }
    }
    Ok(out)
}

/// `synkopa new FILE [--template empty|sketch|demo] [--bpm N] [--force]`
fn new_file(files: Option<&dyn Files>, a: &Args) -> Result<Value, Fail> {
    let u = Fail::Usage;
    let files = need_files(files)?;
    let raw = a.pos.get(1).ok_or_else(|| u("new <FILE> [--template empty|sketch|demo] [--bpm N]".into()))?;
    let mut path = abs(raw);
    if path.extension().is_none() {
        path.set_extension("synkopa");
    }
    if path.exists() && !a.has("force") {
        return Err(Fail::App(format!("EXISTS: {} already exists (--force replaces it)", path.display())));
    }
    let template = a.get("template").unwrap_or("empty");
    let doc = files.create(template).map_err(u)?;
    if let Some(bpm) = a.num("bpm").map_err(u)? {
        doc.call("apply", &json!({"ops": [{"op": "setBpm", "bpm": bpm}]}), None).map_err(|e| Fail::App(app_error(e)))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Fail::App(format!("SAVE_FAILED: {}: {e}", dir.display())))?;
    }
    // `--force` here only means "replace an existing file": a project the app has open is never replaced
    // behind its back (its next save would write the old project over the new one)
    if let Some(id) = open_in_session(&path) {
        return Err(Fail::App(format!("FILE_OPEN: {} is open in Synkopa (session {id}); close it in the app first", path.display())));
    }
    doc.save(&path).map_err(|e| Fail::App(format!("SAVE_FAILED: {}: {e}", path.display())))?;
    let ctx = doc.call("context", &json!({}), None).map_err(|e| Fail::App(app_error(e)))?;
    Ok(
        json!({ "saved": path.display().to_string(), "template": template, "bpm": ctx["bpm"], "tracks": ctx["tracks"].as_array().map(Vec::len), "nextId": ctx["nextId"] }),
    )
}

/// `CODE: message`, as the running app reports a refusal.
fn app_error(m: String) -> String {
    let coded = m.split(':').next().is_some_and(|c| c.len() > 2 && c.chars().all(|ch| ch.is_ascii_uppercase() || ch == '_'));
    if coded {
        m
    } else {
        format!("REFUSED: {m}")
    }
}

fn session(a: &Args) -> Result<ws::Endpoint, Fail> {
    let all = ws::sessions();
    match a.get("session") {
        Some(id) => {
            all.into_iter().find(|e| e.session_id.starts_with(id)).ok_or_else(|| Fail::Conn(format!("no running Synkopa session {id}")))
        }
        None => match all.len() {
            0 => Err(Fail::Conn("Synkopa is not running (start the app, or work on a file: synkopa --project song.synkopa …)".into())),
            1 => Ok(all.into_iter().next().unwrap()),
            n => Err(Fail::Conn(format!("{n} Synkopa apps are open; pick one with --session ID (see `synkopa sessions`)"))),
        },
    }
}

fn send(cx: &Cx, a: &Args, command: &str, args: Value) -> Result<Value, Fail> {
    let rev = a.num("if-revision").map_err(Fail::Usage)?.map(|v| v as u64);
    // the CLI names an undo step even when the caller did not pass --label, like the app's
    // buttons do: without it the Edit menu shows the engine's default name for the verb. An
    // explicit --label wins and travels in the args (file mode has no session header field).
    // The top-level `label` arg key is reserved for undo naming — no verb may use it for content
    let default_label = default_undo_label(command);
    let mut args = args;
    if let Some(m) = args.as_object_mut() {
        match a.get("label") {
            Some(l) => {
                m.insert("label".into(), json!(l));
            }
            None => {
                if let Some(l) = default_label {
                    m.entry("label").or_insert(json!(l));
                }
            }
        }
    }
    if let Some(doc) = cx.doc {
        let mut d = doc.call(command, &args, rev).map_err(|e| Fail::App(app_error(e)))?;
        if let Value::Object(m) = &mut d {
            m.entry("revision").or_insert(json!(doc.revision()));
        }
        return Ok(d);
    }
    let ep = session(a)?;
    let label = a.get("label").map(str::to_owned).or_else(|| default_label.map(str::to_owned));
    let rep = ws::call(&ep, command, args, rev, label).map_err(|e| Fail::Conn(format!("could not reach Synkopa: {e}")))?;
    if rep.ok {
        let mut d = rep.data;
        if let Value::Object(m) = &mut d {
            m.entry("revision").or_insert(json!(rep.revision));
        }
        Ok(d)
    } else {
        let e = rep.error.unwrap_or_else(|| ws::ErrorBody::new("ERROR", "unknown error"));
        Err(Fail::App(format!("{}: {}", e.code, e.message)))
    }
}

/// The undo-step name a verb gets when the caller passed no `--label`: only the verbs whose
/// action takes a label name their step (the engine names the others itself).
fn default_undo_label(command: &str) -> Option<&'static str> {
    match command {
        "auto_vocal" => Some("Auto Vocal"),
        "sidechain" => Some("Sidechain"),
        _ => None,
    }
}

/// Splits a script line like a shell: whitespace separates, '…' and "…" group. No escapes,
/// so Windows paths keep their backslashes and JSON in '…' keeps its double quotes.
fn split_line(line: &str) -> Result<Vec<String>, String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    for ch in line.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            None => {
                cur.push(ch);
                started = true;
            }
        }
    }
    if let Some(q) = quote {
        return Err(format!("unclosed {q}"));
    }
    if started {
        out.push(cur);
    }
    Ok(out)
}

/// Options of the whole invocation, not of one script line.
const OUTER_ONLY: &[&str] = &["project", "session", "save-as", "dry-run", "force", "pretty"];

/// `synkopa [--project FILE] script FILE|-`: one command per line, stops at the first failure.
fn script(cx: &Cx, a: &Args) -> Result<Value, Fail> {
    let u = Fail::Usage;
    let src = a.pos.get(1).ok_or_else(|| u("script <FILE> (or - for stdin)".into()))?;
    let text = if src == "-" {
        let mut t = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut t).map_err(|e| u(format!("stdin: {e}")))?;
        t
    } else {
        std::fs::read_to_string(src).map_err(|e| u(format!("{src}: {e}")))?
    };
    Ok(json!({ "results": run_lines(cx, a, &text)? }))
}

/// Runs a script's lines (see [`script`]): the results of each, or the first failure, naming its line.
fn run_lines(cx: &Cx, a: &Args, text: &str) -> Result<Vec<Value>, Fail> {
    let u = Fail::Usage;
    let mut results = vec![];
    for (i, line) in text.lines().enumerate() {
        let n = i + 1;
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut words = split_line(t).map_err(|e| u(format!("line {n}: {e}")))?;
        if matches!(words.first().map(String::as_str), Some("synkopa" | "wave")) {
            words.remove(0);
        }
        let mut la = Args::parse(words);
        let Some(cmd) = la.pos.first().cloned() else { continue };
        if matches!(cmd.as_str(), "script" | "new" | "help" | "watch") {
            return Err(u(format!("line {n}: `{cmd}` cannot run inside a script")));
        }
        if let Some((k, _)) = la.opts.iter().find(|(k, _)| OUTER_ONLY.contains(&k.as_str())) {
            return Err(u(format!("line {n}: --{k} belongs to the whole script: `synkopa --{k} … script FILE`")));
        }
        // on a file, where the project is written is decided once, after the script: a copy made here would be dropped
        if cx.doc.is_some() && cmd == "save" && la.has("path") {
            return Err(u(format!(
                "line {n}: `save --path` cannot write a copy from a script; use `synkopa --project … --save-as FILE script …`"
            )));
        }
        if let Some(s) = a.get("session") {
            la.opts.push(("session".into(), Some(s.into())));
        }
        if a.has("dry-run") {
            la.opts.push(("dry-run".into(), None));
        }
        match run(cx, &cmd, &la) {
            Ok(v) => results.push(json!({ "line": n, "command": cmd, "result": v })),
            Err(e) => {
                let done = if cx.doc.is_some() {
                    "nothing was saved".to_string()
                } else if results.is_empty() {
                    "nothing was changed".to_string()
                } else {
                    format!(
                        "the {} command(s) before it were applied to the open project (each is one undo step in the app)",
                        results.len()
                    )
                };
                let at = |m: String| format!("line {n} (`{cmd}`): {m}; {done}");
                return Err(match e {
                    Fail::Usage(m) => Fail::Usage(at(m)),
                    Fail::Conn(m) => Fail::Conn(at(m)),
                    Fail::App(m) => Fail::App(at(m)),
                });
            }
        }
    }
    Ok(results)
}

/// `12` → 12, `kick` → "kick".
fn id_or_name(s: &str) -> Value {
    s.parse::<u64>().map(|n| json!(n)).unwrap_or_else(|_| json!(s))
}

/// A stamp root: a MIDI key (`57`) or a note name with octave (`A3`, `C#4`, `Bb2` —
/// C4 = 60). Returns the MIDI key.
fn parse_root(s: &str) -> Result<u64, String> {
    let t = s.trim();
    if let Ok(n) = t.parse::<u64>() {
        return if n <= 127 { Ok(n) } else { Err(format!("--root {n} is outside 0..127")) };
    }
    let bad = || format!("--root `{s}` is not a MIDI key or note name (A3, C#4)");
    // char-aware split: the octave is the last character, so a multi-byte accidental
    // without an octave (`C♭`) errors out instead of splitting inside a character
    let chars: Vec<char> = t.chars().collect();
    let (oct_char, name_chars) = chars.split_last().ok_or_else(bad)?;
    let oct = oct_char.to_digit(10).ok_or_else(bad)? as i64;
    let (letter, acc): (char, i64) = match name_chars {
        [l] => (*l, 0),
        [l, '#'] => (*l, 1),
        [l, 'b'] | [l, '♭'] => (*l, -1),
        _ => return Err(bad()),
    };
    let base = match letter.to_ascii_uppercase() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return Err(bad()),
    };
    let midi = 12 * (oct + 1) + base + acc;
    if !(0..=127).contains(&midi) {
        return Err(format!("--root {s} is outside 0..127"));
    }
    Ok(midi as u64)
}

#[cfg(test)]
mod root_tests {
    #[test]
    fn parse_root_takes_midi_and_note_names() {
        assert_eq!(super::parse_root("57").unwrap(), 57);
        assert_eq!(super::parse_root("60").unwrap(), 60);
        assert_eq!(super::parse_root("A3").unwrap(), 57);
        assert_eq!(super::parse_root("c4").unwrap(), 60);
        assert_eq!(super::parse_root("C#4").unwrap(), 61);
        assert_eq!(super::parse_root("bb2").unwrap(), 46);
        assert_eq!(super::parse_root("B3").unwrap(), 59);
        assert!(super::parse_root("H4").is_err());
        assert!(super::parse_root("A").is_err());
        assert!(super::parse_root("128").is_err());
        assert!(super::parse_root("C♭").is_err()); // multi-byte accidental, no octave
    }
}

fn run(cx: &Cx, cmd: &str, a: &Args) -> Result<Value, Fail> {
    let u = Fail::Usage;
    match cmd {
        "sessions" => Ok(json!(ws::sessions()
            .into_iter()
            .map(|e| json!({"sessionId": e.session_id, "pid": e.pid, "project": e.project}))
            .collect::<Vec<_>>())),
        "status" | "catalog" | "schema" | "undo" | "redo" | "stop" => send(cx, a, cmd, json!({})),
        "context" => send(cx, a, "context", json!({"full": a.has("full")})),
        "analyze" => send(
            cx,
            a,
            "music_analyze",
            json!({"clipId": a.num("clip").map_err(u)?.map(|v| v as u64), "excludeFx": a.num("exclude-fx").map_err(u)?.map(|v| v as u64)}),
        ),
        "apply" => {
            let text = match (a.get("file"), a.get("json")) {
                (Some(f), _) => std::fs::read_to_string(f).map_err(|e| u(format!("{f}: {e}")))?,
                (None, Some(j)) => j.to_string(),
                _ => return Err(u("apply needs --file ops.json or --json '[...]'".into())),
            };
            let v: Value = serde_json::from_str(&text).map_err(|e| u(format!("ops are not valid JSON: {e}")))?;
            let ops = match v {
                Value::Array(_) => v,
                Value::Object(ref m) if m.contains_key("ops") => m["ops"].clone(),
                Value::Object(_) => json!([v]),
                _ => return Err(u("ops must be an array of op objects".into())),
            };
            send(cx, a, "apply", json!({"ops": ops}))
        }
        "bpm" => {
            let v: f64 = a.pos.get(1).and_then(|s| s.parse().ok()).ok_or_else(|| u("bpm <value>".into()))?;
            send(cx, a, "apply", json!({"ops": [{"op": "setBpm", "bpm": v}]}))
        }
        "add-fx" => send(
            cx,
            a,
            "add_fx",
            json!({"insertId": a.num("insert").map_err(u)?.ok_or_else(|| u("missing --insert".into()))? as u64, "type": a.need("type").map_err(u)?, "preset": a.num("preset").map_err(u)?}),
        ),
        "route" => send(
            cx,
            a,
            "route",
            json!({
                "from": a.num("from").map_err(u)?.ok_or_else(|| u("missing --from".into()))? as u64,
                "to": a.num("to").map_err(u)?.ok_or_else(|| u("missing --to".into()))? as u64,
                "gain": a.num("gain").map_err(u)?,
                "only": a.has("only"),
            }),
        ),
        "sidechain" => send(
            cx,
            a,
            "sidechain",
            json!({
                "fxId": a.num("fx").map_err(u)?.map(|x| x as u64),
                "from": a.num("from").map_err(u)?.map(|x| x as u64),
                "to": a.num("to").map_err(u)?.map(|x| x as u64),
                "off": a.has("off"),
            }),
        ),
        "unroute" => send(
            cx,
            a,
            "unroute",
            json!({
                "from": a.num("from").map_err(u)?.ok_or_else(|| u("missing --from".into()))? as u64,
                "to": a.num("to").map_err(u)?.ok_or_else(|| u("missing --to".into()))? as u64,
            }),
        ),
        "set-param" => send(
            cx,
            a,
            "set_param",
            json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64, "param": a.need("param").map_err(u)?, "value": a.num("value").map_err(u)?.ok_or_else(|| u("missing --value".into()))?}),
        ),
        "preset" => send(
            cx,
            a,
            "load_preset",
            json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64, "index": a.num("index").map_err(u)?.ok_or_else(|| u("missing --index".into()))? as u64}),
        ),
        "import" => {
            let files: Vec<String> = a.pos[1..]
                .iter()
                .map(|p| std::fs::canonicalize(p).map(|x| x.display().to_string()).unwrap_or_else(|_| p.clone()))
                .collect();
            if files.is_empty() {
                return Err(u("import <file>...".into()));
            }
            send(cx, a, "import", json!({"paths": files, "track": a.num("track").map_err(u)?, "beat": a.num("beat").map_err(u)?}))
        }
        "channels" => {
            let mut args = json!({});
            if let Some(k) = a.get("add") {
                args["add"] = json!(k);
            }
            if let Some(s) = a.num("sample").map_err(u)? {
                args["sample"] = json!(s as u64);
            }
            if let Some(r) = a.get("remove") {
                args["remove"] = id_or_name(r);
            }
            if a.has("keys") {
                args["keys"] = json!(true);
            }
            if a.has("musicbox") {
                args["musicbox"] = json!(true);
            }
            if a.has("synth") {
                args["synth"] = json!(a.get("synth").unwrap_or(""));
            }
            if let Some(v) = a.get("plugin") {
                args["plugin"] = json!(v);
            }
            if let Some(c) = a.get("ch") {
                args["ch"] = id_or_name(c);
            }
            if a.has("group") {
                args["group"] = json!(a.get("group").unwrap_or(""));
            }
            for k in ["preset", "param", "instrument", "articulation"] {
                if let Some(v) = a.get(k) {
                    args[k] = json!(v);
                }
            }
            if let Some(v) = a.num("value").map_err(u)? {
                args["value"] = json!(v);
            }
            send(cx, a, "channels", args)
        }
        "markers" => {
            let mut args = json!({});
            for k in ["add", "name"] {
                if let Some(v) = a.get(k) {
                    args[k] = json!(v);
                }
            }
            for k in ["marker", "remove", "loop"] {
                if let Some(v) = a.get(k) {
                    args[k] = id_or_name(v);
                }
            }
            for k in ["at", "bar"] {
                if let Some(v) = a.num(k).map_err(u)? {
                    args[k] = json!(v);
                }
            }
            send(cx, a, "markers", args)
        }
        "pattern" => {
            if a.has("play") || a.has("stop") {
                let id =
                    if a.has("stop") { None } else { Some(a.num("id").map_err(u)?.ok_or_else(|| u("--play needs --id".into()))? as u64) };
                let mut args = json!({ "id": id });
                if let Some(b) = a.num("from").map_err(u)? {
                    args["from"] = json!(b);
                }
                if let Some(v) = a.get("loop") {
                    let r = v
                        .split_once(':')
                        .and_then(|(x, y)| Some((x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?)))
                        .filter(|(x, y)| x.is_finite() && y.is_finite())
                        .ok_or_else(|| u(format!("--loop wants A:B in beats, not `{v}`")))?;
                    args["range"] = json!([r.0, r.1]);
                }
                return send(cx, a, "pattern_play", args);
            }
            let mut args = json!({ "new": a.has("new"), "clear": a.has("clear") });
            if let Some(id) = a.num("id").map_err(u)? {
                args["id"] = json!(id as u64);
            }
            for k in ["name", "color", "steps"] {
                if let Some(v) = a.get(k) {
                    args[k] = json!(v);
                }
            }
            for k in ["bars", "swing", "vel"] {
                if let Some(v) = a.num(k).map_err(u)? {
                    args[k] = json!(v);
                }
            }
            if let Some(c) = a.get("ch") {
                args["ch"] = id_or_name(c);
            }
            if let Some(n) = a.get("notes") {
                args["notes"] = serde_json::from_str(n).map_err(|e| u(format!("--notes is not JSON: {e}")))?;
            }
            send(cx, a, "pattern", args)
        }
        "missing" => send(cx, a, "missing", json!({})),
        "relink" => {
            // not `canonicalize`: on Windows it yields a `\\?\C:\…` path, which a save then cannot make
            // relative to the project folder
            let abs = |p: &str| std::path::absolute(p).map(|x| x.display().to_string()).unwrap_or_else(|_| p.to_string());
            match (a.get("folder"), a.num("source").map_err(u)?, a.get("path")) {
                (Some(f), None, None) => send(cx, a, "relink", json!({ "folder": abs(f) })),
                (None, Some(id), Some(p)) => send(cx, a, "relink", json!({ "sourceId": id as u64, "path": abs(p) })),
                _ => Err(u("relink --folder DIR | --source ID --path FILE".into())),
            }
        }
        "make-unique" => {
            let ids = a
                .need("clip")
                .map_err(u)?
                .split(',')
                .map(|x| x.trim().parse::<u64>().map_err(|_| u(format!("--clip takes clip ids separated by commas, got {x}"))))
                .collect::<Result<Vec<_>, _>>()?;
            send(cx, a, "make_unique", json!({ "clipIds": ids }))
        }
        "export-in-place" => {
            let mut args = json!({});
            if let Some(c) = a.get("clip") {
                let ids = c
                    .split(',')
                    .map(|x| x.trim().parse::<u64>().map_err(|_| u(format!("--clip takes clip ids separated by commas, got {x}"))))
                    .collect::<Result<Vec<_>, _>>()?;
                args["clipIds"] = json!(ids);
            }
            match (a.num("from").map_err(u)?, a.num("to").map_err(u)?) {
                (Some(f), Some(t)) => {
                    args["fromBeat"] = json!(f);
                    args["toBeat"] = json!(t);
                }
                (None, None) if a.has("clip") => {}
                (None, None) => return Err(u("export-in-place needs --clip, or --from and --to".into())),
                _ => return Err(u("--from and --to go together".into())),
            }
            send(cx, a, "export_in_place", args)
        }
        "chords" if a.has("install") => {
            eprintln!("downloading the ChordMini chord model (~17 MB; MIT licence)");
            send(cx, a, "chords_model_install", json!({}))
        }
        "chords" => match a.num("clip").map_err(u)? {
            Some(clip) => {
                let detail = if a.has("simple") { "simple" } else { "full" };
                if a.has("to-pattern") {
                    let channel = a.num("channel").map_err(u)?.map(|v| v as u64);
                    send(
                        cx,
                        a,
                        "chords_to_pattern",
                        json!({ "clipId": clip as u64, "detail": detail, "from": a.num("from").map_err(u)?, "to": a.num("to").map_err(u)?, "channel": channel }),
                    )
                } else {
                    send(cx, a, "chords_analyze", json!({ "clipId": clip as u64, "detail": detail }))
                }
            }
            None => send(cx, a, "chords_model", json!({})),
        },
        "stems" if a.has("install") => {
            eprintln!("downloading the HTDemucs stem model (~90 MB; MIT licence)");
            send(cx, a, "stems_model_install", json!({}))
        }
        "stems" => match a.num("clip").map_err(u)? {
            Some(clip) => {
                let stems: Option<Vec<&str>> = a.get("only").map(|s| s.split(',').map(str::trim).filter(|x| !x.is_empty()).collect());
                eprintln!("separating clip {} (this takes a while: about 25 s per minute of audio)", clip as u64);
                send(cx, a, "extract_stems", json!({ "clipId": clip as u64, "stems": stems }))
            }
            None => send(cx, a, "stems_model", json!({})),
        },
        "takes" => send(cx, a, "takes", json!({"track": a.num("track").map_err(u)?.ok_or_else(|| u("missing --track".into()))? as u64})),
        "comp" => {
            let mut args =
                json!({"track": a.num("track").map_err(u)?.map(|v| v as u64), "clip": a.num("clip").map_err(u)?.map(|v| v as u64)});
            if args["track"].is_null() && args["clip"].is_null() {
                return Err(u("comp needs --track N (or --clip ID)".into()));
            }
            if a.has("flatten") {
                return send(cx, a, "flatten_comp", args);
            }
            if a.has("audition") {
                let v = a.need("audition").map_err(u)?;
                args["take"] = if v == "off" {
                    Value::Null
                } else {
                    json!(v.parse::<u64>().map_err(|_| u(format!("--audition takes a take id or `off`, got {v}")))?)
                };
                return send(cx, a, "comp_audition", args);
            }
            if let Some(s) = a.get("set") {
                args["regions"] = serde_json::from_str(s).map_err(|e| u(format!("--set is not JSON: {e}")))?;
            }
            if let Some(t) = a.num("take").map_err(u)? {
                args["take"] = json!(t as u64);
            }
            if let Some(x) = a.num("xfade").map_err(u)? {
                args["xfadeMs"] = json!(x);
            }
            if a.has("remove-unused") {
                args["removeUnused"] = json!(true);
            }
            send(cx, a, "comp", args)
        }
        "play" => send(cx, a, "play", json!({"from": a.num("from").map_err(u)?})),
        "render" => {
            let out = a.need("out").map_err(u)?;
            let out = std::path::absolute(out).map(|p| p.display().to_string()).unwrap_or_else(|_| out.to_string());
            let wav_bits = if a.has("wav-bits") {
                let bits = a.need("wav-bits").map_err(u)?;
                Some(match bits {
                    "16" => 16,
                    "24" => 24,
                    "32" => 32,
                    _ => return Err(u("--wav-bits must be 16, 24 or 32".into())),
                })
            } else {
                None
            };
            send(
                cx,
                a,
                "render",
                json!({
                    "out": out,
                    "from": a.num("from").map_err(u)?, "to": a.num("to").map_err(u)?,
                    "tail": a.num("tail").map_err(u)?, "rate": a.num("rate").map_err(u)?,
                    "format": a.get("format"), "mp3Kbps": a.num("kbps").map_err(u)?,
                    "wavBits": wav_bits, "dither": a.has("dither"), "wrapTail": a.has("wrap-tail"),
                    "stems": a.has("stems"), "master": !a.has("no-master"),
                    "pattern": a.num("pattern").map_err(u)?,
                }),
            )
        }
        "export-project" => {
            if a.has("dry-run") {
                return Err(u("export-project writes a ZIP; omit --dry-run".into()));
            }
            let out = std::path::absolute(a.need("out").map_err(u)?).map_err(|e| u(e.to_string()))?;
            send(cx, a, "export_project_zip", json!({ "out": out.display().to_string() }))
        }
        // in file mode the project is saved after the command (see `on_file`)
        "save" if cx.doc.is_some() => Ok(json!({})),
        "save" => send(
            cx,
            a,
            "save",
            json!({"path": a.get("path").map(|p| std::path::absolute(p).map(|x| x.display().to_string()).unwrap_or_else(|_| p.to_string()))}),
        ),
        "open" => {
            let p = a.pos.get(1).ok_or_else(|| u("open <file>".into()))?;
            send(cx, a, "open", json!({"path": std::path::absolute(p).map(|x| x.display().to_string()).unwrap_or_else(|_| p.clone())}))
        }
        "plugins" => send(cx, a, "plugin_scan", json!({"rescan": a.has("rescan")})),
        "plugin-add" => send(
            cx,
            a,
            "plugin_add",
            json!({"insertId": a.num("insert").map_err(u)?.ok_or_else(|| u("missing --insert".into()))? as u64, "format": a.get("format"), "path": a.get("path"), "cid": a.need("cid").map_err(u)?}),
        ),
        "plugin-params" => send(
            cx,
            a,
            "plugin_params",
            json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64, "query": a.get("query")}),
        ),
        "plugin-set" => send(
            cx,
            a,
            "plugin_set_param",
            json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64, "id": a.num("id").map_err(u)?.ok_or_else(|| u("missing --id".into()))? as u64, "value": a.num("value").map_err(u)?.ok_or_else(|| u("missing --value".into()))?}),
        ),
        "plugin-load-anyway" => {
            send(cx, a, "plugin_load_anyway", json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64}))
        }
        "vst3" => send(cx, a, "vst3_scan", json!({"rescan": a.has("rescan")})),
        "vst3-add" => send(
            cx,
            a,
            "vst3_add",
            json!({"insertId": a.num("insert").map_err(u)?.ok_or_else(|| u("missing --insert".into()))? as u64, "path": a.need("path").map_err(u)?, "cid": a.need("cid").map_err(u)?}),
        ),
        "vst3-params" => send(
            cx,
            a,
            "vst3_params",
            json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64, "query": a.get("query")}),
        ),
        "vst3-set" => send(
            cx,
            a,
            "vst3_set_param",
            json!({"fxId": a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64, "id": a.num("id").map_err(u)?.ok_or_else(|| u("missing --id".into()))? as u64, "value": a.num("value").map_err(u)?.ok_or_else(|| u("missing --value".into()))?}),
        ),
        "auto-add" => {
            // an automation envelope (a hosted plugin parameter by default, `--target` for the
            // rest), plus the playlist clip that plays it
            let target = match a.get("target") {
                None | Some("plugin") => {
                    let fx = a.num("fx").map_err(u)?.ok_or_else(|| u("missing --fx".into()))? as u64;
                    let param = a.num("param").map_err(u)?.ok_or_else(|| u("missing --param".into()))? as u64;
                    json!({"kind": "plugin", "fxId": fx, "paramId": param})
                }
                Some("mix") => {
                    let fx = a.num("fx").map_err(u)?.ok_or_else(|| u("--target mix needs --fx".into()))? as u64;
                    json!({"kind": "mix", "fxId": fx})
                }
                Some(kind @ ("insertVol" | "insertPan" | "trackVol" | "chanVol" | "chanPan")) => {
                    let id = a.num("id").map_err(u)?.ok_or_else(|| u(format!("--target {kind} needs --id")))? as u64;
                    json!({"kind": kind, "id": id})
                }
                Some(other) => {
                    return Err(u(format!("unknown --target `{other}` (plugin, mix, insertVol, insertPan, trackVol, chanVol, chanPan)")))
                }
            };
            let mut points: Vec<Value> = vec![];
            if let Some(p) = a.get("points") {
                for pair in p.split(',') {
                    let (t, v) = pair.split_once(':').ok_or_else(|| u("--points is t:v pairs, e.g. 0:0.2,4:0.8".into()))?;
                    let t: f64 = t.trim().parse().map_err(|_| u(format!("bad time `{t}`")))?;
                    let v: f64 = v.trim().parse().map_err(|_| u(format!("bad value `{v}`")))?;
                    if !(0.0..=1.0).contains(&v) {
                        return Err(u(format!("value {v} outside 0..1")));
                    }
                    points.push(json!({"t": t, "v": v}));
                }
            } else {
                let v = a.num("value").map_err(u)?.ok_or_else(|| u("needs --points \"t:v,...\" or --value 0..1".into()))?;
                if !(0.0..=1.0).contains(&v) {
                    return Err(u(format!("value {v} outside 0..1")));
                }
                points.push(json!({"t": 0.0, "v": v}));
            }
            let ctx = send(cx, a, "context", json!({}))?;
            let next = ctx.get("nextId").and_then(Value::as_u64).ok_or_else(|| u("no nextId in context".into()))?;
            let (auto_id, clip_id) = (next, next + 1);
            let track = a.num("track").map_err(u)?.unwrap_or(0.0) as u64;
            let name = a.get("name").unwrap_or("Automation").to_string();
            let len = points.iter().filter_map(|p| p["t"].as_f64()).fold(1.0, f64::max) + 1.0;
            send(
                cx,
                a,
                "apply",
                json!({"ops": [
                    {"op": "putAutomation", "automation": {"id": auto_id, "name": name, "color": "#e0a44a", "target": target, "points": points}},
                    {"op": "putClips", "clips": [{"id": clip_id, "track": track, "start": 0.0, "len": len, "offset": 0.0, "kind": "auto", "ref": auto_id, "muted": false, "gain": 0.0, "fadeIn": 0.0, "fadeOut": 0.0, "pan": 0.0, "norm": false, "rev": false}]}
                ]}),
            )
        }
        "notes" => {
            let verb = a
                .pos
                .get(1)
                .ok_or_else(|| u("notes <humanize|quantize|euclid|strum|chop|glue|arp|drums|melody|chord|progression|stamp> …".into()))?
                .clone();
            let pattern = a.num("pattern").map_err(u)?.ok_or_else(|| u("missing --pattern".into()))? as u64;
            let f = |k: &str| a.num(k);
            if verb == "stamp" {
                // one chord through the app's `pattern` command (the existing note op):
                // replaces the notes at that step on the channel, prints notes + label
                let root = a.get("root").ok_or_else(|| u("missing --root (MIDI key or note name like A3)".into()))?;
                let st = json!({
                    "step": f("step").map_err(u)?.ok_or_else(|| u("missing --step (16ths)".into()))?,
                    "root": parse_root(root).map_err(u)?,
                    "type": a.need("type").map_err(u)?,
                    "inv": f("inv").map_err(u)?.unwrap_or(0.0),
                    "len": f("len").map_err(u)?.unwrap_or(4.0),
                });
                return send(cx, a, "pattern", json!({"id": pattern, "ch": id_or_name(a.need("ch").map_err(u)?), "stamp": st}));
            }
            let (verb_json, needs_ch) = match verb.as_str() {
                "humanize" => (
                    json!({"kind": "humanize", "timing": f("timing").map_err(u)?.unwrap_or(0.5), "velocity": f("velocity").map_err(u)?.unwrap_or(0.4)}),
                    false,
                ),
                "quantize" => (
                    json!({"kind": "quantize", "grid": f("grid").map_err(u)?.unwrap_or(1.0), "amount": f("amount").map_err(u)?.unwrap_or(1.0), "scaleAware": a.has("scale")}),
                    false,
                ),
                "euclid" => (
                    json!({"kind": "euclidFill", "ch": f("ch").map_err(u)?.ok_or_else(|| u("missing --ch".into()))? as u64, "k": f("k").map_err(u)?.ok_or_else(|| u("missing --k".into()))? as u32, "n": f("n").map_err(u)?.ok_or_else(|| u("missing --n".into()))? as u32, "rotate": f("rotate").map_err(u)?.unwrap_or(0.0) as i32, "vel": f("vel").map_err(u)?.unwrap_or(0.7)}),
                    true,
                ),
                "strum" => (
                    json!({"kind": "strum", "width": f("width").map_err(u)?.unwrap_or(0.5), "ramp": f("ramp").map_err(u)?.unwrap_or(0.05)}),
                    false,
                ),
                "chop" => (json!({"kind": "chop", "len": f("len").map_err(u)?.unwrap_or(1.0)}), false),
                "glue" => (json!({"kind": "glue"}), false),
                "arp" => (
                    json!({"kind": "arpeggiate", "mode": a.get("mode").unwrap_or("up"), "rate": f("rate").map_err(u)?.unwrap_or(1.0), "gate": f("gate").map_err(u)?.unwrap_or(0.9), "octaves": f("octaves").map_err(u)?.unwrap_or(1.0) as u32}),
                    false,
                ),
                "chord" => {
                    let ty = a.get("type").map(str::to_owned).unwrap_or_else(|| "diatonic".into());
                    let harmony = match ty.as_str() {
                        "major" => "maj".to_string(),
                        "minor" => "min".to_string(),
                        t => t.to_string(),
                    };
                    (json!({"kind": "chord", "harmony": harmony}), false)
                }
                "progression" => {
                    let mut v = json!({
                        "kind": "progression",
                        "ch": f("ch").map_err(u)?.ok_or_else(|| u("missing --ch (the channel the chords go to)".into()))? as u64,
                        "bars": f("bars").map_err(u)?.unwrap_or(4.0) as u32,
                        "template": a.get("template").map(str::to_owned).unwrap_or_else(|| "pop".into()),
                        "voiceLead": !a.has("no-voice-lead"),
                    });
                    if let Some(d) = a.get("degrees") {
                        let list: Result<Vec<u64>, _> = d.split(':').map(|x| x.trim().parse::<u64>()).collect();
                        v["degrees"] = json!(list.map_err(|_| u("--degrees is a colon list of scale degrees, e.g. \"0:5:2:6\"".into()))?);
                    }
                    (v, true)
                }
                "drums" => {
                    let mut voices = vec![];
                    for (i, v) in a.get_all("voice").iter().enumerate() {
                        let parts: Vec<&str> = v.split(':').collect();
                        if parts.len() < 3 {
                            return Err(u(format!("--voice is CH:K:N[:ROT[:VEL]] (voice {i})")));
                        }
                        let num = |i: usize, name: &str| match parts.get(i) {
                            // absent → the caller's default; present-but-malformed → an error
                            Some(x) => {
                                x.trim().parse::<f64>().map(Some).map_err(|_| u(format!("--voice {i}: bad number `{x}` for {name}")))
                            }
                            None => Ok(None),
                        };
                        voices.push(json!({"ch": num(0, "CH")?.ok_or_else(|| u(format!("--voice {i}: missing CH")))? as u64,
                            "k": num(1, "K")?.ok_or_else(|| u(format!("--voice {i}: missing K")))? as u32,
                            "n": num(2, "N")?.ok_or_else(|| u(format!("--voice {i}: missing N")))? as u32,
                            "rotate": num(3, "ROT")?.unwrap_or(0.0) as i32, "vel": num(4, "VEL")?.unwrap_or(0.7)}));
                    }
                    if voices.is_empty() {
                        return Err(u("drums needs at least one --voice CH:K:N".into()));
                    }
                    (json!({"kind": "euclidDrums", "voices": voices, "bars": f("bars").map_err(u)?.unwrap_or(2.0) as u32}), false)
                }
                "melody" => (
                    json!({"kind": "melody", "ch": f("ch").map_err(u)?.ok_or_else(|| u("missing --ch".into()))? as u64, "bars": f("bars").map_err(u)?.unwrap_or(2.0) as u32, "density": f("density").map_err(u)?.unwrap_or(0.5), "repeat": f("repeat").map_err(u)?.unwrap_or(1.0) as u32}),
                    true,
                ),
                other => {
                    return Err(u(format!(
                        "unknown notes verb `{other}` (humanize|quantize|euclid|strum|chop|glue|arp|drums|melody|chord|progression|stamp)"
                    )))
                }
            };
            if needs_ch {
                // a channel id here is the Channel Rack channel: accepted as-is, validated by the engine
            }
            let mut op = json!({"op": "transformNotes", "pattern": pattern, "verb": verb_json});
            if let Some(seed) = a.get("seed") {
                // the op seed is u64: parse it directly, an f64 round-trip loses bits above 2^53
                let s = seed.trim().parse::<u64>().map_err(|_| u(format!("--seed must be an unsigned integer, got `{seed}`")))?;
                op["seed"] = json!(s);
            }
            if let Some(sel) = a.get("select") {
                let (from, rest) = sel.split_once(':').ok_or_else(|| u("--select is FROM:TO[@CH]".into()))?;
                let (to, ch) = rest.split_once('@').map_or((rest, None), |(t, c)| (t, Some(c)));
                let pf = |x: &str| x.trim().parse::<f64>().map_err(|_| u(format!("--select: bad number `{x}`")));
                let mut node = json!({"kind": "range", "from": pf(from)?, "to": pf(to)?});
                if let Some(c) = ch {
                    node["ch"] = json!(c.trim().parse::<u64>().map_err(|_| u(format!("--select: bad channel `{c}`")))?);
                }
                op["select"] = node;
            } else if let Some(ix) = a.get("indices") {
                let list: Result<Vec<u64>, _> = ix.split(',').map(|x| x.trim().parse::<u64>()).collect();
                op["select"] =
                    json!({"kind": "indices", "indices": list.map_err(|_| u("--indices is a comma list of note indices".into()))?});
            }
            send(cx, a, "apply", json!({"ops": [op]}))
        }
        "key" => {
            if a.has("off") {
                return send(cx, a, "apply", json!({"ops": [{"op": "setKey", "key": null, "scale": 1}]}));
            }
            let note_names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
            let scales = ["chromatic", "major", "minor", "major pentatonic", "minor pentatonic"];
            let note = a.pos.get(1).ok_or_else(|| u("key <NOTE> [SCALE] | key --off  (e.g. key C minor)".into()))?;
            let key_id =
                note_names.iter().position(|n| n.eq_ignore_ascii_case(note)).ok_or_else(|| u(format!("unknown note `{note}` (C…B)")))?
                    as u64;
            let scale = a
                .pos
                .get(2)
                .map(|sc| {
                    scales
                        .iter()
                        .position(|n| n.eq_ignore_ascii_case(sc))
                        .map(|i| i as u64)
                        .ok_or_else(|| u(format!("unknown scale `{sc}` ({} )", scales.join(", "))))
                })
                .transpose()?;
            send(cx, a, "apply", json!({"ops": [{"op": "setKey", "key": key_id, "scale": scale.unwrap_or(1)}]}))
        }
        "call" => {
            let c = a.pos.get(1).ok_or_else(|| u("call <command> [--args JSON]".into()))?;
            let args = match a.get("args") {
                Some(t) => serde_json::from_str(t).map_err(|e| u(format!("--args is not JSON: {e}")))?,
                None => json!({}),
            };
            send(cx, a, c, args)
        }
        "pitch-target" => send(
            cx,
            a,
            "pitch_target",
            json!({"clipId": a.num("clip").map_err(u)?.ok_or_else(|| u("missing --clip".into()))? as u64, "full": a.has("full")}),
        ),
        "tune-ref" => {
            let mut args =
                json!({"clipId": a.num("clip").map_err(u)?.ok_or_else(|| u("missing --clip".into()))? as u64, "off": a.has("off")});
            for k in ["reference", "correction", "vibrato", "influence", "key", "scale", "speed"] {
                if let Some(v) = a.num(k).map_err(u)? {
                    args[k] = json!(v);
                }
            }
            if let Some(v) = a.num("melody").map_err(u)? {
                args["melodyChannel"] = json!(v);
            }
            match a.get("octave") {
                Some("auto") => args["octave"] = json!("auto"),
                Some(o) => args["octave"] = json!(o.parse::<i64>().map_err(|_| u("--octave is auto or semitones (-12, 0, 12…)".into()))?),
                None => {}
            }
            send(cx, a, "tune_ref", args)
        }
        "melody-channels" => {
            send(cx, a, "melody_channels", json!({"clipId": a.num("clip").map_err(u)?.ok_or_else(|| u("missing --clip".into()))? as u64}))
        }
        "auto-vocal" => {
            let (command, args) = auto_vocal_args(a)?;
            send(cx, a, command, args)
        }
        "f0-model" if a.has("install") => send(cx, a, "f0_model_install", json!({})),
        "f0-model" => send(cx, a, "f0_model", json!({})),
        "pitch" => pitch(cx, a),
        "midi" => midi(cx, a),
        "fxchain" => fxchain(cx, a),
        "tune-file" => tune_file(a),
        "script" => script(cx, a),
        "new" => Err(u("`new` creates a file; run it on its own, without --project".into())),
        other => Err(u(format!("unknown command `{other}`"))),
    }
}

/// `synkopa fxchain list|save|load|rename|delete`: FX chain presets in the user's library.
fn fxchain(cx: &Cx, a: &Args) -> Result<Value, Fail> {
    let u = Fail::Usage;
    let name = || a.pos.get(2).cloned().ok_or_else(|| u("fxchain save|load|rename|delete NAME (quote a name with spaces)".into()));
    let insert = || a.num("insert").map_err(u)?.map(|v| v as u64).ok_or_else(|| u("--insert ID (see `context`: inserts)".into()));
    match a.pos.get(1).map(String::as_str) {
        Some("list") | None => send(cx, a, "fx_chains", json!({})),
        Some("save") => send(cx, a, "fx_chain_save", json!({ "name": name()?, "insert": insert()?, "overwrite": a.has("force") })),
        Some("load") => {
            let mode = a.get("mode");
            if mode.is_some_and(|m| m != "replace" && m != "append") {
                return Err(u("--mode replace|append".into()));
            }
            send(cx, a, "fx_chain_load", json!({ "name": name()?, "insert": insert()?, "mode": mode }))
        }
        Some("rename") => {
            let to = a.get("to").ok_or_else(|| u("fxchain rename NAME --to NEW".into()))?;
            send(cx, a, "fx_chain_rename", json!({ "name": name()?, "to": to }))
        }
        Some("delete") => send(cx, a, "fx_chain_delete", json!({ "name": name()? })),
        _ => Err(u("fxchain list|save|load|rename|delete (see `synkopa help`)".into())),
    }
}

/// `synkopa midi inspect|import|export`: standard MIDI files.
fn midi(cx: &Cx, a: &Args) -> Result<Value, Fail> {
    let u = Fail::Usage;
    let abs = |p: &str| std::fs::canonicalize(p).map(|x| x.display().to_string()).unwrap_or_else(|_| p.to_string());
    let file = || a.pos.get(2).map(|p| abs(p)).ok_or_else(|| u("midi inspect|import FILE".into()));
    match a.pos.get(1).map(String::as_str) {
        Some("inspect") => send(cx, a, "midi_inspect", json!({ "path": file()? })),
        Some("import") => {
            let mut args = json!({ "path": file()?, "setTempo": a.has("tempo") });
            if let Some(list) = a.get("parts") {
                let ix: Result<Vec<u64>, _> = list.split(',').map(|s| s.trim().parse::<u64>()).collect();
                args["parts"] = json!(ix.map_err(|_| u("--parts takes part indices, e.g. 0,2 (see `midi inspect`)".into()))?);
            }
            if let Some(b) = a.num("beat").map_err(u)? {
                args["beat"] = json!(b);
            }
            if let Some(t) = a.num("track").map_err(u)? {
                args["track"] = json!(t);
            }
            if let Some(pat) = a.num("pattern").map_err(u)? {
                let ch = a.num("ch").map_err(u)?.ok_or_else(|| u("--pattern needs --ch".into()))?;
                args["into"] = json!({ "pattern": pat as u64, "ch": ch as u64, "replace": a.has("replace") });
            }
            send(cx, a, "midi_import", args)
        }
        Some("export") => {
            let out = a.get("out").ok_or_else(|| u("midi export --out FILE.mid [--pattern P]".into()))?;
            let out = std::path::absolute(out).map(|p| p.display().to_string()).unwrap_or_else(|_| out.to_string());
            let mut args = json!({ "out": out });
            if let Some(p) = a.num("pattern").map_err(u)? {
                args["pattern"] = json!(p as u64);
            }
            send(cx, a, "midi_export", args)
        }
        _ => Err(u("midi inspect|import|export (see `synkopa help`)".into())),
    }
}

/// `synkopa pitch inspect|compare|suggest|edit|render`: the pitch editor for scripts and agents.
fn pitch(cx: &Cx, a: &Args) -> Result<Value, Fail> {
    let u = Fail::Usage;
    let verb = a.pos.get(1).map(String::as_str).ok_or_else(|| u("pitch inspect|compare|suggest|edit|render --clip ID …".into()))?;
    let clip = a.num("clip").map_err(u)?.ok_or_else(|| u("missing --clip".into()))? as u64;
    let mut args = json!({ "clipId": clip });
    let num_into = |args: &mut Value, flag: &str, key: &str| -> Result<(), Fail> {
        if let Some(v) = a.num(flag).map_err(u)? {
            args[key] = json!(v);
        }
        Ok(())
    };
    let reference = |args: &mut Value| -> Result<(), Fail> {
        num_into(args, "source", "source")?;
        num_into(args, "ref-clip", "referenceClip")
    };
    match verb {
        "inspect" => {
            args["full"] = json!(a.has("full"));
            args["all"] = json!(a.has("all"));
            num_into(&mut args, "from", "from")?;
            num_into(&mut args, "to", "to")?;
            send(cx, a, "pitch_inspect", args)
        }
        "compare" => {
            reference(&mut args)?;
            if args.get("source").is_none() && args.get("referenceClip").is_none() {
                return Err(u("pitch compare needs --source ID (the reference's source) or --ref-clip ID".into()));
            }
            send(cx, a, "pitch_compare", args)
        }
        "suggest" => {
            reference(&mut args)?;
            for (f, k) in [("min-cents", "minCents"), ("max-cents", "maxCents"), ("strength", "strength"), ("tuning", "tuning")] {
                num_into(&mut args, f, k)?;
            }
            if let Some(k) = a.get("key") {
                args["key"] = json!(k);
            }
            if let Some(sc) = a.get("scale") {
                args["scale"] = json!(sc);
            }
            send(cx, a, "pitch_suggest", args)
        }
        "edit" => pitch_edit_args(a, clip, args).and_then(|args| send(cx, a, "pitch_edit", args)),
        "render" => {
            args["out"] = json!(a.need("out").map_err(u)?);
            args["original"] = json!(a.has("original"));
            send(cx, a, "pitch_render", args)
        }
        other => Err(u(format!("unknown pitch verb `{other}` (inspect, compare, suggest, edit, render)"))),
    }
}

/// The request `auto-vocal` sends: `auto_vocal` — the plan, the rider bake and the chain in
/// one call — or, with `--plan`, the read-only `auto_vocal_plan`. Ids are parsed as whole
/// numbers (`a.num` would truncate `--clip 5.9` to clip 5), and a value flag with no value
/// (`--style --no-bake`) is a usage error, not a silently dropped option.
fn auto_vocal_args(a: &Args) -> Result<(&'static str, Value), Fail> {
    let u = Fail::Usage;
    let clip: u64 =
        a.get("clip").ok_or_else(|| u("missing --clip".into()))?.parse().map_err(|_| u("--clip must be a whole number".into()))?;
    let mut args = json!({ "clipId": clip });
    if a.has("style") && a.get("style").is_none() {
        return Err(u("--style needs a value: natural or hard".into()));
    }
    if let Some(s) = a.get("style") {
        if s != "natural" && s != "hard" {
            return Err(u(format!("--style is natural or hard, not `{s}`")));
        }
        args["style"] = json!(s);
    }
    if a.has("beat-clip") && a.get("beat-clip").is_none() {
        return Err(u("--beat-clip needs a value".into()));
    }
    if let Some(v) = a.get("beat-clip") {
        let beat: u64 = v.parse().map_err(|_| u("--beat-clip must be a whole number".into()))?;
        args["beatClipId"] = json!(beat);
    }
    if a.has("plan") {
        // read-only: the plan itself, the rider stage in `riderBake` unless --no-bake
        args["bakeRider"] = json!(!a.has("no-bake"));
        return Ok(("auto_vocal_plan", args));
    }
    args["noBake"] = json!(a.has("no-bake"));
    Ok(("auto_vocal", args))
}

/// The arguments of `pitch_edit`: a whole edit as JSON (`--json`/`--file`: the `edit` of an
/// editTune op, or the whole op as `pitch suggest` prints it), plus quick flags.
fn pitch_edit_args(a: &Args, clip: u64, mut args: Value) -> Result<Value, Fail> {
    let u = Fail::Usage;
    let text = match (a.get("json"), a.get("file")) {
        (Some(j), _) => Some(j.to_string()),
        (None, Some(f)) => Some(std::fs::read_to_string(f).map_err(|e| u(format!("{f}: {e}")))?),
        _ => None,
    };
    if let Some(t) = text {
        let mut v: Value = serde_json::from_str(&t).map_err(|e| u(format!("the edit is not JSON: {e}")))?;
        // a whole `pitch suggest` result: its ready op
        if v.get("op").is_some_and(Value::is_object) {
            v = v["op"].clone();
        } else if v.get("suggestions").is_some() {
            return Err(u("this `pitch suggest` result has no edits (its `op` is null): nothing to apply".into()));
        }
        if v.get("op").and_then(Value::as_str) == Some("editTune") {
            if v.get("clip").and_then(Value::as_u64).is_some_and(|c| c != clip) {
                return Err(u(format!("the op edits clip {}, not --clip {clip}", v["clip"])));
            }
            v = v["edit"].clone();
        }
        let Value::Object(m) = v else { return Err(u("the edit is a JSON object".into())) };
        for (k, x) in m {
            args[k] = x;
        }
    }
    let push = |args: &mut Value, key: &str, x: Value| match args.get_mut(key).and_then(Value::as_array_mut) {
        Some(l) => l.push(x),
        None => args[key] = json!([x]),
    };
    if let Some(i) = a.num("note").map_err(u)? {
        let mut n = json!({ "i": i as u64 });
        for (f, k) in [("shift", "shift"), ("cents", "shiftBy"), ("target", "target"), ("formant", "formant"), ("gain", "gain")] {
            if let Some(v) = a.num(f).map_err(u)? {
                n[k] = json!(v);
            }
        }
        if let Some(d) = a.num("drift").map_err(u)? {
            if !(0.0..=100.0).contains(&d) {
                return Err(u("--drift is a percentage 0..100".into()));
            }
            n["drift"] = json!(d / 100.0);
        }
        match a.get("speed") {
            Some("none") => n["speed"] = Value::Null,
            Some(_) => n["speed"] = json!(a.num("speed").map_err(u)?),
            None => {}
        }
        if n.as_object().is_some_and(|m| m.len() == 1) {
            return Err(u(
                "--note I needs --shift C, --cents C, --target MIDI, --drift %, --formant C, --gain dB or --speed MS|none".into()
            ));
        }
        push(&mut args, "notes", n);
    }
    for sp in a.get_all("split") {
        let (i, t) = sp.split_once('@').ok_or_else(|| u("--split is NOTE@SECONDS (e.g. 4@12.35)".into()))?;
        let i: u64 = i.trim().parse().map_err(|_| u(format!("--split: bad note `{i}`")))?;
        let t: f64 = t.trim().parse().map_err(|_| u(format!("--split: bad time `{t}`")))?;
        push(&mut args, "split", json!({ "i": i, "at": t }));
    }
    for key in ["merge", "reset"] {
        for x in a.get_all(key).iter().flat_map(|x| x.split(',')) {
            let i: u64 = x.trim().parse().map_err(|_| u(format!("--{key} is a comma list of note indices")))?;
            push(&mut args, key, json!(i));
        }
    }
    if a.has("clear") {
        args["clear"] = json!(true);
    }
    if let Some(b) = a.get("base") {
        args["base"] = json!(b);
    }
    if let Some(m) = a.num("max-cents").map_err(u)? {
        args["maxCents"] = json!(m);
    }
    if args.as_object().is_some_and(|m| m.len() == 1) {
        return Err(u(
            "pitch edit: nothing to do (--note I --shift C, --split I@T, --merge I, --reset I, --clear, or --json/--file)".into()
        ));
    }
    Ok(args)
}

/// Tune to Reference on two files, offline: no app, no project.
fn tune_file(a: &Args) -> Result<Value, Fail> {
    use wave_engine::sources::{write_wav, Audio};
    let u = Fail::Usage;
    let (take_p, ref_p, out_p) = (a.need("take").map_err(u)?, a.need("reference").map_err(u)?, a.need("out").map_err(u)?);
    let take = Audio::load(std::path::Path::new(take_p)).map_err(|e| u(format!("{take_p}: {e}")))?;
    let reference = Audio::load(std::path::Path::new(ref_p)).map_err(|e| u(format!("{ref_p}: {e}")))?;
    let pct = |k: &str| -> Result<f32, Fail> {
        match a.num(k).map_err(u)? {
            Some(v) if (0.0..=100.0).contains(&v) => Ok(v as f32 / 100.0),
            Some(_) => Err(u(format!("--{k} is a percentage 0..100"))),
            None => Ok(1.0),
        }
    };
    let octave = match a.get("octave") {
        None | Some("auto") => None,
        Some(o) => Some(
            o.parse::<i32>()
                .ok()
                .filter(|o| o % 12 == 0 && o.abs() <= 36)
                .ok_or_else(|| u("--octave is auto or a multiple of 12 within ±36".into()))?,
        ),
    };
    let params = wave_engine::RefTune {
        source: 0,
        correction: pct("correction")?,
        vibrato: pct("vibrato")?,
        influence: pct("influence")?,
        octave,
        key: a.num("key").map_err(u)?.map(|k| k as u32).unwrap_or(0).min(11),
        scale: a.num("scale").map_err(u)?.map(|k| k as u32).unwrap_or(0).min(4),
        speed: None,
        melody: None,
    };
    // this build has no RMVPE model: the reference is always analysed with YIN
    if a.get("model").is_some() {
        return Err(Fail::Usage("--model: the RMVPE pitch model is not available in this build".into()));
    }
    let est: Option<&dyn wave_engine::pitch::F0Estimator> = None;
    let (out, target, analysis) = wave_engine::reference::tune_audio(&take, &reference, &params, est);
    write_wav(std::path::Path::new(out_p), out.content(), out.sr).map_err(|e| Fail::App(format!("{out_p}: {e}")))?;
    if let Some(j) = a.get("json") {
        let text = serde_json::to_string(&target).map_err(|e| Fail::App(e.to_string()))?;
        std::fs::write(j, text).map_err(|e| Fail::App(format!("{j}: {e}")))?;
    }
    Ok(
        json!({ "out": out_p, "backend": analysis.backend, "corrected": target.reason.is_none(), "reason": target.reason, "score": target.score, "octave": target.octave, "notes": target.notes.len(), "seconds": out.seconds() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::{Arc, Once};

    #[test]
    fn the_labeled_verbs_have_default_undo_names() {
        assert_eq!(default_undo_label("auto_vocal"), Some("Auto Vocal"));
        assert_eq!(default_undo_label("sidechain"), Some("Sidechain"));
        assert_eq!(default_undo_label("route"), None, "the engine names the rest itself");
    }

    /// Records the args each verb call gets, so file-mode label travel can be pinned.
    struct LabelSpy {
        last: RefCell<Option<(String, Value)>>,
    }

    impl Doc for LabelSpy {
        fn call(&self, command: &str, args: &Value, _: Option<u64>) -> Result<Value, String> {
            *self.last.borrow_mut() = Some((command.to_string(), args.clone()));
            Ok(json!({}))
        }
        fn revision(&self) -> u64 {
            1
        }
        fn dirty(&self) -> bool {
            false
        }
        fn save(&self, _: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn file_mode_forwards_an_explicit_label_and_defaults_the_rest() {
        let spy = LabelSpy { last: RefCell::new(None) };
        let cx = Cx { doc: Some(&spy) };
        // an explicit --label travels to the verb even in file mode (it used to be dropped there)
        let a = args(&["-p", "s.wave", "auto-vocal", "--clip", "1", "--label", "Verse"]);
        send(&cx, &a, "auto_vocal", json!({ "clipId": 1 })).unwrap();
        let (cmd, sent) = spy.last.borrow().clone().unwrap();
        assert_eq!(cmd, "auto_vocal");
        assert_eq!(sent["label"], json!("Verse"));
        // without --label the verb keeps its default undo name
        let a = args(&["-p", "s.wave", "sidechain"]);
        send(&cx, &a, "sidechain", json!({})).unwrap();
        assert_eq!(spy.last.borrow().as_ref().unwrap().1["label"], json!("Sidechain"));
        // a verb with no default carries no label unless the caller names it
        let a = args(&["-p", "s.wave", "apply", "--json", "[]"]);
        send(&cx, &a, "apply", json!({ "ops": [] })).unwrap();
        assert_eq!(spy.last.borrow().as_ref().unwrap().1.get("label"), None);
        let a = args(&["-p", "s.wave", "apply", "--json", "[]", "--label", "Fix timing"]);
        send(&cx, &a, "apply", json!({ "ops": [] })).unwrap();
        assert_eq!(spy.last.borrow().as_ref().unwrap().1["label"], json!("Fix timing"));
    }

    /// Keeps the tests away from Synkopa apps really running on this machine.
    fn isolate() -> PathBuf {
        static ONCE: Once = Once::new();
        let root = std::env::temp_dir().join(format!("wave-cli-tests-{}", std::process::id()));
        ONCE.call_once(|| {
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("sessions")).unwrap();
            std::env::set_var("WAVE_SESSION_DIR", root.join("sessions"));
        });
        root
    }

    fn dir(name: &str) -> PathBuf {
        let d = isolate().join(name);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn args(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| x.to_string()).collect())
    }

    /// A project held in memory: `apply` of `setBpm` changes it, `set_param` always fails.
    struct FakeDoc {
        bpm: RefCell<f64>,
        dirty: RefCell<bool>,
        saves: Rc<RefCell<Vec<PathBuf>>>,
        /// `transformNotes` ops it was sent, as sent.
        ops: Rc<RefCell<Vec<Value>>>,
    }

    impl Doc for FakeDoc {
        fn call(&self, command: &str, args: &Value, _: Option<u64>) -> Result<Value, String> {
            match command {
                "apply" => {
                    for op in args["ops"].as_array().cloned().unwrap_or_default() {
                        match op["op"].as_str() {
                            Some("setBpm") => *self.bpm.borrow_mut() = op["bpm"].as_f64().unwrap(),
                            Some("transformNotes") => self.ops.borrow_mut().push(op.clone()),
                            other => return Err(format!("BAD_OPS: unknown op {other:?}")),
                        }
                    }
                    *self.dirty.borrow_mut() = true;
                    Ok(json!({}))
                }
                "context" => Ok(json!({ "bpm": *self.bpm.borrow(), "tracks": [], "nextId": 7 })),
                "set_param" => Err("no effect 5".into()),
                _ => Ok(json!({})),
            }
        }
        fn revision(&self) -> u64 {
            1
        }
        fn dirty(&self) -> bool {
            *self.dirty.borrow()
        }
        fn save(&self, path: &Path) -> Result<(), String> {
            std::fs::write(path, format!("bpm {}", self.bpm.borrow())).map_err(|e| e.to_string())?;
            *self.dirty.borrow_mut() = false;
            self.saves.borrow_mut().push(path.to_path_buf());
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeFiles {
        saves: Rc<RefCell<Vec<PathBuf>>>,
        ops: Rc<RefCell<Vec<Value>>>,
    }

    impl FakeFiles {
        fn doc(&self) -> Box<dyn Doc> {
            Box::new(FakeDoc { bpm: RefCell::new(120.0), dirty: RefCell::new(false), saves: self.saves.clone(), ops: self.ops.clone() })
        }
        fn saves(&self) -> Vec<PathBuf> {
            self.saves.borrow().clone()
        }
    }

    impl Files for FakeFiles {
        fn open(&self, _: &Path) -> Result<(Box<dyn Doc>, Vec<String>), String> {
            Ok((self.doc(), vec![]))
        }
        fn create(&self, template: &str) -> Result<Box<dyn Doc>, String> {
            match template {
                "empty" | "sketch" | "demo" => Ok(self.doc()),
                t => Err(format!("unknown template `{t}`")),
            }
        }
    }

    fn project(d: &Path) -> String {
        let p = d.join("song.wave");
        std::fs::write(&p, "bpm 120").unwrap();
        p.display().to_string()
    }

    fn file(f: &FakeFiles, a: &[&str]) -> Result<Value, Fail> {
        let a = args(a);
        let cmd = a.pos[0].clone();
        on_file(Some(f), &cmd, &a)
    }

    #[test]
    fn short_project_flag_and_shell_like_script_lines() {
        let a = args(&["-p", "a.wave", "bpm", "120"]);
        assert_eq!(a.get("project"), Some("a.wave"));
        assert_eq!(a.pos, ["bpm", "120"]);
        assert_eq!(split_line(r#"pattern --ch kick --steps "x... x...""#).unwrap(), ["pattern", "--ch", "kick", "--steps", "x... x..."]);
        assert_eq!(
            split_line(r#"apply --json '[{"op":"setBpm","bpm":90}]'"#).unwrap(),
            ["apply", "--json", r#"[{"op":"setBpm","bpm":90}]"#]
        );
        assert_eq!(
            split_line(r#"import "C:\My Samples\kick.wav"  --beat 4"#).unwrap(),
            ["import", r"C:\My Samples\kick.wav", "--beat", "4"]
        );
        assert_eq!(split_line(r#"channels --synth """#).unwrap(), ["channels", "--synth", ""]);
        assert!(split_line("bpm '90").is_err());
    }

    #[test]
    fn switches_never_swallow_the_next_word() {
        let a = args(&["bpm", "90", "--dry-run", "-p", "song.wave"]);
        assert_eq!(a.get("project"), Some("song.wave"));
        assert!(a.has("dry-run"));
        assert_eq!(a.pos, ["bpm", "90"]);
        let a = args(&["-p", "song.wave", "--dry-run", "bpm", "90"]);
        assert_eq!(a.get("project"), Some("song.wave"));
        assert_eq!(a.pos, ["bpm", "90"]);
        let a = args(&["render", "--stems", "--out", "x.wav", "--dither", "mix"]);
        assert_eq!(a.get("out"), Some("x.wav"));
        assert_eq!(a.pos, ["render", "mix"]);
        let a = args(&["fx", "--pan", "-0.5", "--value", "-3"]);
        assert_eq!((a.get("pan"), a.get("value")), (Some("-0.5"), Some("-3")));
    }

    #[test]
    fn refusals_keep_the_apps_error_codes() {
        assert_eq!(app_error("BAD_OPS: x".into()), "BAD_OPS: x");
        assert_eq!(app_error("no effect 5".into()), "REFUSED: no effect 5");
        assert_eq!(app_error("no: such".into()), "REFUSED: no: such");
    }

    #[test]
    fn an_edit_is_saved_back_and_a_read_saves_nothing() {
        let d = dir("save");
        let p = project(&d);
        let f = FakeFiles::default();
        let v = file(&f, &["context", "--project", &p]).unwrap();
        assert_eq!(v["saved"], Value::Null);
        assert!(f.saves().is_empty());
        let v = file(&f, &["bpm", "140", "--project", &p]).unwrap();
        assert_eq!(v["saved"], json!(p));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "bpm 140");
        // `save` writes even an unchanged project; `save --path` is a save-as
        file(&f, &["save", "--project", &p]).unwrap();
        let other = d.join("copy.wave");
        file(&f, &["save", "--path", &other.display().to_string(), "--project", &p]).unwrap();
        assert_eq!(f.saves().len(), 3);
        assert!(same_file(f.saves().last().unwrap(), &other));
    }

    #[test]
    fn chop_glue_and_arp_send_their_transform_verbs() {
        let d = dir("notetools");
        let p = project(&d);
        let f = FakeFiles::default();
        file(&f, &["notes", "chop", "--pattern", "3", "--len", "0.5", "--select", "0:16@7", "--project", &p]).unwrap();
        file(&f, &["notes", "glue", "--pattern", "3", "--project", &p]).unwrap();
        file(&f, &["notes", "arp", "--pattern", "3", "--mode", "upDown", "--octaves", "2", "--seed", "4", "--project", &p]).unwrap();
        let ops = f.ops.borrow();
        assert_eq!(ops[0]["verb"], json!({"kind": "chop", "len": 0.5}));
        assert_eq!(ops[0]["select"], json!({"kind": "range", "from": 0.0, "to": 16.0, "ch": 7}));
        assert_eq!(ops[1]["verb"], json!({"kind": "glue"}));
        assert_eq!(ops[2]["verb"], json!({"kind": "arpeggiate", "mode": "upDown", "rate": 1.0, "gate": 0.9, "octaves": 2}));
        assert_eq!(ops[2]["seed"], json!(4));
    }

    #[test]
    fn dry_run_reports_and_save_as_leaves_the_original() {
        let d = dir("dry");
        let p = project(&d);
        let f = FakeFiles::default();
        let v = file(&f, &["bpm", "90", "--dry-run", "--project", &p]).unwrap();
        assert_eq!(v["saved"], Value::Null);
        assert_eq!(v["dryRun"]["changed"], true);
        assert_eq!(v["dryRun"]["wouldSave"], json!(p));
        assert!(f.saves().is_empty());
        let v2 = d.join("v2.wave").display().to_string();
        let v = file(&f, &["bpm", "90", "--save-as", &v2, "--project", &p]).unwrap();
        assert_eq!(v["saved"], json!(v2));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "bpm 120");
        assert_eq!(std::fs::read_to_string(&v2).unwrap(), "bpm 90");
        assert!(matches!(file(&f, &["bpm", "90", "--save-as", "--project", &p]), Err(Fail::Usage(_))));
    }

    #[test]
    fn a_refused_command_saves_nothing() {
        let d = dir("refused");
        let p = project(&d);
        let f = FakeFiles::default();
        match file(&f, &["set-param", "--fx", "5", "--param", "mix", "--value", "1", "--project", &p]) {
            Err(Fail::App(m)) => assert_eq!(m, "REFUSED: no effect 5"),
            other => panic!("{other:?}"),
        }
        assert!(f.saves().is_empty());
    }

    #[test]
    fn file_mode_needs_an_existing_file_and_the_app_binary() {
        let d = dir("missing");
        let missing = d.join("nope.wave").display().to_string();
        match file(&FakeFiles::default(), &["context", "--project", &missing]) {
            Err(Fail::Usage(m)) => assert!(m.contains("synkopa new"), "{m}"),
            other => panic!("{other:?}"),
        }
        let p = project(&d);
        assert!(matches!(on_file(None, "context", &args(&["context", "--project", &p])), Err(Fail::Usage(_))));
        assert!(matches!(file(&FakeFiles::default(), &["context", "--session", "ab", "--project", &p]), Err(Fail::Usage(_))));
    }

    #[test]
    fn a_script_is_all_or_nothing_on_a_file() {
        let d = dir("script");
        let p = project(&d);
        let f = FakeFiles::default();
        let ok = d.join("ok.txt");
        std::fs::write(&ok, "# tempo first\nsynkopa bpm 99\nwave bpm 100\napply --json '[{\"op\":\"setBpm\",\"bpm\":101}]'\ncontext\n")
            .unwrap();
        let v = file(&f, &["script", &ok.display().to_string(), "--project", &p]).unwrap();
        let lines: Vec<_> = v["results"].as_array().unwrap().iter().map(|r| r["line"].as_u64().unwrap()).collect();
        assert_eq!(lines, [2, 3, 4, 5]);
        assert_eq!(v["results"][3]["result"]["bpm"], 101.0);
        assert_eq!(f.saves().len(), 1, "one save for the whole script");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "bpm 101");

        let bad = d.join("bad.txt");
        std::fs::write(&bad, "bpm 60\nset-param --fx 5 --param mix --value 1\nbpm 70\n").unwrap();
        match file(&f, &["script", &bad.display().to_string(), "--project", &p]) {
            Err(Fail::App(m)) => assert!(m.starts_with("line 2 (`set-param`): REFUSED") && m.ends_with("nothing was saved"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(f.saves().len(), 1);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "bpm 101");

        for (body, why) in [
            ("script x.txt\n", "cannot run inside"),
            ("bpm 90 --project o.wave\n", "--project belongs"),
            ("bpm '90\n", "unclosed"),
            ("save --path copy.wave\n", "--save-as"),
        ] {
            std::fs::write(&bad, body).unwrap();
            match file(&f, &["script", &bad.display().to_string(), "--project", &p]) {
                Err(Fail::Usage(m)) => assert!(m.contains(why), "{m}"),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn a_dry_run_script_refuses_project_zip_export() {
        let d = dir("dry-run-zip");
        let p = project(&d);
        let f = FakeFiles::default();
        let script = d.join("export.txt");
        std::fs::write(&script, "bpm 90\nexport-project --out song.zip\n").unwrap();
        match file(&f, &["script", &script.display().to_string(), "--project", &p, "--dry-run"]) {
            Err(Fail::Usage(m)) => assert!(m.starts_with("line 2 (`export-project`): export-project writes a ZIP; omit --dry-run"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert!(f.saves().is_empty());
    }

    #[test]
    fn new_creates_a_file_once() {
        let d = dir("new");
        let f = FakeFiles::default();
        let base = d.join("beat").display().to_string();
        let v = new_file(Some(&f), &args(&["new", &base, "--bpm", "95"])).unwrap();
        let made = d.join("beat.synkopa");
        assert_eq!(v["saved"], json!(made.display().to_string()));
        assert_eq!(v["bpm"], 95.0);
        assert_eq!(std::fs::read_to_string(&made).unwrap(), "bpm 95");
        match new_file(Some(&f), &args(&["new", &base])) {
            Err(Fail::App(m)) => assert!(m.starts_with("EXISTS"), "{m}"),
            other => panic!("{other:?}"),
        }
        new_file(Some(&f), &args(&["new", &base, "--force"])).unwrap();
        assert!(matches!(new_file(Some(&f), &args(&["new", &base, "--force", "--template", "nope"])), Err(Fail::Usage(_))));
    }

    #[test]
    fn a_file_the_app_has_open_is_not_overwritten() {
        let d = dir("open");
        let p = project(&d);
        let open = PathBuf::from(&p);
        let handler: Arc<ws::Handler> = Arc::new(move |_req: &ws::Request| Ok((json!({ "path": open.display().to_string() }), 1)));
        let _server = ws::Server::start(handler).unwrap();
        let f = FakeFiles::default();
        // reading (and rendering) a file the app has open is fine
        file(&f, &["context", "--project", &p]).unwrap();
        match file(&f, &["bpm", "90", "--project", &p]) {
            Err(Fail::App(m)) => assert!(m.starts_with("FILE_OPEN") && m.contains("--force"), "{m}"),
            other => panic!("{other:?}"),
        }
        if cfg!(windows) {
            // the same file, spelled differently
            match file(&f, &["bpm", "90", "--project", &p.to_uppercase()]) {
                Err(Fail::App(m)) => assert!(m.starts_with("FILE_OPEN"), "{m}"),
                other => panic!("{other:?}"),
            }
        }
        assert!(f.saves().is_empty());
        // a copy next to it, or --force, is written
        let v2 = d.join("v2.wave").display().to_string();
        file(&f, &["bpm", "90", "--save-as", &v2, "--project", &p]).unwrap();
        file(&f, &["bpm", "90", "--force", "--project", &p]).unwrap();
        assert_eq!(f.saves().len(), 2);
    }

    #[test]
    fn printed_numbers_drop_f32_noise_but_keep_ids_and_useful_precision() {
        let mut v = json!({
            "id": 11639u64, "revision": 1020, "neg": -3,
            "notes": [{"step": 28.333332061767578, "v": 0.4699999988079071, "len": 0.5}],
            "vol": 0.7936999797821045, "tiny": -0.00001, "big": 6000.000000001
        });
        tidy_numbers(&mut v);
        assert_eq!(v["id"], json!(11639u64));
        assert_eq!(v["revision"], json!(1020));
        assert_eq!(v["neg"], json!(-3));
        assert_eq!(v["notes"][0]["step"], json!(28.3333));
        assert_eq!(v["notes"][0]["v"], json!(0.47));
        assert_eq!(v["notes"][0]["len"], json!(0.5));
        assert_eq!(v["vol"], json!(0.7937));
        assert_eq!(serde_json::to_string(&v["tiny"]).unwrap(), "0.0"); // no "-0.0"
        assert_eq!(v["big"], json!(6000.0));
        assert_eq!(serde_json::to_string(&v["notes"][0]["v"]).unwrap(), "0.47");
    }
}

#[cfg(test)]
mod pitch_args_tests {
    use super::*;

    fn args(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| x.to_string()).collect())
    }

    #[test]
    fn quick_flags_build_one_edit() {
        let a = args(&[
            "pitch",
            "edit",
            "--clip",
            "5",
            "--note",
            "3",
            "--cents",
            "-20",
            "--drift",
            "40",
            "--speed",
            "none",
            "--split",
            "2@1.5",
            "--split",
            "7@3.25",
            "--merge",
            "4,6",
            "--reset",
            "1",
            "--base",
            "abc",
            "--max-cents",
            "80",
        ]);
        let v = pitch_edit_args(&a, 5, json!({ "clipId": 5 })).unwrap();
        assert_eq!(v["notes"], json!([{ "i": 3, "shiftBy": -20.0, "drift": 0.4, "speed": null }]));
        assert_eq!(v["split"], json!([{ "i": 2, "at": 1.5 }, { "i": 7, "at": 3.25 }]));
        assert_eq!(v["merge"], json!([4, 6]));
        assert_eq!(v["reset"], json!([1]));
        assert_eq!(v["base"], "abc");
        assert_eq!(v["maxCents"], 80.0);
    }

    #[test]
    fn a_suggested_op_is_accepted_as_the_edit_and_mistakes_are_usage_errors() {
        let op = r#"{"op":"editTune","clip":5,"edit":{"base":"f00","notes":[{"i":1,"shift":-30}]}}"#;
        let v = pitch_edit_args(&args(&["pitch", "edit", "--clip", "5", "--json", op]), 5, json!({ "clipId": 5 })).unwrap();
        assert_eq!(v, json!({ "clipId": 5, "base": "f00", "notes": [{ "i": 1, "shift": -30 }] }));
        let plan = format!(r#"{{"suggestions":[],"op":{op}}}"#);
        let v2 = pitch_edit_args(&args(&["pitch", "edit", "--clip", "5", "--json", &plan]), 5, json!({ "clipId": 5 })).unwrap();
        assert_eq!(v2, v, "a whole `pitch suggest` result is its op");
        let wrong = pitch_edit_args(&args(&["pitch", "edit", "--clip", "6", "--json", op]), 6, json!({ "clipId": 6 }));
        assert!(matches!(wrong, Err(Fail::Usage(m)) if m.contains("clip 5")));
        for bad in [
            vec!["pitch", "edit", "--clip", "5"],
            vec!["pitch", "edit", "--clip", "5", "--note", "2"],
            vec!["pitch", "edit", "--clip", "5", "--split", "2-1.5"],
            vec!["pitch", "edit", "--clip", "5", "--merge", "x"],
            vec!["pitch", "edit", "--clip", "5", "--note", "1", "--drift", "150"],
            vec!["pitch", "edit", "--clip", "5", "--json", "{not json"],
        ] {
            assert!(matches!(pitch_edit_args(&args(&bad), 5, json!({ "clipId": 5 })), Err(Fail::Usage(_))), "{bad:?}");
        }
    }
}

#[cfg(test)]
mod auto_vocal_args_tests {
    use super::*;

    fn args(s: &[&str]) -> Args {
        Args::parse(s.iter().map(|x| x.to_string()).collect())
    }

    #[test]
    fn flags_build_the_apply_request() {
        let (command, v) = auto_vocal_args(&args(&["auto-vocal", "--clip", "5"])).unwrap();
        assert_eq!(command, "auto_vocal");
        assert_eq!(v, json!({ "clipId": 5, "noBake": false }));
        let (command, v) =
            auto_vocal_args(&args(&["auto-vocal", "--clip", "5", "--style", "hard", "--beat-clip", "3", "--no-bake"])).unwrap();
        assert_eq!(command, "auto_vocal");
        assert_eq!(v, json!({ "clipId": 5, "style": "hard", "beatClipId": 3, "noBake": true }));
    }

    #[test]
    fn plan_is_read_only_and_keeps_the_bake_flag() {
        let (command, v) = auto_vocal_args(&args(&["auto-vocal", "--clip", "5", "--plan"])).unwrap();
        assert_eq!(command, "auto_vocal_plan");
        assert_eq!(v, json!({ "clipId": 5, "bakeRider": true }));
        let (command, v) = auto_vocal_args(&args(&["auto-vocal", "--clip", "5", "--plan", "--no-bake"])).unwrap();
        assert_eq!(command, "auto_vocal_plan");
        assert_eq!(v, json!({ "clipId": 5, "bakeRider": false }));
    }

    #[test]
    fn style_is_validated_here() {
        let bad = ["auto-vocal", "--clip", "5", "--style", "crunchy"];
        assert!(matches!(auto_vocal_args(&args(&bad)), Err(Fail::Usage(_))), "{bad:?}");
    }

    #[test]
    fn ids_are_whole_numbers_not_truncated_or_saturated() {
        for bad in [
            vec!["auto-vocal", "--clip", "5.9"], // would silently select clip 5
            vec!["auto-vocal", "--clip", "-3"],  // would saturate to clip 0
            vec!["auto-vocal", "--clip", "nan"],
            vec!["auto-vocal", "--clip", "5", "--beat-clip", "3.9"],
        ] {
            assert!(matches!(auto_vocal_args(&args(&bad)), Err(Fail::Usage(_))), "{bad:?}");
        }
        assert!(
            matches!(auto_vocal_args(&args(&["auto-vocal", "--style", "hard"])), Err(Fail::Usage(_))),
            "no --clip at all is a usage error"
        );
    }

    #[test]
    fn a_value_flag_with_no_value_is_an_error_not_a_default() {
        // `--style --no-bake`: the parser records style as present with no value, and the
        // request must refuse instead of quietly using the default style
        for bad in
            [vec!["auto-vocal", "--clip", "5", "--style", "--no-bake"], vec!["auto-vocal", "--clip", "5", "--beat-clip", "--no-bake"]]
        {
            assert!(matches!(auto_vocal_args(&args(&bad)), Err(Fail::Usage(_))), "{bad:?}");
        }
    }

    #[test]
    fn the_new_switches_do_not_swallow_the_next_word() {
        // `--plan --style hard` must not eat `--style`; same for --no-bake and --install
        let a = args(&["auto-vocal", "--clip", "5", "--plan", "--style", "hard"]);
        assert!(a.has("plan"));
        assert_eq!(a.get("style"), Some("hard"));
        let a = args(&["auto-vocal", "--clip", "5", "--no-bake", "--style", "natural"]);
        assert!(a.has("no-bake"));
        assert_eq!(a.get("style"), Some("natural"));
        let a = args(&["f0-model", "--install", "--session", "1"]);
        assert!(a.has("install"));
        assert_eq!(a.get("session"), Some("1"));
    }
}
