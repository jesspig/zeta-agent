import { readConfig, runTestGroup, writeGates } from "./gate-lib.mjs";

const config = readConfig();
const gates = [];
for (const [id, group] of Object.entries(config.securityGroups)) {
  gates.push(
    runTestGroup({
      id: `security:${id}`,
      name: group.name,
      category: "security",
      files: group.files,
    })
  );
}
writeGates("security", gates);
for (const item of gates) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
if (gates.some((item) => item.status === "fail")) process.exit(1);
