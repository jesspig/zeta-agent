/**
 * 真实 PTY 异常恢复夹具：启动生产 renderTui/完整 App，模拟运行期异常后走统一收尾路径，
 * 验证终端在异常路径仍被复位（备用屏退出 + raw 模式还原）。仅用于 PTY 门，不进入生产装配。
 */
import { renderTui } from "../runtime";

const handle = await renderTui({
  title: "zeta",
  messages: [],
  onExit() {},
});
try {
  await Bun.sleep(400);
  throw new Error("ABNORMAL_FIXTURE");
} catch {
  await handle.destroy();
  process.exit(1);
}
