import type { SolidPlugin } from "@opentui/solid";

export type BannerSlots = {
  banner: object;
};

export const BANNER_MARKER = "RUNTIME_BANNER_OK";

const bannerPlugin: SolidPlugin<BannerSlots> = {
  id: "runtime-banner-plugin",
  slots: {
    banner: () => <text fg="#7ee787">{BANNER_MARKER}</text>,
  },
};

export default bannerPlugin;
