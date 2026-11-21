import type { SolidPlugin } from "@opentui/solid";
import type { BannerSlots } from "./banner-plugin";

const brokenPlugin: SolidPlugin<BannerSlots> = {
  id: "runtime-broken-plugin",
  slots: {
    banner: () => {
      throw new Error("PLUGIN_RENDER_BOOM");
    },
  },
};

export default brokenPlugin;
