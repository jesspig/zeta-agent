import type { RuntimeProtocol, RuntimeSessionCompactResult } from "@zeta-agent/agent";

export type CompactNotice = (text: string) => void;

/** CLI /compact 的生产执行入口：只调用真实 RuntimeProtocol，无持久会话时明确失败。 */
export async function runCompactCommand(
  protocol: RuntimeProtocol,
  notice: CompactNotice
): Promise<boolean> {
  const control = protocol.sessionControl;
  if (control === undefined) {
    notice("compact: 需要持久会话控制面；当前为内存态会话，未执行压缩");
    return false;
  }
  try {
    const result: RuntimeSessionCompactResult = await control.compact(protocol.session.id);
    if (!result.compacted) {
      notice("compact: 控制面未确认压缩，未改变会话");
      return false;
    }
    notice(
      `compact: 已写入 frame=${result.frameId ?? "unknown"}，workspace 块=${result.uris.length}`
    );
    return true;
  } catch (error) {
    notice(`compact 失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
