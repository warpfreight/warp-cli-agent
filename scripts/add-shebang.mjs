import { readFileSync, writeFileSync, chmodSync } from "node:fs";

const target = new URL("../dist/cli.js", import.meta.url);
const content = readFileSync(target, "utf8");

if (!content.startsWith("#!")) {
  writeFileSync(target, "#!/usr/bin/env node\n" + content);
}

chmodSync(target, 0o755);
