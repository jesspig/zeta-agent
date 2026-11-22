import { expect, test } from "bun:test";
import { collectRpcLines } from "./index";

/** CR-09/stdin：非 TTY 时 RPC 从 stdin 逐帧读取。 */
test("非 TTY 下 stdin 文本按行拆为 RPC 帧，忽略空行", () => {
  const stdin = '{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"text":"a"}}\n\n{"jsonrpc":"2.0","id":2,"method":"continue"}\n';
  const lines = collectRpcLines(undefined, stdin, false);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('"id":1');
  expect(lines[1]).toContain('"id":2');
});

test("TTY 或空 stdin 时回退到 argv 单帧", () => {
  expect(collectRpcLines('{"id":9}', "", true)).toEqual(['{"id":9}']);
  expect(collectRpcLines('{"id":9}', "", false)).toEqual(['{"id":9}']);
  expect(collectRpcLines(undefined, "", false)).toEqual([]);
});
