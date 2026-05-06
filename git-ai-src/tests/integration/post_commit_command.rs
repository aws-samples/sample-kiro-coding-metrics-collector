use crate::repos::test_file::ExpectedLineExt;
use crate::repos::test_repo::TestRepo;

/// Test: Normal commit with AI edits — `git-ai post-commit <sha>` generates authorship note.
///
/// Flow:
/// 1. Create repo, write AI edits via checkpoint (creates working log)
/// 2. Commit using git_og (bypasses git-ai proxy, so no post-commit hook runs)
/// 3. Verify no authorship note exists yet
/// 4. Call `git-ai post-commit <sha>` directly
/// 5. Verify authorship note is now generated and blame shows correct AI attribution
#[test]
fn test_post_commit_generates_authorship_note() {
    let repo = TestRepo::new();
    let mut file = repo.filename("test.txt");

    // Create AI edits via checkpoint — this writes the working log
    file.set_contents(crate::lines!["Human line", "AI line".ai(), "Another AI line".ai()]);

    // Commit using git_og (bypasses git-ai proxy — no post-commit hook)
    repo.git_og(&["add", "-A"]).unwrap();
    repo.git_og(&["commit", "-m", "commit with AI edits"])
        .unwrap();

    let commit_sha = repo
        .git_og(&["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();

    // Verify no authorship note exists yet (git_og bypassed the proxy)
    assert!(
        repo.read_authorship_note(&commit_sha).is_none(),
        "Authorship note should not exist before post-commit"
    );

    // Call git-ai post-commit directly
    repo.git_ai(&["post-commit", &commit_sha]).unwrap();

    // Verify authorship note is now generated
    let note = repo.read_authorship_note(&commit_sha);
    assert!(
        note.is_some(),
        "Authorship note should exist after git-ai post-commit"
    );

    // Verify blame shows correct AI attribution
    file.assert_lines_and_blame(crate::lines![
        "Human line".human(),
        "AI line".ai(),
        "Another AI line".ai(),
    ]);
}

/// Test: Missing commit SHA argument — `git-ai post-commit` without args exits with error.
#[test]
fn test_post_commit_missing_sha_argument() {
    let repo = TestRepo::new();

    // Create a minimal commit so the repo is valid
    let file_path = repo.path().join("init.txt");
    std::fs::write(&file_path, "init").unwrap();
    repo.git_og(&["add", "-A"]).unwrap();
    repo.git_og(&["commit", "-m", "init"]).unwrap();

    // Call git-ai post-commit without SHA — should fail
    let result = repo.git_ai(&["post-commit"]);
    assert!(
        result.is_err(),
        "git-ai post-commit without SHA should fail"
    );

    let err = result.unwrap_err();
    assert!(
        err.contains("Usage") || err.contains("post-commit"),
        "Error should contain usage hint, got: {}",
        err
    );
}

/// Test: Initial commit (no parent) — `git-ai post-commit <sha>` handles no-parent case.
///
/// For the very first commit in a repo, `git rev-parse <sha>^` fails because there's
/// no parent. The post-commit handler should set base_commit to None and still work.
#[test]
fn test_post_commit_initial_commit_no_parent() {
    let repo = TestRepo::new();
    let mut file = repo.filename("test.txt");

    // Create AI edits via checkpoint on an empty repo (no prior commits)
    file.set_contents(crate::lines!["First line".ai(), "Second line".ai()]);

    // Commit using git_og (bypasses proxy)
    repo.git_og(&["add", "-A"]).unwrap();
    repo.git_og(&["commit", "-m", "initial commit"]).unwrap();

    let commit_sha = repo
        .git_og(&["rev-parse", "HEAD"])
        .unwrap()
        .trim()
        .to_string();

    // Verify no authorship note yet
    assert!(
        repo.read_authorship_note(&commit_sha).is_none(),
        "Authorship note should not exist before post-commit"
    );

    // Call git-ai post-commit on the initial commit (no parent)
    // This should succeed — base_commit is None for initial commits
    repo.git_ai(&["post-commit", &commit_sha]).unwrap();

    // Verify authorship note is generated even for initial commit
    let note = repo.read_authorship_note(&commit_sha);
    assert!(
        note.is_some(),
        "Authorship note should exist after git-ai post-commit on initial commit"
    );

    // Verify blame shows correct AI attribution
    file.assert_lines_and_blame(crate::lines![
        "First line".ai(),
        "Second line".ai(),
    ]);
}
