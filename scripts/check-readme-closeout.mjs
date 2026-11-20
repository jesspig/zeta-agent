import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const index = readFileSync(join(root, "index.ts"), "utf8");

const failures = [];
function check(label, ok) {
  if (ok) console.log(`PASS ${label}`);
  else failures.push(label);
}

check("README 非 bun init 模板残留", !readme.includes("This project was created using"));
check("README 有项目定位段落", /##\s*定位|##\s*项目定位/.test(readme));
check("README 有架构段落", /##\s*架构|##\s*项目结构/.test(readme));
check("README 有快速开始段落", /##\s*快速开始/.test(readme));
check("README 指向 docs/desgin", readme.includes("docs/desgin"));
check("README 指向归档", /\.handoff\/archive|archive/.test(readme));
check("index.ts 无 Hello via Bun", !index.includes("Hello via Bun"));

if (failures.length > 0) {
  console.error(`\nFAIL readme-closeout: ${failures.length} 项未通过: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nPASS readme-closeout: 根 README 与 index.ts 已收尾");
