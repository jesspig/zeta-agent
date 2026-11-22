import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ZetaApp } from "./runtime";
import { createSignal, type EventSource } from "./signal";

function source(): { source: EventSource; emit: (event: unknown) => void } {
  const signal = createSignal<unknown>(null);
  return {
    source: {
      subscribe(listener) {
        return signal.subscribe((event) => {
          if (event !== null) listener(event as never);
        });
      },
    },
    emit: (event) => signal.set(event),
  };
}

test("/clear 清空对话并回到启动状态", async () => {
  const { source: events, emit } = source();
  const setup = await testRender(
    () => <ZetaApp title="zeta" messages={[]} source={events} onPush={() => {}} onSubmit={() => {}} onExit={() => {}} />,
    { width: 80, height: 20 },
  );
  try {
    await setup.renderOnce();
    emit({ type: "message_start", message: { role: "user", content: "旧消息" } });
    emit({ type: "message_end", message: { role: "user", content: "旧消息" } });
    await setup.waitForFrame((frame) => frame.includes("旧消息") && !frame.includes("New session started"));

    setup.mockInput.typeText("/clear");
    await setup.waitForFrame((frame) => frame.includes("/clear"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("New session started") && !frame.includes("旧消息"));
  } finally {
    setup.renderer.destroy();
  }
});

test("/help 打开快捷键面板，Esc 关闭", async () => {
  const setup = await testRender(
    () => <ZetaApp title="zeta" messages={[]} onPush={() => {}} onSubmit={() => {}} onExit={() => {}} />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("/help");
    await setup.waitForFrame((frame) => frame.includes("/help"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame((frame) => frame.includes("Ctrl+O") && !frame.includes("/help "));
    expect(setup.captureCharFrame()).toContain("快捷键");
    setup.mockInput.pressEscape();
    await Bun.sleep(120);
    await setup.waitForFrame((frame) => !frame.includes("快捷键"));
  } finally {
    setup.renderer.destroy();
  }
});

test("/quit 触发退出回调", async () => {
  let exited = false;
  const setup = await testRender(
    () => <ZetaApp title="zeta" messages={[]} onPush={() => {}} onSubmit={() => {}} onExit={() => { exited = true; }} />,
    { width: 80, height: 20 },
  );
  try {
    await setup.renderOnce();
    setup.mockInput.typeText("/quit");
    await setup.waitForFrame((frame) => frame.includes("/quit"));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(() => exited);
    expect(exited).toBe(true);
  } finally {
    setup.renderer.destroy();
  }
});
