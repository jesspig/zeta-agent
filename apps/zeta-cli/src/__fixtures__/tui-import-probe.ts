await import("@opentui/solid/preload");
const tui = await import("@zeta-agent/tui");
if (typeof tui.renderTui !== "function") throw new Error("TUI_IMPORT_FAILED");
console.log("TUI_IMPORT_OK");
