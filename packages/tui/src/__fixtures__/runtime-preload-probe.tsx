import { testRender } from "@opentui/solid";
import { MessageList } from "../components/message";

const source = {
  subscribe(_listener: (event: unknown) => void) {
    return () => {};
  },
};

const setup = await testRender(() => <MessageList source={source as never} />, {
  width: 30,
  height: 4,
});
try {
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  if (!frame.includes("IDLE")) throw new Error(`UNEXPECTED_FRAME: ${frame}`);
  console.log("RENDER_OK");
} finally {
  setup.renderer.destroy();
}
