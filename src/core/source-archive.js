import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const DEFAULT_SOURCE_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
const SOURCE_ARCHIVE_VERIFY_MAX_ENTRY_BYTES = 128 * 1024 * 1024;

export const DEFAULT_SOURCE_ARCHIVE_ENTRIES = [
  "AGENTS.md",
  "ScopeLease.command",
  "KOREAN_PATENT_DRAFT.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "docs",
  "examples",
  "patent-package",
  "public",
  "scripts",
  "src",
  "test",
  ".gitignore"
];

export const SOURCE_ARCHIVE_EVIDENCE_ENTRIES = [
  ".scopelease/evaluation",
  ".scopelease/experiments/formal-command-100pair-mini-20260521-133429/product-wide-summary.json",
  ".scopelease/experiments/pilot-codex-main-20260603",
  ".scopelease/experiments/pilot-codex-main-20260607",
  ".scopelease/experiments/pilot-claude-main-20260607",
  ".scopelease/experiments/claude-pilot5",
  ".scopelease/experiments/chi-live-mcp-pilot-final-20260601",
  ".scopelease/experiments/formal-local-main-codex-resource-bounded/product-wide-summary.json",
  ".scopelease/reports/formal-local-main-codex-resource-bounded/claim-ready-report.json",
  ".scopelease/reports/formal-local-main-codex-resource-bounded/claim-ready-report.md",
  ".scopelease/experiments/formal-local-main-claude-resource-bounded/product-wide-summary.json",
  ".scopelease/reports/formal-local-main-claude-resource-bounded/claim-ready-report.json",
  ".scopelease/reports/formal-local-main-claude-resource-bounded/claim-ready-report.md",
  ".scopelease/fixtures/permission-fixtures.jsonl",
  ".scopelease/reports/delegation-control-source-of-truth-20260528",
  ".scopelease/reports/delegation-control-controlled",
  ".scopelease/reports/pilot-codex-main-20260603",
  ".scopelease/reports/pilot-codex-main-20260607",
  ".scopelease/reports/pilot-claude-main-20260607",
  ".scopelease/reports/claude-pilot5",
  ".scopelease/reports/terminal-bench-scopelease-c0c3-20260531/scopelease-terminal-bench-connected-c0c3-panel.json",
  ".scopelease/reports/terminal-bench-scopelease-c0c3-20260603/scopelease-terminal-bench-connected-c0c3-panel.json",
  ".scopelease/reports/terminal-bench-same-prompt-observed-20260531/tbench-hello-same-prompt-20260531/scopelease-terminal-bench-summary.json",
  ".scopelease/studies/decision-fatigue-protocol-v1",
  ".scopelease/terminal_bench_agents/codex_oauth_agent.py"
];

export const SOURCE_ARCHIVE_EXCLUDED_ROOTS = [
  ".scopelease/benchmarks",
  ".codex",
  ".decision",
  "dist",
  ".git",
  "node_modules"
];

export const SOURCE_ARCHIVE_OUTPUT_EXCLUDED_ROOTS = [
  ".scopelease",
  ".codex",
  ".decision",
  "dist",
  ".git",
  "node_modules"
];

export const SOURCE_ARCHIVE_EXCLUDE_PATTERNS = [
  "*.DS_Store",
  "*/.DS_Store",
  "__MACOSX/*",
  "*/__pycache__/*",
  "claim-report.stdout.json",
  "*/claim-report.stdout.json",
  "*.pyc",
  "*.zip"
];

export function createSourceArchive(repoPath, {
  outputPath = "scopelease_clean_source.zip",
  maxBytes = DEFAULT_SOURCE_ARCHIVE_MAX_BYTES
} = {}) {
  const root = path.resolve(repoPath);
  const output = resolveSourceArchiveOutput(root, outputPath);
  const entries = sourceArchiveEntries(root);
  if (!entries.length) throw new Error("source archive has no existing entries to package");

  fs.rmSync(output, { force: true });
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scopelease-source-archive-"));
  let copyStats = { copiedFiles: 0, sanitizedFiles: 0 };
  try {
    copyStats = stageSourceArchiveEntries(root, stagingRoot, entries);
    writeZipArchive(output, collectSourceArchiveZipFiles(stagingRoot, entries));
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }

  const stat = fs.statSync(output);
  const max = Number(maxBytes || DEFAULT_SOURCE_ARCHIVE_MAX_BYTES);
  if (max > 0 && stat.size > max) {
    throw new Error(`source archive exceeds max size: ${stat.size} > ${max}`);
  }
  return {
    kind: "scopelease.source_archive",
    output,
    sizeBytes: stat.size,
    maxBytes: max,
    entries,
    copiedFiles: copyStats.copiedFiles,
    sanitizedLocalPaths: true,
    sanitizedFiles: copyStats.sanitizedFiles,
    excludedRoots: SOURCE_ARCHIVE_EXCLUDED_ROOTS,
    excludedPatterns: SOURCE_ARCHIVE_EXCLUDE_PATTERNS
  };
}

export function sanitizeArchiveText(text, { root = process.cwd(), home = os.homedir() } = {}) {
  let clean = String(text || "");
  const repoRoot = path.resolve(root || ".");
  const userHome = path.resolve(home || "");
  const userName = path.basename(userHome);
  const rootPlaceholder = "<project-root>";
  const pathReplacements = [
    { value: repoRoot, replacement: rootPlaceholder },
    { value: repoRoot.normalize("NFC"), replacement: rootPlaceholder },
    { value: repoRoot.normalize("NFD"), replacement: rootPlaceholder },
    { value: repoRoot.toLowerCase(), replacement: rootPlaceholder },
    { value: repoRoot.normalize("NFC").toLowerCase(), replacement: rootPlaceholder },
    { value: repoRoot.normalize("NFD").toLowerCase(), replacement: rootPlaceholder },
    { value: userHome, replacement: "<user-home>" },
    { value: userHome.normalize("NFC"), replacement: "<user-home>" },
    { value: userHome.normalize("NFD"), replacement: "<user-home>" },
    { value: userHome.toLowerCase(), replacement: "<user-home>" },
    { value: userHome.normalize("NFC").toLowerCase(), replacement: "<user-home>" },
    { value: userHome.normalize("NFD").toLowerCase(), replacement: "<user-home>" }
  ]
    .filter((item) => item.value && item.value !== path.parse(item.value).root)
    .sort((a, b) => b.value.length - a.value.length);

  const seen = new Set();
  for (const item of pathReplacements) {
    if (seen.has(`${item.replacement}:${item.value}`)) continue;
    seen.add(`${item.replacement}:${item.value}`);
    clean = clean.split(item.value).join(item.replacement);
  }

  clean = clean
    .replace(/\/private\/var\/folders\/[^"'\s\\]+/g, "<macos-temp>")
    .replace(/\/var\/folders\/[^"'\s\\]+/g, "<macos-temp>")
    .replace(/\/Users\/[^"'\s\\]+/g, "<user-home>")
    .replace(/\/home\/[^"'\s\\]+/g, "<user-home>");
  clean = clean
    .replace(/<user-home>\/Desktop\/[^"'\r\n\\]+/g, rootPlaceholder)
    .replace(/<user-home>\/Documents\/[^"'\r\n\\]+/g, rootPlaceholder)
    .replace(/<user-home>\/Downloads\/[^"'\r\n\\]+/g, rootPlaceholder);
  if (userName) {
    const escapedUser = escapeRegExp(userName);
    clean = clean.replace(new RegExp(`\\busers/${escapedUser}(?:/[^"'\\s\\\\]*)?`, "gi"), "<user-home>");
  }
  return clean;
}

export function containsUnsanitizedLocalPath(value, { root = process.cwd(), home = os.homedir() } = {}) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  const localRoot = path.resolve(root || ".");
  const userHome = path.resolve(home || "");
  const userName = path.basename(userHome);
  const literalCandidates = [
    localRoot,
    localRoot.normalize("NFC"),
    localRoot.normalize("NFD"),
    userHome,
    userHome.normalize("NFC"),
    userHome.normalize("NFD")
  ].filter(Boolean);
  const lowered = text.toLowerCase();
  if (literalCandidates.some((candidate) => text.includes(candidate) || lowered.includes(candidate.toLowerCase()))) {
    return true;
  }
  if (/\/private\/var\/folders\/|\/var\/folders\//i.test(text)) return true;
  if (/\/Users\/[^"'\s\\]+/i.test(text)) return true;
  if (/\/home\/[^"'\s\\]+/i.test(text)) return true;
  if (/<user-home>\/(?:Desktop|Documents|Downloads)\/[^"'\s\\]+/i.test(text)) return true;
  if (userName) {
    const escapedUser = escapeRegExp(userName);
    if (new RegExp(`\\busers/${escapedUser}(?:/|\\b)`, "i").test(text)) return true;
  }
  return false;
}

export function containsStaleSourceArchiveAssertion(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return text.split(/\r?\n/).some((line) => (
    /assert\.equal\(\s*containsUnsanitizedLocalPath\(\s*["']<project-root>["']\s*,\s*\{\s*root\s*\}\s*\)\s*,\s*true\s*\)/.test(line)
  ));
}

export function verifySourceArchive(repoPath, {
  archivePath = "scopelease_clean_source.zip",
  maxBytes = DEFAULT_SOURCE_ARCHIVE_MAX_BYTES
} = {}) {
  const root = path.resolve(repoPath);
  const archive = resolveSourceArchiveOutput(root, archivePath);
  if (!fs.existsSync(archive)) {
    throw new Error(`source archive does not exist: ${path.relative(root, archive)}`);
  }
  const stat = fs.statSync(archive);
  const max = Number(maxBytes || DEFAULT_SOURCE_ARCHIVE_MAX_BYTES);
  if (max > 0 && stat.size > max) {
    throw new Error(`source archive exceeds max size: ${stat.size} > ${max}`);
  }
  const zipEntries = readSourceArchiveEntries(archive);
  const entries = zipEntries.map((entry) => entry.name);
  const leaks = [];
  const staleAssertions = [];
  let textFilesChecked = 0;
  for (const entry of zipEntries) {
    if (entry.directory) continue;
    if (containsUnsanitizedLocalPath(entry.name, { root })) {
      leaks.push({ entry: entry.name, where: "entry-name" });
      continue;
    }
    const text = decodeUtf8(entry.content || Buffer.alloc(0));
    if (text === null) continue;
    textFilesChecked += 1;
    if (containsUnsanitizedLocalPath(text, { root })) {
      leaks.push({ entry: entry.name, where: "content" });
      if (leaks.length >= 20) break;
    }
    if (entry.name === "test/analyzer.test.js" && containsStaleSourceArchiveAssertion(text)) {
      const leak = { entry: entry.name, where: "content", reason: "stale-source-archive-assertion" };
      leaks.push(leak);
      staleAssertions.push(leak);
      if (leaks.length >= 20) break;
    }
  }
  return {
    kind: "scopelease.source_archive_verify",
    archive,
    sizeBytes: stat.size,
    maxBytes: max,
    entries: entries.length,
    textFilesChecked,
    ok: leaks.length === 0,
    staleAssertions,
    leaks
  };
}

export function readSourceArchiveEntries(archivePath) {
  const archive = path.resolve(archivePath);
  const buffer = fs.readFileSync(archive);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid source archive central directory at offset ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8");
    const directory = name.endsWith("/");
    let content = null;
    if (!directory) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`invalid source archive local header for ${name}`);
      }
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
      if (compressed.length > SOURCE_ARCHIVE_VERIFY_MAX_ENTRY_BYTES) {
        throw new Error(`source archive entry too large to verify: ${name}`);
      }
      if (method === 0) {
        content = Buffer.from(compressed);
      } else if (method === 8) {
        content = inflateRawSync(compressed);
      } else {
        throw new Error(`unsupported source archive compression method ${method} for ${name}`);
      }
      if (content.length !== uncompressedSize) {
        throw new Error(`source archive entry size mismatch: ${name}`);
      }
    }
    entries.push({ name, directory, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sourceArchiveEntries(repoPath) {
  const root = path.resolve(repoPath);
  return uniqueEntries([
    ...DEFAULT_SOURCE_ARCHIVE_ENTRIES,
    ...SOURCE_ARCHIVE_EVIDENCE_ENTRIES,
    latestDirectoryEntry(root, ".scopelease/fixtures/runs", { prefix: "permission-" })
  ]).filter((entry) => fs.existsSync(path.join(root, entry)));
}

export function resolveSourceArchiveOutput(repoPath, outputPath = "scopelease_clean_source.zip") {
  const root = path.resolve(repoPath);
  const output = path.resolve(root, String(outputPath || "scopelease_clean_source.zip"));
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("source archive output must be inside the repository");
  }
  if (!/\.zip$/i.test(output)) {
    throw new Error("source archive output must end with .zip");
  }
  if (SOURCE_ARCHIVE_OUTPUT_EXCLUDED_ROOTS.some((item) => relative === item || relative.startsWith(`${item}${path.sep}`))) {
    throw new Error("source archive output cannot be inside an excluded local directory");
  }
  return output;
}

function latestDirectoryEntry(root, relativeParent, { prefix = "" } = {}) {
  const parent = path.join(root, relativeParent);
  if (!fs.existsSync(parent)) return "";
  const latest = fs.readdirSync(parent)
    .filter((name) => {
      if (prefix && !name.startsWith(prefix)) return false;
      return fs.statSync(path.join(parent, name)).isDirectory();
    })
    .sort()
    .at(-1);
  return latest ? path.posix.join(relativeParent, latest) : "";
}

function uniqueEntries(entries) {
  return [...new Set(entries.filter(Boolean))];
}

function stageSourceArchiveEntries(root, stagingRoot, entries) {
  const stats = { copiedFiles: 0, sanitizedFiles: 0 };
  for (const entry of entries) {
    copyArchiveEntry(root, stagingRoot, entry, stats);
  }
  return stats;
}

function copyArchiveEntry(root, stagingRoot, relativeEntry, stats) {
  const source = path.join(root, relativeEntry);
  const target = path.join(stagingRoot, relativeEntry);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const child of fs.readdirSync(source).sort()) {
      copyArchiveEntry(root, stagingRoot, path.join(relativeEntry, child), stats);
    }
    return;
  }
  if (!stat.isFile()) return;
  copyArchiveFile(root, source, target, stats);
}

function copyArchiveFile(root, source, target, stats) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buffer = fs.readFileSync(source);
  const text = decodeUtf8(buffer);
  if (text === null) {
    fs.copyFileSync(source, target);
    stats.copiedFiles += 1;
    return;
  }
  const sanitized = sanitizeArchiveText(text, { root });
  fs.writeFileSync(target, sanitized);
  stats.copiedFiles += 1;
  if (sanitized !== text) stats.sanitizedFiles += 1;
}

function collectSourceArchiveZipFiles(stagingRoot, entries) {
  const files = [];
  for (const entry of entries) {
    const target = path.join(stagingRoot, entry);
    if (!fs.existsSync(target)) continue;
    collectZipFiles(stagingRoot, target, files);
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function collectZipFiles(root, target, files) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  const name = toArchivePath(path.relative(root, target));
  if (!name || sourceArchivePathExcluded(name)) return;
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(target).sort()) {
      collectZipFiles(root, path.join(target, child), files);
    }
    return;
  }
  if (stat.isFile()) {
    files.push({ name, path: target });
  }
}

function sourceArchivePathExcluded(archivePath) {
  const parts = archivePath.split("/");
  const basename = parts.at(-1) || "";
  if (basename === ".DS_Store") return true;
  if (basename === "claim-report.stdout.json") return true;
  if (parts.includes("__MACOSX")) return true;
  if (parts.includes("__pycache__")) return true;
  if (/\.pyc$/i.test(basename)) return true;
  if (/\.zip$/i.test(basename)) return true;
  return false;
}

function writeZipArchive(output, files) {
  if (!files.length) throw new Error("source archive has no files to package");
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file.path);
    const deflated = deflateRawSync(data, { level: 9 });
    const compressed = deflated.length < data.length ? deflated : data;
    const method = compressed === deflated ? 8 : 0;
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(data);
    const { date, time } = fixedDosDateTime();
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectorySize = centralDirectory.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(output, Buffer.concat([...localParts, centralDirectory, end]));
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("source archive end-of-central-directory record not found");
}

function fixedDosDateTime() {
  return {
    date: (1 << 5) | 1,
    time: 0
  };
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toArchivePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function decodeUtf8(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
