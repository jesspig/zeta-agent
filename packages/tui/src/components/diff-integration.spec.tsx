import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { RichMessageList } from "./message";

const EMPTY_SOURCE = { subscribe: () => () => {} };

test("U-06 DiffView 通过 RichMessageList.diffs 接入消息流", async () => {
  const setup = await testRender(
    () => (
      <RichMessageList
        source={EMPTY_SOURCE}
        diffs={[{ before: "the quick fox\nshared", after: "the slow fox\nshared" }]}
      />
    ),
    { width: 50, height: 30 },
  );
  try {
    await setup.waitForFrame((frame) => frame.includes("+ the slow fox"));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("- the quick fox");
    expect(frame).toContain("+ the slow fox");
    expect(frame).toContain("[diff]");
  } finally {
    setup.renderer.destroy();
  }
});
