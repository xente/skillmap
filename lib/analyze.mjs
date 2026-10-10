// skillmap — graph builder + analysis.
// Turns scanned docs into a node/edge graph, then derives the insights the
// user cares about: unused skills, duplicates, organizers/children, orphans.

const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','for','in','on','with','use','this',
  'that','you','your','it','is','are','be','as','at','by','from','when','not',
  'do','does','can','will','should','must','if','then','than','into','about',
  'skill','skills','agent','agents','file','files','code','project','user',
  'using','used','based','only','also','any','all','each','other','more',
  'de','la','el','los','las','un','una','unos','unas','y','o','para','con',
  'en','del','al','que','por','se','su','es','son','como','cuando','no','si',
  'usa','usar','skill','agente','agentes','fichero','proyecto','código','codigo',
]);

// Words that signal the next token is a deliberate reference (not prose).
const REF_VERB = /(\bskills?\b|\bagents?\b|\bsub-?agents?\b|\bsubagentes?\b|delegat|\borchestrat|\buse\b|\busa\b|\busar\b|\blee\b|\bleer\b|\bread\b|invoca|\bdispatch\b|\btasks?\b|\btareas?\b|flujo|workflow|pipeline|hand ?off|@|\/|->|→)\s*[`"']?$/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9áéíóúñü]+/i)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Build the reference graph. */
export function buildGraph(docs) {
  const byId = new Map(docs.map((d) => [d.id, d]));

  // name → docs (name can collide across scopes → that is itself a finding)
  const bySlug = new Map();
  for (const d of docs) {
    const keys = new Set([d.slug, slug(d.name)]);
    const folder = d.rel.split(/[\\/]/).slice(-2, -1)[0];
    if (d.isSkillFile && folder) keys.add(slug(folder));
    for (const k of keys) {
      if (!k || k.length < 3) continue;
      if (!bySlug.has(k)) bySlug.set(k, []);
      if (!bySlug.get(k).includes(d)) bySlug.get(k).push(d);
    }
  }

  const edges = [];
  const edgeKey = new Map();
  const addEdge = (source, target, type, snippet) => {
    if (source === target) return;
    const k = `${source}|${target}|${type}`;
    const existing = edgeKey.get(k);
    if (existing) {
      if (snippet && existing.evidence.length < 4 && !existing.evidence.includes(snippet)) existing.evidence.push(snippet);
      return;
    }
    const e = { source, target, type, evidence: snippet ? [snippet] : [], weight: 1 };
    edgeKey.set(k, e);
    edges.push(e);
  };

  // Explicit file-path references:  @./.config/AGENTS/e2e-testing.md  or  .claude/skills/x/SKILL.md
  const pathRefDocs = docs.map((d) => ({ d, rel: d.rel.replace(/\\/g, '/') }));

  for (const doc of docs) {
    const text = `${doc.description}\n${doc.body}`;
    const lower = text.toLowerCase();

    // 1) file-path references
    const pathRe = /(?:@?\.?\/?)([\w./-]*(?:skills|agents|AGENTS)\/[\w./-]+\.(?:md|markdown|mdx))/gi;
    for (const m of text.matchAll(pathRe)) {
      const refPath = m[1].replace(/^\.?\//, '');
      const hit = pathRefDocs.find((p) => p.rel === refPath || p.rel.endsWith('/' + refPath) || refPath.endsWith(p.rel));
      if (hit && hit.d.id !== doc.id) {
        addEdge(doc.id, hit.d.id, doc.kind === 'instructions' ? 'instruction-ref' : 'path-ref', m[0].trim());
      }
    }

    // 2) name references
    for (const [key, targets] of bySlug) {
      const re = new RegExp(`(^|[^\\w@/.-])(${esc(key)})(?![\\w-])`, 'gi');
      let m;
      let count = 0;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const before = text.slice(Math.max(0, start - 45), start + m[1].length);
        // a little leading context, cut at a word boundary so it reads cleanly
        const from = Math.max(0, start - 30);
        let around = text.slice(from, start + 60);
        if (from > 0) around = around.replace(/^\S*\s+/, '');
        const inTick = /`[^`]*$/.test(before) || /`$/.test(before);
        const isVerb = REF_VERB.test(before);
        const distinctive = key.includes('-') || key.length >= 9;
        count++;
        if (!inTick && !isVerb && !distinctive) continue;
        // A doc mentioning its own name is not a reference to its copies in
        // other scopes. When the name exists in the doc's own scope, link only
        // there — otherwise every copy would look "used".
        const candidates = targets.filter((t) => t.id !== doc.id && t.slug !== doc.slug);
        const sameScope = candidates.filter((t) => t.scope === doc.scope);
        for (const t of sameScope.length ? sameScope : candidates) {
          const type = doc.kind === 'skill' && t.kind === 'skill' ? 'skill-ref'
            : doc.kind === 'agent' && t.kind === 'agent' ? 'delegation'
            : doc.kind === 'instructions' ? 'instruction-ref'
            : 'uses';
          addEdge(doc.id, t.id, type, around.trim().replace(/\s+/g, ' ').slice(0, 90));
        }
        if (count > 40) break;
      }
    }
  }

  // degree metrics
  const inDeg = new Map();
  const outDeg = new Map();
  for (const e of edges) {
    outDeg.set(e.source, (outDeg.get(e.source) || 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  }

  const nodes = docs.map((d) => ({
    ...d,
    inDegree: inDeg.get(d.id) || 0,
    outDegree: outDeg.get(d.id) || 0,
    degree: (inDeg.get(d.id) || 0) + (outDeg.get(d.id) || 0),
    tokens: tokens(d.description),
  }));

  for (const n of nodes) delete n.body; // keep the JSON payload lean

  // Organizers: skills/instructions/agents that orchestrate >= 2 children.
  for (const n of nodes) {
    const kids = edges.filter((e) => e.source === n.id && e.target !== n.id);
    n.children = [...new Set(kids.map((e) => e.target))];
    n.isOrganizer = n.children.length >= 2;
  }

  return { nodes: nodes.map((n) => ({ ...n, tokenSet: undefined })), edges, byId, docs };
}

/** Derive the insights (unused / duplicates / hierarchy / god nodes). */
export function analyze(graph) {
  const { nodes, edges } = graph;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const unusedAll = nodes
    .filter((n) => n.kind === 'skill' && n.inDegree === 0 && !n.commandOnly)
    .map((n) => n.id);
  const unusedOrganizers = unusedAll.filter((id) => nodeById.get(id).isOrganizer);
  const unusedLeaves = unusedAll.filter((id) => !nodeById.get(id).isOrganizer);

  const manualOnly = nodes
    .filter((n) => n.kind === 'skill' && n.inDegree === 0 && n.commandOnly)
    .map((n) => n.id);

  // duplicate names (same slug in >1 place)
  const nameGroups = new Map();
  for (const n of nodes) {
    if (n.kind === 'instructions') continue; // one AGENTS.md per folder is the convention, not a duplicate
    const k = n.slug;
    if (!nameGroups.has(k)) nameGroups.set(k, []);
    nameGroups.get(k).push(n.id);
  }
  const duplicateNames = [...nameGroups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, ids]) => ({ name, ids }));

  // near-duplicate descriptions (same kind, similar tokens)
  const descDupes = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.kind !== b.kind || a.slug === b.slug) continue; // same-name copies are reported as cross-scope copies
      const s = jaccard(a.tokens, b.tokens);
      if (s >= 0.4) descDupes.push({ ids: [a.id, b.id], score: Math.round(s * 100) / 100 });
    }
  }
  descDupes.sort((x, y) => y.score - x.score);

  // confusingly similar names (design vs design-system, typos, plurals)
  const similarNames = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      if (a.kind !== b.kind) continue;
      if (a.slug === b.slug) continue;
      if (Math.min(a.slug.length, b.slug.length) < 5) continue;
      const s = nameSim(a.slug, b.slug);
      if (s >= 0.75) similarNames.push({ ids: [a.id, b.id], score: Math.round(s * 100) / 100 });
    }
  }
  similarNames.sort((x, y) => y.score - x.score);

  // cross-scope copies: same name in >1 scope — do the copies still match?
  const bySlug2 = new Map();
  for (const n of nodes) {
    if (!bySlug2.has(n.slug)) bySlug2.set(n.slug, []);
    bySlug2.get(n.slug).push(n);
  }
  const scopeDivergence = [];
  for (const list of bySlug2.values()) {
    if (list[0].kind === 'instructions') continue;
    const scopes = [...new Set(list.map((n) => n.scope))];
    if (scopes.length < 2) continue;
    // Compare the whole file line by line — two copies can share a description
    // and still have drifted apart in the body.
    const lineSets = list.map((n) => lineSet(n.raw));
    let min = 1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) min = Math.min(min, jaccard(lineSets[i], lineSets[j]));
    }
    scopeDivergence.push({ name: list[0].name, ids: list.map((n) => n.id), scopes, similarity: Math.round(min * 100) / 100, diverged: min < 0.6 });
  }
  scopeDivergence.sort((a, b) => a.similarity - b.similarity);

  // organizers + hierarchy
  const organizers = nodes
    .filter((n) => n.isOrganizer)
    .sort((a, b) => b.children.length - a.children.length)
    .map((n) => ({ id: n.id, children: n.children }));

  // god nodes by degree
  const godNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 8).map((n) => n.id);

  // scope breakdown
  const scopes = {};
  for (const n of nodes) scopes[n.scope] = (scopes[n.scope] || 0) + 1;

  // cycle detection (skill A -> B -> A) — ignore the shared AGENTS.md-style
  // instructions and generic "uses" edges, they would create false loops.
  const orchEdges = edges.filter((e) => e.type === 'skill-ref' || e.type === 'delegation');
  const orchNodes = nodes.filter((n) => n.kind === 'skill' || n.kind === 'agent');
  const cycles = findCycles(orchNodes, orchEdges);

  const health = computeHealth({ nodes, unused: unusedAll, duplicateNames, descDupes, similarNames, cycles });

  return { unused: unusedAll, unusedLeaves, unusedOrganizers, manualOnly, duplicateNames, descDupes, similarNames, scopeDivergence, organizers, godNodes, scopes, cycles, health };
}

function lineSet(text) {
  return new Set(String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

function findCycles(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) adj.get(e.source)?.push(e.target);
  const out = [];
  const seen = new Set();
  let budget = 200000; // dense graphs explode combinatorially — stop exploring after this many steps
  for (const n of nodes) {
    const stack = [[n.id, [n.id]]];
    while (stack.length && budget-- > 0) {
      const [cur, path] = stack.pop();
      for (const nxt of adj.get(cur) || []) {
        if (nxt === n.id && path.length > 1) {
          const key = [...path].sort().join('|');
          if (!seen.has(key)) { seen.add(key); out.push(path.slice()); }
        } else if (!path.includes(nxt) && path.length < 8) {
          stack.push([nxt, [...path, nxt]]);
        }
      }
    }
  }
  return out.slice(0, 20);
}

function computeHealth({ nodes, unused, duplicateNames, descDupes, similarNames, cycles }) {
  const totalSkills = nodes.filter((n) => n.kind === 'skill').length || 1;
  let score = 100;
  score -= Math.min(45, (unused.length / totalSkills) * 90);
  score -= Math.min(20, duplicateNames.length * 5);
  score -= Math.min(15, similarNames.length * 2);
  score -= Math.min(15, descDupes.length * 2);
  score -= Math.min(10, cycles.length * 3);
  score = Math.max(0, Math.round(score));
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade };
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function nameSim(a, b) {
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export { tokens, jaccard };
