import { STATE_VERSION } from "../constants.js";

export function detectChanges(baselineHashes, currentHashes) {
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [file, hash] of Object.entries(currentHashes)) {
    if (!baselineHashes[file]) added.push(file);
    else if (baselineHashes[file] !== hash) modified.push(file);
  }

  for (const file of Object.keys(baselineHashes)) {
    if (!currentHashes[file]) deleted.push(file);
  }

  return { added, modified, deleted };
}

export function mapChangedSymbols(index, changedFiles) {
  return Object.fromEntries(
    changedFiles.map((file) => [
      file,
      (index.files[file]?.symbols || []).map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        type: symbol.type,
        line: symbol.line,
        path: file
      }))
    ])
  );
}

export function summarizeChanges({ changes, changedFiles, deletedFiles, changedSymbols, assessment }) {
  const symbolCount = Object.values(changedSymbols).flat().length;
  const addedCount = changes?.added?.length || 0;
  const modifiedCount = changes?.modified?.length ?? changedFiles.length;
  const deletedCount = changes?.deleted?.length ?? deletedFiles.length;
  if (!addedCount && !modifiedCount && !deletedCount) return "기준점 이후 감지된 로컬 변경이 없습니다.";
  return `${addedCount}개 추가, ${modifiedCount}개 변경, ${deletedCount}개 삭제, ${symbolCount}개 심볼 감지; ${riskText(assessment.risk)} 위험.`;
}

export function emptyAnalysis(root) {
  return {
    version: STATE_VERSION,
    repo: root,
    generatedAt: new Date().toISOString(),
    summary: "기준점 이후 감지된 로컬 변경이 없습니다.",
    risk: "low",
    uncertainty: "low",
    recommendation: "auto_log",
    reasons: [],
    changes: { added: [], modified: [], deleted: [], files: [], symbols: {}, fileHashes: {} },
    impact: { imports: [], importedBy: [], tests: [], docs: [], routes: [], policies: [] },
    policyHits: [],
    repoStats: { fileCount: 0, totalChars: 0, totalLines: 0, fullContextTokens: 0, byType: {} },
    graph: { nodes: [], edges: [] },
    knowledgeGraph: { schema: { model: "scopelease_knowledge_graph" }, nodes: [], edges: [] },
    contextBudget: 8000
  };
}

function riskText(value) {
  return { low: "낮음", medium: "중간", high: "높음", critical: "치명적" }[value] || value || "낮음";
}
