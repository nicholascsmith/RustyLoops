//! Makes `synkopa` a command in every new terminal, with no installer step.
//!
//! The app binary doubles as the CLI (`wave-app --cli …`). On start we drop a
//! tiny launcher into a folder that is already on the user's PATH:
//! * Windows: `%LOCALAPPDATA%\Microsoft\WindowsApps\synkopa.cmd` (on PATH by default
//!   since Windows 10, no admin rights, survives app updates because we rewrite it);
//! * macOS/Linux: `~/.local/bin/synkopa` (a `sh` script).
//!
//! The command was called `wave` before the rename, so a second launcher with that name is
//! written next to it: scripts and agents that call `wave` keep working.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub command: String,
    pub path: Option<String>,
    pub note: Option<String>,
}

fn target_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("WAVE_CLI_DIR") {
        return Some(PathBuf::from(d));
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Microsoft").join("WindowsApps"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("bin"))
    }
}

fn on_path(dir: &std::path::Path) -> bool {
    std::env::var_os("PATH").map(|p| std::env::split_paths(&p).any(|x| x == dir)).unwrap_or(false)
}

fn mark_executable(_file: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(_file, std::fs::Permissions::from_mode(0o755));
    }
}

/// The terminal command this build installs (upstream installs `synkopa` and `wave`).
pub const CMD: &str = "rustyloops";

/// Writes a launcher unless it already says `body`; best effort.
#[cfg(windows)]
fn write_launcher(file: &std::path::Path, body: &str) {
    if std::fs::read_to_string(file).is_ok_and(|t| t == body) {
        return;
    }
    if std::fs::write(file, body).is_ok() {
        mark_executable(file);
    }
}

/// The `sh` launcher for Git Bash / MSYS / Cygwin on Windows: the app's path with forward
/// slashes (`C:/…`), which every one of those shells accepts.
#[cfg(any(windows, test))]
fn sh_launcher(exe: &std::path::Path) -> String {
    format!("#!/bin/sh\nexec \"{}\" --cli \"$@\"\n", exe.display().to_string().replace('\\', "/"))
}

/// Writes (or refreshes) the launcher. Never fails the app: problems become a note.
pub fn install() -> CliStatus {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            return CliStatus { installed: false, command: CMD.into(), path: None, note: Some(format!("cannot locate the app: {e}")) }
        }
    };
    let Some(dir) = target_dir() else {
        return CliStatus { installed: false, command: CMD.into(), path: None, note: Some("no home folder to install into".into()) };
    };
    #[cfg(windows)]
    let (file, body) = (dir.join(format!("{CMD}.cmd")), format!("@echo off\r\n\"{}\" --cli %*\r\n", exe.display()));
    #[cfg(not(windows))]
    let (file, body) = (dir.join(CMD), format!("#!/bin/sh\nexec \"{}\" --cli \"$@\"\n", exe.display()));
    let unchanged = std::fs::read_to_string(&file).map(|t| t == body).unwrap_or(false);
    if !unchanged {
        if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, &body)) {
            return CliStatus {
                installed: false,
                command: format!("\"{}\" --cli", exe.display()),
                path: None,
                note: Some(format!("could not write {}: {e}", file.display())),
            };
        }
        mark_executable(&file);
    }
    // Git Bash / MSYS (the shell coding agents run on Windows) does not run a `.cmd` without its
    // extension, so `synkopa` was "command not found" there. An extensionless sh script beside it
    // fixes that; cmd and PowerShell ignore it (not in PATHEXT) — npm's shims do the same.
    #[cfg(windows)]
    {
        let sh = sh_launcher(&exe);
        write_launcher(&dir.join(CMD), &sh);
    }
    let note = if on_path(&dir) {
        None
    } else {
        Some(format!("{} is not on PATH — add it, or call {} directly", dir.display(), file.display()))
    };
    CliStatus { installed: true, command: CMD.into(), path: Some(file.display().to_string()), note }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_launcher_uses_forward_slashes_and_passes_every_argument() {
        let s = sh_launcher(std::path::Path::new(r"C:\Program Files\Synkopa\synkopa.exe"));
        assert_eq!(s, "#!/bin/sh\nexec \"C:/Program Files/Synkopa/synkopa.exe\" --cli \"$@\"\n");
    }
}
