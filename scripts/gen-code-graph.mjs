#!/usr/bin/env node
/**
 * gen-code-graph.mjs
 *
 * Reads code-graph.json, validates it, and regenerates the region of CODE-GRAPH.md
 * between the BEGIN GENERATED and END GENERATED markers. Hand-written prose outside
 * the markers is preserved byte for byte.
 *
 *   node scripts/gen-code-graph.mjs            regenerate CODE-GRAPH.md in place
 *   node scripts/gen-code-graph.mjs --check    exit 1 if the document is stale or the graph is invalid
 *
 * No dependencies beyond node:fs and node:path. Node 22 LTS.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GRAPH_PATH = join(ROOT, 'code-graph.json');
const DOC_PATH = join(ROOT, 'CODE-GRAPH.md');
const BEGIN = '<!-- BEGIN GENERATED -->';
const END = '<!-- END GENERATED -->';

const NODE_TYPES = ['app', 'package', 'datastore', 'queue', 'external', 'job'];
const EDGE_KINDS = ['http', 'sql', 'queue', 'pubsub', 'ws', 's3', 'smtp', 'webhook', 'imports'];
const MILESTONES = ['M0', 'M1', 'M2', 'M3', 'M4'];
const STATUSES = ['planned', 'in-progress', 'built'];
const TYPE_ORDER = ['app', 'package', 'datastore', 'queue', 'job', 'external'];
const TYPE_LABEL = {
  app: 'Applications',
  package: 'Packages',
  datastore: 'Datastores',
  queue: 'Queues',
  job: 'Scheduled jobs',
  external: 'External services',
};

const rel = (p) => relative(ROOT, p) || p;

/* ------------------------------------------------------------------ loading */

function loadGraph() {
  if (!existsSync(GRAPH_PATH)) {
    fail([`${rel(GRAPH_PATH)} does not exist. It is the source of truth; the document is generated from it.`]);
  }
  const raw = readFileSync(GRAPH_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail([`${rel(GRAPH_PATH)} is not valid JSON: ${err.message}`]);
  }
}

function fail(errors) {
  console.error('\ncode-graph validation failed:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

/* --------------------------------------------------------------- validation */

function validate(graph) {
  const errors = [];
  const nodes = graph.nodes;
  const edges = graph.edges;

  if (!Array.isArray(nodes) || nodes.length === 0) errors.push('"nodes" must be a non-empty array.');
  if (!Array.isArray(edges)) errors.push('"edges" must be an array.');
  if (errors.length) fail(errors);

  const byId = new Map();
  for (const [i, n] of nodes.entries()) {
    const where = `nodes[${i}]${n && n.id ? ` (${n.id})` : ''}`;
    for (const field of ['id', 'name', 'type', 'milestone', 'status', 'owner', 'path', 'purpose']) {
      if (!n[field] || String(n[field]).trim() === '') {
        errors.push(`${where}: missing required field "${field}".`);
      }
    }
    if (n.type && !NODE_TYPES.includes(n.type)) {
      errors.push(`${where}: type "${n.type}" is not one of ${NODE_TYPES.join(' | ')}.`);
    }
    if (n.milestone && !MILESTONES.includes(n.milestone)) {
      errors.push(`${where}: milestone "${n.milestone}" is not one of ${MILESTONES.join(' | ')}.`);
    }
    if (n.status && !STATUSES.includes(n.status)) {
      errors.push(`${where}: status "${n.status}" is not one of ${STATUSES.join(' | ')}.`);
    }
    if (!Array.isArray(n.invariants) || n.invariants.length === 0) {
      errors.push(`${where}: needs at least one entry in "invariants". If nothing must hold, the node does not belong in the graph.`);
    }
    if (!Array.isArray(n.public_surface) || n.public_surface.length === 0) {
      errors.push(`${where}: needs at least one entry in "public_surface".`);
    }
    if (!Array.isArray(n.docs) || n.docs.length === 0) {
      errors.push(`${where}: needs at least one entry in "docs" linking to the document that specifies it.`);
    }
    if (n.id) {
      if (byId.has(n.id)) errors.push(`${where}: duplicate node id "${n.id}".`);
      byId.set(n.id, n);
    }
  }

  for (const n of nodes) {
    if (n.type === 'queue') {
      const backing = byId.get(n.backed_by);
      if (!backing) errors.push(`nodes (${n.id}): queue node needs "backed_by" pointing at a datastore node; "${n.backed_by}" does not resolve.`);
      else if (backing.type !== 'datastore') errors.push(`nodes (${n.id}): "backed_by" must be a datastore, but "${n.backed_by}" is a ${backing.type}.`);
    }
    if (n.type === 'job') {
      const host = byId.get(n.host);
      if (!host) errors.push(`nodes (${n.id}): job node needs "host" pointing at the app it runs inside; "${n.host}" does not resolve.`);
      else if (host.type !== 'app') errors.push(`nodes (${n.id}): "host" must be an app, but "${n.host}" is a ${host.type}.`);
    }
  }

  const edgeIds = new Set();
  for (const [i, e] of edges.entries()) {
    const where = `edges[${i}]${e && e.id ? ` (${e.id})` : ''}`;
    if (!e.id) errors.push(`${where}: missing "id".`);
    else if (edgeIds.has(e.id)) errors.push(`${where}: duplicate edge id "${e.id}".`);
    else edgeIds.add(e.id);

    if (!byId.has(e.from)) errors.push(`${where}: "from" is "${e.from}", which resolves to no node id.`);
    if (!byId.has(e.to)) errors.push(`${where}: "to" is "${e.to}", which resolves to no node id.`);
    if (!EDGE_KINDS.includes(e.kind)) errors.push(`${where}: kind "${e.kind}" is not one of ${EDGE_KINDS.join(' | ')}.`);
    if (typeof e.sync !== 'boolean') errors.push(`${where}: "sync" must be true or false.`);
    if (!e.protocol) errors.push(`${where}: missing "protocol".`);
    if (!e.description) errors.push(`${where}: missing "description".`);
    if (e.milestone && !MILESTONES.includes(e.milestone)) {
      errors.push(`${where}: milestone "${e.milestone}" is not one of ${MILESTONES.join(' | ')}.`);
    }
    if (e.from === e.to) errors.push(`${where}: an edge from a node to itself carries no information.`);
  }

  errors.push(...validateLayers(graph, byId, edges));
  errors.push(...validateQueuesAndJobs(graph, byId));

  if (errors.length) fail(errors);
  return byId;
}

function validateLayers(graph, byId, edges) {
  const errors = [];
  const layers = graph.layers || {};
  const pure = new Set(layers.pure_packages || []);
  const io = new Set(layers.io_packages || []);
  const imports = edges.filter((e) => e.kind === 'imports' && byId.has(e.from) && byId.has(e.to));

  for (const e of imports) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);

    if (to.type === 'app') {
      errors.push(`layering violation L1/L4 (${e.id}): "${from.id}" imports the app "${to.id}". Nothing may import an app; move the shared code into a package.`);
    } else if (to.type !== 'package') {
      errors.push(`layering violation (${e.id}): "${from.id}" imports "${to.id}", which is a ${to.type}. An imports edge must point at a package.`);
    }
    if (from.type !== 'app' && from.type !== 'package') {
      errors.push(`layering violation (${e.id}): a ${from.type} node ("${from.id}") cannot import anything.`);
    }
    if (from.id === 'contracts') {
      errors.push(`layering violation L3 (${e.id}): "contracts" imports "${to.id}". contracts is the root of the graph and must import no workspace package.`);
    }
    if (pure.has(from.id)) {
      if (io.has(to.id)) {
        errors.push(`layering violation L2 (${e.id}): pure package "${from.id}" imports I/O package "${to.id}". core-domain and grading must stay deterministic and I/O free.`);
      } else if (!pure.has(to.id) && to.id !== 'contracts') {
        errors.push(`layering violation L2 (${e.id}): pure package "${from.id}" may import only contracts or another pure package, not "${to.id}".`);
      }
    }
  }

  const declared = new Set(imports.map((e) => `${e.from}->${e.to}`));
  for (const pair of layers.forbidden_imports || []) {
    if (!byId.has(pair.from)) errors.push(`layers.forbidden_imports: "${pair.from}" resolves to no node id.`);
    if (!byId.has(pair.to)) errors.push(`layers.forbidden_imports: "${pair.to}" resolves to no node id.`);
    if (declared.has(`${pair.from}->${pair.to}`)) {
      errors.push(`layering violation (forbidden import): "${pair.from}" imports "${pair.to}" but the rule says it must not. ${pair.reason}`);
    }
  }

  const cycle = findImportCycle(imports);
  if (cycle) {
    errors.push(`layering violation: import cycle ${cycle.join(' -> ')}. The package graph must be acyclic.`);
  }

  if (!Array.isArray(layers.rules) || layers.rules.length === 0) {
    errors.push('"layers.rules" must list the dependency-direction rules; the generated document renders them.');
  }
  return errors;
}

function findImportCycle(imports) {
  const adj = new Map();
  for (const e of imports) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const state = new Map();
  const stack = [];
  let found = null;

  const visit = (id) => {
    if (found) return;
    state.set(id, 'open');
    stack.push(id);
    for (const next of adj.get(id) || []) {
      if (state.get(next) === 'open') {
        found = stack.slice(stack.indexOf(next)).concat(next);
        return;
      }
      if (!state.has(next)) visit(next);
      if (found) return;
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const id of adj.keys()) if (!state.has(id)) visit(id);
  return found;
}

function validateQueuesAndJobs(graph, byId) {
  const errors = [];

  for (const [i, q] of (graph.queues || []).entries()) {
    const where = `queues[${i}]${q && q.name ? ` (${q.name})` : ''}`;
    for (const field of ['name', 'node', 'priority', 'payload', 'concurrency_env', 'retry', 'dead_letter']) {
      if (!q[field]) errors.push(`${where}: missing required field "${field}".`);
    }
    const node = byId.get(q.node);
    if (!node) errors.push(`${where}: "node" is "${q.node}", which resolves to no node id.`);
    else if (node.type !== 'queue') errors.push(`${where}: "node" must point at a queue node, but "${q.node}" is a ${node.type}.`);
  }

  const queueNodes = [...byId.values()].filter((n) => n.type === 'queue').map((n) => n.id);
  const describedQueues = new Set((graph.queues || []).map((q) => q.node));
  for (const id of queueNodes) {
    if (!describedQueues.has(id)) errors.push(`queue node "${id}" has no entry in "queues"; payload, retry policy and dead-letter are not optional.`);
  }

  for (const [i, j] of (graph.scheduled_jobs || []).entries()) {
    const where = `scheduled_jobs[${i}]${j && j.name ? ` (${j.name})` : ''}`;
    for (const field of ['node', 'name', 'cadence', 'invariant_protected']) {
      if (!j[field]) errors.push(`${where}: missing required field "${field}".`);
    }
    if (!Array.isArray(j.specified_by) || j.specified_by.length === 0) {
      errors.push(`${where}: "specified_by" must link at least one document.`);
    }
    const node = byId.get(j.node);
    if (!node) errors.push(`${where}: "node" is "${j.node}", which resolves to no node id.`);
    else if (node.type !== 'job') errors.push(`${where}: "node" must point at a job node, but "${j.node}" is a ${node.type}.`);
  }

  const jobNodes = [...byId.values()].filter((n) => n.type === 'job').map((n) => n.id);
  const describedJobs = new Set((graph.scheduled_jobs || []).map((j) => j.node));
  for (const id of jobNodes) {
    if (!describedJobs.has(id)) errors.push(`job node "${id}" has no entry in "scheduled_jobs"; cadence and the invariant it protects are not optional.`);
  }

  return errors;
}

/* --------------------------------------------------------------- rendering */

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const mid = (id) => `n_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`;
const mlabel = (s) => String(s).replace(/"/g, "'");

function mermaidShape(node) {
  const id = mid(node.id);
  const label = mlabel(node.name);
  switch (node.type) {
    case 'app': return `${id}["${label}"]`;
    case 'package': return `${id}(["${label}"])`;
    case 'datastore': return `${id}[("${label}")]`;
    case 'queue': return `${id}[/"${label}"/]`;
    case 'job': return `${id}{{"${label}"}}`;
    case 'external': return `${id}[["${label}"]]`;
    default: return `${id}["${label}"]`;
  }
}

function renderMermaid(graph) {
  const out = [];
  out.push('```mermaid');
  out.push('flowchart LR');
  for (const type of TYPE_ORDER) {
    const group = graph.nodes.filter((n) => n.type === type);
    if (group.length === 0) continue;
    out.push(`  subgraph sg_${type}["${TYPE_LABEL[type]}"]`);
    out.push('    direction TB');
    for (const n of group) out.push(`    ${mermaidShape(n)}`);
    out.push('  end');
  }
  out.push('');
  for (const e of graph.edges) {
    if (e.kind === 'imports') {
      out.push(`  ${mid(e.from)} -. imports .-> ${mid(e.to)}`);
    } else {
      out.push(`  ${mid(e.from)} -->|"${mlabel(e.kind)}"| ${mid(e.to)}`);
    }
  }
  out.push('```');
  return out.join('\n');
}

function renderNodeTable(graph) {
  const rows = [
    '| ID | Node | Type | Milestone | Status | Path | Purpose |',
    '|---|---|---|---|---|---|---|',
  ];
  const ordered = [...graph.nodes].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.id.localeCompare(b.id)
  );
  for (const n of ordered) {
    rows.push(`| \`${cell(n.id)}\` | ${cell(n.name)} | ${cell(n.type)} | ${cell(n.milestone)} | ${cell(n.status)} | \`${cell(n.path)}\` | ${cell(n.purpose)} |`);
  }
  return rows.join('\n');
}

function renderSurfaces(graph) {
  const out = [];
  const ordered = [...graph.nodes].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.id.localeCompare(b.id)
  );
  for (const n of ordered) {
    out.push(`#### \`${n.id}\` — ${n.name}`);
    out.push('');
    out.push(`**Owner:** ${n.owner}${n.owner_role ? ` (expected: ${n.owner_role})` : ''} · **Milestone:** ${n.milestone} · **Status:** ${n.status}`);
    out.push('');
    out.push('Public surface:');
    out.push('');
    for (const s of n.public_surface) out.push(`- ${s}`);
    out.push('');
    out.push('Invariants:');
    out.push('');
    for (const s of n.invariants) out.push(`- ${s}`);
    out.push('');
    out.push(`Specified by: ${n.docs.map((d) => `[\`${d}\`](${d})`).join(', ')}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function renderEdgeTable(graph) {
  const rows = [
    '| From | To | Kind | Protocol | Sync | Milestone | What crosses it |',
    '|---|---|---|---|---|---|---|',
  ];
  const runtime = graph.edges.filter((e) => e.kind !== 'imports');
  const imports = graph.edges.filter((e) => e.kind === 'imports');
  for (const e of [...runtime, ...imports]) {
    rows.push(`| \`${cell(e.from)}\` | \`${cell(e.to)}\` | ${cell(e.kind)} | ${cell(e.protocol)} | ${e.sync ? 'yes' : 'no'} | ${cell(e.milestone ?? '—')} | ${cell(e.description)} |`);
  }
  return rows.join('\n');
}

function renderQueueTable(graph) {
  const rows = [
    '| Queue | Priority | Producer → consumer | Payload | Concurrency | Retry | Dead letter |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const q of graph.queues || []) {
    rows.push(
      `| \`${cell(q.name)}\` | ${cell(q.priority)} | \`${cell(q.producer)}\` → \`${cell(q.consumer)}\` | \`${cell(q.payload)}\` | ${cell(q.concurrency_env)} | ${cell(q.retry)} | ${cell(q.dead_letter)} |`
    );
  }
  const notes = (graph.queues || []).filter((q) => q.notes);
  if (notes.length) {
    rows.push('');
    for (const q of notes) rows.push(`- \`${q.name}\` — ${q.notes}`);
  }
  return rows.join('\n');
}

function renderJobTable(graph) {
  const rows = [
    '| Job | Cadence | Milestone | Specified by | Invariant it protects |',
    '|---|---|---|---|---|',
  ];
  for (const j of graph.scheduled_jobs || []) {
    const docs = (j.specified_by || []).map((d) => `[\`${d}\`](${d})`).join(', ');
    rows.push(`| ${cell(j.name)} (\`${cell(j.node)}\`) | ${cell(j.cadence)} | ${cell(j.milestone ?? '—')} | ${docs} | ${cell(j.invariant_protected)} |`);
  }
  return rows.join('\n');
}

function renderLayers(graph) {
  const layers = graph.layers || {};
  const out = [];
  if (layers.description) {
    out.push(layers.description);
    out.push('');
  }
  if (Array.isArray(layers.order)) {
    out.push(`Direction of dependency, top to bottom: ${layers.order.map((l) => `**${l}**`).join(' → ')}.`);
    out.push('');
  }
  out.push('| Rule | Statement | Why | Enforced by |');
  out.push('|---|---|---|---|');
  for (const r of layers.rules || []) {
    out.push(`| ${cell(r.id)} | ${cell(r.rule)} | ${cell(r.rationale)} | ${cell(r.enforced_by)} |`);
  }
  out.push('');
  out.push('Forbidden import pairs. The generator fails if any of these appears as an `imports` edge.');
  out.push('');
  out.push('| From | To | Reason |');
  out.push('|---|---|---|');
  for (const p of layers.forbidden_imports || []) {
    out.push(`| \`${cell(p.from)}\` | \`${cell(p.to)}\` | ${cell(p.reason)} |`);
  }
  return out.join('\n');
}

function renderGenerated(graph) {
  const meta = graph._meta || {};
  const counts = TYPE_ORDER.map((t) => `${graph.nodes.filter((n) => n.type === t).length} ${TYPE_LABEL[t].toLowerCase()}`).join(', ');
  const runtimeEdges = graph.edges.filter((e) => e.kind !== 'imports').length;
  const importEdges = graph.edges.length - runtimeEdges;

  const out = [];
  out.push(BEGIN);
  out.push('');
  out.push('<!--');
  out.push(`  Generated from code-graph.json by scripts/gen-code-graph.mjs. Do not edit this region by hand.`);
  out.push(`  Edit code-graph.json and run: ${meta.regeneration_command || 'node scripts/gen-code-graph.mjs'}`);
  out.push('-->');
  out.push('');
  out.push('## Graph at a glance');
  out.push('');
  out.push(`Graph version ${meta.version || '0.0.0'}, generated ${meta.generated_at || 'unknown'}. ${counts}. ${runtimeEdges} runtime edges, ${importEdges} import edges.`);
  out.push('');
  out.push(renderMermaid(graph));
  out.push('');
  out.push('Solid arrows are runtime calls, labelled by kind. Dotted arrows are compile-time workspace imports and always point down the layer order.');
  out.push('');
  out.push('## Nodes');
  out.push('');
  out.push(renderNodeTable(graph));
  out.push('');
  out.push('## Public surface and invariants');
  out.push('');
  out.push(renderSurfaces(graph));
  out.push('');
  out.push('## Edges');
  out.push('');
  out.push(renderEdgeTable(graph));
  out.push('');
  out.push('## Queues');
  out.push('');
  out.push(renderQueueTable(graph));
  out.push('');
  out.push('## Scheduled jobs');
  out.push('');
  out.push(renderJobTable(graph));
  out.push('');
  out.push('## Layering rules');
  out.push('');
  out.push(renderLayers(graph));
  out.push('');
  out.push(END);
  return out.join('\n');
}

/* ------------------------------------------------------------------ splice */

function splice(doc, generated) {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    fail([
      `${rel(DOC_PATH)} is missing the generated-region markers.`,
      `Add a line containing exactly ${BEGIN} and, below it, a line containing exactly ${END}.`,
    ]);
  }
  if (end < start) {
    fail([`${rel(DOC_PATH)}: ${END} appears before ${BEGIN}.`]);
  }
  return doc.slice(0, start) + generated + doc.slice(end + END.length);
}

function reportStale(current, next) {
  const a = current.split('\n');
  const b = next.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.error('\nCODE-GRAPH.md is stale relative to code-graph.json.\n');
  console.error(`  First difference at line ${i + 1}:`);
  console.error(`    committed: ${JSON.stringify(a[i] ?? '<end of file>')}`);
  console.error(`    generated: ${JSON.stringify(b[i] ?? '<end of file>')}`);
  console.error(`  Line count: committed ${a.length}, generated ${b.length}.`);
  console.error('\n  Fix: run `node scripts/gen-code-graph.mjs` and commit CODE-GRAPH.md alongside code-graph.json.\n');
  process.exit(1);
}

/* -------------------------------------------------------------------- main */

function main() {
  const check = process.argv.includes('--check');
  const graph = loadGraph();
  validate(graph);

  if (!existsSync(DOC_PATH)) {
    fail([
      `${rel(DOC_PATH)} does not exist.`,
      `Create it with the hand-written sections plus a generated region delimited by ${BEGIN} and ${END}.`,
    ]);
  }

  const current = readFileSync(DOC_PATH, 'utf8');
  const next = splice(current, renderGenerated(graph));

  if (check) {
    if (current !== next) reportStale(current, next);
    console.log(`code-graph OK: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${(graph.queues || []).length} queues, ${(graph.scheduled_jobs || []).length} scheduled jobs. CODE-GRAPH.md is in sync.`);
    return;
  }

  if (current === next) {
    console.log(`code-graph OK: CODE-GRAPH.md already in sync (${graph.nodes.length} nodes, ${graph.edges.length} edges).`);
    return;
  }
  writeFileSync(DOC_PATH, next, 'utf8');
  console.log(`Wrote ${rel(DOC_PATH)} (${graph.nodes.length} nodes, ${graph.edges.length} edges, ${(graph.queues || []).length} queues, ${(graph.scheduled_jobs || []).length} scheduled jobs).`);
}

main();
