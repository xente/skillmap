# SkillMap

Point it at an AI project folder. It finds every **skill**, **agent** and
**instruction file**, works out how they reference each other, and renders one
self-contained interactive HTML report — so you can stop maintaining skills
nobody uses, skills that overlap, and organizers whose children you've lost
track of.

No dependencies. No build step. One Node command.

```bash
node bin/skillmap.mjs <project-folder> --open
```

## What it looks at

It scans the folder recursively (skipping `node_modules`, `.git`, `dist`,
`worktrees`, …) and recognises the conventions these tools actually use:

| Found | Treated as |
| --- | --- |
| `**/SKILL.md`, `<scope>/skills/<name>.md` | **Skill** |
| `**/agents/*.md`, `**/agent/*.md` (e.g. `.claude/agents`, `.opencode/agents`) | **Agent** |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.config/AGENTS/*.md` | **Instructions** |

Reference docs that live *inside* a skill (`references/`, `scripts/`,
`templates/`, …) are correctly ignored — they are part of a skill, not skills
themselves.

Frontmatter is parsed for `name`, `description`, `tools`, `model`, `mode`,
`argument-hint` and `disable-model-invocation`. Scopes (`.claude`, `.opencode`,
`.codex`, `.config`, …) are labelled automatically.

## How connections are derived

For every file it looks for deliberate references to other known
skills/agents/instructions:

- explicit paths — `` @./.config/AGENTS/e2e-testing.md ``
- backticked names — `` `build-plugin` ``
- names preceded by a signal word — *skill, agent, delegate, orchestrate, use,
  read, usa, usar, lee, flujo, task, @, →* …

A name that exists in several scopes is linked to the copy in the *same* scope
when there is one, and a file mentioning its own name never counts as using its
copies elsewhere — otherwise every copy would look "used".

It turns them into typed edges:

- **skill reference** — a skill using another skill
- **delegation** — an agent handing off to another agent
- **instructs** — an instruction file pointing at skills/agents

## What it surfaces (Insights)

- **Unused skills** — nothing references them. Candidates for deletion.
- **Orphan organizers** — skills that orchestrate others but are themselves
  never invoked. Wire them into an agent or a parent.
- **Duplicate names** — the same skill/agent name in more than one place
  (usually the same skill copied across `.claude` / `.opencode` / `.codex`).
  Instruction files are excluded: one `AGENTS.md` per folder is the convention.
- **Similar names** — close enough to confuse (`design` vs `design-system`,
  plurals, typos, near-identical prefixes).
- **Overlapping descriptions** — descriptions ≥40% token-similar (same-name
  copies are excluded; they are reported as cross-scope copies).
- **Cross-scope copies** — the same skill/agent name living in more than one
  scope (`.claude` / `.opencode` / `.codex`). The % is how many lines of the
  file the copies share; a low % means they have **drifted apart**. **Click one to see the exact
  line-by-line diff** (`+added` / `−removed`), or use **⇄ Compare copies** in the
  details drawer.
- **Reference cycles** — A → B → … → A, which make orchestration ambiguous.
- **Organizers** and **Most connected** — the hubs of the project.

Each finding is a card; click any item to jump to it in the graph.

## The views

- **Diagram** (default) — UML-style cards. Each card is one skill/agent/instruction
  and shows its name, kind, scope, `mode`, child count, in/out references, a
  snippet of its description, its `model`/`tools`/`args`, and any finding
  (`unused`, `orphan organizer`, `duplicate name`…). Arrows are typed edges with
  labels on the focused card.
  - **Drag a card to move it, scroll to zoom, click for the details drawer.**
  - **Double-click a card to zoom in on it** (double-click empty space to zoom
    there). Or use the `−` / `+` / `100%` buttons, or `+` / `-` / `0` keys.
    Trackpad/wheel zoom is damped so it stays controllable.
  - **▦ Group by scope** packs the cards into a labelled container box per scope
    (`.claude`, `.opencode`, `.codex`, Project…). `G`. **Click a group header to
    collapse/expand** it.
  - The layout is computed once and then **frozen** — filtering and searching only
    show/hide, they never reshuffle. Use **⟳ Re-layout** (`R`) for a fresh
    arrangement and **⤢ Fit** (`F`) to frame everything.
  - **Read the full definition**: the details drawer shows a live preview of the
    file plus a **⤢ Read full definition** button (or press `O`) that opens the
    complete `SKILL.md` / agent file in a scrollable reader, **rendered as
    Markdown** (frontmatter as a table, headings, lists, tables, fenced code and
    links).
- **Graph** — the classic force-directed map, kept for comparison. Color = kind,
  size = connectivity, red ring = unused, amber ring = organizer.
- **Hierarchy** — organizers expand into their children (recursively), plus
  agents → the skills they pull in, and any stranded skills.
- **Insights** — the findings above.

Filters by kind and scope, plus a search box (`/` to focus, **Enter** jumps to
the first match, **Esc** clears it), let you isolate one tool's scope or hunt
for a name. When filters hide something a banner says so, with a **Show all**
button. Clicking any item in Insights/Hierarchy reveals it even if it was
filtered out. Both the Diagram and the Graph share one details drawer, which
lists every connection together with the text snippet that produced it — so a
false positive is easy to spot — plus a **Copy path** button.

Insights that involve several nodes (duplicate/similar names, overlapping
descriptions, cross-scope copies) show both names and open a side-by-side diff
when clicked.

### Keyboard

| Key | Action |
| --- | --- |
| `/` | Search |
| `1`–`4` | Diagram · Graph · Hierarchy · Insights |
| `F` / `R` / `G` | Fit · Re-layout · Group by scope |
| `+` `-` `0` | Zoom in · out · 100% |
| `O` | Read the selected definition |
| `Esc` | Close dialog / clear selection |
| `?` | Shortcut help |

### Export

- **⤓ PNG** — saves the current Diagram or Graph view (with background) as an image.
- **⤓ JSON** — saves the full graph payload (nodes, edges, analysis) for
  scripting or CI. `skillmap <folder> -j out.json` writes the same file directly.

## Usage

```bash
skillmap <project-folder> [options]

  -o, --out <file>   Output HTML file   (default: <project>/.skillmap/skillmap.html)
  -j, --json <file>  Also write the raw graph as JSON (for scripting/CI)
      --open         Open the report in your browser
  -h, --help         Show help
```

Examples:

```bash
# the project you're standing in → ./.skillmap/skillmap.html
node bin/skillmap.mjs . --open

# a specific project, with a JSON dump for CI
node bin/skillmap.mjs ~/code/my-app -o reports/skillmap.html -j reports/skillmap.json
```

By default the report is written **inside the scanned project**, at
`<project>/.skillmap/skillmap.html` (the folder is created if needed, and
SkillMap never scans its own output). Commit it to share the map with your
team, or add `.skillmap/` to the project's `.gitignore` to keep it local. Use
`-o` to write it somewhere else.

The output is a single HTML file with the data inlined — no server, no
network. Open it anywhere. Note that it embeds the contents of the scanned
skill/agent files and the project's absolute path.

## Using it from another project

Drop this folder anywhere and call it with an absolute path, or symlink the
binary:

```bash
npm link            # makes `skillmap` available globally
skillmap ~/code/my-app --open
```

## Layout

```
bin/skillmap.mjs     CLI entry point
lib/scan.mjs         recursive scanner + frontmatter parser
lib/analyze.mjs      graph builder, duplicate/unused/cycle analysis
lib/report.mjs       inlines assets + data into one HTML file
assets/template.html page shell
assets/app.css       styling
assets/app.js        force-directed graph + views
```
