/**
 * Property-based tests for RepoRouter pure functions.
 *
 * Feature: repo-aware-checkpoint-routing
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  groupActionsByRepo,
  findRepoForFile,
  toRepoRelativePath,
  normalizePath,
  ensureTrailingSlash,
  type RepoInfo,
} from "../repoRouter.js";
import type { WriteAction } from "../workspacePathEncoder.js";

// ── Generators ───────────────────────────────────────────────────────

/** Arbitrary simple directory name segment (lowercase, no separators). */
const dirSegmentArb = fc.stringMatching(/^[a-z][a-z0-9\-]{0,11}$/);

/** Arbitrary file name with extension. */
const fileNameArb = fc.stringMatching(/^[a-z][a-z0-9]{0,7}\.[a-z]{1,4}$/);

/** Arbitrary action type from the known write action types. */
const actionTypeArb = fc.constantFrom(
  "replace",
  "create",
  "write",
  "append",
  "editCode",
  "delete",
  "smartRelocate"
);

/** Arbitrary file content string. */
const contentArb = fc.string({ minLength: 0, maxLength: 50 });

/** Arbitrary timestamp in milliseconds. */
const timestampArb = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });

/**
 * Generate a workspace path (absolute Unix-style).
 */
const workspacePathArb = fc
  .tuple(dirSegmentArb, dirSegmentArb)
  .map(([a, b]) => `/home/${a}/${b}`);

/**
 * Generate a set of nested repos under a workspace.
 *
 * Returns { workspacePath, repos } where repos includes at least one top-level
 * repo and optionally a nested repo inside it.
 *
 * Example output:
 *   workspacePath: "/home/user/ws"
 *   repos: [
 *     { rootPath: "/home/user/ws/repo-a" },
 *     { rootPath: "/home/user/ws/repo-a/packages/nested" },
 *     { rootPath: "/home/user/ws/repo-b" },
 *   ]
 */
const nestedRepoSetArb = fc
  .tuple(
    workspacePathArb,
    // Top-level repo names (1-4 repos)
    fc.array(dirSegmentArb, { minLength: 1, maxLength: 4 }),
    // For each top-level repo, optionally generate a nested sub-path
    fc.array(
      fc.tuple(
        fc.boolean(), // whether to create a nested repo
        dirSegmentArb  // nested sub-directory name
      ),
      { minLength: 1, maxLength: 4 }
    )
  )
  .map(([wsPath, topNames, nestingInfo]) => {
    // Deduplicate top-level names
    const uniqueTopNames = [...new Set(topNames)];
    const repos: RepoInfo[] = [];

    for (let i = 0; i < uniqueTopNames.length; i++) {
      const topPath = `${wsPath}/${uniqueTopNames[i]}`;
      repos.push({ rootPath: topPath });

      // Optionally add a nested repo
      const nesting = nestingInfo[i % nestingInfo.length];
      if (nesting[0]) {
        const nestedPath = `${topPath}/packages/${nesting[1]}`;
        // Only add if it's actually different from the parent
        if (nestedPath !== topPath) {
          repos.push({ rootPath: nestedPath });
        }
      }
    }

    return { workspacePath: wsPath, repos };
  });

/**
 * Generate a WriteAction whose filePath is workspace-relative and falls
 * under a specific repo. The caller provides the workspace path and repo path.
 */
function writeActionUnderRepoArb(
  workspacePath: string,
  repoPath: string
): fc.Arbitrary<{ action: WriteAction; expectedRepo: string }> {
  const wsPrefix = ensureTrailingSlash(normalizePath(workspacePath));
  const normalizedRepo = normalizePath(repoPath);

  // The repo-relative portion of the path (what comes after the repo root)
  // We need the workspace-relative path: strip wsPrefix from repoPath, then add file
  const repoRelativeToWs = normalizedRepo.startsWith(wsPrefix)
    ? normalizedRepo.slice(wsPrefix.length)
    : "";

  return fc
    .tuple(
      fc.array(dirSegmentArb, { minLength: 0, maxLength: 2 }),
      fileNameArb,
      actionTypeArb,
      contentArb,
      contentArb,
      timestampArb
    )
    .map(([subDirs, fileName, actionType, original, modified, emittedAt]) => {
      // Build workspace-relative path: repoRelativeToWs / subDirs / fileName
      const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
      const filePath = repoRelativeToWs
        ? `${repoRelativeToWs}/${subPath}${fileName}`
        : `${subPath}${fileName}`;

      return {
        action: {
          actionType,
          filePath,
          originalContent: original,
          modifiedContent: modified,
          emittedAt,
        },
        expectedRepo: normalizedRepo,
      };
    });
}

// ── Property 1: Grouping assigns each action to the longest-prefix repository ──

describe("Feature: repo-aware-checkpoint-routing, Property 1: Grouping assigns each action to the longest-prefix repository", () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.4**
   *
   * For any set of repositories (including nested repos) and for any list of
   * WriteActions whose absolute paths fall under at least one repository,
   * each action SHALL be assigned to the repository with the longest matching
   * root path prefix.
   */
  it("each action is assigned to the repo with the longest matching prefix", () => {
    fc.assert(
      fc.property(
        nestedRepoSetArb.chain(({ workspacePath, repos }) => {
          // For each repo, generate 1-3 actions that fall under it
          const actionArbs = repos.map((repo) =>
            fc
              .array(writeActionUnderRepoArb(workspacePath, repo.rootPath), {
                minLength: 1,
                maxLength: 3,
              })
          );

          return fc.tuple(
            fc.constant(workspacePath),
            fc.constant(repos),
            ...actionArbs
          );
        }),
        (tuple) => {
          const [workspacePath, repos, ...actionGroups] = tuple as [
            string,
            RepoInfo[],
            ...Array<Array<{ action: WriteAction; expectedRepo: string }>>
          ];

          // Flatten all generated actions with their expected repos
          const allGenerated = actionGroups.flat();
          const actions = allGenerated.map((g) => g.action);

          // Run groupActionsByRepo
          const result = groupActionsByRepo(actions, repos, workspacePath);

          // For each generated action, verify it ended up in the correct group
          for (const { action, expectedRepo: generatedUnderRepo } of allGenerated) {
            // Resolve the absolute path of this action
            const absolutePath =
              ensureTrailingSlash(normalizePath(workspacePath)) +
              normalizePath(action.filePath);

            // Independently compute the expected repo (longest prefix match)
            const expectedRepo = findRepoForFile(absolutePath, repos);
            expect(expectedRepo).not.toBeNull();

            // Find which group this action ended up in
            // The action's filePath was converted to repo-relative in the group,
            // so we need to check by reconstructing the absolute path from each group
            const matchingGroup = result.groups.find((g) => {
              const groupRepoPrefix = ensureTrailingSlash(normalizePath(g.repoPath));
              return g.actions.some((groupAction) => {
                const reconstructed = groupRepoPrefix + normalizePath(groupAction.filePath);
                return reconstructed === absolutePath;
              });
            });

            expect(matchingGroup).toBeDefined();
            expect(normalizePath(matchingGroup!.repoPath)).toBe(
              normalizePath(expectedRepo!.rootPath)
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * Specifically tests that nested repos win over parent repos.
   * When a file is under both a parent repo and a nested child repo,
   * it must be assigned to the nested (longer prefix) repo.
   */
  it("nested repo takes priority over parent repo", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        dirSegmentArb,
        fileNameArb,
        actionTypeArb,
        contentArb,
        timestampArb,
        (wsPath, parentName, nestedName, fileName, actionType, content, ts) => {
          const parentRepo = `${wsPath}/${parentName}`;
          const nestedRepo = `${parentRepo}/packages/${nestedName}`;
          const repos: RepoInfo[] = [
            { rootPath: parentRepo },
            { rootPath: nestedRepo },
          ];

          // Create an action under the nested repo
          const wsRelativePath = `${parentName}/packages/${nestedName}/${fileName}`;
          const action: WriteAction = {
            actionType,
            filePath: wsRelativePath,
            originalContent: content,
            modifiedContent: content,
            emittedAt: ts,
          };

          const result = groupActionsByRepo([action], repos, wsPath);

          // Should have exactly one group, for the nested repo
          expect(result.orphans).toHaveLength(0);
          expect(result.groups).toHaveLength(1);
          expect(normalizePath(result.groups[0].repoPath)).toBe(
            normalizePath(nestedRepo)
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.4**
   *
   * When actions span multiple repos, separate groups are produced for each.
   */
  it("actions spanning multiple repos produce separate groups", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        dirSegmentArb,
        fileNameArb,
        fileNameArb,
        actionTypeArb,
        contentArb,
        timestampArb,
        (wsPath, repoA, repoB, fileA, fileB, actionType, content, ts) => {
          // Ensure repo names are distinct
          fc.pre(repoA !== repoB);

          const repos: RepoInfo[] = [
            { rootPath: `${wsPath}/${repoA}` },
            { rootPath: `${wsPath}/${repoB}` },
          ];

          const actions: WriteAction[] = [
            {
              actionType,
              filePath: `${repoA}/${fileA}`,
              originalContent: content,
              modifiedContent: content,
              emittedAt: ts,
            },
            {
              actionType,
              filePath: `${repoB}/${fileB}`,
              originalContent: content,
              modifiedContent: content,
              emittedAt: ts + 1,
            },
          ];

          const result = groupActionsByRepo(actions, repos, wsPath);

          expect(result.orphans).toHaveLength(0);
          expect(result.groups).toHaveLength(2);

          // Each group should have exactly one action
          for (const group of result.groups) {
            expect(group.actions).toHaveLength(1);
          }

          // The two groups should be for different repos
          const repoPaths = result.groups.map((g) => normalizePath(g.repoPath));
          expect(new Set(repoPaths).size).toBe(2);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 2: Orphan exclusion ─────────────────────────────────────

/**
 * Generate a WriteAction whose filePath is workspace-relative but falls
 * outside all provided repo roots. The orphan path is placed under a
 * dedicated "orphan" directory that is guaranteed not to be a repo root.
 */
function orphanWriteActionArb(
  workspacePath: string,
  repos: RepoInfo[]
): fc.Arbitrary<WriteAction> {
  // Collect all repo directory names relative to workspace so we can avoid them
  const wsPrefix = ensureTrailingSlash(normalizePath(workspacePath));
  const repoRelDirs = new Set(
    repos.map((r) => {
      const normalized = normalizePath(r.rootPath);
      return normalized.startsWith(wsPrefix)
        ? normalized.slice(wsPrefix.length).split("/")[0]
        : "";
    }).filter(Boolean)
  );

  return fc
    .tuple(
      dirSegmentArb,
      fc.array(dirSegmentArb, { minLength: 0, maxLength: 2 }),
      fileNameArb,
      actionTypeArb,
      contentArb,
      contentArb,
      timestampArb
    )
    .filter(([orphanDir]) => !repoRelDirs.has(orphanDir))
    .map(([orphanDir, subDirs, fileName, actionType, original, modified, emittedAt]) => {
      const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
      const filePath = `${orphanDir}/${subPath}${fileName}`;
      return {
        actionType,
        filePath,
        originalContent: original,
        modifiedContent: modified,
        emittedAt,
      };
    });
}

describe("Feature: repo-aware-checkpoint-routing, Property 2: Orphan exclusion", () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * For any set of repositories and for any WriteAction whose absolute path
   * does not fall under any repository root, that action SHALL appear in the
   * orphans list and SHALL NOT appear in any repository group.
   */
  it("orphan actions appear in orphans list and not in any group", () => {
    fc.assert(
      fc.property(
        nestedRepoSetArb.chain(({ workspacePath, repos }) =>
          fc.tuple(
            fc.constant(workspacePath),
            fc.constant(repos),
            fc.array(orphanWriteActionArb(workspacePath, repos), {
              minLength: 1,
              maxLength: 5,
            })
          )
        ),
        ([workspacePath, repos, orphanActions]) => {
          const result = groupActionsByRepo(orphanActions, repos, workspacePath);

          // All orphan actions must appear in the orphans list
          expect(result.orphans).toHaveLength(orphanActions.length);

          // No orphan action should appear in any group
          const allGroupedActions = result.groups.flatMap((g) => g.actions);
          expect(allGroupedActions).toHaveLength(0);

          // Verify each original orphan action is present in the orphans list
          // (orphans are returned with their original workspace-relative filePath)
          for (const orphan of orphanActions) {
            const found = result.orphans.some(
              (o) =>
                o.filePath === orphan.filePath &&
                o.actionType === orphan.actionType &&
                o.emittedAt === orphan.emittedAt
            );
            expect(found).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.3**
   *
   * When a mix of orphan and non-orphan actions is provided, orphans end up
   * exclusively in the orphans list and non-orphans exclusively in groups.
   */
  it("mixed actions: orphans and non-orphans are correctly separated", () => {
    fc.assert(
      fc.property(
        nestedRepoSetArb.chain(({ workspacePath, repos }) => {
          // Generate some actions under repos and some orphans
          const repoActionArbs = repos.map((repo) =>
            fc.array(writeActionUnderRepoArb(workspacePath, repo.rootPath), {
              minLength: 1,
              maxLength: 2,
            })
          );

          return fc.tuple(
            fc.constant(workspacePath),
            fc.constant(repos),
            fc.array(orphanWriteActionArb(workspacePath, repos), {
              minLength: 1,
              maxLength: 3,
            }),
            ...repoActionArbs
          );
        }),
        (tuple) => {
          const [workspacePath, repos, orphanActions, ...repoActionGroups] =
            tuple as [
              string,
              RepoInfo[],
              WriteAction[],
              ...Array<Array<{ action: WriteAction; expectedRepo: string }>>
            ];

          const repoActions = repoActionGroups.flat().map((g) => g.action);
          const allActions = [...orphanActions, ...repoActions];

          const result = groupActionsByRepo(allActions, repos, workspacePath);

          // Orphan count must match
          expect(result.orphans).toHaveLength(orphanActions.length);

          // Grouped action count must match non-orphan count
          const totalGrouped = result.groups.reduce(
            (sum, g) => sum + g.actions.length,
            0
          );
          expect(totalGrouped).toBe(repoActions.length);

          // Verify each orphan is in the orphans list by identity
          for (const orphan of orphanActions) {
            const found = result.orphans.some(
              (o) =>
                o.filePath === orphan.filePath &&
                o.actionType === orphan.actionType &&
                o.emittedAt === orphan.emittedAt
            );
            expect(found).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 3: Partition completeness ───────────────────────────────

describe("Feature: repo-aware-checkpoint-routing, Property 3: Partition completeness", () => {
  /**
   * **Validates: Requirements 2.1, 2.3**
   *
   * For any set of repositories and for any list of WriteActions (mix of
   * repo-bound and orphan actions), every action SHALL appear either in
   * exactly one repository group or in the orphans list, and the total count
   * of grouped actions plus orphaned actions SHALL equal the original action
   * count.
   */
  it("total grouped actions + orphans equals original action count", () => {
    fc.assert(
      fc.property(
        nestedRepoSetArb.chain(({ workspacePath, repos }) => {
          // Generate a mix of repo-bound and orphan actions
          const repoActionArbs = repos.map((repo) =>
            fc.array(writeActionUnderRepoArb(workspacePath, repo.rootPath), {
              minLength: 0,
              maxLength: 3,
            })
          );

          return fc.tuple(
            fc.constant(workspacePath),
            fc.constant(repos),
            fc.array(orphanWriteActionArb(workspacePath, repos), {
              minLength: 0,
              maxLength: 3,
            }),
            ...repoActionArbs
          );
        }),
        (tuple) => {
          const [workspacePath, repos, orphanActions, ...repoActionGroups] =
            tuple as [
              string,
              RepoInfo[],
              WriteAction[],
              ...Array<Array<{ action: WriteAction; expectedRepo: string }>>
            ];

          const repoActions = repoActionGroups.flat().map((g) => g.action);
          const allActions = [...repoActions, ...orphanActions];

          const result = groupActionsByRepo(allActions, repos, workspacePath);

          // Count total grouped actions across all groups
          const totalGrouped = result.groups.reduce(
            (sum, g) => sum + g.actions.length,
            0
          );

          // Partition completeness: grouped + orphans === original count
          expect(totalGrouped + result.orphans.length).toBe(allActions.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.1, 2.3**
   *
   * No action appears in more than one group. Each action's absolute path
   * (reconstructed from the group's repoPath + repo-relative filePath) must
   * be unique across all groups.
   */
  it("no action appears in more than one group", () => {
    fc.assert(
      fc.property(
        nestedRepoSetArb.chain(({ workspacePath, repos }) => {
          const repoActionArbs = repos.map((repo) =>
            fc.array(writeActionUnderRepoArb(workspacePath, repo.rootPath), {
              minLength: 0,
              maxLength: 3,
            })
          );

          return fc.tuple(
            fc.constant(workspacePath),
            fc.constant(repos),
            fc.array(orphanWriteActionArb(workspacePath, repos), {
              minLength: 0,
              maxLength: 3,
            }),
            ...repoActionArbs
          );
        }),
        (tuple) => {
          const [workspacePath, repos, orphanActions, ...repoActionGroups] =
            tuple as [
              string,
              RepoInfo[],
              WriteAction[],
              ...Array<Array<{ action: WriteAction; expectedRepo: string }>>
            ];

          const repoActions = repoActionGroups.flat().map((g) => g.action);
          const allActions = [...repoActions, ...orphanActions];

          const result = groupActionsByRepo(allActions, repos, workspacePath);

          // Reconstruct absolute paths for every grouped action and check uniqueness
          const allAbsolutePaths: string[] = [];
          for (const group of result.groups) {
            const repoPrefix = ensureTrailingSlash(normalizePath(group.repoPath));
            for (const action of group.actions) {
              allAbsolutePaths.push(repoPrefix + normalizePath(action.filePath));
            }
          }

          // No duplicates — each action appears in at most one group
          const uniquePaths = new Set(allAbsolutePaths);
          expect(uniquePaths.size).toBe(allAbsolutePaths.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ── Property 4: Path conversion round-trip ───────────────────────────

describe("Feature: repo-aware-checkpoint-routing, Property 4: Path conversion round-trip", () => {

  /**
   * **Validates: Requirements 3.1, 7.4**
   *
   * For any workspace root path, for any repository root path that is a
   * subdirectory of the workspace root, and for any workspace-relative file
   * path that falls under the repository, converting the path to repo-relative
   * and then resolving it against the repository root SHALL produce the same
   * absolute path as resolving the original workspace-relative path against
   * the workspace root.
   */
  it("toRepoRelativePath round-trips: resolve(repoPath, toRepoRelativePath(...)) === resolve(wsPath, wsRelPath)", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        fc.array(dirSegmentArb, { minLength: 0, maxLength: 2 }),
        fileNameArb,
        (wsPath, repoName, subDirs, fileName) => {
          // Repo is a subdirectory of the workspace
          const repoPath = `${wsPath}/${repoName}`;

          // Build a workspace-relative path that falls under the repo
          const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
          const wsRelPath = `${repoName}/${subPath}${fileName}`;

          // Convert workspace-relative to repo-relative
          const repoRelPath = toRepoRelativePath(wsRelPath, wsPath, repoPath);

          // Round-trip: resolve repo-relative against repo root
          const resolvedViaRepo =
            ensureTrailingSlash(normalizePath(repoPath)) + repoRelPath;

          // Direct: resolve workspace-relative against workspace root
          const resolvedViaWs =
            ensureTrailingSlash(normalizePath(wsPath)) + normalizePath(wsRelPath);

          expect(resolvedViaRepo).toBe(resolvedViaWs);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.1, 7.4**
   *
   * Round-trip holds for nested repos (repo inside another repo's subtree).
   * The file is under the nested repo, so the conversion should use the
   * nested repo path and still round-trip correctly.
   */
  it("round-trip holds for nested repo paths", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        dirSegmentArb,
        fc.array(dirSegmentArb, { minLength: 0, maxLength: 2 }),
        fileNameArb,
        (wsPath, parentName, nestedName, subDirs, fileName) => {
          // Nested repo: wsPath/parentName/packages/nestedName
          const nestedRepoPath = `${wsPath}/${parentName}/packages/${nestedName}`;

          // Build workspace-relative path under the nested repo
          const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
          const wsRelPath = `${parentName}/packages/${nestedName}/${subPath}${fileName}`;

          // Convert workspace-relative to repo-relative using nested repo
          const repoRelPath = toRepoRelativePath(wsRelPath, wsPath, nestedRepoPath);

          // Round-trip: resolve repo-relative against nested repo root
          const resolvedViaRepo =
            ensureTrailingSlash(normalizePath(nestedRepoPath)) + repoRelPath;

          // Direct: resolve workspace-relative against workspace root
          const resolvedViaWs =
            ensureTrailingSlash(normalizePath(wsPath)) + normalizePath(wsRelPath);

          expect(resolvedViaRepo).toBe(resolvedViaWs);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ── Property 5: Single-repo identity ─────────────────────────────────

describe("Feature: repo-aware-checkpoint-routing, Property 5: Single-repo identity", () => {
  /**
   * **Validates: Requirements 3.4, 5.1, 5.3**
   *
   * For any workspace root path that is also a repository root, and for any
   * workspace-relative file path, converting to repo-relative SHALL produce
   * a path identical to the original workspace-relative path (after
   * forward-slash normalization).
   */
  it("when wsPath === repoPath, toRepoRelativePath returns the original path unchanged", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        fc.array(dirSegmentArb, { minLength: 0, maxLength: 3 }),
        fileNameArb,
        (wsPath, subDirs, fileName) => {
          // Single-repo case: workspace root IS the repo root
          const repoPath = wsPath;

          // Build a workspace-relative file path
          const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
          const wsRelPath = `${subPath}${fileName}`;

          // Convert workspace-relative to repo-relative
          const repoRelPath = toRepoRelativePath(wsRelPath, wsPath, repoPath);

          // The result should be identical to the original (forward-slash normalized)
          expect(repoRelPath).toBe(normalizePath(wsRelPath));
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.4, 5.1, 5.3**
   *
   * When workspace root === repo root, groupActionsByRepo should produce
   * repo-relative paths identical to the original workspace-relative paths.
   * This ensures single-repo workspaces see no behavioral change.
   */
  it("single-repo grouping preserves original workspace-relative paths", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        fc.array(
          fc.tuple(
            fc.array(dirSegmentArb, { minLength: 0, maxLength: 2 }),
            fileNameArb,
            actionTypeArb,
            contentArb,
            contentArb,
            timestampArb
          ),
          { minLength: 1, maxLength: 5 }
        ),
        (wsPath, actionTuples) => {
          // Single-repo: workspace root is the repo root
          const repos: RepoInfo[] = [{ rootPath: wsPath }];

          const actions: WriteAction[] = actionTuples.map(
            ([subDirs, fileName, actionType, original, modified, emittedAt]) => {
              const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
              return {
                actionType,
                filePath: `${subPath}${fileName}`,
                originalContent: original,
                modifiedContent: modified,
                emittedAt,
              };
            }
          );

          const result = groupActionsByRepo(actions, repos, wsPath);

          // No orphans — all files are under the single repo
          expect(result.orphans).toHaveLength(0);

          // Exactly one group for the single repo
          expect(result.groups).toHaveLength(1);
          expect(normalizePath(result.groups[0].repoPath)).toBe(normalizePath(wsPath));

          // Each grouped action's filePath should match the original (normalized)
          expect(result.groups[0].actions).toHaveLength(actions.length);
          for (let i = 0; i < actions.length; i++) {
            expect(result.groups[0].actions[i].filePath).toBe(
              normalizePath(actions[i].filePath)
            );
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 3.4, 5.1, 5.3**
   *
   * When workspace root === repo root and paths contain Windows-style
   * backslashes, the result should still equal the forward-slash normalized
   * original path.
   */
  it("single-repo identity holds with backslash paths", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        fc.array(dirSegmentArb, { minLength: 1, maxLength: 3 }),
        fileNameArb,
        (wsPath, subDirs, fileName) => {
          const repoPath = wsPath;

          // Build a workspace-relative path with backslashes (Windows-style)
          const wsRelPathBackslash = subDirs.join("\\") + "\\" + fileName;

          // Convert workspace-relative to repo-relative
          const repoRelPath = toRepoRelativePath(wsRelPathBackslash, wsPath, repoPath);

          // The result should be the forward-slash normalized version
          expect(repoRelPath).toBe(normalizePath(wsRelPathBackslash));
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ── Property 6: Output path format invariants ────────────────────────

describe("Feature: repo-aware-checkpoint-routing, Property 6: Output path format invariants", () => {
  /**
   * **Validates: Requirements 7.1, 7.2**
   *
   * For any valid path conversion from workspace-relative to repo-relative,
   * the resulting path SHALL contain only forward slashes (no backslashes)
   * and SHALL NOT start with a path separator character.
   */
  it("toRepoRelativePath output contains no backslashes and no leading separator", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        fc.array(dirSegmentArb, { minLength: 0, maxLength: 3 }),
        fileNameArb,
        (wsPath, repoName, subDirs, fileName) => {
          const repoPath = `${wsPath}/${repoName}`;

          // Build a workspace-relative path under the repo
          const subPath = subDirs.length > 0 ? subDirs.join("/") + "/" : "";
          const wsRelPath = `${repoName}/${subPath}${fileName}`;

          const result = toRepoRelativePath(wsRelPath, wsPath, repoPath);

          // No backslashes
          expect(result).not.toContain("\\");
          // No leading separator
          expect(result).not.toMatch(/^[/\\]/);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.1, 7.2**
   *
   * When input paths contain Windows-style backslashes, toRepoRelativePath
   * still produces output with only forward slashes and no leading separator.
   */
  it("toRepoRelativePath normalizes Windows-style backslash inputs", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        fc.array(dirSegmentArb, { minLength: 1, maxLength: 3 }),
        fileNameArb,
        (wsPath, repoName, subDirs, fileName) => {
          const repoPath = `${wsPath}/${repoName}`;

          // Build a workspace-relative path with backslashes (Windows-style)
          const wsRelPathBackslash =
            repoName + "\\" + subDirs.join("\\") + "\\" + fileName;

          const result = toRepoRelativePath(wsRelPathBackslash, wsPath, repoPath);

          // No backslashes in output
          expect(result).not.toContain("\\");
          // No leading separator
          expect(result).not.toMatch(/^[/\\]/);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.1, 7.2**
   *
   * All filePaths in groupActionsByRepo output groups contain only forward
   * slashes and do not start with a path separator.
   */
  it("groupActionsByRepo output filePaths have no backslashes and no leading separator", () => {
    fc.assert(
      fc.property(
        nestedRepoSetArb.chain(({ workspacePath, repos }) => {
          // Generate actions under each repo
          const actionArbs = repos.map((repo) =>
            fc.array(writeActionUnderRepoArb(workspacePath, repo.rootPath), {
              minLength: 1,
              maxLength: 3,
            })
          );

          return fc.tuple(
            fc.constant(workspacePath),
            fc.constant(repos),
            ...actionArbs
          );
        }),
        (tuple) => {
          const [workspacePath, repos, ...actionGroups] = tuple as [
            string,
            RepoInfo[],
            ...Array<Array<{ action: WriteAction; expectedRepo: string }>>
          ];

          const actions = actionGroups.flat().map((g) => g.action);
          const result = groupActionsByRepo(actions, repos, workspacePath);

          for (const group of result.groups) {
            for (const action of group.actions) {
              // No backslashes
              expect(action.filePath).not.toContain("\\");
              // No leading separator
              expect(action.filePath).not.toMatch(/^[/\\]/);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 7.1, 7.2**
   *
   * When input WriteActions contain Windows-style backslash paths,
   * groupActionsByRepo still produces output filePaths with only forward
   * slashes and no leading separator.
   */
  it("groupActionsByRepo normalizes backslash input paths in output", () => {
    fc.assert(
      fc.property(
        workspacePathArb,
        dirSegmentArb,
        fc.array(dirSegmentArb, { minLength: 1, maxLength: 2 }),
        fileNameArb,
        actionTypeArb,
        contentArb,
        timestampArb,
        (wsPath, repoName, subDirs, fileName, actionType, content, ts) => {
          const repos: RepoInfo[] = [{ rootPath: `${wsPath}/${repoName}` }];

          // Build a workspace-relative path with backslashes
          const wsRelPathBackslash =
            repoName + "\\" + subDirs.join("\\") + "\\" + fileName;

          const actions: WriteAction[] = [
            {
              actionType,
              filePath: wsRelPathBackslash,
              originalContent: content,
              modifiedContent: content,
              emittedAt: ts,
            },
          ];

          const result = groupActionsByRepo(actions, repos, wsPath);

          // Should have one group, no orphans
          expect(result.orphans).toHaveLength(0);
          expect(result.groups).toHaveLength(1);

          for (const action of result.groups[0].actions) {
            // No backslashes in output
            expect(action.filePath).not.toContain("\\");
            // No leading separator
            expect(action.filePath).not.toMatch(/^[/\\]/);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
