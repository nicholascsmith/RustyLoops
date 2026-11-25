// What this fork leaves out of upstream Synkopa. Each switch is read where the feature is
// offered (a menu, a picker category, a panel), so upstream's own code stays as it is and
// merges cleanly; the engine keeps loading projects that still use a removed feature.
import type { BuiltinKind } from './api/types';

// Switches that only hide upstream code are on in tests, so upstream's tests keep checking that code
const TEST = import.meta.env.MODE === 'test';

export const FORK = {
  /** VST3 and LV2 hosting: no scan, no plugin effects or instruments to add. */
  plugins: false,
  /** Pitch editor, live tuning, Tune to Reference, auto vocal, the vocal effects. */
  vocal: false,
  /** Stem separation, chord detection, the Music Box instrument, the downloadable pitch model. */
  analysis: false,
  /** Audio recording, takes and comping, input monitoring, the input device and its latency.
   *  Record still captures notes and automation. */
  audioRecording: false,
  /** The built-in updater: upstream's releases would replace this build with the full app. */
  updates: false,
  /** Ask ChatGPT: the menu-row button, the Help menu item, F1 and the palette's question row. */
  ask: TEST,
  /** Synkopa Instruments (the sampled piano) as an instrument to add, with its downloads. Without
   *  it installed, MIDI import makes piano parts a synth. */
  keys: TEST,
  /** The library's "More sounds to download" kits. */
  downloads: TEST,
  /** What's new: the Help menu item, the button in Settings and the dialog after a version change. */
  whatsNew: TEST,
  /** File → Export project as ZIP. */
  projectZip: TEST,
  /** MIDI export of the song or a pattern (MIDI import stays). */
  midiExport: TEST,
  /** Polish: the language setting; the interface is always English. */
  polish: TEST,
  /** Help ▸ Join the Discord (upstream's community server). */
  discord: TEST,
} as const;

/** Built-in effects the picker does not offer (a project that has one still plays it). */
export const HIDDEN_FX: ReadonlySet<BuiltinKind> = new Set<BuiltinKind>([
  ...(FORK.vocal ? [] : ['tune', 'voice', 'rider', 'deess', 'denoise'] as const),
  ...(TEST ? [] : ['gate', 'warp'] as const),
]);

/** This build's name, shown wherever upstream's text says "Synkopa". */
export const APP_NAME = 'Rusty Loops';

// "Synkopa" and its Polish forms (Synkopy, Synkopę, Synkopie, Synkopą); the new name stays undeclined
const UPSTREAM_NAME = /Synkop(?:a|y|ę|ie|ą)(?!\p{L})/gu;

// Upstream's tests check its own wording, so the test runner sees upstream's name (fork.test.ts checks the swap)
const RENAME = import.meta.env.MODE !== 'test';

/** Upstream's text with this build's name in it. */
export const brand = (text: string, rename = RENAME): string => (rename ? text.replace(UPSTREAM_NAME, APP_NAME) : text);
