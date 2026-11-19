import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
    failures.push(label);
  }
}

function readJson(rel) {
  const file = path.join(root, rel);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const pkg = readJson("package.json");
const workspaces = Array.isArray(pkg?.workspaces) ? pkg.workspaces : [];
for (const glob of ["packages/*", "packages/components/*", "packages/agent-components/*", "apps/*"]) {
  check(`workspace glob ${glob}`, workspaces.includes(glob), `workspaces=${JSON.stringify(workspaces)}`);
}

const turbo = readJson("turbo.json");
const tasks = turbo?.tasks ?? {};
check("turbo build.dependsOn ^build", Array.isArray(tasks.build?.dependsOn) && tasks.build.dependsOn.includes("^build"));
check("turbo build.outputs dist/**", Array.isArray(tasks.build?.outputs) && tasks.build.outputs.includes("dist/**"));
for (const name of ["typecheck", "test", "dev"]) {
  check(`turbo task ${name}`, Object.hasOwn(tasks, name));
}
for (const name of ["build", "typecheck", "test", "check"]) {
  check(`root script ${name}`, typeof pkg?.scripts?.[name] === "string");
}

const packages = [
  "packages/framework",
  "packages/agent-framework",
  "packages/components",
  "packages/agent-components",
  "apps/zeta-cli",
];
for (const rel of packages) {
  check(`${rel}/package.json`, existsSync(path.join(root, rel, "package.json")));
  check(`${rel}/src/index.ts`, existsSync(path.join(root, rel, "src", "index.ts")));
  check(`${rel}/dist/index.js`, existsSync(path.join(root, rel, "dist", "index.js")));
}

check("bun.lock", existsSync(path.join(root, "bun.lock")));
check("tsconfig.base.json", existsSync(path.join(root, "tsconfig.base.json")));
check("bunfig.toml", existsSync(path.join(root, "bunfig.toml")));

const configFiles = ["package.json", "turbo.json", "tsconfig.json", "tsconfig.base.json", "bunfig.toml"];
const absolutePath = /[A-Za-z]:\\|\/Users\/|\/home\//;
for (const rel of configFiles) {
  const file = path.join(root, rel);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  check(`${rel} 无绝对路径`, !absolutePath.test(text));
}

if (failures.length > 0) {
  console.error(`\nverify-workspace: ${failures.length} 项失败`);
  process.exit(1);
}
console.log("\nverify-workspace: 全部通过");
