import { enrichEdge, enrichGraph, enrichNode } from "./identity.js";

export function findRelated(index, changedFiles, changedSymbols, policyHits) {
  const changedSet = new Set(changedFiles.map((file) => `file:${file}`));
  const changedSymbolIds = Object.values(changedSymbols).flat().map((symbol) => symbol.id);
  const imports = [];
  const importedBy = [];
  const tests = [];
  const docs = [];
  const routes = [];
  const policies = [];

  for (const edge of index.edges) {
    const sourceChanged = changedSet.has(edge.source);
    const targetChanged = changedSet.has(edge.target);

    if (edge.type === "imports" && sourceChanged) imports.push(nodeFor(index, edge.target));
    if (edge.type === "imports" && targetChanged) importedBy.push(nodeFor(index, edge.source));
    if (edge.type === "tests" && targetChanged) tests.push(nodeFor(index, edge.source));
    if (edge.type === "mentions" && changedSymbolIds.includes(edge.target)) {
      docs.push(nodeFor(index, edge.source));
    }
  }

  for (const file of collectRouteFiles(changedFiles, imports, importedBy)) {
    for (const symbol of index.files[file]?.symbols || []) {
      if (symbol.type === "route") {
        routes.push({ id: symbol.id, label: symbol.name, path: file, line: symbol.line, type: "route" });
      }
    }
  }

  for (const hit of policyHits) {
    policies.push({
      id: `policy:${hit.ruleId}`,
      label: hit.ruleId,
      type: "policy",
      risk: hit.risk,
      route: hit.route,
      files: hit.files
    });
  }

  const related = {
    imports: uniqueNodes(imports),
    importedBy: uniqueNodes(importedBy),
    tests: uniqueNodes(tests),
    docs: uniqueNodes(docs),
    routes: uniqueNodes(routes),
    policies,
    paths: []
  };

  related.paths = buildEvidencePaths(index, changedFiles, changedSymbols, related, policyHits);
  return related;
}

export function buildImpactGraph(index, changedFiles, changedSymbols, related, policyHits) {
  const nodes = new Map();
  const edges = [];

  function addNode(node) {
    if (node) nodes.set(node.id, node);
  }

  for (const file of changedFiles) {
    addNode(enrichNode({
      id: `file:${file}`,
      type: "changed_file",
      label: file,
      path: file,
      fileType: index.files[file]?.type || "unknown"
    }));

    for (const symbol of changedSymbols[file] || []) {
      addNode(enrichNode({ ...symbol, type: `changed_${symbol.type}`, label: symbol.name }));
      edges.push(enrichEdge({ source: `file:${file}`, target: symbol.id, type: "defines" }));
    }
  }

  for (const group of ["imports", "importedBy", "tests", "docs", "routes"]) {
    for (const node of related[group] || []) addNode(enrichNode({ ...node, group }));
  }

  for (const policy of related.policies || []) addNode(enrichNode(policy));

  const included = new Set(nodes.keys());
  for (const edge of index.edges) {
    if (included.has(edge.source) && included.has(edge.target)) edges.push(edge);
  }

  for (const hit of policyHits) {
    const policyId = `policy:${hit.ruleId}`;
    addNode(enrichNode({
      id: policyId,
      label: hit.ruleId,
      type: "policy",
      risk: hit.risk,
      route: hit.route
    }));
    for (const file of hit.files) {
      if (included.has(`file:${file}`)) {
        edges.push(enrichEdge({ source: `file:${file}`, target: policyId, type: "policy_hit" }));
      }
    }
  }

  return enrichGraph({
    nodes: [...nodes.values()],
    edges: dedupeEdges(edges)
  });
}

export function buildKnowledgeGraph({ root, index, changedFiles = [], changedSymbols = {}, related = {}, policyHits = [], assessment = {} }) {
  const changedFileIds = new Set(changedFiles.map((file) => `file:${file}`));
  const changedSymbolIds = new Set(Object.values(changedSymbols).flat().map((symbol) => symbol.id));
  const evidenceIds = new Set([
    ...(related.imports || []).map((node) => node.id),
    ...(related.importedBy || []).map((node) => node.id),
    ...(related.routes || []).map((node) => node.id),
    ...(related.tests || []).map((node) => node.id),
    ...(related.docs || []).map((node) => node.id)
  ]);
  const nodes = new Map();
  const edges = [];

  for (const node of Object.values(index.nodes || {})) {
    nodes.set(node.id, toKnowledgeNode(node, {
      changed: changedFileIds.has(node.id) || changedSymbolIds.has(node.id),
      evidence: evidenceIds.has(node.id)
    }));
  }

  for (const edge of index.edges || []) {
    edges.push(toKnowledgeRelationship(edge));
  }

  for (const hit of policyHits) {
    const policyId = `policy:${hit.ruleId}`;
    nodes.set(policyId, toKnowledgeNode({
      id: policyId,
      label: hit.ruleId,
      type: "policy",
      risk: hit.risk,
      route: hit.route
    }, { policy: true, evidence: true }));

    for (const file of hit.files || []) {
      const source = `file:${file}`;
      if (!nodes.has(source)) continue;
      edges.push(toKnowledgeRelationship(enrichEdge({
        source,
        target: policyId,
        type: "policy_hit",
        meta: { risk: hit.risk, route: hit.route, reason: hit.reason }
      })));
    }
  }

  const relationshipList = dedupeEdges(edges);
  const schema = buildKnowledgeSchema({
    root,
    nodes: [...nodes.values()],
    relationships: relationshipList,
    assessment
  });
  return {
    schema,
    nodes: [...nodes.values()],
    edges: relationshipList
  };
}

function buildKnowledgeSchema({ root, nodes, relationships, assessment }) {
  const labelCounts = new Map();
  const relationshipCounts = new Map();
  const propertyKeys = new Set();
  const relationshipPropertyKeys = new Set();

  for (const node of nodes) {
    for (const label of node.labels || []) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    for (const key of Object.keys(node.properties || {})) propertyKeys.add(key);
  }

  for (const relationship of relationships) {
    const type = relationship.relationshipType || relationshipTypeFor(relationship.type);
    relationshipCounts.set(type, (relationshipCounts.get(type) || 0) + 1);
    for (const key of Object.keys(relationship.properties || {})) relationshipPropertyKeys.add(key);
  }

  return {
    version: "scopelease-kg-v1",
    model: "scopelease_knowledge_graph",
    reference: "ScopeLease KG: nodes keep labels/properties and relationships stay directed and typed for context pruning and evidence inspection.",
    root,
    nodeCount: nodes.length,
    relationshipCount: relationships.length,
    changedNodeCount: nodes.filter((node) => node.properties?.changed).length,
    risk: assessment.risk || "low",
    nodeLabels: [...labelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({ label, count })),
    relationshipTypes: [...relationshipCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, count]) => ({ type, count })),
    propertyKeys: [...propertyKeys].sort(),
    relationshipPropertyKeys: [...relationshipPropertyKeys].sort()
  };
}

function toKnowledgeNode(node, flags = {}) {
  const labels = kgLabels(node, flags);
  const properties = compactProperties({
    id: node.id,
    name: node.label || node.path || node.id,
    path: node.path,
    line: node.line,
    type: node.type,
    fileType: node.fileType,
    layer: node.identity?.layer,
    kind: node.identity?.kind,
    memoryType: node.identity?.memoryType,
    cpgType: node.identity?.cpgType,
    source: node.provenance?.source,
    basis: node.provenance?.basis,
    changed: Boolean(flags.changed),
    evidence: Boolean(flags.evidence),
    risk: node.risk,
    route: node.route
  });

  return {
    ...node,
    labels,
    caption: properties.name,
    properties
  };
}

function toKnowledgeRelationship(edge) {
  const relationshipType = relationshipTypeFor(edge.type);
  const properties = compactProperties({
    type: edge.type,
    relationshipType,
    relation: edge.identity?.relation,
    layer: edge.identity?.layer,
    direction: "OUTGOING",
    confidence: edge.identity?.confidence,
    source: edge.provenance?.source,
    basis: edge.provenance?.basis,
    line: edge.meta?.line || edge.provenance?.line,
    risk: edge.meta?.risk,
    route: edge.meta?.route,
    reason: edge.meta?.reason
  });

  return {
    ...edge,
    id: `rel:${edge.source}:${relationshipType}:${edge.target}`,
    relationshipType,
    properties
  };
}

function kgLabels(node, flags) {
  const labels = ["ScopeLeaseNode"];
  const type = String(node.type || "").replace(/^changed_/, "");
  const fileType = node.fileType || "";

  if (flags.changed || String(node.type || "").startsWith("changed_")) labels.push("Changed");
  if (flags.evidence) labels.push("Evidence");
  if (type === "policy" || flags.policy) labels.push("Policy");
  else if (type === "route") labels.push("Route");
  else if (type === "function") labels.push("Function");
  else if (type === "class") labels.push("Class");
  else if (type === "type") labels.push("Type");
  else if (type === "table") labels.push("Table");
  else if (fileType === "test") labels.push("TestFile");
  else if (fileType === "doc") labels.push("Document");
  else if (fileType === "config") labels.push("ConfigFile");
  else if (fileType === "code") labels.push("CodeFile");
  else labels.push("File");

  return [...new Set(labels)];
}

function relationshipTypeFor(type) {
  return {
    defines: "DEFINES",
    imports: "IMPORTS",
    imported_by: "IMPORTED_BY",
    tests: "TESTS",
    mentions: "MENTIONS",
    route: "EXPOSES",
    defined_by: "DEFINED_BY",
    policy_hit: "VIOLATES_POLICY"
  }[type] || String(type || "RELATED_TO").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function compactProperties(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "")
  );
}

function collectRouteFiles(changedFiles, imports, importedBy) {
  return [
    ...changedFiles,
    ...imports.map((node) => node.path),
    ...importedBy.map((node) => node.path)
  ].filter(Boolean);
}

function nodeFor(index, nodeId) {
  const node = index.nodes[nodeId];
  if (!node) return null;
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    path: node.path,
    line: node.line,
    fileType: node.fileType,
    identity: node.identity,
    memory: node.memory,
    provenance: node.provenance
  };
}

function buildEvidencePaths(index, changedFiles, changedSymbols, related, policyHits) {
  const paths = [];
  const changedSymbolIds = Object.values(changedSymbols).flat().map((symbol) => symbol.id);

  for (const file of changedFiles) {
    const fileNode = nodeFor(index, `file:${file}`) || { id: `file:${file}`, label: file, path: file, type: "file" };
    for (const symbol of changedSymbols[file] || []) {
      paths.push(pathRecord("defines", [fileNode, symbol], ["defines"]));
    }
  }

  for (const node of related.importedBy || []) {
    for (const file of changedFiles) {
      if (hasEdge(index, `file:${node.path}`, `file:${file}`, "imports")) {
        paths.push(pathRecord("imported_by", [node, nodeFor(index, `file:${file}`)], ["imports"]));
      }
    }
  }

  for (const node of related.imports || []) {
    for (const file of changedFiles) {
      if (hasEdge(index, `file:${file}`, `file:${node.path}`, "imports")) {
        paths.push(pathRecord("imports", [nodeFor(index, `file:${file}`), node], ["imports"]));
      }
    }
  }

  for (const route of related.routes || []) {
    const routeFile = nodeFor(index, `file:${route.path}`);
    const changedTarget = changedFiles
      .map((file) => nodeFor(index, `file:${file}`))
      .find((fileNode) => fileNode && hasEdge(index, `file:${route.path}`, fileNode.id, "imports"));
    paths.push(pathRecord("route", [route, routeFile, changedTarget].filter(Boolean), ["defined_by", "imports"]));
  }

  for (const test of related.tests || []) {
    for (const file of changedFiles) {
      if (hasEdge(index, `file:${test.path}`, `file:${file}`, "tests")) {
        paths.push(pathRecord("test", [test, nodeFor(index, `file:${file}`)], ["tests"]));
      }
    }
  }

  for (const doc of related.docs || []) {
    const mentionedSymbol = changedSymbolIds.find((symbolId) => hasEdge(index, `file:${doc.path}`, symbolId, "mentions"));
    if (mentionedSymbol) {
      paths.push(pathRecord("doc", [doc, nodeFor(index, mentionedSymbol)], ["mentions"]));
    }
  }

  for (const hit of policyHits) {
    const policyNode = { id: `policy:${hit.ruleId}`, label: hit.ruleId, type: "policy", risk: hit.risk, route: hit.route };
    for (const file of hit.files) {
      paths.push(pathRecord("policy", [nodeFor(index, `file:${file}`), policyNode], ["policy_hit"]));
    }
  }

  return uniquePaths(paths).slice(0, 24);
}

function pathRecord(kind, nodes, edgeTypes) {
  const compactNodes = nodes.filter(Boolean).map((node) => ({
    id: node.id,
    label: node.label || node.name || node.path || node.id,
    type: node.type,
    path: node.path,
    line: node.line
  }));

  return {
    kind,
    nodes: compactNodes,
    edges: edgeTypes,
    summary: summarizePath(compactNodes, edgeTypes)
  };
}

function summarizePath(nodes, edgeTypes) {
  if (!nodes.length) return "";
  const labels = nodes.map(formatPathNode);
  let output = labels[0];
  for (let index = 1; index < labels.length; index += 1) {
    output += ` --${edgeTypeLabel(edgeTypes[index - 1])}--> ${labels[index]}`;
  }
  return output;
}

function formatPathNode(node) {
  if (node.type === "route") return node.label;
  if (node.type === "policy") return `정책:${node.label}`;
  if (node.path && node.line) return `${node.label}(${node.path}:${node.line})`;
  return node.path || node.label;
}

function edgeTypeLabel(type) {
  return {
    defines: "정의",
    imports: "가져옴",
    imported_by: "호출됨",
    route: "라우트",
    defined_by: "구현",
    tests: "검증",
    mentions: "언급",
    policy_hit: "정책"
  }[type] || type || "관계";
}

function hasEdge(index, source, target, type) {
  return index.edges.some((edge) => edge.source === source && edge.target === target && edge.type === type);
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((path) => {
    const key = `${path.kind}:${path.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueNodes(nodes) {
  const seen = new Set();
  return nodes.filter(Boolean).filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    const key = `${edge.source}->${edge.target}:${edge.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
