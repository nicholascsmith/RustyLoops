//! Linux: WebKitGTK renderer setup. Plugin windows are not hosted in this build, so the
//! app runs on the session's own display server (native Wayland under GNOME).

/// Whether to turn off WebKitGTK's DMA-BUF renderer (`WEBKIT_DISABLE_DMABUF_RENDERER=1`), given
/// the variable as the user set it. With the DMA-BUF renderer, while the Playlist repaints slower
/// than the display a Ctrl+wheel zoom showed its scroll position several frames behind its
/// canvases: the view jumped sideways or showed a blank strip on every zoom step (#136, #160,
/// #228; reproduced on WebKitGTK 2.52 with an NVIDIA GPU, gone with the variable set). It is
/// Tauri's documented workaround for WebKitGTK rendering faults. Any value the user set (`0`
/// keeps DMA-BUF) wins.
pub fn wants_no_dmabuf(user: Option<&str>) -> bool {
    user.is_none()
}

/// Rusty Loops runs on AMD only, so it keeps WebKitGTK's faster DMA-BUF renderer instead of
/// upstream's NVIDIA workaround.
const NVIDIA_WORKAROUND: bool = false;

/// Apply [`wants_no_dmabuf`] to this process. Call first thing, before GTK starts and before any
/// other thread exists (it sets an environment variable).
pub fn webkit_renderer() {
    if NVIDIA_WORKAROUND && wants_no_dmabuf(std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").ok().as_deref()) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::wants_no_dmabuf;

    #[test]
    fn the_dmabuf_renderer_is_off_unless_the_user_chose() {
        assert!(wants_no_dmabuf(None));
        assert!(!wants_no_dmabuf(Some("0")), "WEBKIT_DISABLE_DMABUF_RENDERER=0 keeps DMA-BUF");
        assert!(!wants_no_dmabuf(Some("1")), "already off: left as set");
    }
}
