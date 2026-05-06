use crate::authorship::virtual_attribution::{VirtualAttributions, restore_stashed_va};
use crate::commands::git_handlers::CommandHooksContext;
use crate::commands::hooks::commit_hooks::get_commit_default_author;
use crate::git::cli_parser::ParsedGitInvocation;
use crate::git::repository::Repository;
use crate::utils::debug_log;

pub fn pre_switch_hook(
    parsed_args: &ParsedGitInvocation,
    repository: &mut Repository,
    command_hooks_context: &mut CommandHooksContext,
) {
    repository.require_pre_command_head();

    // If --merge is used, we need to capture VirtualAttributions before the switch
    // because the merge might shift lines around
    if is_merge_switch(parsed_args) && has_uncommitted_changes(repository) {
        capture_va_for_merge(parsed_args, repository, command_hooks_context);
    }
}

/// Capture VirtualAttributions before a --merge switch.
fn capture_va_for_merge(
    parsed_args: &ParsedGitInvocation,
    repository: &Repository,
    command_hooks_context: &mut CommandHooksContext,
) {
    debug_log("Detected switch --merge with uncommitted changes, capturing VirtualAttributions");

    let head_sha = match repository.head().ok().and_then(|h| h.target().ok()) {
        Some(sha) => sha,
        None => {
            debug_log("Failed to get HEAD for VA capture");
            return;
        }
    };

    let human_author = get_commit_default_author(repository, &parsed_args.command_args);
    match VirtualAttributions::from_just_working_log(
        repository.clone(),
        head_sha.clone(),
        Some(human_author),
    ) {
        Ok(va) => {
            if !va.attributions.is_empty() {
                debug_log(&format!(
                    "Captured VA with {} files for switch --merge preservation",
                    va.attributions.len()
                ));
                command_hooks_context.stashed_va = Some(va);
            } else {
                debug_log("No attributions in working log to preserve");
            }
        }
        Err(e) => {
            debug_log(&format!("Failed to build VirtualAttributions: {}", e));
        }
    }
}

pub fn post_switch_hook(
    parsed_args: &ParsedGitInvocation,
    repository: &mut Repository,
    exit_status: std::process::ExitStatus,
    command_hooks_context: &mut CommandHooksContext,
) {
    if !exit_status.success() {
        debug_log("Switch failed, skipping working log handling");
        return;
    }

    let old_head = match &repository.pre_command_base_commit {
        Some(sha) => sha.clone(),
        None => return,
    };

    let new_head = match repository.head().ok().and_then(|h| h.target().ok()) {
        Some(sha) => sha,
        None => return,
    };

    if old_head == new_head {
        debug_log("HEAD unchanged after switch, no working log handling needed");
        return;
    }

    // Force switch - delete working log (changes discarded)
    if is_force_switch(parsed_args) {
        debug_log(&format!(
            "Force switch detected, deleting working log for {}",
            &old_head
        ));
        let _ = repository
            .storage
            .delete_working_log_for_base_commit(&old_head);
        return;
    }

    // --merge switch - restore VirtualAttributions (lines may have shifted)
    if let Some(stashed_va) = command_hooks_context.stashed_va.take() {
        debug_log("Restoring VA after switch --merge");
        let _ = repository
            .storage
            .delete_working_log_for_base_commit(&old_head);
        restore_stashed_va(repository, &old_head, &new_head, stashed_va);
        return;
    }

    // Normal branch switch - migrate working log
    debug_log(&format!(
        "Switch changed HEAD: {} -> {}",
        &old_head, &new_head
    ));
    let _ = repository.storage.rename_working_log(&old_head, &new_head);
}

/// Check if switch uses force flag (--discard-changes, -f, --force).
fn is_force_switch(parsed_args: &ParsedGitInvocation) -> bool {
    parsed_args
        .command_args
        .iter()
        .any(|arg| arg == "-f" || arg == "--force" || arg == "--discard-changes")
}

/// Check if switch uses --merge flag that merges local changes.
fn is_merge_switch(parsed_args: &ParsedGitInvocation) -> bool {
    parsed_args.has_command_flag("--merge") || parsed_args.has_command_flag("-m")
}

/// Check if the working directory has uncommitted changes.
fn has_uncommitted_changes(repository: &Repository) -> bool {
    match repository.get_staged_and_unstaged_filenames() {
        Ok(filenames) => !filenames.is_empty(),
        Err(_) => false,
    }
}
