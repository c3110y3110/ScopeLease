import path from "node:path";
import { hashText, readText, walkFiles } from "../fs-utils.js";
import { classifyFile, extractImports, extractSymbols, resolveImport } from "../symbols.js";
import { enrichEdge, enrichNode, graphSchema } from "./identity.js";

export function buildIndex(root) {
  const files = {};
  const fileHashes = {};
  const nodes = {};
  const edges = [];

  for (const relativePath of walkFiles(root)) {
    const fullPath = path.join(root, relativePath);
    let content = "";
    try {
      content = readText(fullPath);
    } catch {
      continue;
    }

    const type = classifyFile(relativePath);
    const symbols = extractSymbols(relativePath, content);
    const imports = extractImports(relativePath, content);
    const hash = hashText(content);

    files[relativePath] = {
      path: relativePath,
      type,
      hash,
      size: content.length,
      lineCount: content.split(/\r?\n/).length,
      symbols,
      imports,
      content
    };
    fileHashes[relativePath] = hash;

    nodes[`file:${relativePath}`] = enrichNode({
      id: `file:${relativePath}`,
      type: "file",
      label: relativePath,
      path: relativePath,
      fileType: type
    });

    for (const symbol of symbols) {
      nodes[symbol.id] = enrichNode({
        id: symbol.id,
        type: symbol.type,
        label: symbol.name,
        path: relativePath,
        line: symbol.line
      });
      edges.push(enrichEdge({ source: `file:${relativePath}`, target: symbol.id, type: "defines" }));
    }
  }

  connectImportEdges(files, edges);
  connectTestsAndDocs(files, edges);

  return {
    generatedAt: new Date().toISOString(),
    schema: graphSchema(),
    files,
    fileHashes,
    nodes,
    edges: edges.map(enrichEdge)
  };
}

function connectImportEdges(files, edges) {
  for (const [relativePath, file] of Object.entries(files)) {
    for (const imported of file.imports) {
      const target = resolveImport({ files }, relativePath, imported.specifier);
      if (!target) continue;
      edges.push(enrichEdge({
        source: `file:${relativePath}`,
        target: `file:${target}`,
        type: "imports",
        meta: { specifier: imported.specifier, line: imported.line }
      }));
    }
  }
}

function connectTestsAndDocs(files, edges) {
  const codeFiles = Object.values(files).filter((file) => file.type === "code");
  const symbols = codeFiles.flatMap((file) => file.symbols.map((symbol) => ({ ...symbol, file: file.path })));

  for (const file of Object.values(files)) {
    if (file.type === "test") {
      connectTestFile(file, codeFiles, edges);
    }

    if (file.type === "doc") {
      connectDocFile(file, symbols, edges);
    }
  }
}

function connectTestFile(testFile, codeFiles, edges) {
  for (const codeFile of codeFiles) {
    const basename = path.basename(codeFile.path).replace(/\.[^.]+$/, "");
    const importsSource = testFile.imports.some((entry) => entry.specifier.includes(basename));
    const mentionsSource = testFile.content.includes(basename);
    if (importsSource || mentionsSource) {
      edges.push(enrichEdge({ source: `file:${testFile.path}`, target: `file:${codeFile.path}`, type: "tests" }));
    }
  }
}

function connectDocFile(docFile, symbols, edges) {
  for (const symbol of symbols) {
    if (symbol.name.length >= 4 && docFile.content.includes(symbol.name)) {
      edges.push(enrichEdge({ source: `file:${docFile.path}`, target: symbol.id, type: "mentions" }));
    }
  }
}
