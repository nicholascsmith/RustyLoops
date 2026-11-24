//! Plugin hosting is removed from this build: no VST3 or LV2 module is scanned, loaded or
//! shown. This keeps the interface the rest of the app calls, so a project that names a
//! hosted plugin still opens; that effect or instrument channel reports a load error and
//! stays silent, and its saved state is kept untouched in the file.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wave_engine::{Id, Instrument, PluginFactory, PluginRef, Processor};

/// The sentence a hosted effect or instrument shows instead of loading.
pub const NOT_HOSTED: &str = "plugins are not supported in this build";

/// Kept for the UI's error prefix check (`wave_engine::errors::ERR_NO_EDITOR`).
#[cfg(test)]
pub const NO_EDITOR: &str = "NO_EDITOR: this plugin has no window of its own; its parameters are listed below";

/// One parameter of a hosted plugin. Never produced: nothing is hosted.
#[derive(Debug, Clone, Serialize)]
pub struct ParamInfo {
    pub id: u32,
    pub name: String,
}

impl ParamInfo {
    pub fn id(&self) -> u32 {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
}

/// One installed effect, as `plugin_scan` lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    pub format: String,
    pub path: String,
    pub cid: String,
    pub name: String,
    pub vendor: String,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<String>,
}

/// What `plugin_scan` returns: always empty here.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub plugins: Vec<ScanEntry>,
    pub instruments: Vec<ScanEntry>,
    pub unavailable: HashMap<String, String>,
}

/// A plugin to ask the user about after a crash. Never produced: nothing is hosted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashSuspect {
    pub format: String,
    pub cid: String,
    pub name: String,
    pub path: String,
}

/// The header a plugin window would show.
pub struct Label {
    pub title: String,
    pub subtitle: String,
    pub tag: u64,
}

pub fn register_bundled(_resource_dir: Option<std::path::PathBuf>) {}

struct Factory;

impl PluginFactory for Factory {
    fn create(&self, _fx_id: Id, p: &PluginRef, _sr: f32, _max_block: usize, _live: bool) -> Result<Box<dyn Processor>, String> {
        Err(format!("{}: {NOT_HOSTED}", p.name))
    }
    fn create_instrument(
        &self,
        _chan_id: Id,
        p: &PluginRef,
        _sr: f32,
        _max_block: usize,
        _live: bool,
    ) -> Result<Box<dyn Instrument>, String> {
        Err(format!("{}: {NOT_HOSTED}", p.name))
    }
    fn vet(&self, _plugins: &[(&PluginRef, bool)]) {}
    fn release(&self, _fx_id: Id) {}
    fn state(&self, _fx_id: Id) -> Option<String> {
        None
    }
    fn has_plugin_param(&self, _fx_id: Id, _param_id: u32) -> bool {
        false
    }
    fn latency(&self, _fx_id: Id) -> Option<usize> {
        None
    }
}

#[derive(Default)]
pub struct Plugins;

impl Plugins {
    pub fn new() -> Arc<Self> {
        Arc::new(Plugins)
    }

    pub fn crash_suspects(&self) -> Vec<CrashSuspect> {
        Vec::new()
    }

    pub fn clear_crash_suspects(&self) {}

    pub fn clean_exit(&self) {}

    pub fn block(&self, _format: &str, _path: &str) -> Result<(), String> {
        Err(NOT_HOSTED.into())
    }

    pub fn factory(self: &Arc<Self>) -> Arc<dyn PluginFactory> {
        Arc::new(Factory)
    }

    pub fn trust(&self, _p: &PluginRef, _instrument: bool) {}

    pub fn scan(&self, _rescan: bool) -> ScanResult {
        ScanResult::default()
    }

    pub fn info(&self, _format: &str, _path: &str, _cid: &str) -> Option<ScanEntry> {
        None
    }

    pub fn instrument(&self, _path: &str, _cid: &str) -> Option<ScanEntry> {
        None
    }

    pub fn params(&self, fx: Id) -> Result<Vec<ParamInfo>, String> {
        Err(format!("{fx} is not a loaded plugin effect or instrument: {NOT_HOSTED}"))
    }

    pub fn state(&self, fx: Id) -> Result<String, String> {
        Err(format!("{fx} is not a loaded plugin effect or instrument: {NOT_HOSTED}"))
    }

    pub fn set_param(&self, fx: Id, _id: u32, _v: f64) -> Result<(), String> {
        Err(format!("{fx} is not a loaded plugin effect or instrument: {NOT_HOSTED}"))
    }

    pub fn editor_open(&self, _fx: Id) -> Result<bool, String> {
        Ok(false)
    }

    pub fn editor(&self, _app: &tauri::AppHandle, _fx: Id, _open: bool, _label: Label, _pinned: bool) -> Result<(), String> {
        Err(NOT_HOSTED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_plugin_is_a_load_error_not_a_panic() {
        let f = Plugins::new().factory();
        let p =
            PluginRef { format: "vst3".into(), path: "x".into(), cid: "y".into(), name: "Z".into(), vendor: String::new(), state: None };
        let err = f.create(1, &p, 48_000.0, 256, true).err().unwrap();
        assert!(err.contains(NOT_HOSTED), "{err}");
        let err = f.create_instrument(2, &p, 48_000.0, 256, true).err().unwrap();
        assert!(err.contains(NOT_HOSTED), "{err}");
        assert!(f.latency(1).is_none() && f.state(1).is_none());
        assert!(Plugins::new().scan(true).plugins.is_empty());
    }
}
