import { readConfig, runTestGroup, writeGates } from "./gate-lib.mjs";

const config = readConfig();
const gates = [];
for (const [id, group] of Object.entries(config.testCategories)) {
  gates.push(
    runTestGroup({
      id: `tests:${id}`,
      name: group.name,
      category: "tests",
      files: group.files,
    })
  );
}
writeGates("tests", gates);
for (const item of gates) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
if (gates.some((item) => item.status === "fail")) process.exit(1);
