import { loadInteractiveTui } from "../index";

const tui = await loadInteractiveTui();
if (typeof tui.renderTui !== "function") throw new Error("TUI_IMPORT_FAILED");
console.log("TUI_IMPORT_OK");
