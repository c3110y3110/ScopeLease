import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function collectTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const root = process.cwd();
const testRoot = path.join(root, "test");
const testFiles = collectTestFiles(testRoot).sort();

if (testFiles.length === 0) {
  console.error(`No .test.js files found under ${testRoot}`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: root,
  env: process.env,
  shell: false,
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`node --test terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
