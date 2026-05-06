mod fork_app;
#[cfg(target_os = "macos")]
pub mod mac_prefs;
mod sublime_merge;

pub use fork_app::ForkAppInstaller;
pub use sublime_merge::SublimeMergeInstaller;

use super::git_client_installer::GitClientInstaller;

/// Get all available git client installers for the current platform
pub fn get_all_git_client_installers() -> Vec<Box<dyn GitClientInstaller>> {
    let all: Vec<Box<dyn GitClientInstaller>> =
        vec![Box::new(ForkAppInstaller), Box::new(SublimeMergeInstaller)];

    // Filter to only platform-supported installers
    all.into_iter()
        .filter(|installer| installer.is_platform_supported())
        .collect()
}
