// What this fork leaves out of upstream Synkopa. Each switch is read where the feature is
// offered (a menu, a picker category, a panel), so upstream's own code stays as it is and
// merges cleanly; the engine keeps loading projects that still use a removed feature.
import type { BuiltinKind } from './api/types';

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
} as const;

/** Built-in effects the picker does not offer (a project that has one still plays it). */
export const HIDDEN_FX: ReadonlySet<BuiltinKind> = new Set<BuiltinKind>(FORK.vocal ? [] : ['tune', 'voice', 'rider', 'deess', 'denoise']);
