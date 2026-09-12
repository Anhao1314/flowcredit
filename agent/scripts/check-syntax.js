import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const agentRoot = fileURLToPath(new URL("../", import.meta.url));
let count = 0;
for (const directory of ["src", "scripts", "test", "../assets/js"]) {
  const root = resolve(agentRoot, directory);
  for (const name of (await readdir(root)).filter(name => name.endsWith(".js")).sort()) {
    const result = spawnSync(process.execPath, ["--check", resolve(root, name)], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
    count += 1;
  }
}
console.log(`Syntax checked ${count} JavaScript files.`);
