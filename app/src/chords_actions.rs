//! Chord detection is removed from this build (no ChordMini model, no ONNX Runtime). The
//! commands keep their names and answer with [`crate::models::NOT_IN_BUILD`].

use serde::Serialize;
use serde_json::{json, Value};
use wave_engine::chords::Detail;
use wave_engine::Engine;

use crate::actions::{arg, Host, R};
use crate::models;

pub const MODEL_ID: &str = "chordmini";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChordModelStatus {
    pub id: &'static str,
    pub installed: bool,
    pub unavailable: &'static str,
}

pub fn status() -> ChordModelStatus {
    ChordModelStatus { id: MODEL_ID, installed: false, unavailable: models::NOT_IN_BUILD }
}

pub fn download() -> models::Download {
    models::Download::none()
}

pub fn control(_app: &dyn Host, cmd: &str, _a: &Value, _if_revision: Option<u64>) -> Option<R<Value>> {
    Some(match cmd {
        "chords_model" => Ok(json!(status())),
        "chords_model_install" | "chords_analyze" | "chords_to_pattern" => Err(models::NOT_IN_BUILD.into()),
        _ => return None,
    })
}

/// `detail`: "full" (default) or "simple".
pub fn detail_arg(a: &Value) -> R<Detail> {
    match arg(a, "detail").and_then(Value::as_str) {
        None | Some("full") => Ok(Detail::Full),
        Some("simple") => Ok(Detail::Simple),
        Some(x) => Err(format!("`detail`: full or simple, not `{x}`")),
    }
}

pub fn analyze(_e: &Engine, _clip_id: u64, _detail: Detail) -> R<wave_engine::chords::ChordAnalysis> {
    Err(models::NOT_IN_BUILD.into())
}

pub fn to_pattern(_app: &dyn Host, _a: &Value, _if_revision: Option<u64>) -> R<Value> {
    Err(models::NOT_IN_BUILD.into())
}
