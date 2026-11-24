//! Stem separation is removed from this build (no HTDemucs model, no ONNX Runtime). The
//! commands keep their names and answer with [`crate::models::NOT_IN_BUILD`].

use std::sync::atomic::AtomicBool;

use serde::Serialize;
use serde_json::{json, Value};
use wave_engine::{Engine, PlacedStems};

use crate::actions::{Host, R};
use crate::models;

pub const MODEL_ID: &str = "htdemucs";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemModelStatus {
    pub id: &'static str,
    pub installed: bool,
    pub unavailable: &'static str,
}

pub fn status() -> StemModelStatus {
    StemModelStatus { id: MODEL_ID, installed: false, unavailable: models::NOT_IN_BUILD }
}

pub fn download() -> models::Download {
    models::Download::none()
}

pub fn control(_app: &dyn Host, cmd: &str, _a: &Value, _if_revision: Option<u64>) -> Option<R<Value>> {
    Some(match cmd {
        "stems_model" => Ok(json!(status())),
        "stems_model_install" | "extract_stems" => Err(models::NOT_IN_BUILD.into()),
        _ => return None,
    })
}

pub fn placed_json(p: &PlacedStems, revision: u64) -> Value {
    json!({ "sourceIds": p.source_ids, "clipIds": p.clip_ids, "track": p.track, "mutedClip": p.muted_clip, "revision": revision })
}

pub fn extract(
    _engine: &Engine,
    _clip_id: u64,
    _which: &[String],
    _cancel: &AtomicBool,
    _progress: &dyn Fn(&'static str, f64),
) -> R<Option<PlacedStems>> {
    Err(models::NOT_IN_BUILD.into())
}
