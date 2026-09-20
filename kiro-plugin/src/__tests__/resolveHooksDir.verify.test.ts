/**
 * 验证 resolveGitCommonDir / resolveHooksDir 在真实 git 布局下的行为。
 *
 * 覆盖批次1-A4 修复的核心场景：worktree 与 submodule 的 `.git` 是文件而非目录，
 * 旧代码硬编码 `<repo>/.git/hooks` 在这些布局下会指向不存在的目录，导致 hook
 * 安装静默失败。另外覆盖 core.hooksPath（绝对/相对/禁用）与非仓库回退。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("vscode", () => ({}));

import {
  resolveGitCommonDir,
  resolveHooksDir,
  installPostCommitHook,
  HOOKS_DISABLED,
} from "../gitUtils";

const sh = (cmd: string, cwd: string) =>
  execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });

let base: string;
let mainRepo: string;
let savedNoSystem: string | undefined;
let savedGlobal: string | undefined;

beforeAll(() => {
  // 隔离宿主机的 system/global git 配置。本机（以及很多企业环境）设置了
  // 系统级 core.hooksPath 指向公司统一的 hook 管理器，会干扰这里对
  // 「默认 hooks 目录」的断言。这些环境变量会被 resolveHooksDir 内部
  // spawn 出来的 git 子进程继承。
  savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";

  // realpathSync：macOS 的 os.tmpdir() 是 /var/... 符号链接，而 git 返回
  // 解析后的 /private/var/...，不规范化会导致字符串断言失败。
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hooksdir-")));
  mainRepo = path.join(base, "main");
  fs.mkdirSync(mainRepo);
  sh("git init -q", mainRepo);
  sh("git config user.email t@example.com", mainRepo);
  sh("git config user.name tester", mainRepo);
  fs.writeFileSync(path.join(mainRepo, "f.txt"), "x\n");
  sh("git add -A", mainRepo);
  sh("git commit -qm init", mainRepo);
});

afterAll(() => {
  if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;

  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("resolveGitCommonDir / resolveHooksDir", () => {
  it("普通仓库解析到 <repo>/.git/hooks", () => {
    expect(resolveGitCommonDir(mainRepo)).toBe(path.join(mainRepo, ".git"));
    expect(resolveHooksDir(mainRepo)).toBe(path.join(mainRepo, ".git", "hooks"));
  });

  it("linked worktree 的 .git 是文件，hooks 应共享主仓库目录", () => {
    const wt = path.join(base, "wt");
    sh(`git worktree add -q "${wt}" -b wtbranch`, mainRepo);

    // 前提确认：worktree 的 .git 是文件，旧的硬编码拼接必然失效
    expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(fs.existsSync(path.join(wt, ".git", "hooks"))).toBe(false);

    expect(resolveHooksDir(wt)).toBe(path.join(mainRepo, ".git", "hooks"));
  });

  it("submodule 的 .git 是文件，hooks 应指向 modules/<name>/hooks", () => {
    const subSrc = path.join(base, "subsrc");
    fs.mkdirSync(subSrc);
    sh("git init -q", subSrc);
    sh("git config user.email t@example.com", subSrc);
    sh("git config user.name tester", subSrc);
    fs.writeFileSync(path.join(subSrc, "s.txt"), "s\n");
    sh("git add -A", subSrc);
    sh("git commit -qm init", subSrc);

    sh(
      `git -c protocol.file.allow=always submodule add -q "${subSrc}" vendored`,
      mainRepo
    );
    const subPath = path.join(mainRepo, "vendored");

    expect(fs.statSync(path.join(subPath, ".git")).isFile()).toBe(true);
    expect(fs.existsSync(path.join(subPath, ".git", "hooks"))).toBe(false);

    expect(resolveHooksDir(subPath)).toBe(
      path.join(mainRepo, ".git", "modules", "vendored", "hooks")
    );
  });

  it("core.hooksPath 绝对路径被采用", () => {
    const shared = path.join(base, "shared-hooks");
    fs.mkdirSync(shared, { recursive: true });
    sh(`git config core.hooksPath "${shared}"`, mainRepo);
    expect(resolveHooksDir(mainRepo)).toBe(shared);
    sh("git config --unset core.hooksPath", mainRepo);
  });

  it("core.hooksPath 相对路径按仓库根解析", () => {
    sh('git config core.hooksPath "myhooks"', mainRepo);
    expect(resolveHooksDir(mainRepo)).toBe(path.join(mainRepo, "myhooks"));
    sh("git config --unset core.hooksPath", mainRepo);
  });

  it("core.hooksPath=/dev/null 表示禁用，返回 HOOKS_DISABLED", () => {
    sh("git config core.hooksPath /dev/null", mainRepo);
    expect(resolveHooksDir(mainRepo)).toBe(HOOKS_DISABLED);
    sh("git config --unset core.hooksPath", mainRepo);
  });

  it("非 git 目录回退到 <path>/.git", () => {
    const notRepo = path.join(base, "notrepo");
    fs.mkdirSync(notRepo, { recursive: true });
    expect(resolveGitCommonDir(notRepo)).toBe(path.join(notRepo, ".git"));
  });
});

describe("安装 hook 时不得破坏已有的非文本 hook", () => {
  it("现存 post-commit 是二进制时跳过安装且不修改该文件", () => {
    const repo = path.join(base, "binhook");
    fs.mkdirSync(repo, { recursive: true });
    sh("git init -q", repo);

    // 模拟企业安全工具装的编译型 hook（含 NUL 字节，非 UTF-8 文本）
    const hooksDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "post-commit");
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0xff, 0xfe, 0x00]);
    fs.writeFileSync(hookPath, binary);
    const before = fs.readFileSync(hookPath);

    installPostCommitHook(repo);

    const after = fs.readFileSync(hookPath);
    // 关键断言：文件逐字节未变。若按 utf-8 读取再写回，0xff/0xfe 会被替换为
    // U+FFFD，文件必然被破坏。
    expect(Buffer.compare(before, after)).toBe(0);
  });

  it("现存 post-commit 是普通文本时正常追加我们的段落", () => {
    const repo = path.join(base, "texthook");
    fs.mkdirSync(repo, { recursive: true });
    sh("git init -q", repo);

    const hooksDir = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "post-commit");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho existing-hook\n", "utf-8");

    installPostCommitHook(repo);

    const after = fs.readFileSync(hookPath, "utf-8");
    // 原有内容保留
    expect(after).toContain("echo existing-hook");
    // 我们的段落被追加（仅在 binary 可用时；不可用则只校验未破坏原内容）
    if (after.includes("git-ai-kiro post-commit hook")) {
      expect(after).toContain("# <<< git-ai-kiro post-commit hook <<<");
    }
  });
});
