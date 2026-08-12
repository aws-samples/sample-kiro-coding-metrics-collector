/**
 * 批次2 验证：Format C（Kiro 1.0 messages.jsonl）解析与增量读取语义。
 *
 * 重点固化两件事：
 *  1. parseFormatCLog 对真实/畸形 JSONL 的行为（success 过滤、不抛异常）。
 *  2. 增量读取必须按「最后一个完整行」推进偏移量。Kiro 逐行追加并以 \n 结尾，
 *     但 fs.watch 可能在长行（如携带大文件正文的 fs_write）尚未刷完时触发。
 *     若直接把偏移推进到 stat.size，半行会解析失败被丢弃，补齐后也不会重读，
 *     该写操作即永久丢失。
 */
import { describe, it, expect } from "vitest";
import { parseFormatCLog } from "../sessionLogParser";

/** 构造一行 Format C tool_call + 对应 tool_result 的 JSONL 文本 */
function makeEdit(
  id: string,
  filePath: string,
  text: string,
  ts: string,
  success = true
): string {
  const call = {
    id,
    timestamp: ts,
    payload: {
      type: "tool_call",
      toolName: "fs_write",
      actionType: "create",
      kind: "edit",
      toolCallId: id,
      args: { path: filePath, text },
    },
  };
  const result = {
    id: `${id}-r`,
    timestamp: ts,
    payload: { type: "tool_result", toolCallId: id, success },
  };
  return JSON.stringify(call) + "\n" + JSON.stringify(result) + "\n";
}

/**
 * 复刻 watcher 的增量消费语义：仅消费到最后一个完整行，返回新偏移量。
 * 与 processMessagesJsonlIncremental 中的实现保持一致。
 */
function consumeIncremental(
  buf: Buffer,
  lastOffset: number
): { text: string; newOffset: number } {
  const slice = buf.subarray(lastOffset);
  const lastNewline = slice.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return { text: "", newOffset: lastOffset };
  }
  const consumed = lastNewline + 1;
  return {
    text: slice.subarray(0, consumed).toString("utf-8"),
    newOffset: lastOffset + consumed,
  };
}

describe("parseFormatCLog", () => {
  it("提取成功的写操作并带上时间戳", () => {
    const jsonl = makeEdit("a", "/w/x.txt", "hello\n", "2026-08-06T10:00:01Z");
    const r = parseFormatCLog(jsonl);
    expect(r.format).toBe("C");
    expect(r.writeActions).toHaveLength(1);
    expect(r.writeActions[0].filePath).toBe("/w/x.txt");
    expect(r.writeActions[0].modifiedContent).toBe("hello\n");
    expect(r.writeActions[0].emittedAt).toBe(Date.parse("2026-08-06T10:00:01Z"));
  });

  it("排除 tool_result.success !== true 的写操作", () => {
    const jsonl =
      makeEdit("ok", "/w/keep.txt", "a\n", "2026-08-06T10:00:01Z", true) +
      makeEdit("bad", "/w/drop.txt", "b\n", "2026-08-06T10:00:02Z", false);
    const r = parseFormatCLog(jsonl);
    expect(r.writeActions.map((w) => w.filePath)).toEqual(["/w/keep.txt"]);
  });

  it("对畸形输入不抛异常且跳过坏行", () => {
    const good = makeEdit("a", "/w/x.txt", "hi\n", "2026-08-06T10:00:01Z");
    for (const bad of ["", "\n\n", "not json", '{"payload":null}', '{"a":1}']) {
      expect(() => parseFormatCLog(bad)).not.toThrow();
      expect(parseFormatCLog(bad).writeActions).toHaveLength(0);
    }
    // 坏行夹在好行之间：好行仍应被提取
    const mixed = "garbage\n" + good + "{broken\n";
    expect(parseFormatCLog(mixed).writeActions).toHaveLength(1);
  });
});

describe("增量读取按完整行推进偏移量", () => {
  it("半行刷盘时不推进偏移，补齐后完整提取（不丢写操作）", () => {
    const full = makeEdit("a", "/w/big.txt", "x".repeat(200), "2026-08-06T10:00:01Z");
    const fullBuf = Buffer.from(full, "utf-8");

    // 模拟只刷入了前半部分（切在第一行中间，无换行）
    const partialLen = full.indexOf("\n") - 20;
    const partial = fullBuf.subarray(0, partialLen);

    const step1 = consumeIncremental(partial, 0);
    // 关键：没有完整行 → 不消费、不推进
    expect(step1.text).toBe("");
    expect(step1.newOffset).toBe(0);

    // 数据补齐后从原偏移继续读，应完整拿到该写操作
    const step2 = consumeIncremental(fullBuf, step1.newOffset);
    expect(step2.newOffset).toBe(fullBuf.length);
    const actions = parseFormatCLog(step2.text).writeActions;
    expect(actions).toHaveLength(1);
    expect(actions[0].filePath).toBe("/w/big.txt");
    expect(actions[0].modifiedContent).toHaveLength(200);
  });

  it("尾部半行被保留到下次读取，且不重复计入已完整的行", () => {
    const first = makeEdit("a", "/w/one.txt", "1\n", "2026-08-06T10:00:01Z");
    const second = makeEdit("b", "/w/two.txt", "2\n", "2026-08-06T10:00:02Z");

    // 第一次：完整的 first + second 的一部分（末尾无换行）
    const cut = second.indexOf("\n") - 5;
    const chunk1 = Buffer.from(first + second.slice(0, cut), "utf-8");

    const s1 = consumeIncremental(chunk1, 0);
    const a1 = parseFormatCLog(s1.text).writeActions;
    expect(a1.map((w) => w.filePath)).toEqual(["/w/one.txt"]);
    // 偏移只推进到 first 结束处，未越过残缺的 second
    expect(s1.newOffset).toBe(Buffer.byteLength(first, "utf-8"));

    // 第二次：完整数据到位
    const chunk2 = Buffer.from(first + second, "utf-8");
    const s2 = consumeIncremental(chunk2, s1.newOffset);
    const a2 = parseFormatCLog(s2.text).writeActions;
    expect(a2.map((w) => w.filePath)).toEqual(["/w/two.txt"]);
    expect(s2.newOffset).toBe(chunk2.length);

    // 合计恰好两个，无重复无遗漏
    expect(a1.length + a2.length).toBe(2);
  });

  it("无新数据时返回空且偏移不变", () => {
    const full = makeEdit("a", "/w/x.txt", "hi\n", "2026-08-06T10:00:01Z");
    const buf = Buffer.from(full, "utf-8");
    const s1 = consumeIncremental(buf, 0);
    expect(s1.newOffset).toBe(buf.length);
    const s2 = consumeIncremental(buf, s1.newOffset);
    expect(s2.text).toBe("");
    expect(s2.newOffset).toBe(s1.newOffset);
  });

  it("多字节 UTF-8 内容不会在行边界被截断", () => {
    const cn = "中文内容测试\n";
    const full = makeEdit("a", "/w/cn.txt", cn, "2026-08-06T10:00:01Z");
    const buf = Buffer.from(full, "utf-8");
    const s = consumeIncremental(buf, 0);
    const actions = parseFormatCLog(s.text).writeActions;
    expect(actions).toHaveLength(1);
    expect(actions[0].modifiedContent).toBe(cn);
  });
});
