# Rusty Loops fork

Rusty Loops is a fork of [Synkopa](https://github.com/miskibin/synkopa) (`upstream`) that
leaves out plugin hosting, audio recording, the vocal and analysis tools, and the updater,
and renames the app. Everything else, the engine above all, follows upstream unchanged.

Upstream moves fast, so the fork is kept as a thin layer on top of it and synced often.
These rules hold the layer thin and the syncs cheap.

## How the Fork Differs

- **Removed paths.** The fork deletes these and must never bring them back:
  - `crates/chords/`, `crates/demo-synth/`, `crates/lv2-host/`, `crates/perf/`,
    `crates/plugin-scan/`, `crates/plugin-windows/`, `crates/rmvpe/`, `crates/stems/`,
    `crates/tune-bench/`, `crates/vst3-host/`
  - `app/src/plugin_probe.rs`, `app/src/chords_actions_tests.rs`,
    `app/src/stems_actions_tests.rs`, `app/resources/ort/`, `app/resources/plugins/`
  - `scripts/build-demo-synth.mjs`, `scripts/chords-reference.py`,
    `scripts/export-htdemucs-onnx.py`, `scripts/fetch-onnxruntime.mjs`
- **UI switches.** `ui/src/fork.ts` turns the removed features off (`FORK`), hides their
  effects (`HIDDEN_FX`) and swaps the name (`brand`, `APP_NAME`). Views read these at the
  point where a feature is offered; upstream's code around them stays as it is. When
  upstream's tests cover a feature the fork only hides, make its switch true in tests
  (`import.meta.env.MODE === 'test'`), as `ask` and `brand` do, so those tests keep passing.
- **Backend.** `app/src/lib.rs`, `app/Cargo.toml`, `crates/cli` and the files under `app/src`
  that served the removed features drop their wiring to the removed crates.
- **Name.** `app/tauri.conf.json`, `app/tauri.linux.conf.json` and `ui/index.html` carry
  the Rusty Loops name and identifiers.

Make new fork changes the same way: a switch in `ui/src/fork.ts` or a removed call, never
a rewrite of upstream code. Every line that differs from upstream is a future conflict.

## Syncing With Upstream

When asked to sync with upstream, do all of this without stopping for approval, and stop
only for the case in step 5.

1. **Prepare.** Work on `master` with a clean tree. Make sure the `upstream` remote points at
   `https://github.com/miskibin/synkopa.git`, and turn on `git config rerere.enabled true`
   and `git config rerere.autoUpdate true` so Git replays earlier conflict resolutions.
2. **Merge.** `git fetch upstream` and `git merge --no-ff --no-commit upstream/main`. Merge;
   never rebase, because rebasing replays every fork commit against every upstream change.
3. **Resolve conflicts.**
   - A removed path that upstream changed ("deleted by us"): `git rm` it again.
   - A new upstream crate, script or file that exists only to serve a removed feature:
     delete it too, and add it to the removed paths above.
   - `Cargo.lock`: take upstream's (`git checkout --theirs Cargo.lock`); the build in step 4
     prunes the removed crates from it.
   - Any other file: keep upstream's version and reapply the fork's intent on top of it.
     The fork's side of the conflict shows what that intent was.
4. **Check.** Run everything in the `rust` distrobox (`distrobox enter rust -- …`) from the
   repo root:
   - `cargo fmt --all --check`
   - `cargo clippy --workspace --all-targets -- -D warnings`
   - `cargo test --workspace`
   - the UI install, test and build: `pnpm --dir ui install --frozen-lockfile`,
     `pnpm --dir ui test` and `pnpm --dir ui build`, with the pnpm major version that
     `.github/workflows/ci.yml` pins (run it through `npx --yes pnpm@<major>`)
   - `cargo build -p wave-app --features custom-protocol`

   `pool::tests::rest_parks_the_workers_and_the_next_dispatch_wakes_them` in `wave-engine`
   is timing-sensitive and can fail when the whole suite loads every core. If it fails,
   rerun it alone (`cargo test -p wave-engine --lib pool::tests::rest_parks`); it counts as
   passing when that run passes. Do not change upstream's test to quiet it.

   Fix what the merge broke. A clean merge can still fail to build when new upstream code
   calls into a removed crate; remove or gate that call the way the fork already does.
5. **Review.** Read `git diff HEAD` (the incoming upstream changes) for new features that
   touch a removed area: a new menu item, picker entry, panel, shortcut or CLI command that
   offers plugins, recording, vocal tools, analysis or updates. Hide each behind the matching
   `FORK` switch, or drop its backend call. If a change could reasonably go either way
   (part of a feature the fork keeps, part of one it removes), describe it and ask the user.
6. **Commit.** Commit the merge with a one-line message that names the upstream commit, for
   example `merge upstream 1a2b3c4`. Then report what came in, grouped by area, and what
   the fork had to adjust.
