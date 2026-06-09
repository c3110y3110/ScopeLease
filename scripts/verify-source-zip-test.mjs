import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSourceArchiveEntries } from "../src/core/source-archive.js";

function safeTarget(root, entryName) {
  const target = path.resolve(root, entryName);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  return target;
}

function extractArchive(archivePath, extractRoot) {
  fs.mkdirSync(extractRoot, { recursive: true });
  const entries = readSourceArchiveEntries(archivePath);
  for (const entry of entries) {
    const target = safeTarget(extractRoot, entry.name);
    if (entry.directory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content);
  }
  return entries.length;
}

function runNpm(cwd, args) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      SCOPELEASE_DISABLE_TIKTOKEN: "1"
    },
    shell: false,
    stdio: "inherit"
  });
}

const archivePath = path.resolve(process.argv[2] ?? "scopelease_clean_source.zip");
if (!fs.existsSync(archivePath)) {
  console.error(`Source archive not found: ${archivePath}`);
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-source-zip-test-"));
const extractRoot = path.join(tempRoot, "scopelease-clean-source");
let keepExtracted = true;

try {
  const entryCount = extractArchive(archivePath, extractRoot);
  const checks = [
    { label: "npm test", args: ["test"] },
    { label: "npm run paper:verify:frozen", args: ["run", "paper:verify:frozen"] },
    { label: "npm run paper:source-truth-check", args: ["run", "paper:source-truth-check"] }
  ];

  for (const check of checks) {
    console.log(`\n[scopelease source zip self-test] ${check.label}`);
    const result = runNpm(extractRoot, check.args);
    if (result.status !== 0) {
      console.error(`Source zip self-test failed: ${check.label}`);
      console.error(`Extracted copy left at: ${extractRoot}`);
      process.exit(result.status ?? 1);
    }
  }

  keepExtracted = false;
  console.log(JSON.stringify({
    kind: "scopelease.source_archive_self_test",
    ok: true,
    archivePath,
    entryCount,
    checks: checks.map((check) => check.label)
  }, null, 2));
} finally {
  if (!keepExtracted) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
