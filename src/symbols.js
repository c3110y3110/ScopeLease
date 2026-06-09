import path from "node:path";
import { CODE_EXTENSIONS, CONFIG_EXTENSIONS, DOC_EXTENSIONS } from "./constants.js";
import { normalizePath } from "./fs-utils.js";

export function classifyFile(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  const lower = relativePath.toLowerCase();

  if (lower.includes("/test/") || lower.includes("/tests/") || /(\.|-)(test|spec)\.[a-z]+$/.test(lower)) {
    return "test";
  }

  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (CONFIG_EXTENSIONS.has(ext)) return "config";
  return "other";
}

export function extractSymbols(relativePath, content) {
  const ext = path.extname(relativePath).toLowerCase();
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
    return extractJavaScriptSymbols(relativePath, content);
  }
  if (ext === ".py") return extractPythonSymbols(relativePath, content);
  if (ext === ".go") return extractGoSymbols(relativePath, content);
  if (ext === ".java" || ext === ".kt") return extractJvmSymbols(relativePath, content);
  if (ext === ".sql") return extractSqlSymbols(relativePath, content);
  return [];
}

export function extractImports(relativePath, content) {
  const ext = path.extname(relativePath).toLowerCase();
  const imports = [];
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
    collectRegex(imports, content, /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g, "import");
    collectRegex(imports, content, /\brequire\(\s*["']([^"']+)["']\s*\)/g, "require");
  } else if (ext === ".py") {
    collectRegex(imports, content, /^\s*from\s+([.\w]+)\s+import\s+/gm, "import");
    collectRegex(imports, content, /^\s*import\s+([.\w]+)/gm, "import");
  } else if (ext === ".go") {
    collectRegex(imports, content, /"([^"]+)"/g, "import");
  }
  return imports.map((entry) => ({ ...entry, from: relativePath }));
}

export function resolveImport(rootIndex, fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const fromDir = path.posix.dirname(normalizePath(fromFile));
  const base = specifier.startsWith("/")
    ? normalizePath(specifier.replace(/^\/+/, ""))
    : normalizePath(path.posix.normalize(path.posix.join(fromDir, specifier)));

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    `${base}.go`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`
  ];

  return candidates.find((candidate) => rootIndex.files[candidate]) || null;
}

function extractJavaScriptSymbols(relativePath, content) {
  const symbols = [];
  collectSymbol(symbols, content, /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm, "function");
  collectSymbol(symbols, content, /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, "class");
  collectSymbol(symbols, content, /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm, "type");
  collectSymbol(symbols, content, /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm, "function");
  collectSymbol(symbols, content, /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g, "route", 1, (match) => match[0].match(/\.(get|post|put|patch|delete)\s*\(/)?.[1]?.toUpperCase());
  collectSymbol(symbols, content, /^\s*export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gm, "route");

  if (/(^|\/)(app\/api|pages\/api|api)\//.test(relativePath)) {
    symbols.push({
      id: symbolId(relativePath, "route", apiRouteName(relativePath)),
      name: apiRouteName(relativePath),
      type: "route",
      line: 1,
      meta: { framework: "file-route" }
    });
  }

  return dedupeSymbols(symbols, relativePath);
}

function extractPythonSymbols(relativePath, content) {
  const symbols = [];
  collectSymbol(symbols, content, /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm, "function");
  collectSymbol(symbols, content, /^\s*class\s+([A-Za-z_]\w*)/gm, "class");
  collectSymbol(symbols, content, /^\s*@(?:app|router)\.(get|post|put|patch|delete)\(["']([^"']+)["']\)/gm, "route");
  return dedupeSymbols(symbols, relativePath);
}

function extractGoSymbols(relativePath, content) {
  const symbols = [];
  collectSymbol(symbols, content, /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/gm, "function");
  collectSymbol(symbols, content, /^\s*type\s+([A-Za-z_]\w*)\s+struct\b/gm, "class");
  return dedupeSymbols(symbols, relativePath);
}

function extractJvmSymbols(relativePath, content) {
  const symbols = [];
  collectSymbol(symbols, content, /^\s*(?:public|private|protected|internal)?\s*(?:class|interface|object)\s+([A-Za-z_]\w*)/gm, "class");
  collectSymbol(symbols, content, /^\s*(?:public|private|protected|internal|static|final|suspend|\s)+\s*[A-Za-z_<>\[\]?]+\s+([A-Za-z_]\w*)\s*\(/gm, "function");
  return dedupeSymbols(symbols, relativePath);
}

function extractSqlSymbols(relativePath, content) {
  const symbols = [];
  collectSymbol(symbols, content, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/gi, "table");
  collectSymbol(symbols, content, /\balter\s+table\s+([A-Za-z_][\w.]*)/gi, "table");
  return dedupeSymbols(symbols, relativePath);
}

function collectRegex(output, content, regex, type) {
  for (const match of content.matchAll(regex)) {
    output.push({ type, specifier: match[1], line: lineForOffset(content, match.index || 0) });
  }
}

function collectSymbol(output, content, regex, type, nameIndex = 1, metaFactory = null) {
  for (const match of content.matchAll(regex)) {
    const name = match[nameIndex];
    output.push({
      name,
      type,
      line: lineForOffset(content, match.index || 0),
      meta: metaFactory ? { detail: metaFactory(match) } : {}
    });
  }
}

function dedupeSymbols(symbols, relativePath) {
  const seen = new Set();
  return symbols
    .map((symbol) => ({
      ...symbol,
      id: symbol.id || symbolId(relativePath, symbol.type, symbol.name)
    }))
    .filter((symbol) => {
      const key = `${symbol.type}:${symbol.name}:${symbol.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function symbolId(relativePath, type, name) {
  return `symbol:${relativePath}:${type}:${name}`;
}

function lineForOffset(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function apiRouteName(relativePath) {
  const normalized = relativePath
    .replace(/^src\//, "")
    .replace(/^app\/api\//, "api/")
    .replace(/^pages\/api\//, "api/")
    .replace(/^api\//, "api/")
    .replace(/\/route\.[jt]sx?$/, "")
    .replace(/\.[jt]sx?$/, "")
    .replace(/\/index$/, "")
    .replace(/\[([^\]]+)\]/g, ":$1");
  return `/${normalized}`;
}
