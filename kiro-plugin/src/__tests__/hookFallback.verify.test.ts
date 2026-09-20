/**
 * 验证 core.hooksPath 被覆盖到不可写/含二进制 hook 的目录时的降级行为。
 *
 * 背景（实测环境）：企业安全工具会在系统级 gitconfig 里设置
 * core.hooksPath 指向一个 root 所有、不可写、且其中 hook 是编译型二进制的目录。
 * 此时：
 *  - 绝不能写入该目录（会破坏对方 hook，且影响本机所有仓库）
 *  - 但也不能什么都不做，否则该仓库完全采集不到数据
 * 正确行为是降级安装到仓库自身的 hooks 目录，并如实报告 effective=false，
 * 让扩展改由自身上传统计。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("vscode", () => ({}));

import {
  resolveHookTarget,
  isPostCommitHookEffective,
  HOOKS_DISABLED,
} from "../gitUtils";

const sh = (cmd: string, cwd: string) =>
  execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });

const POST_COMMIT_MARKER = "# >>> git-ai-kiro post-commit hook >>>";

let base: string;
let repo: string;
let savedNoSystem: string | undefined;
let savedGlobal: string | undefined;

beforeAll(() => {
  savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";

  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hookfb-")));
  repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  sh("git init -q", repo);
  sh("git config user.email t@example.com", repo);
  sh("git config user.name tester", repo);
  fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
  sh("git add -A", repo);
  sh("git commit -qm init", repo);
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

describe("resolveHookTarget 降级策略", () => {
  it("无 core.hooksPath 时用仓库自身 hooks 目录且 effective=true", () => {
    const t = resolveHookTarget(repo, "post-commit");
    expect(t.dir).toBe(path.join(repo, ".git", "hooks"));
    expect(t.effective).toBe(true);
  });

  it("core.hooksPath 指向可写的外部目录时采用它，但标记为全机生效", () => {
    const shared = path.join(base, "shared-writable");
    fs.mkdirSync(shared, { recursive: true });
    sh(`git config core.hooksPath "${shared}"`, repo);

    const t = resolveHookTarget(repo, "post-commit");
    expect(t.dir).toBe(shared);
    expect(t.effective).toBe(true);

    sh("git config --unset core.hooksPath", repo);
  });

  it("core.hooksPath 目录含二进制 hook 时降级到仓库内，且 effective=false", () => {
    const corp = path.join(base, "corp-binary");
    fs.mkdirSync(corp, { recursive: true });
    // 模拟企业安全工具的编译型 hook（含 NUL 字节）
    fs.writeFileSync(
      path.join(corp, "post-commit"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff, 0xfe, 0x00])
    );
    sh(`git config core.hooksPath "${corp}"`, repo);

    const t = resolveHookTarget(repo, "post-commit");
    // 关键：不写入企业目录，改用仓库自身目录
    expect(t.dir).toBe(path.join(repo, ".git", "hooks"));
    // 关键：如实报告 git 不会执行它
    expect(t.effective).toBe(false);

    sh("git config --unset core.hooksPath", repo);
  });

  it("core.hooksPath 目录不可写时降级到仓库内，且 effective=false", () => {
    const ro = path.join(base, "readonly");
    fs.mkdirSync(ro, { recursive: true });
    fs.chmodSync(ro, 0o500); // r-x：不可写
    sh(`git config core.hooksPath "${ro}"`, repo);

    const t = resolveHookTarget(repo, "post-commit");
    expect(t.dir).toBe(path.join(repo, ".git", "hooks"));
    expect(t.effective).toBe(false);

    sh("git config --unset core.hooksPath", repo);
    fs.chmodSync(ro, 0o700);
  });

  it("core.hooksPath=/dev/null 表示禁用，返回 HOOKS_DISABLED", () => {
    sh("git config core.hooksPath /dev/null", repo);
    const t = resolveHookTarget(repo, "post-commit");
    expect(t.dir).toBe(HOOKS_DISABLED);
    expect(t.effective).toBe(false);
    sh("git config --unset core.hooksPath", repo);
  });
});

describe("isPostCommitHookEffective — 决定扩展是否需要自行上传", () => {
  it("生效 hooks 目录中存在带标记的 hook → true", () => {
    const hooks = path.join(repo, ".git", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, "post-commit"),
      `#!/bin/sh\n${POST_COMMIT_MARKER}\necho hi\n`,
      "utf-8"
    );
    expect(isPostCommitHookEffective(repo)).toBe(true);
  });

  it("hook 装在仓库内但 core.hooksPath 指向别处 → false（git 不会执行它）", () => {
    const corp = path.join(base, "corp2");
    fs.mkdirSync(corp, { recursive: true });
    sh(`git config core.hooksPath "${corp}"`, repo);
    // 仓库内那份带标记的 hook 仍然存在，但 git 只看 corp/
    expect(isPostCommitHookEffective(repo)).toBe(false);
    sh("git config --unset core.hooksPath", repo);
  });

  it("生效目录中的 hook 不含我们的标记 → false", () => {
    const hooks = path.join(repo, ".git", "hooks");
    fs.writeFileSync(
      path.join(hooks, "post-commit"),
      "#!/bin/sh\necho someone-elses-hook\n",
      "utf-8"
    );
    expect(isPostCommitHookEffective(repo)).toBe(false);
  });

  it("生效目录中的 hook 是二进制 → false（不去解析，也不误判为已生效）", () => {
    const hooks = path.join(repo, ".git", "hooks");
    fs.writeFileSync(
      path.join(hooks, "post-commit"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01])
    );
    expect(isPostCommitHookEffective(repo)).toBe(false);
  });
});
