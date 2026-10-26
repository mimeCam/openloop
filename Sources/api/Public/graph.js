(function () {
    const instanceParam = new URLSearchParams(location.search).get('instance');
    let nodes = [];
    let agents = [];
    let selectedId = null;
    let composerMode = null;
    let composerRefId = null;
    let mcpOriginal = '';
    let mcpAuthOriginal = '';
    let nameOriginal = '';
    let promptEditing = false;
    let summaryEditing = false;
    let panelStatus = '';
    let panelJson = '';
    let logsJson = '';
    let runsCache = [];
    let focusedRunId = null;
    let footerKey = null;
    let pendingRowFocus = null;
    let pendingRunFocus = null; // run to open once logs land — a ?run= deep link OR a freshly scheduled run; consumed in loadLogs
    let staleDeepRun = false;   // a pending run id that no longer exists → one-line notice
    let runSummaryEditing = false;
    let countdownInterval = null;
    let countdownValue = 5;
    let viewMode = 'normal';
    let attractPlayed = false; // one attract pulse per empty-graph period
    const ISOLATED_RUN = false; // flip to true to run sanity checks in DevTools

    const $ = id => document.getElementById(id);

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s ?? '';
        return d.innerHTML.replace(/"/g, '&quot;');
    }

    function showError(msg) {
        const el = $('error-banner');
        el.textContent = msg;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 5000);
    }

    async function fetchJson(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`${res.status} ${body.slice(0, 140)}`);
        }
        return res.json();
    }

    async function loadAgents() {
        try {
            const data = await fetchJson('/api/agents');
            agents = data.agents.map(a => a.name);
        } catch {
            agents = [];
        }
    }

    async function loadInstances() {
        try {
            const data = await fetchJson('/api/instances');
            renderChain(parentChainOf(data.instances, instanceParam));
            await loadPersonas(data.instances);
        } catch { }
    }

    function parentChainOf(instances, self) {
        const parentOf = {};
        for (const inst of instances) parentOf[inst.path] = inst.parentPath;
        const chain = [];
        let cur = self;
        const visited = new Set();
        while (cur && !visited.has(cur)) {
            visited.add(cur);
            chain.unshift(cur);
            cur = parentOf[cur];
        }
        return chain;
    }

    // Crumb markup, pure (checkChainPath pins it): parents are names-only —
    // context, not location, and their paths already ride the hover; the
    // current crumb states its full path inline, muted beside the green
    // name. Name and path are separate spans so the path is what ellipsizes
    // when the bar runs out of room (.crumb.cur is a flex row in graph.html).
    function crumbHtml(p, cur) {
        const name = p.split('/').filter(Boolean).pop() || p;
        const cls = cur ? 'crumb cur' : 'crumb';
        const body = cur
            ? `<span class="crumb-name">${esc(name)}</span><span class="crumb-path">(${esc(p)})</span>`
            : esc(name);
        return `<span class="${cls}" title="${esc(p)}">${body}</span>`;
    }

    function renderChain(chain) {
        const crumbs = chain.map((p, i) => crumbHtml(p, i === chain.length - 1));
        const sep = '<span class="crumb-sep">&gt;</span>';
        $('graph-chain').innerHTML = sep + crumbs.join(sep);
    }

    let personaGroups = [];
    const personaIndex = new Map();

    async function loadPersonas(instances) {
        const sources = personaSources(instances);
        await Promise.all(sources.map(async src => {
            src.personas = await fetchPersonasAt(src.path);
            src.personas.forEach(p => personaIndex.set(p.id, p));
        }));
        personaGroups = sources.filter(s => s.personas.length);
    }

    async function fetchPersonasAt(path) {
        try {
            const data = await fetchJson(`/api/instances/${encodeURIComponent(path)}/personas`);
            return data.personas || [];
        } catch {
            return [];
        }
    }

    function personaSources(instances) {
        const chain = parentChainOf(instances, instanceParam);
        const globals = instances
            .filter(i => i.isGlobalShare && !chain.includes(i.path))
            .map(i => i.path);
        return [
            { label: 'This workflow', path: instanceParam },
            ...chain.slice(0, -1).map(p => ({ label: `Parent: ${baseName(p)}`, path: p })),
            ...globals.map(p => ({ label: 'Global (system-wide)', path: p }))
        ];
    }

    function baseName(p) {
        return p.split('/').filter(Boolean).pop() || p;
    }

    async function load() {
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph`;
        try {
            const data = await fetchJson(url);
            nodes = data.nodes;
            if (nodes.length) emptiedByDelete = false;
            render();
            refreshPanel();
        } catch (e) {
            showError(`Failed to load graph: ${e.message}`);
        }
        resetCountdown();
    }

    function refreshPanel() {
        if (!selectedId) return;
        const n = nodes.find(x => x.id === selectedId);
        if (!n) return closePanel();
        if (focusedRunId) return loadLogs(selectedId);
        if (promptEditing || summaryEditing) return;
        if (n.status === panelStatus) return loadLogs(selectedId);
        const input = $('mcp-input');
        if (input && input.value.trim() !== mcpOriginal) return;
        const authInput = $('mcp-auth-input');
        if (authInput && authInput.value.trim() !== mcpAuthOriginal) return;
        const nameInput = $('name-input');
        if (nameInput && nameInput.value.trim() !== nameOriginal) return;
        openPanel(n);
    }

    // A wider panel can free a folded text; a narrower one folds a free
    // one; a late webfont (or a rotation) can re-wrap either way. Re-gate
    // every bubble surface once geometry settles. OPEN stays OPEN — the
    // gate never re-folds an expanded text, and a freed text's door simply
    // dissolves, no announcement.
    function regateBubbles() {
        if (viewMode === 'birds') return;
        OpenLoopBubble.gateBubbles($('detail-panel-inner'));
        OpenLoopBubble.gateBubbles($('graph-grid'));
        drawEdges(); // a fold↔free flip changes card heights
    }

    function updateCountdown() {
        const el = $('refreshCountdown');
        if (!el) return;
        if ($('composer').classList.contains('open')) {
            el.textContent = '--';
            el.classList.add('paused');
            el.classList.remove('warning');
            return;
        }
        el.classList.remove('paused');
        el.textContent = countdownValue + 's';
        el.classList.toggle('warning', countdownValue <= 2);
        countdownValue--;
        if (countdownValue < 0) countdownValue = 5;
    }

    function startCountdown() {
        countdownValue = 5;
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
    }

    function resetCountdown() {
        countdownValue = 5;
        updateCountdown();
    }

    function childrenMap() {
        const map = new Map();
        for (const n of nodes) {
            const key = n.parent_id;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(n);
        }
        return map;
    }

    // root-ness has one definition: no parent, or a parent outside the graph
    // (delete bridges children up; orphans re-root). Column building and the
    // edge count read from this helper; naming is per-cell and needs no root.
    function rootNodes() {
        const ids = new Set(nodes.map(n => n.id));
        return nodes.filter(n => !n.parent_id || !ids.has(n.parent_id));
    }

    function buildColumns() {
        const byParent = childrenMap();
        const cols = [];
        let level = rootNodes();
        while (level.length) {
            cols.push(level);
            level = level.flatMap(n => byParent.get(n.id) || []);
        }
        return cols;
    }

    // — birds-eye view —
    // Spine & branch: every node renders exactly once — a chain ends at its fork, branches continue below indented to the child's depth (--be-offset, graph.html).

    function byCreated(a, b) {
        return a.created_at - b.created_at || String(a.id).localeCompare(String(b.id));
    }

    function sortedKids(n, byParent) {
        return (byParent.get(n.id) || []).slice().sort(byCreated);
    }

    function segmentsOf() {
        const byParent = childrenMap();
        const seen = new Set();
        const out = [];
        rootNodes().sort(byCreated).forEach(r => emitSegment(r, byParent, 0, out, seen));
        return out;
    }

    // DFS pre-order — grouping rides on DOM order: reading order is tab order.
    function emitSegment(node, byParent, depth, out, seen) {
        if (seen.has(node.id)) return;
        const seg = extendSegment({ indent: depth, nodes: [], leaf: true }, node, byParent, seen);
        out.push(seg);
        forkKids(seg, byParent, seen).forEach(kid =>
            emitSegment(kid, byParent, depth + seg.nodes.length, out, seen));
    }

    function extendSegment(seg, node, byParent, seen) {
        seen.add(node.id); // visited guard: malformed parent links must never hang the walk
        seg.nodes.push(node);
        const kids = sortedKids(node, byParent).filter(k => !seen.has(k.id));
        seg.leaf = !kids.length;
        return kids.length === 1 ? extendSegment(seg, kids[0], byParent, seen) : seg;
    }

    function forkKids(seg, byParent, seen) {
        const end = seg.nodes[seg.nodes.length - 1];
        return seg.leaf ? [] : sortedKids(end, byParent).filter(k => !seen.has(k.id));
    }

    function render() {
        const out = viewMode === 'birds' ? renderBirdsEye() : renderGrid();
        syncAddRootAttract();
        syncMcpAuthWarn();
        return out;
    }

    // Header warning: how many cells wait on an MCP key this computer
    // doesn't hold. Hidden at zero; the count is the answer to "which cells
    // need auth?" before any cell is tapped. Static toolbar DOM — updated
    // in place, never re-created, so the once-bound click listener survives
    // every 5s poll.
    function syncMcpAuthWarn() {
        const btn = $('mcp-auth-warn');
        if (!btn) return;
        const count = nodes.filter(mcpAuthMissing).length;
        btn.hidden = !count;
        btn.querySelector('.gt-warn-count').textContent = count;
    }

    // The pinned + is the empty state's front door: pulse when the canvas
    // empties (first load or delete-all), once — never again until it refills.
    function syncAddRootAttract() {
        const btn = $('add-root');
        if (nodes.length) { attractPlayed = false; return btn.classList.remove('attract'); }
        if (!attractPlayed) { attractPlayed = true; btn.classList.add('attract'); }
    }

    function renderGrid() {
        const grid = $('graph-grid');
        const snap = OpenLoopBubble.snapshotExpansion(grid); // the 5s rebuild must not re-fold an opened cell
        const cols = buildColumns();
        const hint = nodes.length ? '' : `<span id="empty-hint">${emptyHint()}</span>`;
        grid.innerHTML = `<svg id="edge-layer"></svg>` + hint +
            cols.map(col => `<div class="depth-col">${col.map(nodeCell).join('')}</div>`).join('');
        bindGraph(grid);
        OpenLoopBubble.restoreExpansion(grid, snap);
        OpenLoopBubble.gateBubbles(grid);
        drawEdges(); // after the gate: edges follow the folded card heights
        syncBirdsToggle();
    }

    function renderBirdsEye() {
        const host = $('birds-eye');
        host.innerHTML = nodes.length
            ? segmentsOf().map(laneHtml).join('')
            : `<span id="empty-hint">${emptyHint()}</span>`;
        syncBirdsToggle();
        bindBirdsEye(host);
    }

    function emptyHint() {
        return emptiedByDelete
            ? 'All nodes deleted — tap + to start fresh'
            : 'no runs yet — tap + to start';
    }

    // Trails belong to outcomes (leaf segments only); .be-branch tags indent > 0 (P2 bracket hook, graph.html).
    function laneHtml(seg) {
        const last = seg.nodes.length - 1;
        return `<div class="be-chain${seg.indent ? ' be-branch' : ''}" style="--be-offset:${seg.indent}">` +
            `<div class="be-lane">` +
            seg.nodes.map((n, i) => slotHtml(n, seg.nodes[i + 1], i === last)).join('') +
            (seg.leaf ? personaTrail(seg.nodes[last]) : '') + `</div>` +
            captionsHtml(seg.nodes) + `</div>`;
    }

    // The caption cascade: one row per named cell, stacked under the rail in
    // segment order — block flow, so two rows can never overlap, and each spans
    // the full remaining width. Row i indents to its cell's dot (geometry in
    // .be-caption, graph.html); a node's caption renders exactly once, under
    // its own dot, in whichever segment owns it. Unnamed cells (or a fully
    // unnamed chain) render nothing.
    function captionsHtml(cells) {
        const rows = cells.map(beCaptionHtml).join('');
        return rows ? `<div class="be-captions">${rows}</div>` : '';
    }

    function beCaptionHtml(n, i) {
        if (!n.name) return '';
        const cls = `be-caption clamp-10 ${esc(n.status)}${n.active === false ? ' inactive' : ''}`;
        return `<button class="${cls}" data-id="${esc(n.id)}" style="--i:${i}"` +
            ` title="${esc(n.name)}">${esc(n.name)}</button>`;
    }

    function slotHtml(n, next, last) {
        const cls = 'be-slot' +
            (last ? ' last' : '') +
            (next && next.status === 'progress' ? ' to-progress' : '') +
            (n.active === false ? ' inactive' : '');
        return `<span class="${cls}">${dotHtml(n)}${last ? '' : miniPersonas(n)}</span>`;
    }

    // A named cell leads its dot tooltip — names are per-cell now, so the
    // chain-head-only gate is gone (head == i === 0 died with it).
    function dotLabel(n) {
        const k = (n.personas || []).length;
        const took = n.took != null ? ` · ${OpenLoopPanel.fmtDur(n.took)}` : '';
        const name = n.name ? `${n.name} · ` : '';
        return `${name}${n.agent} · ${n.status}${took}${k ? ` · ${k} persona${k > 1 ? 's' : ''}` : ''}`;
    }

    function dotHtml(n) {
        const label = dotLabel(n);
        const cls = `node-status-dot be-dot ${esc(n.status)}${mcpAuthMissing(n) ? ' mcp-missing' : ''}`;
        return `<button class="${cls}" data-id="${esc(n.id)}"` +
            ` title="${esc(label)}" aria-label="${esc(label)}"></button>`;
    }

    function miniPersonas(n) {
        const list = (n.personas || []).map(id => personaIndex.get(id)).filter(Boolean);
        if (!list.length) return '';
        return `<span class="be-mini">` +
            list.map(p => avatarHtml(p, 'pp-avatar be-mi-avatar', p.name)).join('') + `</span>`;
    }

    function personaTrail(n) {
        const list = (n.personas || []).map(id => personaIndex.get(id)).filter(Boolean);
        if (!list.length) return '';
        return `<span class="be-trail">` +
            list.slice(0, 5).map(trailDotHtml).join('') + moreTrailHtml(n, list) + `</span>`;
    }

    function trailDotHtml(p) {
        return `<span class="be-persona">${avatarHtml(p, 'pp-avatar be-p-avatar', p.name)}` +
            `<span class="be-persona-name">${esc(p.name)}</span></span>`;
    }

    function moreTrailHtml(n, list) {
        const k = list.length - 5;
        if (k <= 0) return '';
        return `<button class="be-more" data-id="${esc(n.id)}"` +
            ` title="${k} more persona${k > 1 ? 's' : ''}">+${k}</button>`;
    }

    function setMode(mode) {
        viewMode = mode;
        const birds = mode === 'birds';
        document.body.classList.toggle('birds-eye', birds);
        syncToggles(birds);
        localStorage.setItem('openloop-birds-eye', mode);
        if (birds) { closeComposer(); closePanel(); showWhisper(); }
        render();
    }

    function syncToggles(birds) {
        document.querySelectorAll('.be-toggle').forEach(btn => {
            btn.classList.toggle('active', birds);
            btn.setAttribute('aria-pressed', String(birds));
        });
    }

    function syncBirdsToggle() {
        document.querySelectorAll('.be-toggle')
            .forEach(btn => { btn.disabled = !nodes.length; });
    }

    function bindBirdsEye(host) {
        host.querySelectorAll('.be-dot, .be-more, .be-caption').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                focusFromBirds(el.dataset.id);
            });
        });
        bindAvatarFallbacks(host);
    }

    function focusFromBirds(id) {
        fadeWhisper();
        setMode('normal');
        selectNode(id);
        const card = document.querySelector(`.node-card[data-id="${CSS.escape(id)}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        card.setAttribute('tabindex', '-1');
        card.focus({ preventScroll: true });
        card.classList.add('beacon');
        setTimeout(() => card.classList.remove('beacon'), 900);
    }

    function showWhisper() {
        if (sessionStorage.getItem('openloop-be-hint')) return;
        const w = document.createElement('span');
        w.className = 'be-whisper';
        w.textContent = 'tap a dot to open its card';
        document.body.appendChild(w);
        setTimeout(fadeWhisper, 8000);
    }

    function fadeWhisper() {
        const w = document.querySelector('.be-whisper');
        if (!w) return;
        sessionStorage.setItem('openloop-be-hint', '1');
        w.style.opacity = '0';
        setTimeout(() => w.remove(), 300);
    }

    function nodeCell(n) {
        const inactive = n.active ? '' : ' inactive';
        return `<div class="node-cell${inactive}">` +
            nodeNameHtml(n) + // before .node-slot: inside it, a title would shift the top:50% insert +
            `<div class="node-slot">${nodeCard(n)}` +
            `<button class="node-insert-btn" data-id="${esc(n.id)}" title="Insert before">+</button></div>` +
            personaStrip(n) +
            runButton(n) +
            `</div>`;
    }

    // Cell title: ink above the card, never inside it — the card header is
    // machine facts (dur · mcp · dot); a name is a human word that wraps.
    // Card-bounded and left-aligned (see .node-title in graph.html), so
    // neighbouring titles can never collide. Unnamed cells render nothing.
    function nodeNameHtml(n) {
        if (!n.name) return '';
        return `<div class="node-title clamp-10" title="${esc(n.name)}">${esc(n.name)}</div>`;
    }

    function personaStrip(n) {
        const list = (n.personas || []).map(id => personaIndex.get(id)).filter(Boolean);
        if (!list.length) return '';
        return `<div class="node-personas">` +
            list.map(p => avatarHtml(p, 'np-avatar pp-avatar', p.name)).join('') +
            `</div>`;
    }

    function avatarHtml(p, cls, title) {
        if (!p.avatar) return `<span class="${cls} pp-fallback" title="${esc(title)}">${esc(initialOf(p.name))}</span>`;
        return `<img class="${cls}" src="${esc(p.avatar)}" alt="${esc(p.name)}" title="${esc(title)}">`;
    }

    function initialOf(name) {
        return (name || '?').trim().charAt(0).toUpperCase() || '?';
    }

    function bindAvatarFallbacks(container) {
        container.querySelectorAll('img.pp-avatar').forEach(img => {
            img.addEventListener('error', () => swapFallback(img), { once: true });
        });
    }

    function swapFallback(img) {
        const span = document.createElement('span');
        span.className = img.className + ' pp-fallback';
        span.title = img.title;
        span.textContent = initialOf(img.alt);
        img.replaceWith(span);
    }

    // Word-form, never a 4th pipe: "5 | 2 | 1 · Running: 2". Pipes are ledger
    // columns (history); the middle dot separates tenses (present). A bare
    // fourth digit would force arithmetic on every glance. Never renders at 0.
    function runningTag(n) {
        const a = n.runs && n.runs.active > 0 ? n.runs.active : 0;
        return a ? ` <span class="live">· Running: <b>${a}</b></span>` : '';
    }

    // The chain gate, shared verbatim by every Run affordance — the cell's
    // Run button and the panel's New run buttons. Never re-derived client
    // -side: the server owns readiness (isChainReady, GraphHandler.swift).
    // One string = a disabled Run says the same thing everywhere.
    function runDisabledAttr(n) {
        return n.runnable ? '' : ' disabled title="chain not ready — parents need summaries"';
    }

    function runButton(n) {
        const counts = n.runs && n.runs.total > 0
            ? `<span class="run-counts">${n.runs.total} | <b class="ok">${n.runs.success}</b> | <b class="bad">${n.runs.failed}</b>${runningTag(n)}</span>`
            : '';
        return `<button class="node-run-btn" data-id="${esc(n.id)}"${runDisabledAttr(n)}>` +
            `<span class="run-label">Run</span>${counts}</button>`;
    }

    function nodeCard(n) {
        const missingAuth = mcpAuthMissing(n) ? ' data-mcp-auth="missing"' : '';
        return `<div class="node-card" data-id="${esc(n.id)}" data-status="${esc(n.status)}"${missingAuth}>` +
            `<div class="node-main">` +
            cardHeader(n) + cardBody(n) +
            `</div>` +
            addChildButton(n) +
            `</div>`;
    }

    // The right-side + is a ready cell's privilege: children fork off a node's
    // settled run, so loading (progress/summarizing) and errored (failed) cells
    // render no + — no more children can be created off them until they land.
    // answered keeps its + (run done, summary pending): the fork is allowed,
    // while its own Run stays gated by the chain rule ("parents need summaries").
    function addChildButton(n) {
        return isChildReady(n) ? `<button class="node-add-child" title="Add child">+</button>` : '';
    }

    function isChildReady(n) {
        return n.status === 'success' || n.status === 'answered';
    }

    function cardHeader(n) {
        const badge = n.mcp ? mcpBadge(n) : '';
        return `<div class="node-card-header">` +
            `<span class="node-dur">${esc(headerDur(n))}</span>` +
            badge +
            `<span class="node-status-dot ${esc(n.status)}"></span>` +
            `</div>`;
    }

    // The fresh-clone state, defined once: the repo says this endpoint
    // requires a key (mcp_requires_auth travels with the node file) and
    // this computer's secrets store doesn't hold it (mcp_auth_local). Every
    // surface that announces it — the badge, the card header tint, the
    // bird's-eye halo, the header warning count — reads this one predicate.
    function mcpAuthMissing(n) {
        return !!n.mcp_requires_auth && !n.mcp_auth_local;
    }

    // The header is machine facts — the badge itself reports whether this
    // machine can actually authenticate: hollow dashed = the repo says the
    // endpoint needs a key this computer doesn't hold yet (fresh clone).
    function mcpBadge(n) {
        const missing = mcpAuthMissing(n);
        const cls = missing ? 'mcp-badge missing' : 'mcp-badge';
        const title = missing ? 'MCP authorization key not set on this computer' : 'Remote MCP configured';
        return `<span class="${cls}" title="${esc(title)}">mcp</span>`;
    }

    function headerDur(n) {
        if (n.took != null) return OpenLoopPanel.fmtDur(n.took);
        if (n.status === 'progress') {
            return OpenLoopPanel.fmtDur(Math.max(0, Math.round((Date.now() - n.created_at) / 1000)));
        }
        return '–';
    }

    // Cells speak the shared bubble grammar (bubble.js): free to 10 painted
    // lines, folded to 3 + an in-place door beyond — gated + snapshotted in
    // renderGrid like every other bubble surface. The old always-clamped,
    // door-less markup is gone.
    function cardBody(n) {
        if (n.summary) return `<div class="node-card-body">${summaryCard(n)}</div>`;
        const prompt = OpenLoopBubble.bubbleHtml('input', n.prompt);
        return `<div class="node-card-body">${prompt}${snippetBubble(n)}</div>`;
    }

    function summaryCard(n) {
        return OpenLoopBubble.bubbleHtml('summary', n.summary, 'summary-text');
    }

    function snippetBubble(n) {
        if (n.status === 'progress' || !n.output) return '';
        const cls = n.status === 'failed' ? 'output error' : 'output';
        return OpenLoopBubble.bubbleHtml(cls, n.output, 'result-snippet');
    }

    function bindGraph(grid) {
        bindCards(grid);
        bindRunButtons(grid);
        bindInsertButtons(grid);
        bindAvatarFallbacks(grid);
        markSelectedCard(grid);
    }

    function bindCards(grid) {
        grid.querySelectorAll('.node-card').forEach(card => {
            card.addEventListener('click', () => selectNode(card.dataset.id));
            // the + is absent on non-ready cells (addChildButton) — bind only if rendered
            card.querySelector('.node-add-child')?.addEventListener('click', e => {
                e.stopPropagation();
                openComposer(card.dataset.id);
            });
        });
    }

    function bindInsertButtons(grid) {
        grid.querySelectorAll('.node-insert-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                openInsert(btn.dataset.id);
            });
        });
    }

    function bindRunButtons(grid) {
        grid.querySelectorAll('.node-run-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                openRunComposer(btn.dataset.id);
            });
        });
    }

    function markSelectedCard(grid) {
        if (!selectedId) return;
        const card = grid.querySelector(`.node-card[data-id="${CSS.escape(selectedId)}"]`);
        if (card) card.classList.add('selected');
    }

    function bindCanvasDismiss() {
        $('graph-canvas').addEventListener('click', e => {
            if (!e.target.closest('.node-card')) closePanel();
        });
    }

    function selectNode(id) {
        selectedId = id;
        document.querySelectorAll('.node-card.selected')
            .forEach(c => c.classList.remove('selected'));
        const card = document.querySelector(`.node-card[data-id="${CSS.escape(id)}"]`);
        if (card) card.classList.add('selected');
        openPanel(nodes.find(n => n.id === id));
    }

    function relToGrid(el) {
        const g = $('graph-grid').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { left: r.left - g.left, top: r.top - g.top, right: r.right - g.left, height: r.height };
    }

    function edgePath(fromEl, toEl) {
        const f = relToGrid(fromEl);
        const t = relToGrid(toEl);
        const x1 = f.right, y1 = f.top + f.height / 2;
        const x2 = t.left, y2 = t.top + t.height / 2;
        const dx = Math.max(40, (x2 - x1) / 2);
        return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    }

    function drawEdges() {
        const svg = $('edge-layer');
        const grid = $('graph-grid');
        if (!svg || !grid) return;
        svg.setAttribute('width', Math.max(grid.scrollWidth, 1));
        svg.setAttribute('height', Math.max(grid.scrollHeight, 1));
        svg.innerHTML = nodes.map(n => edgeFor(n)).join('');
    }

    function edgeFor(n) {
        if (!n.parent_id) return '';
        const from = document.querySelector(`.node-card[data-id="${CSS.escape(n.parent_id)}"]`);
        const to = document.querySelector(`.node-card[data-id="${CSS.escape(n.id)}"]`);
        if (!from || !to) return '';
        const cls = n.status === 'progress' ? 'edge to-progress' : 'edge';
        return `<path class="${cls}" d="${edgePath(from, to)}"/>`;
    }

    function openComposer(parentId) {
        composerMode = 'child';
        composerRefId = parentId;
        showComposer();
    }

    function openInsert(nodeId) {
        composerMode = 'insert';
        composerRefId = nodeId;
        showComposer();
    }

    function openRunComposer(nodeId) {
        composerMode = 'run';
        composerRefId = nodeId;
        showComposer();
    }

    function showComposer() {
        $('composer-agents').innerHTML = composerAgents();
        $('composer-agents').querySelectorAll('.agent-btn').forEach(btn => {
            btn.addEventListener('click', () => submit(btn.dataset.agent));
        });
        $('composer-hint').textContent = composerHint();
        resetComposerMcp();
        $('composer').classList.add('open');
        $('composer-text').value = '';
        $('composer-text').focus();
    }

    function resetComposerMcp() {
        $('composer-mcp').classList.remove('open');
        $('composer-mcp-toggle').style.display = composerMode === 'run' ? 'none' : '';
        $('composer-mcp-url').value = '';
        $('composer-mcp-auth').value = '';
    }

    function composerAgents() {
        if (composerMode !== 'run') {
            return agents
                .map(a => `<button class="agent-btn" data-agent="${esc(a)}" disabled>${esc(a)}</button>`)
                .join('');
        }
        const agent = runTargetAgent();
        // run mode owns exactly one action — the button says ⌘↵ is its twin
        return `<button class="agent-btn" data-agent="${esc(agent)}" aria-label="Run · ${esc(agent)} (⌘↵)" title="Run · ${esc(agent)} (⌘↵)" aria-keyshortcuts="Meta+Enter Control+Enter" disabled>Run · ${esc(agent)}</button>`;
    }

    function runTargetAgent() {
        const n = nodes.find(x => x.id === composerRefId);
        return n ? n.agent : '';
    }

    function composerHint() {
        if (composerMode === 'insert') return 'New run will be inserted between this node and its parent.';
        if (composerMode === 'run') return 'Reuses this node’s runner — the log is saved to the node.';
        return 'Pick an agent to run. Runs with the _bottom_ persona.';
    }

    function closeComposer() {
        $('composer').classList.remove('open');
        composerMode = null;
        composerRefId = null;
    }

    async function submit(agent) {
        const prompt = $('composer-text').value.trim();
        if (!prompt) return;
        const nodeId = composerRefId; // closeComposer nulls it — capture first
        try { await submitPrompt(prompt, agent, nodeId); }
        catch (e) { showError(`Failed to start run: ${e.message}`); }
    }

    // The modal's keyboard door: run mode owns exactly one action, so ⌘↵
    // submits it — the Run button's twin. Choice modes need a runner
    // picked first; ⌘↵ stays a no-op there rather than firing some
    // default agent the UI never showed (the hint copy teaches the pick).
    // composerMode is null while the modal is closed — the same guard
    // covers a stray keydown from a closed #composer.
    function composerCmdEnter() {
        if (composerMode !== 'run') return;
        submit(runTargetAgent()); // submit captures composerRefId before closeComposer nulls it
    }

    // A run you start is a place you go: capture the response id (node modes
    // return undefined — the natural guard), then hand the arrival to
    // scheduleRunFocus once the reload has settled. Composer stays open
    // through the POST — failure keeps the user's words.
    async function submitPrompt(prompt, agent, nodeId) {
        const res = await (composerMode === 'run' ? postRun(prompt) : postNode(prompt, agent));
        closeComposer();
        await load();
        if (res?.id) scheduleRunFocus(nodeId, res.id);
    }

    async function postRun(prompt, parentId) {
        const nodeId = parentId ? selectedId : composerRefId;
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(nodeId)}/run`;
        const body = parentId ? { prompt, parent_run_id: parentId } : { prompt };
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
        return fetchJson(url, opts);
    }

    async function postNode(prompt, agent) {
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph`;
        const body = {
            prompt, agent,
            mcp: $('composer-mcp-url').value.trim(),
            mcp_auth: $('composer-mcp-auth').value.trim()
        };
        body[composerMode === 'insert' ? 'insert_before' : 'parent_id'] = composerRefId;
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
        await fetchJson(url, opts);
    }

    function openPanel(n) {
        if (!n) return;
        disarmDelete(); // a re-render silently disarms a pending confirm — always the safe direction
        focusedRunId = null;
        logsJson = ''; // innerHTML rebuild wipes #runs-list — the cache guard in loadLogs must not skip the re-render
        runSummaryEditing = false;
        promptEditing = false;
        summaryEditing = false;
        panelStatus = n.status;
        panelJson = JSON.stringify(n);
        const inner = $('detail-panel-inner');
        const snap = OpenLoopBubble.snapshotExpansion(inner);
        inner.innerHTML = panelHtml(n);
        OpenLoopBubble.restoreExpansion(inner, snap);
        OpenLoopBubble.gateBubbles(inner);
        $('detail-panel').classList.add('open');
        $('graph-canvas').classList.add('panel-open');
        bindPanelControls(n);
    }

    function bindPanelControls(n) {
        $('detail-panel-inner').querySelector('.detail-panel-close').addEventListener('click', closePanel);
        bindNameField(n.id);
        bindActiveToggle(n);
        bindMcpField(n.id);
        bindPersonaPicks(n);
        bindAgentPicks(n);
        bindSummaryButton(n);
        bindRetryButton(n);
        bindNewRunButtons(n);
        bindDeleteButtons();
        bindAvatarFallbacks($('detail-panel-inner'));
        loadLogs(n.id);
    }

    function bindActiveToggle(n) {
        $('active-toggle').addEventListener('change', async e => {
            try {
                await putNode(n.id, { active: e.target.checked });
                await load();
                const fresh = nodes.find(x => x.id === n.id);
                if (fresh) openPanel(fresh);
            } catch (err) {
                showError(`Failed to save active state: ${err.message}`);
            }
        });
    }

    function bindPersonaPicks(n) {
        $('detail-panel-inner').querySelectorAll('.persona-pick').forEach(el => {
            el.addEventListener('click', () => togglePersona(n.id, el.dataset.personaId));
        });
    }

    function bindAgentPicks(n) {
        $('detail-panel-inner').querySelectorAll('.agent-btn[data-agent]').forEach(btn => {
            btn.addEventListener('click', () => changeAgent(n.id, btn.dataset.agent));
        });
    }

    async function changeAgent(nodeId, agent) {
        const n = nodes.find(x => x.id === nodeId);
        if (!n || n.agent === agent) return;
        try {
            await putNode(nodeId, { agent });
            await load();
            const fresh = nodes.find(x => x.id === selectedId);
            if (fresh) openPanel(fresh); // re-render so the title meta + pills swap too
        } catch (e) {
            showError(`Failed to save agent: ${e.message}`);
        }
    }

    async function togglePersona(nodeId, personaId) {
        const n = nodes.find(x => x.id === nodeId);
        if (!n) return;
        const next = new Set(n.personas || []);
        next.has(personaId) ? next.delete(personaId) : next.add(personaId);
        n.personas = [...next];
        panelJson = JSON.stringify(n);
        syncPersonaUI(n);
        await savePersonas(nodeId, n.personas);
    }

    function syncPersonaUI(n) {
        const assigned = new Set(n.personas || []);
        $('detail-panel-inner').querySelectorAll('.persona-pick').forEach(el => {
            el.classList.toggle('selected', assigned.has(el.dataset.personaId));
        });
        render();
    }

    function bindMcpField(nodeId) {
        mcpOriginal = $('mcp-input').value.trim();
        const authInput = $('mcp-auth-input');
        mcpAuthOriginal = authInput ? authInput.value.trim() : ''; // always '' — write-only field, never echoes
        bindFieldPair('mcp', () => saveMcp(nodeId), syncMcpButton);
        if (authInput) bindFieldPair('mcp-auth', () => saveMcpAuth(nodeId), syncMcpAuthButton);
        const clear = $('mcp-auth-clear');
        if (clear) clear.addEventListener('click', () => clearMcpAuth(nodeId));
    }

    // The NAME section renders on every node; autosize keeps a long
    // description visible as it is written, and survives re-opens.
    function bindNameField(nodeId) {
        nameOriginal = $('name-input').value.trim();
        autosizeName();
        $('name-input').addEventListener('input', autosizeName);
        bindFieldPair('name', () => saveName(nodeId), syncNameButton);
    }

    function autosizeName() {
        const ta = $('name-input');
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
    }

    function bindFieldPair(id, save, sync) {
        $(id + '-input').addEventListener('input', sync);
        $(id + '-input').addEventListener('keydown', e => {
            // Enter always saves; in the name textarea it must not also
            // insert a newline (no rendering surface keeps newlines)
            if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
        $(id + '-save').addEventListener('click', save);
        sync();
    }

    function syncMcpButton() {
        const dirty = $('mcp-input').value.trim() !== mcpOriginal;
        $('mcp-save').textContent = dirty ? 'Save' : '✓';
        $('mcp-save').classList.toggle('saved', !dirty);
    }

    function syncMcpAuthButton() {
        const dirty = $('mcp-auth-input').value.trim() !== mcpAuthOriginal;
        $('mcp-auth-save').textContent = dirty ? 'Save' : '✓';
        $('mcp-auth-save').classList.toggle('saved', !dirty);
    }

    function syncNameButton() {
        const dirty = $('name-input').value.trim() !== nameOriginal;
        $('name-save').textContent = dirty ? 'Save' : '✓';
        $('name-save').classList.toggle('saved', !dirty);
    }

    async function putNode(nodeId, body) {
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(nodeId)}`;
        await fetchJson(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    async function saveMcp(nodeId) {
        const mcp = $('mcp-input').value.trim();
        try {
            await putNode(nodeId, { mcp });
            mcpOriginal = mcp;
            syncMcpButton();
            await load();
            const fresh = nodes.find(x => x.id === selectedId);
            if (fresh) openPanel(fresh); // re-render: the auth row follows the URL (state line, placeholder, Clear)
        } catch (e) {
            showError(`Failed to save mcp: ${e.message}`);
        }
    }

    async function saveMcpAuth(nodeId) {
        const auth = $('mcp-auth-input').value.trim();
        const n = nodes.find(x => x.id === nodeId);
        if (!auth && n && n.mcp_auth_local) return; // clearing has its own button — an empty Save never wipes a stored key
        try {
            await putNode(nodeId, { mcp_auth: auth });
            await load();
            const fresh = nodes.find(x => x.id === selectedId);
            if (fresh) openPanel(fresh); // re-render: the state line + Clear button changed; the field itself stays empty
        } catch (e) {
            showError(`Failed to save authorization: ${e.message}`);
        }
    }

    async function clearMcpAuth(nodeId) {
        try {
            await putNode(nodeId, { mcp_auth: '' }); // empty string clears — server normalizes to nil
            await load();
            const fresh = nodes.find(x => x.id === selectedId);
            if (fresh) openPanel(fresh);
        } catch (e) {
            showError(`Failed to clear authorization: ${e.message}`);
        }
    }

    async function saveName(nodeId) {
        const name = $('name-input').value.trim();
        try {
            await putNode(nodeId, { name }); // "" clears — server normalizes to null
            nameOriginal = name;
            await load();
            const fresh = nodes.find(x => x.id === selectedId);
            if (fresh) openPanel(fresh); // re-render so the panel title swaps too
        } catch (e) {
            showError(`Failed to save name: ${e.message}`);
        }
    }

    async function savePersonas(nodeId, personas) {
        try {
            await putNode(nodeId, { personas });
        } catch (e) {
            showError(`Failed to save personas: ${e.message}`);
            await load();
        }
    }

    function closePanel() {
        $('detail-panel').classList.remove('open');
        $('graph-canvas').classList.remove('panel-open');
        document.querySelectorAll('.node-card.selected')
            .forEach(c => c.classList.remove('selected'));
        selectedId = null;
        panelJson = '';
        logsJson = '';
        runsCache = [];
        pendingRowFocus = null;
        pendingRunFocus = null;
        staleDeepRun = false;
        focusedRunId = null;
        runSummaryEditing = false;
        promptEditing = false;
        summaryEditing = false;
        panelStatus = '';
    }

    function panelHtml(n) {
        return panelHeader(n) + `<div class="detail-panel-body">${panelBody(n)}</div>`;
    }

    function panelHeader(n) {
        const took = n.took != null ? ` · took ${OpenLoopPanel.fmtDur(n.took)}` : '';
        return `<div class="detail-panel-header">` +
            `<div class="detail-panel-accent"></div>` +
            panelTitleHtml(n, took) +
            `<button class="detail-panel-close" title="Close panel" aria-label="Close panel">✕</button>` +
            `</div>`;
    }

    function panelTitleHtml(n, took) {
        return `<div class="detail-panel-title">` + panelTitleLines(n, took) + `</div>`;
    }

    // Named node: the name is the title (Inter, via its own class — the page's
    // .detail-panel-name mono override must not touch it), agent demotes into
    // the meta line. True for any named cell, root or not.
    function panelTitleLines(n, took) {
        const time = ` · ${fmtTime(n.created_at)}`;
        if (!n.name) {
            return `<div class="detail-panel-name">${esc(n.agent)}</div>` +
                `<div class="detail-panel-meta">${esc(n.status)}${took}${time}</div>`;
        }
        return `<div class="detail-panel-title-name clamp-10" title="${esc(n.name)}">${esc(n.name)}</div>` +
            `<div class="detail-panel-meta">${esc(n.agent)} · ${esc(n.status)}${took}${time}</div>`;
    }

    function activeToggleHtml(active) {
        const checked = active === false ? '' : ' checked';
        return `<label class="active-toggle"><input type="checkbox" id="active-toggle"${checked}>Active</label>`;
    }

    function panelBody(n) {
        return nameSection(n) + activeSection(n) + summarySection(n) + promptSection(n) + resultSection(n) +
            personasSection(n) + mcpSection(n) + runsSection(n) + agentSection(n) + deleteSection(n);
    }

    // NAME on every node: names are usually descriptions, so the field is a
    // one-row textarea that grows (autosizeName) — a single-line input cannot
    // show a description while it is being written. No maxlength: the backend
    // has no cap (GraphStore.updateName stores TEXT) and every surface that
    // renders the name wraps it. "" clears — server normalizes to null.
    function nameSection(n) {
        return `<div><div class="detail-section-label">NAME</div>` +
            `<div class="name-row">` +
            `<textarea id="name-input" rows="1" spellcheck="false" autocomplete="off" aria-label="Node name" placeholder="Name or describe this node…">${esc(n.name || '')}</textarea>` +
            `<button id="name-save">Save</button>` +
            `</div>` +
            `<div class="mcp-hint">Shows above this card and beneath its dot in bird's-eye view.</div>` +
            `</div>`;
    }

    function activeSection(n) {
        return `<div class="active-section">` +
            activeToggleHtml(n.active) +
            `<div class="active-note">${esc(activeNoteText(n.active))}</div>` +
            `</div>`;
    }

    function activeNoteText(active) {
        if (active === false) {
            return 'Skipped in all chain building — its MCPs, personas & summary are not included in any context. ' +
                'A run can still be started directly from this node.';
        }
        return 'Deactivate to skip this node in all chains — its MCPs, personas & summary won\'t be included in any context.';
    }

    function promptSection(n) {
        return `<div id="prompt-section"><div class="detail-section-label prompt">PROMPT</div>` +
            OpenLoopBubble.bubbleHtml('input', n.prompt) + `</div>`;
    }

    function editPromptHtml(n) {
        return `<div class="detail-section-label prompt">PROMPT</div>` +
            `<textarea id="regen-prompt" rows="7" aria-label="Edit prompt" spellcheck="false">${esc(n.prompt)}</textarea>` +
            `<button class="regen-submit" id="regen-submit">Regenerate</button>`;
    }

    function personasSection(n) {
        if (!personaGroups.length) return '';
        if (!n.summary) return personasLockedSection();
        const assigned = new Set(n.personas || []);
        return `<div><div class="detail-section-label">PERSONAS</div>` +
            personaGroups.map(g => personaGroupHtml(g, assigned)).join('') +
            `</div>`;
    }

    function personasLockedSection() {
        return `<div><div class="detail-section-label">PERSONAS</div>` +
            `<div class="summary-missing">Node needs a summary before personas can be assigned.</div></div>`;
    }

    function personaGroupHtml(g, assigned) {
        return `<div class="persona-group">` +
            `<div class="persona-group-label">${esc(g.label)}</div>` +
            `<div class="persona-grid">` +
            g.personas.map(p => personaPickHtml(p, assigned)).join('') +
            `</div></div>`;
    }

    function personaPickHtml(p, assigned) {
        const sel = assigned.has(p.id) ? ' selected' : '';
        return `<div class="persona-pick${sel}" data-persona-id="${esc(p.id)}" title="${esc(p.role || p.name)}">` +
            avatarHtml(p, 'pp-avatar', p.role || p.name) +
            `<span class="persona-pick-name">${esc(p.name)}</span></div>`;
    }

    // The Runs section is self-sufficient — it can start a run, not just
    // list them: bookended by New run buttons, a compact pill in the label
    // row (the scanner's door) and a full-width one after the list (the
    // finisher's door — and the empty state's call to action). Both live in
    // the section wrapper, OUTSIDE #runs-list: the list is rewritten by
    // renderLogs every 5s, and the buttons must not flicker or lose hover.
    function runsSection(n) {
        return `<div>` +
            `<div class="summary-head">` +
            `<div class="detail-section-label runs">Runs</div>` +
            newRunBtnHtml(n, false) + `</div>` +
            `<div id="runs-list"><div class="summary-missing">loading…</div></div>` +
            newRunBtnHtml(n, true) + `</div>`;
    }

    // One generator, two sizes — same words, same icon, same gate: the pill
    // is a shortcut, the wide one a destination; nobody learns two controls.
    function newRunBtnHtml(n, wide) {
        const cls = wide ? 'new-run-btn wide' : 'new-run-btn';
        const title = n.runnable ? ' title="Schedule a new run on this node"' : '';
        return `<button class="${cls}" data-id="${esc(n.id)}"${runDisabledAttr(n)}${title}>` +
            `${plusIcon(wide ? 14 : 12)}New run</button>`;
    }

    function plusIcon(size) {
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
    }

    // Bound once per openPanel — the section wrapper is rebuilt only then.
    // Deliberately NOT inside #runs-list: renderLogs rewrites it every cycle,
    // and a per-render binding there would stack one listener per 5s tick.
    function bindNewRunButtons(n) {
        $('detail-panel-inner').querySelectorAll('.new-run-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                openRunComposer(n.id);
            });
        });
    }

    // — agent picker —
    // The composer's pills, reprised at the panel bottom (just above the
    // danger zone): one per known agent, the node's current one selected and
    // inert, a click on any other PUTs the switch. Locked while the node runs
    // (the delete grammar): the in-flight run already holds its script, and a
    // mid-run switch would read as a no-op. An agent gone from the server
    // still renders — the current fact stays visible and switchable-away-from.
    function agentSection(n) {
        return `<div><div class="detail-section-label">AGENT</div>${agentPills(n)}</div>`;
    }

    function agentPills(n) {
        if (!agents.length) return '<div class="summary-missing">No agents available on this server.</div>';
        const running = RUNNING_STATUSES.includes(n.status);
        const list = agents.includes(n.agent) ? agents : [n.agent, ...agents];
        return `<div class="agent-row">` +
            list.map(a => agentPillHtml(a, a === n.agent, running)).join('') +
            `</div>` +
            `<div class="mcp-hint">${esc(agentHint(running))}</div>`;
    }

    function agentPillHtml(agent, current, running) {
        const cls = 'agent-btn' + (current ? ' selected' : '');
        const dis = current || running ? ' disabled' : '';
        return `<button class="${cls}" data-agent="${esc(agent)}" aria-pressed="${current}"${dis}>${esc(agent)}</button>`;
    }

    function agentHint(running) {
        if (running) return 'This node is running — the agent unlocks when the run finishes.';
        return 'Used by this node’s next run — re-runs, retries, follow-ups & summary regeneration.';
    }

    async function loadLogs(nodeId) {
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(nodeId)}/logs`;
        try {
            const data = await fetchJson(url);
            if (selectedId !== nodeId) return;
            runsCache = data.logs;
            // runsCache has exactly one producer (here) — consume pendingRunFocus
            // only at this point; openPanel nulls focusedRunId, so consuming
            // earlier would be wiped. A failed fetch keeps the flag: the 5s
            // refreshPanel retry re-enters here and opens the run then.
            if (consumePendingRunFocus()) return;
            if (blockedByTyping()) return;
            const json = JSON.stringify(data.logs);
            if (json === logsJson) return;
            logsJson = json;
            if (focusedRunId) refreshRunView(data.logs);
            else renderLogs(data.logs);
        } catch (e) {
            showError(`Failed to load runs: ${e.message}`);
        }
    }

    function blockedByTyping() {
        return runSummaryEditing || panelHasTyping();
    }

    function panelHasTyping() {
        const inner = $('detail-panel-inner');
        if (!inner) return false;
        // #name-input is excluded: it holds a durable saved value (not a
        // draft), and refreshPanel already guards it against nameOriginal —
        // a saved non-empty name must not freeze the runs list forever.
        return [...inner.querySelectorAll('input, textarea')]
            .filter(el => el.id !== 'name-input')
            .some(fieldHasTyping);
    }

    function fieldHasTyping(el) {
        return el === document.activeElement || (el.tagName === 'TEXTAREA' && el.value.trim() !== '');
    }

    function rootRuns(logs) {
        return logs.filter(l => !l.parent_run_id).sort((a, b) => b.created_at - a.created_at);
    }

    function threadOf(rootId, logs) {
        return logs.filter(l => l.root_run_id === rootId).sort((a, b) => a.created_at - b.created_at);
    }

    // A notification's run may be a follow-up: its thread opens at the root
    // (focusRun is root-only). Unknown id → null → silent node view.
    function rootRunOf(runId, logs) {
        const run = logs.find(l => l.id === runId);
        if (!run) return null;
        if (!run.parent_run_id) return run.id;
        return logs.some(l => l.id === run.root_run_id && !l.parent_run_id) ? run.root_run_id : null;
    }

    function renderLogs(logs) {
        const el = $('runs-list');
        if (!el) return;
        const snap = OpenLoopBubble.snapshotExpansion(el);
        const roots = rootRuns(logs);
        // stale deep-link run: drift, not error — one muted line above the list
        const notice = staleDeepRun
            ? '<div class="summary-missing">That run isn\'t on this node anymore — showing the node instead.</div>'
            : '';
        el.innerHTML = notice + (roots.length
            ? roots.map(l => runLogHtml(l, logs)).join('')
            : '<div class="summary-missing">no runs yet</div>');
        bindRunFocusButtons(el);
        bindRunThreadDelete(el);
        OpenLoopBubble.restoreExpansion(el, snap);
        OpenLoopBubble.gateBubbles(el);
        focusPendingRow();
    }

    // The list row's chrome: the header's caption, bin, arrow ride INLINE —
    // right after the text, never pinned to the row's right edge. Only the
    // post-item focus row owns that edge (its own flex-end); bin before
    // arrow in both places (the arrow stays the right-most control: it
    // opens, everything left of it removes).
    function runLogHtml(l, logs) {
        const cls = l.status === 'failed' ? 'output error' : 'output';
        const del = runThreadDelBtn(l, logs);
        return `<div class="run-log" data-run-id="${esc(l.id)}">` +
            `<div class="run-log-meta"><span>${rootMeta(l, logs)}</span>${del}${runFocusBtn()}</div>` +
            OpenLoopBubble.bubbleHtml('input', l.prompt) +
            OpenLoopBubble.bubbleHtml(cls, l.output || (l.status === 'progress' ? 'in progress…' : '(empty)')) +
            `<div class="run-log-focus-row">${del}${runFocusBtn()}</div>` +
            `</div>`;
    }

    function rootMeta(l, logs) {
        const n = threadOf(l.id, logs).length - 1;
        return `${runMeta(l)}${n ? ` · <span class="convo-count">+${n}</span>` : ''}`;
    }

    function runMeta(l) {
        const took = l.took != null ? ` · took ${OpenLoopPanel.fmtDur(l.took)}` : '';
        return `${esc(l.status)}${took} · ${ago(l.created_at)}`;
    }

    function runFocusBtn() {
        return `<button class="run-focus-btn" title="Open run" aria-label="Open run details">` +
            `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>`;
    }

    function bindRunFocusButtons(el) {
        el.querySelectorAll('.run-focus-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                focusRun(btn.closest('.run-log').dataset.runId);
            });
        });
    }

    // — full-RUN delete (runs list) —
    // A list item IS the whole conversation, so its bin cascades: root +
    // every follow-up, server-side (?thread=true — the twin of the node
    // delete's ?chain=true). Skin and armed-confirm machine are the
    // thread rows' (.run-del-btn + panel.js armedButton); the copy is the
    // list's own — "run", not "turn" (one word per concept, per surface).
    // Any in-flight turn in the thread holds the delete: disabled + the
    // unlock sentence, the meta-row grammar.

    const RUN_DEL_COPY = {
        armed: 'Confirm — delete this run',
        busy: 'A run in this conversation is in progress — deletion unlocks when it finishes.',
    };

    function runThreadDelTitle(l, logs) {
        const n = threadOf(l.id, logs).length - 1;
        return n
            ? `Delete this run and its ${n} follow-up${n > 1 ? 's' : ''} — the whole conversation goes.`
            : 'Delete this run — prompt, result and summary.';
    }

    function runThreadDelBtn(l, logs) {
        const busy = threadOf(l.id, logs).some(r => RUNNING_STATUSES.includes(r.status));
        const title = busy ? RUN_DEL_COPY.busy : runThreadDelTitle(l, logs);
        return `<button class="run-del-btn" data-run-id="${esc(l.id)}"${busy ? ' disabled' : ''}` +
            ` aria-label="${esc(title)}" title="${esc(title)}">${trashIcon()}</button>`;
    }

    function bindRunThreadDelete(el) {
        el.querySelectorAll('.run-del-btn:not(:disabled)').forEach(btn =>
            OpenLoopPanel.armedButton(btn, btn.title, RUN_DEL_COPY.armed, commitRunThreadDelete));
    }

    function focusRun(runId) {
        const root = runsCache.find(l => l.id === runId && !l.parent_run_id);
        if (!root) return;
        focusedRunId = runId;
        renderRunView(root, true);
        $('detail-panel-inner').querySelector('.run-back-btn').focus();
        scrollToThreadEnd(); // a conversation's news is at its end — arrive there
    }

    function refreshRunView(logs) {
        const root = logs.find(l => l.id === focusedRunId && !l.parent_run_id);
        root ? renderRunView(root, false) : backToNode();
    }

    function backToNode() {
        const from = focusedRunId;
        focusedRunId = null;
        runSummaryEditing = false;
        logsJson = '';
        pendingRowFocus = from; // rows re-render async (loadLogs) — restore focus then
        const n = nodes.find(x => x.id === selectedId);
        if (!n) return closePanel();
        openPanel(n);
        leanBackIn();
    }

    function focusPendingRow() {
        if (!pendingRowFocus) return;
        const row = document.querySelector(`.run-log[data-run-id="${pendingRowFocus}"]`);
        pendingRowFocus = null;
        if (row) { row.tabIndex = -1; row.focus(); }
    }

    // ── pending run arrival (?run= deep link, or a freshly scheduled run) ──
    // The ONLY consumer of pendingRunFocus: resolve it against the freshly
    // filled runsCache, open the thread at its root (focusRun is root-only),
    // then point at the arriving entry. Ghost id → node view + one-line notice.
    function consumePendingRunFocus() {
        const wanted = pendingRunFocus;
        if (!wanted) return false;
        pendingRunFocus = null;
        const root = rootRunOf(wanted, runsCache);
        if (!root) { staleDeepRun = true; return false; }
        gateThreadEnter(() => {
            focusRun(root);
            beaconThreadRun(wanted);
        });
        return true;
    }

    // Sequence gate: a fast local API can land the logs before the panel's
    // 300ms slide ends — swapping views mid-slide reads as flicker. Wait for
    // the slide (transitionend on #detail-panel, 350ms ceiling so a missed
    // event never deadlocks). Reduced motion or a closed panel → open now.
    function gateThreadEnter(open) {
        const panel = $('detail-panel');
        if (reducedMotion() || !panel || !panel.classList.contains('open')) return open();
        let opened = false;
        const finish = () => {
            if (opened) return;
            opened = true;
            panel.removeEventListener('transitionend', onEnd);
            clearTimeout(ceiling);
            open();
        };
        const onEnd = e => {
            if (e.target === panel && e.propertyName === 'transform') finish();
        };
        const ceiling = setTimeout(finish, 350);
        panel.addEventListener('transitionend', onEnd);
    }

    // "This one, specifically": ring the tapped run's entry and center it —
    // the card beacon grammar, root and follow-up alike. The centering is
    // conditional now: an open that landed at the thread's end has already
    // seated the tip, and a second scroll would fight that glide (the
    // geometry lives in panel.js, shared with workflow-log.js's deep link).
    function beaconThreadRun(runId) {
        const row = document.querySelector(`.run-log[data-run-id="${CSS.escape(runId)}"]`);
        if (!row) return;
        OpenLoopPanel.beaconIntoView(row, $('detail-panel-inner').querySelector('.detail-panel-body'));
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function leanBackIn() {
        const body = $('detail-panel-inner').querySelector('.detail-panel-body');
        if (body) body.classList.add('run-back');
    }

    function renderRunView(root, animate) {
        if (animate) return enterThread(root);
        const thread = threadOf(root.id, runsCache);
        refreshThreadMessages(thread);
        reconcileFooter(thread[thread.length - 1]);
    }

    function enterThread(root) {
        const inner = $('detail-panel-inner');
        const thread = threadOf(root.id, runsCache);
        footerKey = footerKeyOf(thread[thread.length - 1]);
        inner.innerHTML = threadViewHtml(root, thread);
        OpenLoopBubble.gateBubbles(inner);
        inner.querySelector('.detail-panel-body').classList.add('run-enter');
        bindThreadMessages($('thread-messages')); // rows are interactive from the first paint — copy/edit/delete must not wait for the next poll
        bindRunViewControls();
    }

    function refreshThreadMessages(thread) {
        const el = $('thread-messages');
        if (!el) return;
        const snap = OpenLoopBubble.snapshotExpansion(el);
        el.innerHTML = thread.map(threadEntryHtml).join('');
        refreshThreadHeaderMeta(thread);
        OpenLoopBubble.restoreExpansion(el, snap);
        OpenLoopBubble.gateBubbles(el);
        bindThreadMessages(el);
    }

    // Header meta follows the thread, not just the first paint: the count and
    // tip status change on every splice, so the same refresh that rewrites
    // the rows rewrites this line too (fixes the stale "N runs" after
    // follow-ups, required after deletes).
    function refreshThreadHeaderMeta(thread) {
        if (!thread.length) return;
        const meta = $('detail-panel-inner').querySelector('.detail-panel-title .detail-panel-meta');
        if (meta) meta.textContent = runViewHeaderMeta(thread[0], thread);
    }

    function bindThreadMessages(el) {
        if (!el) return;
        bindSummaryEdit(el);
        bindRunDelete(el);
    }

    function bindSummaryEdit(scope) {
        scope.querySelectorAll('.summary-edit-btn').forEach(btn =>
            btn.addEventListener('click', () => startRunSummaryEdit(btn.dataset.runId)));
    }

    function bindRunViewControls() {
        const inner = $('detail-panel-inner');
        inner.querySelector('.detail-panel-close').addEventListener('click', closePanel);
        inner.querySelector('.run-back-btn').addEventListener('click', backToNode);
        bindRunComposer();
    }

    // The thread is a triad: header → scroll body (messages only) → dock
    // (the pinned footer). The composer lives in the dock, outside the
    // scroll body: reading a long thread and writing the next turn are one
    // glance, not a scroll round trip. #thread-footer inside it is the
    // state machine's slot — reconcileFooter rewrites only that inner div.
    function threadViewHtml(root, thread) {
        return runViewHeader(root, thread) +
            `<div class="detail-panel-body">${messagesHtml(thread)}</div>` +
            `<div class="detail-panel-footer" role="region" aria-label="Follow-up composer">` +
            `<div class="detail-panel-accent"></div>${threadFooterHtml(thread)}</div>`;
    }

    function messagesHtml(thread) {
        return `<div id="thread-messages">${thread.map(threadEntryHtml).join('')}</div>`;
    }

    function threadFooterHtml(thread) {
        return `<div id="thread-footer">${runFollowupSection(thread[thread.length - 1])}</div>`;
    }

    function threadEntryHtml(l) {
        return `<div class="run-log" data-run-id="${esc(l.id)}">` +
            `<div class="run-log-meta"><span>${runMeta(l)}</span>${runDelBtn(l)}</div>` +
            OpenLoopBubble.bubbleHtml('input', l.prompt) +
            runResultSection(l) +
            runSummarySection(l) +
            `</div>`;
    }

    function runBackBtn() {
        return `<button class="run-back-btn" title="Back to node" aria-label="Back to node">` +
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>`;
    }

    function runViewHeader(root, thread) {
        return `<div class="detail-panel-header">` +
            `<div class="detail-panel-accent"></div>` +
            runBackBtn() +
            `<div class="detail-panel-title">` +
            `<div class="detail-panel-name">Conversation · ${fmtTime(root.created_at)}</div>` +
            `<div class="detail-panel-meta">${runViewHeaderMeta(root, thread)}</div>` +
            `</div>` +
            `<button class="detail-panel-close" title="Close panel" aria-label="Close panel">✕</button>` +
            `</div>`;
    }

    function runViewHeaderMeta(root, thread) {
        const n = thread.length;
        return `${n} run${n > 1 ? 's' : ''} · ${runMeta(thread[n - 1])}`;
    }

    function runSummarySection(l) {
        if (['progress', 'summarizing', 'failed'].includes(l.status)) return '';
        return `<div class="run-summary-section" data-run-id="${esc(l.id)}">${summarySectionInner(l)}</div>`;
    }

    function summarySectionInner(l) {
        const body = l.summary
            ? OpenLoopBubble.bubbleHtml('summary', l.summary)
            : '<div class="summary-missing">No summary yet — write one to allow follow-ups.</div>';
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div>` +
            `<span class="summary-actions"><button class="summary-edit-btn" data-run-id="${esc(l.id)}">${l.summary ? 'Edit' : 'Add'}</button></span></div>${body}`;
    }

    function runSummaryEditHtml(l) {
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div></div>` +
            `<textarea id="run-summary-input" rows="7" aria-label="Edit summary" placeholder="Write a summary to allow follow-ups…" spellcheck="false">${esc(l.summary || '')}</textarea>` +
            `<button class="regen-submit" id="run-summary-update" disabled>Update</button>`;
    }

    function startRunSummaryEdit(runId) {
        const l = runsCache.find(x => x.id === runId);
        const section = document.querySelector(`.run-summary-section[data-run-id="${CSS.escape(runId)}"]`);
        if (!l || !section) return;
        runSummaryEditing = true;
        section.innerHTML = runSummaryEditHtml(l);
        bindRunSummaryUpdate(l);
        OpenLoopPanel.focusEditor($('run-summary-input'), section);
    }

    function bindRunSummaryUpdate(l) {
        const input = $('run-summary-input');
        const update = $('run-summary-update');
        const dirty = () => input.value.trim() !== (l.summary || '') && !!input.value.trim();
        const sync = () => { update.disabled = !dirty(); };
        input.addEventListener('input', sync);
        update.addEventListener('click', () => submitRunSummary(l.id));
        sync();
    }

    async function submitRunSummary(runId) {
        const summary = $('run-summary-input').value.trim();
        if (!summary) return;
        runSummaryEditing = false;
        try {
            applyRunSummary(await putRunSummary(runId, summary));
            logsJson = '';
            await loadLogs(selectedId);
        } catch (e) {
            showError(`Failed to save summary: ${e.message}`);
        }
    }

    function applyRunSummary(updated) {
        runsCache = runsCache.map(l => (l.id === updated.id ? updated : l));
        const section = document.querySelector(`.run-summary-section[data-run-id="${CSS.escape(updated.id)}"]`);
        if (section) {
            section.innerHTML = summarySectionInner(updated);
            OpenLoopBubble.gateBubbles(section); // the swapped-in bubble needs its gate
            bindSummaryEdit(section);
            // no bindCopyButtons here by design: the delegated copy tap
            // (bubble.js bindCopy, bound once at init) covers swapped-in
            // bubbles — this swap once left a dead copy button behind
        }
    }

    async function putRunSummary(runId, summary) {
        return await fetchJson(runThreadUrl(runId), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary })
        });
    }

    function runFollowupSection(tip) {
        if (!tip) return '';
        // Copy matches workflow-log.html character-for-character: the fuller
        // sentence answers "should I reload?" where the question occurs —
        // the terse variant saved four words and spent the user's trust.
        if (tip.status === 'progress') return runHint('Run in progress — the panel refreshes while it works.');
        if (tip.status === 'summarizing') return runHint('Summarizing the answer…');
        if (tip.status === 'failed') return failedFooterHtml();
        if (!tip.summary) return runHint('Write a summary above to continue this conversation.');
        return followupComposerHtml();
    }

    function failedFooterHtml() {
        return `<div class="run-followup-hint">This run failed — restart it to try again.` +
            `<button class="regen-submit run-retry" id="run-retry-btn">Retry</button></div>`;
    }

    // The composer capsule: field + send circle in one row (the skin lives
    // in panel.css). rows=3, not the editors' 7 — a pinned dock must not
    // eat the stream; resize + the 40vh cap bound it. Send is an icon
    // button — quiet until there is something to send.
    function followupComposerHtml() {
        return `<div class="run-composer">` +
            `<textarea id="run-followup-text" rows="3" aria-label="Continue conversation" placeholder="Continue this conversation…" autocomplete="off" spellcheck="false"></textarea>` +
            `<button class="composer-send" id="run-followup-send" aria-label="Send follow-up (⌘↵)" title="Send follow-up (⌘↵)" aria-keyshortcuts="Meta+Enter Control+Enter" disabled>${sendIcon()}</button>` +
            `</div>`;
    }

    function sendIcon() {
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
    }

    function runHint(text) {
        return `<div class="run-followup-hint">${esc(text)}</div>`;
    }

    function reconcileFooter(tip) {
        const key = footerKeyOf(tip);
        if (key === footerKey) return;
        const footer = $('thread-footer');
        if (!footer) return;
        const draft = footerDraft();
        footerKey = key;
        footer.innerHTML = runFollowupSection(tip);
        bindRunComposer();
        restoreFooterDraft(draft);
        // the dock is pinned — every state change is already in view; the
        // old reveal() call died with the scrolling composer
    }

    function footerKeyOf(tip) {
        return tip ? `${tip.id}:${tip.status}:${tip.summary ? 1 : 0}` : 'empty';
    }

    function footerDraft() {
        const text = $('run-followup-text');
        return text && text.value.trim() ? text.value : '';
    }

    function restoreFooterDraft(draft) {
        const text = $('run-followup-text');
        if (!text || !draft) return;
        text.value = draft;
        text.dispatchEvent(new Event('input'));
    }

    function bindRunComposer() {
        const send = $('run-followup-send');
        if (send) bindFollowupComposer(send);
        bindFooterRetry();
    }

    function bindFollowupComposer(send) {
        const text = $('run-followup-text');
        const sync = () => { send.disabled = !text.value.trim(); };
        text.addEventListener('input', sync);
        // One submit grammar, shared with workflow-log.html (panel.js): the
        // shortcut prevents its default AND hands the caret back before the
        // submit — a focused empty field still trips blockedByTyping, and
        // both this submit's loadLogs and the 5s poll would stall silently
        // behind the gate (the ⌘↵-never-updates bug). Per-render bind: the
        // footer rewrite at reconcileFooter recreates the DOM, fresh
        // listeners — the same pattern as today.
        OpenLoopPanel.bindCmdEnterSubmit(text, submitFollowup);
        send.addEventListener('click', () => submitFollowup());
    }

    function bindFooterRetry() {
        const btn = $('run-retry-btn');
        if (btn) btn.addEventListener('click', submitFooterRetry);
    }

    async function submitFooterRetry() {
        const tip = threadOf(focusedRunId, runsCache).pop();
        if (!tip) return;
        try {
            await postRetry(tip.id);
            await load();
            logsJson = '';
            await loadLogs(selectedId);
            scrollToThreadEnd();
        } catch (e) {
            showError(`Failed to restart run: ${e.message}`);
        }
    }

    function postRetry(runId) {
        return fetchJson(runThreadUrl(runId) + '/retry', { method: 'POST' });
    }

    async function submitFollowup() {
        const prompt = $('run-followup-text').value.trim();
        if (!prompt) return;
        const tip = threadOf(focusedRunId, runsCache).pop();
        if (!tip) return;
        try {
            await postRun(prompt, tip.id);
            clearFollowupDraft();
            await load();
            logsJson = '';
            await loadLogs(selectedId);
            scrollToThreadEnd();
        } catch (e) {
            showError(`Failed to continue run: ${e.message}`);
        }
    }

    function clearFollowupDraft() {
        const text = $('run-followup-text');
        if (text) { text.value = ''; text.dispatchEvent(new Event('input')); }
    }

    // Open and send are the sanctioned scrolls: arriving at a thread glides
    // the body to the newest turn, and so does sending one (instant under
    // reduced motion). While merely reading + typing, nothing ever scrolls —
    // that is the dock's contract. A deep link may then retake its own seat:
    // beaconThreadRun centers its row only when this landing left it hidden.
    function scrollToThreadEnd() {
        const body = $('detail-panel-inner').querySelector('.detail-panel-body');
        if (!body) return;
        const end = body.scrollHeight;
        // Element.scrollTo is universal in browsers; the offline harness's
        // jsdom may not ship it — scrollTop reaches the same end, instantly.
        if (typeof body.scrollTo === 'function') body.scrollTo({ top: end, behavior: reducedMotion() ? 'auto' : 'smooth' });
        else body.scrollTop = end;
    }

    function runResultSection(l) {
        const progress = l.status === 'progress';
        const failed = l.status === 'failed';
        const cls = failed ? 'detail-section-label result error' : 'detail-section-label result';
        const label = progress ? '<div class="detail-section-label running">RUNNING</div>' : `<div class="${cls}">${failed ? 'ERROR' : 'RESULT'}</div>`;
        const bubble = progress
            ? OpenLoopBubble.bubbleHtml('output', 'in progress…')
            : OpenLoopBubble.bubbleHtml(failed ? 'output error' : 'output', l.output || '(empty)');
        return `<div>${label}${bubble}</div>`;
    }

    function ago(ms) {
        const mins = Math.floor((Date.now() - ms) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        const days = Math.floor(hrs / 24);
        if (days < 7) return days + 'd ago';
        if (days < 30) return Math.floor(days / 7) + 'w ago';
        if (days < 365) return Math.floor(days / 30) + 'mo ago';
        return Math.floor(days / 365) + 'y ago';
    }

    // — delete actions —
    // Two-step armed confirm (3s auto-disarm) at the panel bottom. "Delete node"
    // bridges children to the deleted node's parent (or they become roots);
    // "Delete chain" removes the whole subtree. Hidden on leaves, disabled while
    // running. A panel re-render (status change, save, 5s refresh) rebuilds the
    // DOM and silently disarms — always the safe direction.

    let deleteArmed = null;
    let deleteTimer = null;
    let deletingNode = false;
    let emptiedByDelete = false;
    const RUNNING_STATUSES = ['progress', 'summarizing'];

    function subtreeIdsOf(n) {
        const byParent = childrenMap();
        const seen = new Set([n.id]);
        const queue = [n.id];
        while (queue.length) {
            for (const c of byParent.get(queue.shift()) || []) {
                if (!seen.has(c.id)) { seen.add(c.id); queue.push(c.id); }
            }
        }
        return [...seen];
    }

    function subtreeNodes(n) {
        const byId = new Map(nodes.map(x => [x.id, x]));
        return subtreeIdsOf(n).map(id => byId.get(id)).filter(Boolean);
    }

    function deleteSection(n) {
        const descendants = subtreeNodes(n).length - 1;
        const busy = subtreeNodes(n).filter(x => RUNNING_STATUSES.includes(x.status)).map(x => x.id);
        const btn = (chain) => deleteBtn(n, chain, chain ? busy.length > 0 : busy.includes(n.id), descendants);
        return `<div class="delete-section">` +
            `<div class="detail-section-label danger">Danger zone</div>` +
            btn(false) + (descendants ? btn(true) : '') + `</div>`;
    }

    function deleteBtn(n, chain, disabled, descendants) {
        const label = chain ? 'Delete chain' : 'Delete node';
        const badge = chain
            ? `<span class="delete-count" title="this node + ${descendants} descendants">${descendants + 1}</span>`
            : '';
        const dis = disabled ? ' disabled' : '';
        return `<button class="delete-btn" data-id="${esc(n.id)}" data-chain="${chain}"` +
            ` data-label="${label}" data-total="${descendants + 1}"${dis}>` +
            trashIcon() + `<span class="delete-label">${label}</span>${badge}</button>` +
            `<div class="delete-hint">${esc(deleteHint(n, chain, disabled, descendants))}</div>`;
    }

    function deleteHint(n, chain, disabled, descendants) {
        if (disabled) return RUNNING_STATUSES.includes(n.status)
            ? 'This node is running — deletion unlocks when the run finishes.'
            : 'A descendant is running — chain deletion unlocks when it finishes.';
        if (chain) {
            return `Deletes this node and ${descendants} descendant${descendants > 1 ? 's' : ''}, with their runs.`;
        }
        return descendants
            ? 'Children are kept — they move up to this node’s parent, or become roots.'
            : 'Removes this node, its result and its run history.';
    }

    function trashIcon() {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">` +
            `<path d="M3 6h18"/><path d="M8 6V4h8v2"/>` +
            `<path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
    }

    function bindDeleteButtons() {
        $('detail-panel-inner').querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => onDeleteClick(btn));
            btn.addEventListener('blur', () => { if (btn === deleteArmed) disarmDelete(); });
        });
    }

    function onDeleteClick(btn) {
        if (deletingNode || btn.disabled) return;
        if (btn === deleteArmed) return commitDelete(btn);
        armDelete(btn);
    }

    function armDelete(btn) {
        disarmDelete();
        deleteArmed = btn;
        btn.classList.add('armed');
        armLabel(btn, true);
        deleteTimer = setTimeout(disarmDelete, 3000);
    }

    function disarmDelete() {
        if (deleteTimer) clearTimeout(deleteTimer);
        deleteTimer = null;
        if (!deleteArmed) return false;
        const btn = deleteArmed;
        deleteArmed = null;
        btn.classList.remove('armed', 'deleting');
        armLabel(btn, false);
        return true;
    }

    function armLabel(btn, armed) {
        const label = btn.querySelector('.delete-label');
        if (!label) return;
        label.textContent = armed
            ? (btn.dataset.chain === 'true' ? `Confirm — delete ${btn.dataset.total} nodes` : 'Confirm delete')
            : btn.dataset.label;
    }

    function commitDelete(btn) {
        deletingNode = true;
        btn.classList.add('deleting');
        markDeleting();
        delNode(btn.dataset.id, btn.dataset.chain === 'true');
    }

    function markDeleting() {
        $('detail-panel-inner').querySelectorAll('.delete-btn').forEach(b => {
            b.disabled = true;
            const label = b.querySelector('.delete-label');
            if (label) label.textContent = 'Deleting…';
        });
    }

    // — per-turn delete (thread rows) —
    // The node grammar scaled to a 24px row icon: quiet at rest, armed
    // confirm (3s fuse, panel.js armedButton — fresh DOM disarms for free),
    // one splice beat, then the same reload as a submitted follow-up. The
    // server splices (`next` reparents to `deleted.parent`); deleting the
    // focused root needs no special case — refreshRunView finds the root
    // gone and lands in backToNode. Copy is character-identical to
    // workflow-log.js's THREAD_DEL_COPY (pinned by both sanity suites).

    const THREAD_DEL_COPY = {
        rest: 'Delete this turn. Follow-ups move up to this run’s parent — nothing else changes.',
        armed: 'Confirm — delete this turn',
        busy: 'This turn is running — deletion unlocks when it finishes.',
    };

    function runDelBtn(l) {
        const busy = RUNNING_STATUSES.includes(l.status);
        const title = busy ? THREAD_DEL_COPY.busy : THREAD_DEL_COPY.rest;
        return `<button class="run-del-btn" data-run-id="${esc(l.id)}"${busy ? ' disabled' : ''}` +
            ` aria-label="${esc(title)}" title="${esc(title)}">${trashIcon()}</button>`;
    }

    function bindRunDelete(scope) {
        scope.querySelectorAll('.run-del-btn:not(:disabled)').forEach(btn =>
            OpenLoopPanel.armedButton(btn, THREAD_DEL_COPY.rest, THREAD_DEL_COPY.armed, commitRunDelete));
    }

    function commitRunDelete(btn) {
        const runId = btn.dataset.runId;
        btn.classList.add('deleting');
        markRunDeleting();
        delRunLog(runId, threadFocusIndex(runId));
    }

    function markRunDeleting() {
        $('detail-panel-inner').querySelectorAll('.run-del-btn').forEach(b => { b.disabled = true; });
    }

    async function delRunLog(runId, focusIndex) {
        const beat = spliceBeat(runId);
        try {
            const res = await fetch(runThreadUrl(runId), { method: 'DELETE' });
            if (res.status !== 404 && !res.ok) throw await runDeleteError(res);
            await beat;
            await load();
            logsJson = '';
            await loadLogs(selectedId);
            focusThreadRowAt(focusIndex);
        } catch (e) {
            showError(e.message);
            logsJson = '';
            await loadLogs(selectedId);
            focusThreadRowAt(focusIndex);
        }
    }

    async function runDeleteError(res) {
        if (res.status === 409) return new Error('Still running — let the run finish, then delete.');
        return new Error(`Failed to delete the turn: ${res.status} ${(await res.text()).slice(0, 140)}`);
    }

    function runThreadUrl(runId) {
        return `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(selectedId)}/runs/${encodeURIComponent(runId)}`;
    }

    // The splice beat: the dying row exhales (fade + 2px lift) while the
    // DELETE is in flight — 150ms, instant under reduced motion.
    function spliceBeat(runId) {
        const row = document.querySelector(`.run-log[data-run-id="${CSS.escape(runId)}"]`);
        if (!row || reducedMotion()) return Promise.resolve();
        row.classList.add('run-del-dying');
        return new Promise(done => setTimeout(done, 150));
    }

    // Keyboard handoff: focus sat ON the deleted button, so the refresh must
    // not strand it at document top — land on the surviving row at the same
    // index. Mouse users pass -1 and skip this.
    function threadFocusIndex(runId) {
        if (!document.activeElement || !document.activeElement.closest('.run-del-btn')) return -1;
        const rows = [...document.querySelectorAll('#thread-messages .run-log')];
        return Math.max(rows.findIndex(r => r.dataset.runId === runId), 0);
    }

    function focusThreadRowAt(index) {
        const rows = document.querySelectorAll('#thread-messages .run-log');
        if (index < 0 || !rows.length) return; // root deleted → backToNode owns focus
        const row = rows[Math.min(index, rows.length - 1)];
        row.tabIndex = -1;
        row.focus();
    }

    // Full-RUN delete commit — the splice beat, then the same reload ladder
    // as a submitted follow-up: load() recounts the node's run badge (it
    // tracks thread roots), loadLogs() re-renders the list. 404 is silent
    // success (already gone), mirroring delNode/delRunLog.
    function commitRunThreadDelete(btn) {
        btn.classList.add('deleting');
        markRunDeleting();
        delRunThread(btn.dataset.runId, listFocusIndex());
    }

    async function delRunThread(runId, focusIndex) {
        const beat = spliceBeat(runId);
        try {
            const res = await fetch(runThreadUrl(runId) + '?thread=true', { method: 'DELETE' });
            if (res.status !== 404 && !res.ok) throw await runThreadDeleteError(res);
            await beat;
            await load();
            logsJson = '';
            await loadLogs(selectedId);
            focusListRowAt(focusIndex);
        } catch (e) {
            showError(e.message);
            logsJson = '';
            await loadLogs(selectedId);
            focusListRowAt(focusIndex);
        }
    }

    async function runThreadDeleteError(res) {
        if (res.status === 409) return new Error('Still running — let the run finish, then delete.');
        return new Error(`Failed to delete the run: ${res.status} ${(await res.text()).slice(0, 140)}`);
    }

    // Keyboard handoff, list edition: focus sat on the dying row's bin, so
    // the refreshed list lands it on the surviving row at the same index
    // (mouse users pass -1 and skip this). An emptied list has no row —
    // the wide New run finisher below it is the landing.
    function listFocusIndex() {
        if (!document.activeElement || !document.activeElement.closest('.run-del-btn')) return -1;
        return [...document.querySelectorAll('#runs-list .run-log')]
            .findIndex(r => r.contains(document.activeElement));
    }

    function focusListRowAt(index) {
        const rows = document.querySelectorAll('#runs-list .run-log');
        if (index < 0 || !rows.length) return;
        const row = rows[Math.min(index, rows.length - 1)];
        row.tabIndex = -1;
        row.focus();
    }

    function graphNodeUrl(nodeId) {
        return `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(nodeId)}`;
    }

    async function delNode(id, chain) {
        const url = graphNodeUrl(id) + (chain ? '?chain=true' : '');
        try {
            const res = await fetch(url, { method: 'DELETE' });
            if (res.status === 404) return void await load(); // already gone — silent success
            if (!res.ok) throw await deleteError(res);
            applyDeleted(await res.json());
        } catch (e) {
            showError(e.message);
            await resyncPanel();
        } finally {
            deletingNode = false;
        }
    }

    async function deleteError(res) {
        if (res.status === 409) return new Error('Still running — let the run finish, then delete.');
        return new Error(`Delete failed: ${res.status} ${(await res.text()).slice(0, 140)}`);
    }

    function applyDeleted(res) {
        nodes = res.nodes || [];
        emptiedByDelete = nodes.length === 0;
        closePanel();
        render();
    }

    async function resyncPanel() {
        disarmDelete();
        await load();
        const fresh = nodes.find(x => x.id === selectedId);
        if (fresh) openPanel(fresh);
    }

    function summarySection(n) {
        if (n.status === 'progress' || n.status === 'failed') return '';
        return `<div id="summary-section"><div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div>` +
            `<span class="summary-actions">${regenButton(n)}${editSummaryButton(n)}</span></div>` +
            `${n.summary ? OpenLoopBubble.bubbleHtml('summary', n.summary) : summaryPlaceholder(n)}` +
            `</div>`;
    }

    function editSummaryButton(n) {
        return n.summary ? '<button class="summary-edit-btn" id="summary-edit-btn">Edit</button>' : '';
    }

    function summaryEditHtml(n) {
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div></div>` +
            `<textarea id="summary-input" rows="7" aria-label="Edit summary" placeholder="Write a summary to allow follow-ups…" spellcheck="false">${esc(n.summary)}</textarea>` +
            `<button class="regen-submit" id="summary-update" disabled>Update</button>`;
    }

    function regenButton(n) {
        if (n.status === 'summarizing') {
            return '<button class="summary-regen" disabled>summarizing…</button>';
        }
        return '<button class="summary-regen">Regenerate</button>';
    }

    function summaryPlaceholder(n) {
        if (n.status === 'summarizing') return '';
        return '<div class="summary-missing">No summary yet — regenerate to create one.</div>';
    }

    function bindSummaryButton(n) {
        const btn = $('detail-panel-inner').querySelector('.summary-regen');
        if (btn && !btn.disabled) btn.addEventListener('click', startPromptEdit);
        const edit = $('detail-panel-inner').querySelector('.summary-edit-btn');
        if (edit) edit.addEventListener('click', startSummaryEdit);
    }

    function startSummaryEdit() {
        const n = nodes.find(x => x.id === selectedId);
        const section = $('summary-section');
        if (!n || !section || !n.summary) return;
        summaryEditing = true;
        section.innerHTML = summaryEditHtml(n);
        bindSummaryUpdate(n);
        OpenLoopPanel.focusEditor($('summary-input'), section);
    }

    function bindSummaryUpdate(n) {
        const input = $('summary-input');
        const update = $('summary-update');
        const dirty = () => input.value.trim() !== n.summary && !!input.value.trim();
        const sync = () => { update.disabled = !dirty(); };
        input.addEventListener('input', sync);
        update.addEventListener('click', () => submitSummaryEdit(n.id));
        sync();
    }

    async function submitSummaryEdit(nodeId) {
        const summary = $('summary-input').value.trim();
        if (!summary) return;
        summaryEditing = false;
        try {
            await putNode(nodeId, { summary });
            await load();
            openPanel(nodes.find(x => x.id === selectedId));
        } catch (e) {
            showError(`Failed to save summary: ${e.message}`);
        }
    }

    function startPromptEdit() {
        const n = nodes.find(x => x.id === selectedId);
        const section = $('prompt-section');
        if (!n || !section) return;
        promptEditing = true;
        const btn = $('detail-panel-inner').querySelector('.summary-regen');
        if (btn) btn.style.display = 'none';
        section.innerHTML = editPromptHtml(n);
        $('regen-submit').addEventListener('click', () => submitRegen(n.id));
        OpenLoopPanel.focusEditor($('regen-prompt'), section);
    }

    async function postSummary(nodeId, prompt) {
        await fetchJson(summaryUrl(nodeId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        await load();
    }

    async function submitRegen(nodeId) {
        promptEditing = false;
        try {
            await postSummary(nodeId, $('regen-prompt').value.trim());
            openPanel(nodes.find(x => x.id === selectedId));
        } catch (e) {
            showError(`Failed to regenerate summary: ${e.message}`);
        }
    }

    async function submitRetry(nodeId) {
        try {
            await postSummary(nodeId, '');
            openPanel(nodes.find(x => x.id === selectedId));
        } catch (e) {
            showError(`Failed to rerun: ${e.message}`);
        }
    }

    function bindRetryButton(n) {
        const btn = $('detail-panel-inner').querySelector('#retry-btn');
        if (btn) btn.addEventListener('click', () => submitRetry(n.id));
    }

    function summaryUrl(nodeId) {
        return `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(nodeId)}/summary`;
    }

    function mcpSection(n) {
        return `<div><div class="detail-section-label">MCP · REMOTE/HTTP</div>` +
            `<div class="mcp-row">` +
            `<input id="mcp-input" type="text" value="${esc(n.mcp || '')}" placeholder="https://example.com/mcp" spellcheck="false" autocomplete="off">` +
            `<button id="mcp-save">Save</button>` +
            `</div>` +
            mcpAuthSection(n) +
            `<div class="mcp-hint">Remote HTTP MCP endpoint for this cell; optional Authorization header value (full value, prefix included). The key is stored per computer in .openloop/secrets.json5 (git-ignored) — it never travels with the repo, which only records that one is configured.</div>` +
            `</div>`;
    }

    // The key is write-only: the input starts empty and the server never
    // echoes a stored value. What the panel shows is state — set here (calm
    // line + Clear), configured-but-missing (warn — the fresh-clone case:
    // the repo says this MCP needs a key, this machine doesn't have one), or
    // silence (no key configured; many MCPs need none).
    function mcpAuthSection(n) {
        if (!n.mcp) return '';
        const set = !!n.mcp_auth_local;
        const missing = !set && !!n.mcp_requires_auth;
        const placeholder = set
            ? 'Authorization is set — type a new value to replace it'
            : missing
                ? 'Authorization key missing on this computer — set it'
                : 'Authorization header value (optional), e.g. Bearer sk-…';
        const state = set
            ? `<div class="mcp-auth-state ok">Authorization is set on this computer.</div>`
            : missing
                ? `<div class="mcp-auth-state warn">This MCP was configured with an authorization key, but it is not set on this computer — runs from here will call it without auth. Set it below.</div>`
                : '';
        return state +
            `<div class="mcp-row">` +
            `<input id="mcp-auth-input" type="text" value="" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">` +
            `<button id="mcp-auth-save">Save</button>` +
            (set ? `<button id="mcp-auth-clear">Clear</button>` : '') +
            `</div>`;
    }

    function resultSection(n) {
        if (n.status === 'progress') {
            return `<div><div class="detail-section-label running">RUNNING</div>` +
                OpenLoopBubble.bubbleHtml('output', 'in progress…') + `</div>`;
        }
        const failed = n.status === 'failed';
        const cls = failed ? 'detail-section-label result error' : 'detail-section-label result';
        const label = failed ? 'ERROR' : 'RESULT';
        const again = failed ? '<button class="summary-regen" id="retry-btn">retry</button>' : '';
        return `<div><div class="${cls}">${label}</div>` +
            OpenLoopBubble.bubbleHtml(failed ? 'output error' : 'output', n.output || '(empty)') + again + `</div>`;
    }

    // The bubble grammar (markup, the line gate, the door, expansion memory,
    // and the copy tap) lives in bubble.js, shared with workflow-log.html —
    // the char-gated renderBubble and the per-render bindCopyButtons this
    // file used to carry are gone. Copy is bound ONCE at init
    // (OpenLoopBubble.bindCopy), delegation covering every surface.

    function fmtTime(ms) {
        return new Date(ms).toTimeString().slice(0, 8);
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runSanityChecks() {
        checkFmtDur();
        checkChainPath();
        checkClampPanelWidth();
        checkRenderBubbleTruncation();
        checkAddRootPinned();
        checkRunLogHtml();
        checkRunLogEmpty();
        checkListDelete();
        checkRunsSectionButtons();
        checkRunDisabledAttr();
        checkRunViewHtml();
        checkThreadDelete();
        checkThreadHeaderMeta();
        checkRootRunOf();
        checkConsumePendingRunFocus();
        checkThreadOpensAtTip();
        checkFooterStructure();
        checkFooterImmovable();
        checkFooterFadeSuppressed();
        checkComposerCapped();
        checkCmdEnterDockEscape();
        checkComposerCmdEnterModes();
        checkScheduleRunFocus();
        checkFooterAbsentInNodeView();
        checkNodeTitleEveryCard();
        checkNeighborTitlesClear();
        checkInsertBtnStillCentered();
        checkAddChildReadiness();
        checkEdgesStillDrawn();
        checkBeCaptionCascade();
        checkBeCaptionColors();
        checkBeDeepChainIndent();
        checkBeNoNamesUnchanged();
        checkBeForkNoDuplicates();
        checkDotTooltipNames();
        checkNameInputEveryNode();
        checkEditFieldGrammar();
        checkEditFieldExclusions();
        checkMcpAuthSection();
        checkMcpAuthCellIndication();
        checkAgentSectionEveryNode();
        checkClampGrammar();
        console.log('All sanity checks passed.');
    }

    // The RULE lives in panel.js (checkFmtDur pins the full table — this page once carried a drifted twin); here we pin the wiring only.
    function checkFmtDur() {
        console.assert(OpenLoopPanel.fmtDur(90) === '1m 30s' && OpenLoopPanel.fmtDur(150) === '3m',
            'fmtDur wiring: durations render via the shared OpenLoopPanel.fmtDur');
        console.assert(headerDur({ took: null, status: 'progress', created_at: Date.now() - 190000 }).endsWith('3m'),
            'fmtDur wiring: a running node older than 2m shows live rounded minutes');
        console.assert(runMeta({ status: 'success', took: 150, created_at: Date.now() }).includes('took 3m'),
            'fmtDur wiring: a >2m turn renders "took 3m" in the thread meta');
        console.log('OK: fmtDur wiring');
    }

    // The header states which instance you're on: the current crumb pairs
    // its green name with the full path in muted parens; parents stay
    // names-only (context, not location — the hover carries every path).
    function checkChainPath() {
        const cur = crumbHtml('/home/u/dev/openloop', true);
        console.assert(cur.includes('class="crumb-name">openloop<'),
            'chainPath: the name stays its own span — never the part that ellipsizes');
        console.assert(cur.includes('<span class="crumb-path">(/home/u/dev/openloop)</span>'),
            'chainPath: the current crumb states the full path in parens');
        console.assert(cur.includes('title="/home/u/dev/openloop"'),
            'chainPath: the tooltip keeps the full path');
        const parent = crumbHtml('/home/u/dev', false);
        console.assert(!parent.includes('crumb-path') && !parent.includes('crumb-name'),
            'chainPath: parents stay names-only');
        console.log('OK: chain path beside the name');
    }

    function checkRunLogHtml() {
        const l = { id: 'r1', root_run_id: 'r1', status: 'success', took: 2, created_at: Date.now(), prompt: 'p', output: 'o' };
        const html = runLogHtml(l, [l, { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', created_at: Date.now() + 1, prompt: 'x' }]);
        console.assert(html.includes('data-run-id="r1"'), 'runLog: run id attr');
        console.assert((html.match(/run-focus-btn/g) || []).length === 2, 'runLog: two focus arrows');
        console.assert(html.includes('convo-count">+1'), 'runLog: follow-up count badge');
        console.assert(html.includes('run-log-meta"><span>'), 'runLog: caption leads the header');
        console.assert(html.indexOf('run-del-btn') < html.indexOf('run-focus-btn'), 'runLog: header bin before the arrow');
        console.assert(html.lastIndexOf('run-del-btn') < html.lastIndexOf('run-focus-btn'), 'runLog: footer bin before the arrow');
        console.log('OK: runLogHtml chrome order');
    }

    function checkRunLogEmpty() {
        const l = { id: 'r2', root_run_id: 'r2', status: 'failed', created_at: Date.now(), prompt: 'p', output: null };
        const html = runLogHtml(l, [l]);
        console.assert(html.includes('(empty)') && !html.includes('in progress'), 'runLog: failed + empty → (empty)');
        console.assert(!html.includes('convo-count'), 'runLog: no badge on single-run convo');
        console.log('OK: runLogHtml empty output');
    }

    // Full-RUN delete: a bin in the header AND the footer of every list
    // item, caption before both, arrow last; an in-flight turn anywhere in
    // the thread disables both bins with the unlock sentence. Copy is the
    // list's own ("run", never "turn") — pinned here.
    function checkListDelete() {
        const now = Date.now();
        const root = { id: 'r1', root_run_id: 'r1', status: 'success', took: 2, created_at: now, prompt: 'p', output: 'o' };
        const done = { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', status: 'success', created_at: now + 1, prompt: 'p2' };
        const ok = runLogHtml(root, [root, done]);
        console.assert((ok.match(/class="run-del-btn/g) || []).length === 2, 'listDel: a bin in the header AND the footer');
        console.assert(ok.includes('Delete this run and its 1 follow-up'), 'listDel: title teaches the cascade');
        console.assert(ok.indexOf('<span>') < ok.indexOf('run-del-btn'), 'listDel: caption before the buttons');
        const busy = runLogHtml(root, [root, { ...done, status: 'progress' }]);
        console.assert((busy.match(/ disabled/g) || []).length === 2 && busy.includes(`title="${RUN_DEL_COPY.busy}"`),
            'listDel: an in-flight follow-up disables both bins with the unlock sentence');
        console.assert(RUN_DEL_COPY.armed === 'Confirm — delete this run', 'listDel: armed copy pinned');
        console.log('OK: runs-list delete markup');
    }

    // Runs section bookends: exactly two New run buttons, both OUTSIDE
    // #runs-list (they must survive the 5s renderLogs rewrite), both gated
    // by the chain rule with the one-sentence reason.
    function checkRunsSectionButtons() {
        const ready = runsSection({ id: 'n1', runnable: true });
        console.assert((ready.match(/class="new-run-btn/g) || []).length === 2,
            'runsBtns: two — the pill in the label row, the wide one after the list');
        const list = ready.indexOf('id="runs-list"');
        console.assert(ready.indexOf('new-run-btn') < list && ready.lastIndexOf('new-run-btn') > list,
            'runsBtns: bookends live outside #runs-list — no rebind flicker on the 5s rewrite');
        console.assert(!ready.includes('disabled'), 'runsBtns: a runnable node renders both enabled');
        const gated = runsSection({ id: 'n1', runnable: false });
        const attr = ' disabled title="chain not ready — parents need summaries"';
        console.assert(gated.split(attr).length - 1 === 2, 'runsBtns: an unready chain gates BOTH, same sentence');
        console.log('OK: runs section buttons');
    }

    // One gate string, three buttons: the cell's Run and both panel New runs
    // render the identical disabled attribute — single source (runDisabledAttr).
    function checkRunDisabledAttr() {
        const n = { id: 'n1', runs: { total: 3, success: 1, failed: 2, active: 0 } };
        const attr = ' disabled title="chain not ready — parents need summaries"';
        console.assert(runButton({ ...n, runnable: false }).includes(attr), 'gate: the cell Run carries the attr');
        console.assert(!runButton({ ...n, runnable: true }).includes('disabled'), 'gate: runnable → clean attribute');
        console.assert(runsSection({ ...n, runnable: false }).split(attr).length - 1 === 2,
            'gate: both panel buttons render the identical attr');
        console.log('OK: run disabled gate (single source)');
    }

    function checkRunViewHtml() {
        const now = Date.now();
        const thread = [
            { id: 'r1', root_run_id: 'r1', status: 'failed', took: 3, created_at: now, prompt: 'p', output: 'boom' },
            { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', status: 'progress', created_at: now + 1, prompt: 'p2' },
            { id: 'r3', root_run_id: 'r1', parent_run_id: 'r2', status: 'success', created_at: now + 2, prompt: 'p3', output: 'o', summary: 's' },
            { id: 'r4', root_run_id: 'r1', parent_run_id: 'r3', status: 'answered', created_at: now + 3, prompt: 'p4', output: 'o' }
        ];
        const html = threadViewHtml(thread[0], thread);
        console.assert(html.includes('run-back-btn'), 'runView: back button');
        console.assert(html.includes('4 runs'), 'runView: thread length in header');
        console.assert(html.includes('ERROR') && html.includes('RUNNING') && html.includes('RESULT'), 'runView: per-run labels');
        console.assert(!html.includes('run-composer'), 'runView: answered tip without summary → no composer');
        const done = threadViewHtml(thread[0], thread.slice(0, 3));
        console.assert(done.includes('SUMMARY') && done.includes('summary-edit-btn'), 'runView: summary + edit');
        console.assert(done.includes('run-composer'), 'runView: follow-up composer on summarised tip');
        console.log('OK: runViewHtml');
    }

    // Per-turn delete: a quiet icon in EVERY thread row's meta, disabled
    // while the turn is in flight, copy character-identical to
    // workflow-log.js's THREAD_DEL_COPY — the cross-page single source this
    // check is here to enforce.
    function checkThreadDelete() {
        const ok = { id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o' };
        const html = threadEntryHtml(ok);
        console.assert(html.includes('run-del-btn" data-run-id="r1"'), 'threadDel: every turn row carries the delete button');
        console.assert(html.includes(`title="${THREAD_DEL_COPY.rest}"`), 'threadDel: rest title teaches the splice');
        console.assert(html.indexOf('<span>') < html.indexOf('run-del-btn'), 'threadDel: caption leads, button follows it inline');
        for (const status of ['progress', 'summarizing']) {
            const busy = threadEntryHtml({ ...ok, id: 'r9', status });
            console.assert(busy.includes('disabled') && busy.includes(`title="${THREAD_DEL_COPY.busy}"`),
                `threadDel: ${status} renders disabled with the busy title`);
        }
        console.assert(THREAD_DEL_COPY.armed === 'Confirm — delete this turn', 'threadDel: armed copy pinned');
        console.assert(THREAD_DEL_COPY.rest.includes('Follow-ups move up to this run’s parent — nothing else changes'),
            'threadDel: teaching hint pinned');
        console.log('OK: per-turn delete markup');
    }

    // The header count follows the splice, not the first paint — the stale
    // "N runs" after a follow-up (or a delete) is what runViewHeaderMeta +
    // refreshThreadHeaderMeta are here to fix.
    function checkThreadHeaderMeta() {
        const now = Date.now();
        const thread = [
            { id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: now, prompt: 'p', output: 'o' },
            { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', status: 'success', took: 1, created_at: now + 1, prompt: 'p2', output: 'o2' },
            { id: 'r3', root_run_id: 'r1', parent_run_id: 'r2', status: 'success', took: 1, created_at: now + 2, prompt: 'p3', output: 'o3' }
        ];
        console.assert(runViewHeaderMeta(thread[0], thread).startsWith('3 runs · '), 'threadMeta: counts the whole thread');
        const spliced = [thread[0], thread[2]]; // r2 deleted — r3 reparented to r1
        console.assert(runViewHeaderMeta(spliced[0], spliced).startsWith('2 runs · '), 'threadMeta: recounts after the splice');
        console.log('OK: thread header meta recount');
    }

    // rootRunOf: root → itself, follow-up → its root_run_id, unknown/dangling
    // → null (silent node view). Pure, zero DOM.
    function checkRootRunOf() {
        const root = { id: 'r1', root_run_id: 'r1', created_at: 1 };
        const tip = { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', created_at: 2 };
        const logs = [root, tip];
        console.assert(rootRunOf('r1', logs) === 'r1', 'rootRunOf: root maps to itself');
        console.assert(rootRunOf('r2', logs) === 'r1', 'rootRunOf: follow-up maps to its root_run_id');
        console.assert(rootRunOf('nope', logs) === null, 'rootRunOf: unknown id → null');
        console.assert(rootRunOf('r1', []) === null, 'rootRunOf: empty logs → null');
        console.assert(rootRunOf('r2', [tip]) === null, 'rootRunOf: dangling root_run_id → null');
        console.log('OK: rootRunOf');
    }

    // Pending-run arrival, hermetic: seeds runsCache + the panel stub (no
    // fetch — loadLogs' network path is exactly what ISOLATED_RUN must not
    // need). Follow-up → thread at its ROOT + beacon on the tapped entry;
    // ghost id → node view + the one-line stale notice; closePanel clears it.
    function checkConsumePendingRunFocus() {
        const root = { id: 'r1', root_run_id: 'r1', status: 'failed', created_at: 1, prompt: 'p', output: 'boom' };
        const tip = { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', status: 'success', created_at: 2, prompt: 'p2', output: 'o', summary: 's' };
        runsCache = [root, tip];
        selectedId = 'n1';
        pendingRunFocus = 'r2';
        $('detail-panel-inner').innerHTML = runsSection({ id: 'n1', runnable: true }); // hermetic #runs-list
        console.assert(consumePendingRunFocus() === true, 'runFocus: follow-up consumed');
        console.assert(pendingRunFocus === null, 'runFocus: flag nulled on first use');
        console.assert(focusedRunId === 'r1', 'runFocus: thread opened at the ROOT run');
        console.assert($('detail-panel-inner').querySelector('.run-back-btn'), 'runFocus: thread view rendered');
        const row = document.querySelector('.run-log[data-run-id="r2"]');
        console.assert(row && row.classList.contains('beacon'), 'runFocus: tapped follow-up entry beacons');
        pendingRunFocus = 'ghost';
        console.assert(consumePendingRunFocus() === false, 'runFocus: ghost id not consumed');
        console.assert(staleDeepRun === true, 'runFocus: ghost id raises the stale notice');
        $('detail-panel-inner').innerHTML = runsSection({ id: 'n1', runnable: true }); // thread view replaced the stub — restub
        renderLogs(runsCache);
        console.assert($('runs-list').innerHTML.includes("isn't on this node anymore"), 'runFocus: stale notice renders above the runs list');
        console.assert($('runs-list').querySelectorAll('.run-log').length === 1, 'runFocus: runs list itself renders normally');
        closePanel();
        console.assert(staleDeepRun === false && pendingRunFocus === null && focusedRunId === null,
            'runFocus: closePanel clears the pending-run state');
        console.log('OK: consumePendingRunFocus');
    }

    // Opening a thread lands at its tip: focusRun must send the body to the
    // NEWEST turn — a conversation opens at its news, not its first message
    // — while the back button keeps focus. Pinned through a scrollTo spy:
    // the TARGET is the contract, not the glide (smooth scrolling is async
    // by design, and the suite must not depend on its timing). The spy also
    // shields engines without Element.scrollTo (the offline harness's jsdom).
    function checkThreadOpensAtTip() {
        const root = { id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o', summary: 's' };
        const tip = { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', status: 'success', took: 1, created_at: 2, prompt: 'p2', output: 'o2', summary: 's2' };
        runsCache = [root, tip];
        const proto = Element.prototype;
        const real = proto.scrollTo;
        let target = null;
        proto.scrollTo = function (opts) { // swallow the call: no glide, no side effects
            if (this.classList && this.classList.contains('detail-panel-body')) target = opts;
        };
        try { focusRun('r1'); }
        finally { if (real) proto.scrollTo = real; else delete proto.scrollTo; }
        const inner = $('detail-panel-inner');
        const body = inner.querySelector('.detail-panel-body');
        console.assert(focusedRunId === 'r1' && body, 'openTip: the thread view rendered');
        console.assert(target && target.top >= body.scrollHeight - 1, 'openTip: the body is sent to the newest turn');
        console.assert(document.activeElement === inner.querySelector('.run-back-btn'),
            'openTip: the back button keeps focus through the landing');
        closePanel();
        console.log('OK: opening a thread lands at its tip');
    }

    // scheduleRunFocus names its own ordering invariant: selectNode FIRST
    // (openPanel wipes focus state — the flag must survive it), flag AFTER.
    // A node deleted mid-flight opens nothing and sets nothing.
    function checkScheduleRunFocus() {
        nodes = [{ id: 'n1', parent_id: null, agent: 'a', prompt: 'p', status: 'success',
            took: 2, created_at: 1, summary: 's', mcp: '', mcp_requires_auth: false, mcp_auth_local: false, personas: [],
            active: true, name: 'x', runnable: true, runs: { total: 1, success: 1, failed: 0, active: 0 } }];
        closePanel(); // a known floor, independent of the checks before this one
        scheduleRunFocus('nope', 'r9');
        console.assert(selectedId === null && pendingRunFocus === null,
            'schedFocus: unknown node → no panel, no flag');
        scheduleRunFocus('n1', 'r9');
        console.assert(selectedId === 'n1', 'schedFocus: the node\'s panel opens (selectNode)');
        console.assert(pendingRunFocus === 'r9', 'schedFocus: the flag survives openPanel — set after');
        closePanel();
        console.assert(pendingRunFocus === null, 'schedFocus: closePanel clears a pending focus');
        console.log('OK: scheduleRunFocus');
    }

    // ── The dock (pinned panel footer) ──────────────────────────────────────
    // In thread mode the panel is a triad: header → scroll body → dock. The
    // composer lives in the dock — a flex sibling AFTER the body, inside
    // #detail-panel-inner (so blockedByTyping still guards it) but outside
    // the scroll body (so the 5s poll never rewrites it and reading never
    // moves it). checkFooterStructure renders its own hermetic thread (a
    // summarised tip → composer state); the three checks after it reuse it,
    // and checkFooterAbsentInNodeView reuses checkScheduleRunFocus's node panel.
    function checkFooterStructure() {
        const root = { id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o' };
        const tip = { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', status: 'success', took: 1, created_at: 2, prompt: 'p2', output: 'o2', summary: 's' };
        runsCache = [root, tip];
        focusedRunId = 'r1';
        enterThread(root);
        const inner = $('detail-panel-inner');
        const footer = inner.querySelector('.detail-panel-footer');
        const body = inner.querySelector('.detail-panel-body');
        console.assert(footer, 'dock: thread view renders the footer');
        console.assert(footer.parentElement === inner, 'dock: direct child of #detail-panel-inner (inside blockedByTyping\'s scope)');
        console.assert(footer.previousElementSibling === body, 'dock: flex sibling AFTER the scroll body');
        console.assert(body && body.contains($('thread-messages')), 'dock: the thread stays in the scroll body');
        const text = $('run-followup-text');
        console.assert(text && text.closest('.detail-panel-footer') === footer, 'dock: the composer lives in the dock');
        console.log('OK: dock structure (header → body → dock)');
    }

    // Pinned by layout, not by scroll math: scrolling the body must not move
    // the dock by a sub-pixel. The spacer guarantees the body CAN scroll, so
    // the assert cannot pass vacuously on a short thread.
    function checkFooterImmovable() {
        const inner = $('detail-panel-inner');
        const footer = inner.querySelector('.detail-panel-footer');
        const body = inner.querySelector('.detail-panel-body');
        const spacer = document.createElement('div');
        spacer.style.height = '4000px';
        body.appendChild(spacer);
        const top = footer.getBoundingClientRect().top;
        body.scrollTop = 60;
        console.assert(body.scrollTop === 60, 'dock: precondition — the body actually scrolled');
        console.assert(Math.abs(footer.getBoundingClientRect().top - top) < 0.5, 'dock: footer top invariant under body scroll');
        body.scrollTop = 0;
        spacer.remove();
        console.log('OK: dock immovable under body scroll');
    }

    // The dock is the terminus: the body's bottom fade must be suppressed
    // while it exists (fade + dock shadow would stack two depth devices,
    // and the fade's solid #16181f end fights workflow-log's lighter card).
    // fadeDisplay/pseudoStylesWork: strict in every browser — but engines
    // without pseudo-element computed styles (jsdom in the offline harness)
    // silently return the ELEMENT's style instead. The sentinel probe tells
    // the two apart, so the fade asserts skip rather than lie.
    function pseudoStylesWork() {
        const probe = document.createElement('div');
        const style = document.createElement('style');
        probe.id = 'pseudo-probe';
        style.textContent = '#pseudo-probe::after { display: table; }';
        document.head.appendChild(style);
        document.body.appendChild(probe);
        const ok = getComputedStyle(probe, '::after').display === 'table';
        probe.remove();
        style.remove();
        return ok;
    }

    function fadeDisplay(body) {
        return getComputedStyle(body, '::after').display;
    }

    function checkFooterFadeSuppressed() {
        const inner = $('detail-panel-inner');
        console.assert(inner.querySelector('.detail-panel-footer'), 'fade: precondition — the dock exists');
        console.assert(!pseudoStylesWork() || fadeDisplay(inner.querySelector('.detail-panel-body')) === 'none',
            'fade: suppressed while the dock exists');
        console.log('OK: bottom fade suppressed under the dock');
    }

    // The stream always keeps at least half the panel: the composer's
    // max-height cap holds (40vh in panel.css).
    function checkComposerCapped() {
        const cap = parseFloat(getComputedStyle($('run-followup-text')).maxHeight);
        console.assert(cap > 0 && cap <= window.innerHeight * 0.45, 'cap: composer max-height ≤ 45% of the viewport');
        console.log('OK: dock composer height capped');
    }

    // The exact regression this change fixes, pinned: ⌘↵ on the dock must
    // hand the caret back even when the submit self-guards on empty — an
    // empty-but-FOCUSED field still trips fieldHasTyping, so both the
    // submit's own loadLogs and the 5s poll would stall silently behind
    // blockedByTyping and only a reload would show the truth. Empty field
    // ⇒ submitFollowup returns before any POST: side-effect-free. The
    // grammar itself (default prevented, one submit, plain Enter inert)
    // is pinned by panel.js's own check of the shared helper.
    function checkCmdEnterDockEscape() {
        const root = { id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o', summary: 's' };
        runsCache = [root];
        focusedRunId = 'r1';
        enterThread(root); // hermetic thread — the composer + its bindings render with it
        const text = $('run-followup-text');
        text.focus();
        text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
        console.assert(document.activeElement !== text, 'cmdDock: focus leaves the field on ⌘↵ — the blur is the fix');
        console.assert(fieldHasTyping(text) === false, 'cmdDock: a submitted empty field escapes the typing gate');
        console.assert(!$('error-banner').classList.contains('show'), 'cmdDock: empty submit self-guards — no error banner');
        closePanel();
        console.log('OK: ⌘↵ dock escape (blur before submit)');
    }

    // The modal's ⌘↵ is run-mode only: run + empty text self-guards (the
    // modal stays open, no run), insert/child modes no-op (a runner must
    // be picked — the hint teaches it; firing a hidden default would be).
    // The binding lives at module scope next to #composer-text's input
    // listener, so it can only ever be singular. Empty field ⇒ no POST.
    function checkComposerCmdEnterModes() {
        nodes = [{ id: 'n1', parent_id: null, agent: 'codex', prompt: 'p', status: 'success', created_at: 1 }];
        openRunComposer('n1');
        $('composer-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
        console.assert($('composer').classList.contains('open') && composerMode === 'run',
            'cmdModal: run mode + empty text self-guards — modal stays, no run');
        openInsert('n1');
        $('composer-text').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
        console.assert(composerMode === 'insert' && $('composer').classList.contains('open'),
            'cmdModal: choice modes no-op — a runner must be picked first');
        closeComposer();
        closePanel();
        console.log('OK: modal ⌘↵ (run submits, choice modes wait)');
    }

    // Node view: no dock at all — no gap, no second hairline — and the
    // body's fade returns. Runs on the node panel checkScheduleRunFocus left
    // behind (closePanel closes it but leaves its DOM in place).
    function checkFooterAbsentInNodeView() {
        const inner = $('detail-panel-inner');
        console.assert(!inner.querySelector('.detail-panel-footer'), 'nodeView: no dock rendered');
        console.assert(!pseudoStylesWork() || fadeDisplay(inner.querySelector('.detail-panel-body')) !== 'none',
            'nodeView: bottom fade back');
        console.log('OK: node view has no dock');
    }

    function checkClampPanelWidth() {
        const clamp = OpenLoopPanel.clampPanelWidth;
        console.assert(clamp(9999, 375)  <= 375,  'clamp: 375px phone must never overflow');
        console.assert(clamp(9999, 1280) === 960, 'clamp: desktop 75% cap');
        console.assert(clamp(200,  300)  === 300, 'clamp: floor never exceeds a tiny viewport');
        console.log('OK: clampPanelWidth (shared panel.js)');
    }

    // The line gate, measured through the shared module (the char threshold
    // is gone): explicit \n breaks make the painted line count deterministic
    // at any probe width. ≤ 10 free, ≥ 11 folded at 3 + the door offered.
    // jsdom has no layout engine — skip, don't fake (fadeDisplay convention).
    function checkRenderBubbleTruncation() {
        if (!OpenLoopBubble.layoutWorks()) {
            console.log('OK: bubble line gate (skipped — no layout engine)');
            return;
        }
        const host = document.createElement('div');
        host.style.cssText = 'width:360px;position:fixed;top:0;left:0';
        document.body.appendChild(host);
        [[2, false], [10, false], [11, true], [40, true]].forEach(([n, fold]) => {
            host.innerHTML = OpenLoopBubble.bubbleHtml('output', probeLines(n));
            OpenLoopBubble.gateBubbles(host);
            const text = host.querySelector('.wl-bubble-text');
            const door = host.querySelector('.wl-expand-btn');
            console.assert(text.classList.contains('truncated') === fold,
                'bubble: ' + n + ' lines → ' + (fold ? 'folded' : 'free'));
            console.assert(door && door.hidden === !fold,
                'bubble: ' + n + ' lines → door ' + (fold ? 'shown' : 'hidden'));
        });
        host.remove();
        console.log('OK: bubble line gate (≤10 free · >10 folds at 3)');
    }

    function probeLines(n) {
        return Array.from({ length: n }, (_, i) => 'line ' + (i + 1)).join('\n');
    }

    function checkAddRootPinned() {
        const btn = $('add-root');
        console.assert(btn && document.body.contains(btn), 'add-root: static body-level DOM');
        console.assert(btn && !$('graph-grid').contains(btn), 'add-root: outside the 5s re-render');
        console.assert(btn && !btn.classList.contains('be-toggle'), 'add-root: never disabled on empty graph');
        console.assert(btn && getComputedStyle(btn).position === 'fixed', 'add-root: pinned fixed');
        checkAddRootRenders();
        console.log('OK: add-root pinned top-left');
    }

    function checkAddRootRenders() {
        const btn = $('add-root');
        nodes = []; renderGrid();
        console.assert(btn && !btn.disabled, 'add-root: enabled on empty render');
        nodes = [{ id: 'k', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 0 }];
        renderGrid();
        btn.click();
        console.assert($('composer').classList.contains('open'), 'add-root: click opens composer');
        closeComposer();
        console.log('OK: add-root render + click');
    }

    // Names are per-cell: every named node — root, child, deep descendant —
    // renders exactly one .node-title, card-bounded so neighbours cannot
    // collide by construction; unnamed cells render nothing.
    function checkNodeTitleEveryCard() {
        nodes = [
            { id: 't1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'Root description words' },
            { id: 't2', parent_id: 't1', agent: 'a', prompt: 'p', status: 'success', created_at: 2, name: 'Child description words' },
            { id: 't3', parent_id: 't2', agent: 'a', prompt: 'p', status: 'success', created_at: 3, name: 'Deep description words' },
            { id: 't4', parent_id: 't1', agent: 'a', prompt: 'p', status: 'success', created_at: 4 }];
        renderGrid();
        const titles = [...document.querySelectorAll('.node-title')];
        console.assert(titles.length === 3, 'nodeTitle: one per named cell — root, child AND deep descendant');
        console.assert(titles.every(t => t.closest('.node-cell').firstElementChild === t), 'nodeTitle: first child of its cell (before .node-slot)');
        console.assert(titles.every(t => t.title === t.textContent), 'nodeTitle: tooltip carries the full name');
        console.assert(titles.every(t => t.offsetWidth <= 241), 'nodeTitle: card-bounded (≤240px) — neighbours cannot collide');
        console.assert(!$('graph-grid').querySelector('.node-name'), 'nodeTitle: legacy .node-name gone from the grid');
        console.log('OK: node title on every named card');
    }

    // Two long-named neighbours: rect proof that reserved-flow titles never
    // touch, and the leftmost title never clips left of the grid origin.
    function checkNeighborTitlesClear() {
        nodes = [
            { id: 'a1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'x'.repeat(300) },
            { id: 'a2', parent_id: 'a1', agent: 'a', prompt: 'p', status: 'success', created_at: 2, name: 'y'.repeat(300) }];
        renderGrid();
        const rects = [...document.querySelectorAll('.node-title')].map(t => t.getBoundingClientRect());
        console.assert(rects.length === 2 && rects[0].right <= rects[1].left + 0.5, 'neighborTitles: adjacent named cells keep a clear gap');
        const grid = $('graph-grid').getBoundingClientRect();
        console.assert(rects.every(r => r.left >= grid.left - 0.5), 'neighborTitles: no title clips left of the grid at scroll origin');
        console.log('OK: neighbour titles clear');
    }

    function checkInsertBtnStillCentered() {
        if (!document.querySelector('.node-cell')) renderGrid();
        const btn = document.querySelector('.node-slot .node-insert-btn');
        const slot = btn.closest('.node-slot');
        // offsetTop ignores the translateY(-50%), so the visual center sits AT it
        console.assert(Math.abs(btn.offsetTop - slot.offsetHeight / 2) < 1, 'insertBtn: the + stays dead-center despite the title above');
        console.log('OK: insert button centered');
    }

    // The right-side + exists only where a child may fork: loading
    // (progress/summarizing) and errored (failed) cells render none; answered
    // and success cells do, and their + still opens the composer.
    function checkAddChildReadiness() {
        const base = { agent: 'a', prompt: 'p', created_at: 1 };
        nodes = ['progress', 'summarizing', 'failed', 'answered', 'success'].map((s, i) => ({
            ...base, id: 'f' + i, parent_id: null, status: s }));
        renderGrid();
        const plus = id => document.querySelector(`.node-card[data-id="${id}"] .node-add-child`);
        console.assert(['f0', 'f1', 'f2'].every(id => !plus(id)), 'addChild: no + on loading/errored cells');
        console.assert(plus('f3') && plus('f4'), 'addChild: + renders on answered and success cells');
        plus('f4').click();
        console.assert($('composer').classList.contains('open'), 'addChild: a ready + still opens the composer');
        closeComposer();
        console.log('OK: add-child gated by readiness');
    }

    function checkEdgesStillDrawn() {
        const paths = document.querySelectorAll('#edge-layer path').length;
        console.assert(paths === nodes.length - rootNodes().length, 'edges: re-measured paths === nodes − roots');
        console.log('OK: edges drawn after title shift');
    }

    // The cascade fixture: the 300-char spine name drives the wrap case; b3 is the unnamed tail.
    function beCascadeNodes() {
        return [
            { id: 'b1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'x'.repeat(300) },
            { id: 'b2', parent_id: 'b1', agent: 'a', prompt: 'p', status: 'progress', created_at: 2, name: 'second cell note' },
            { id: 'b5', parent_id: 'b2', agent: 'a', prompt: 'p', status: 'success', created_at: 5, name: 'tail note' },
            { id: 'b3', parent_id: 'b1', agent: 'a', prompt: 'p', status: 'success', created_at: 3 },
            { id: 'b4', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 4, name: 'other chain note' }];
    }

    // One caption row per named cell, flowing after the rail in segment order;
    // rows stack (block flow — rect-proofed), row i pins to its cell's dot,
    // measured chain-relative (the wrapper carries the branch indent), wraps
    // instead of clipping. Geometry is viewport-aware: 48/16px desktop, 40/12px ≤768px.
    function checkBeCaptionCascade() {
        renderBeFixture(beCascadeNodes());
        const rows = assertCascadeRows();
        assertCascadeStackAndGrammar(rows);
        assertCascadePins(rows, beGeom());
        assertCascadeWraps();
        document.body.classList.remove('birds-eye');
        console.log('OK: birds-eye caption cascade');
    }

    // Hidden hosts measure 0 — #birds-eye must be visible while a check measures it.
    function renderBeFixture(fixtureNodes, persona) {
        if (persona) personaIndex.set(persona.id, persona);
        nodes = fixtureNodes;
        document.body.classList.add('birds-eye');
        renderBirdsEye();
    }

    function beChains() {
        return [...document.querySelectorAll('.be-chain')];
    }

    function assertCascadeRows() {
        const chains = beChains();
        console.assert(chains.length === 4, 'beCaptions: one chain per segment — spine [b1], forked tails, root [b4]');
        const tail = chains[1]; // [b2,b5] — the indented chain owning two rows
        console.assert(tail.querySelector('.be-lane').nextElementSibling.classList.contains('be-captions'),
            'beCaptions: cascade flows after the rail');
        const rows = [...tail.querySelectorAll('.be-caption')];
        console.assert(rows.length === 2, 'beCaptions: one row per NAMED cell — unnamed renders none');
        return rows;
    }

    function assertCascadeStackAndGrammar(rows) {
        const rr = rows.map(r => r.getBoundingClientRect());
        console.assert(rr[0].bottom <= rr[1].top + 0.5, 'beCaptions: rows stack one under another — never overlap');
        console.assert(rows.every(r => r.classList.contains('clamp-10')), 'beCaptions: clamp-10 guards runaway height');
        console.assert(rows.every(r => r.title === r.textContent), 'beCaptions: tooltip carries the full name');
    }

    // offsetLeft, not rects: the be-enter animation starts at scale(1.02),
    // and getBoundingClientRect would measure that mid-flight transform
    function assertCascadePins(rows, m) {
        const lane = rows[0].closest('.be-chain').querySelector('.be-lane');
        console.assert(Math.abs(rows[0].offsetLeft - (lane.offsetLeft + m.dotLeft)) <= 1, `beCaptions: row 0 pins to cell 0 dot (${m.slot}·0+${m.dotLeft})`);
        console.assert(Math.abs(rows[1].offsetLeft - (lane.offsetLeft + m.slot + m.dotLeft)) <= 1, `beCaptions: row 1 one slot deeper (${m.slot}·1+${m.dotLeft})`);
    }

    function assertCascadeWraps() {
        const wide = document.querySelector('.be-chain .be-caption'); // the spine's 300-char row
        console.assert(wide.offsetHeight > 16, 'beCaptions: a 300-char name wraps — no cut-off');
        console.assert(wide.getBoundingClientRect().width >= 150, 'beCaptions: rows span the full remaining width');
    }

    function beGeom() { // {slot, dotLeft, cap} — mirrors the #birds-eye CSS vars (graph.html)
        return window.matchMedia('(max-width: 768px)').matches
            ? { slot: 40, dotLeft: 12, cap: '160px' }
            : { slot: 48, dotLeft: 16, cap: '192px' };
    }

    // The caption bubble wears its cell's status hue: border/bg/dot agree —
    // parsed channel-wise so the check survives color-string formatting.
    function checkBeCaptionColors() {
        document.body.classList.add('birds-eye');
        renderBirdsEye();
        const rows = [...document.querySelectorAll('.be-caption')];
        const successRow = rows.find(r => r.classList.contains('success'));
        const progressRow = rows.find(r => r.classList.contains('progress'));
        console.assert(successRow && progressRow, 'beColors: rows carry their cell status class');
        console.assert(channelsOf(successRow, 'borderTopColor') === '52,199,89', 'beColors: success border = accent-green');
        console.assert(channelsOf(progressRow, 'borderTopColor') === '245,158,11', 'beColors: progress border = accent-amber');
        const dot = document.querySelector('.be-dot.success');
        console.assert(dot && channelsOf(dot, 'backgroundColor') === channelsOf(successRow, 'borderTopColor'),
            'beColors: caption border shares the dot hue');
        document.body.classList.remove('birds-eye');
        console.log('OK: birds-eye caption colors');
    }

    function channelsOf(el, prop) {
        const m = getComputedStyle(el)[prop].match(/[\d.]+/g) || [];
        return m.slice(0, 3).join(',');
    }

    // Deep chains: the indent caps so far and no further — the 10th cell's
    // row keeps ≥ half the lane width for its text.
    function checkBeDeepChainIndent() {
        nodes = Array.from({ length: 10 }, (_, i) => ({
            id: 'd' + i, parent_id: i ? 'd' + (i - 1) : null, agent: 'a', prompt: 'p',
            status: 'success', created_at: i + 1, name: 'deep ' + i + ' — ' + 'w'.repeat(120)
        }));
        const cap = beGeom().cap;
        document.body.classList.add('birds-eye');
        renderBirdsEye();
        const rows = [...document.querySelectorAll('.be-caption')];
        const last = rows[rows.length - 1];
        console.assert(rows.length === 10 && getComputedStyle(last).marginLeft === cap,
            `beDeep: indent caps at ${cap} — geometry stops early, text keeps the row`);
        console.assert(last.offsetWidth >= 100, 'beDeep: capped row still spans a readable width');
        document.body.classList.remove('birds-eye');
        console.log('OK: deep-chain indent cap');
    }

    function checkBeNoNamesUnchanged() {
        nodes = nodes.map(n => ({ ...n, name: null }));
        renderBirdsEye();
        console.assert(!document.querySelector('.be-captions'), 'beNoNames: zero names → zero caption blocks (rails pixel-identical)');
        console.log('OK: birds-eye unchanged without names');
    }

    // The fork fixture: root r1 forks into c1 (which forks again) and c2.
    function beForkNodes() {
        return [
            { id: 'r1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'fork root' },
            { id: 'c1', parent_id: 'r1', agent: 'a', prompt: 'p', status: 'progress', created_at: 2 },
            { id: 'c2', parent_id: 'r1', agent: 'a', prompt: 'p', status: 'success', created_at: 3, personas: ['p1'] },
            { id: 'g1', parent_id: 'c1', agent: 'a', prompt: 'p', status: 'success', created_at: 4, personas: ['p1'], name: 'leaf g1' },
            { id: 'g2', parent_id: 'c1', agent: 'a', prompt: 'p', status: 'success', created_at: 5, name: 'tail head' },
            { id: 'h1', parent_id: 'g2', agent: 'a', prompt: 'p', status: 'success', created_at: 6, personas: ['p1'], name: 'tail leaf' }];
    }

    // The pinned regression for spine & branch — each invariant lives in its assert message below.
    function checkBeForkNoDuplicates() {
        renderBeFixture(beForkNodes(), { id: 'p1', name: 'Ann' });
        const chains = beChains();
        assertForkDotsOnce(chains);
        assertForkIndents(chains, beGeom());
        assertForkTrails(chains);
        assertForkCaptionPins(beGeom());
        assertForkRerenderStable();
        document.body.classList.remove('birds-eye');
        console.log('OK: fork graph renders each node exactly once');
    }

    function assertForkDotsOnce(chains) {
        const ids = chains.flatMap(c => [...c.querySelectorAll('.be-dot')].map(d => d.dataset.id));
        console.assert(ids.length === 6 && new Set(ids).size === 6, 'beFork: every node id renders in exactly one dot');
    }

    function assertForkIndents(chains, m) {
        const rel = c => c.offsetLeft - chains[0].offsetLeft; // vs the un-indented spine
        const expect = [0, 1, 2, 2, 1]; // [r1] [c1] [g1] [g2,h1] [c2]
        console.assert(chains.length === expect.length &&
            chains.every((c, i) => Math.abs(rel(c) - expect[i] * m.slot) <= 1),
            'beFork: a branch chain indents by indent × slot — dots stay in depth columns');
    }

    function assertForkTrails(chains) {
        console.assert(chains.slice(0, 2).every(c => c.querySelector('.be-slot.last') && !c.querySelector('.be-trail')),
            'beFork: a spine ends AT its fork — last slot, no trail');
        console.assert(chains.slice(2).every(c => c.querySelector('.be-trail')),
            'beFork: a leaf segment carries its persona trail');
    }

    function assertForkCaptionPins(m) {
        const tail = document.querySelectorAll('.be-chain')[3]; // [g2, h1] — two named cells at indent 2
        console.assert(tail.innerHTML.includes('style="--i:0"') && tail.innerHTML.includes('style="--i:1"'),
            'beFork: caption --i is segment-relative — the wrapper carries the indent');
        console.assert(Math.abs(tail.querySelector('.be-caption').offsetLeft - (tail.querySelector('.be-lane').offsetLeft + m.dotLeft)) <= 1,
            'beFork: a branch caption pins under its own dot — indent never double-counted');
    }

    function assertForkRerenderStable() {
        const once = $('birds-eye').innerHTML;
        renderBirdsEye();
        console.assert($('birds-eye').innerHTML === once, 'beFork: re-render is order-stable (poll never shuffles lanes)');
    }

    // Every named cell's dot tooltip leads with the name; unnamed cells
    // render no empty name token.
    function checkDotTooltipNames() {
        const base = { id: 'c1', parent_id: 'x', agent: 'codex', prompt: 'p', status: 'success', took: 3, created_at: 1 };
        console.assert(dotLabel({ ...base, name: 'child note' }).startsWith('child note · '), 'dotTooltip: a named child leads with its name');
        console.assert(!dotLabel({ ...base }).includes('undefined'), 'dotTooltip: unnamed cell renders no empty name token');
        console.log('OK: dot tooltip names');
    }

    // NAME section on every node: non-roots included, textarea for long
    // descriptions, no maxlength, label/hint speak the per-cell surfaces.
    function checkNameInputEveryNode() {
        const child = { id: 'n2', parent_id: 'n1', agent: 'a', prompt: 'p', status: 'success', created_at: 2, name: 'x' };
        const html = nameSection(child);
        console.assert(html.includes('name-input'), 'nameInput: a non-root renders the section');
        console.assert(html.includes('<textarea'), 'nameInput: a growing textarea — descriptions are the use case');
        console.assert(!html.includes('maxlength'), 'nameInput: no cap');
        console.assert(html.includes('>NAME<'), 'nameInput: label reads NAME');
        console.assert(html.includes('above this card'), 'nameInput: hint names both surfaces');
        console.log('OK: name input on every node');
    }

    // Text→field conversions open a 7-line canvas: rows="7" breathes with the
    // mobile 16px font (a fixed px height would not) and outruns the CSS
    // min-height floors, which stay as inert guards. The field self-describes
    // via aria-label — the section label is a styled div, invisible to
    // assistive tech. One grammar across the editor sites on both pages; the
    // dock composer is deliberately NOT one of them (checkEditFieldExclusions).
    function checkEditFieldGrammar() {
        const n = { id: 'n1', prompt: 'p', summary: 's' };
        [editPromptHtml(n), summaryEditHtml(n), runSummaryEditHtml(n)]
            .forEach(h => console.assert(h.includes('rows="7"'), 'editFields: 7 rows'));
        console.assert(editPromptHtml(n).includes('aria-label="Edit prompt"'), 'editFields: prompt self-describes');
        [summaryEditHtml(n), runSummaryEditHtml(n)]
            .forEach(h => console.assert(h.includes('aria-label="Edit summary"'), 'editFields: summary self-describes'));
        console.assert(followupComposerHtml().includes('aria-label="Continue conversation"'), 'editFields: composer self-describes');
        console.assert(runSummaryEditHtml({ summary: null }).includes('Write a summary to allow follow-ups'),
            'editFields: the empty Add state teaches, in the hint copy\'s own words');
        console.log('OK: edit fields default to 7 rows');
    }

    // Deliberate exclusions, pinned so nobody "fixes" them later: the name
    // field is an auto-growing rows=1 (a different creature), the modal
    // composer has its own centered pose, .mcp-row inputs are single-line,
    // and the dock composer is a compact rows=3 capsule — a 7-row canvas
    // would eat the pinned dock it lives in.
    function checkEditFieldExclusions() {
        console.assert(nameSection({ name: 'x' }).includes('rows="1"'),
            'exclusions: name field stays autosize rows=1');
        console.assert($('composer-text').rows === 2,
            'exclusions: modal composer untouched (default rows)');
        const dock = followupComposerHtml();
        console.assert(dock.includes('rows="3"'), 'exclusions: dock composer stays compact rows=3');
        console.assert(dock.includes('composer-send'), 'exclusions: dock composer sends via the icon circle');
        console.log('OK: edit field exclusions untouched');
    }

    // MCP auth is write-only: the panel never echoes a stored key, it shows
    // state. Three truths: set here (ok line + Clear), configured-but-
    // missing (warn — the fresh-clone case), nothing (silence — many MCPs
    // need no auth). No URL, no auth row at all.
    function checkMcpAuthSection() {
        const url = { mcp: 'https://mcp.example' };
        const set = mcpAuthSection({ ...url, mcp_auth_local: true, mcp_requires_auth: true });
        console.assert(set.includes('set on this computer'), 'mcpAuth: local key → calm ok line');
        console.assert(set.includes('mcp-auth-clear'), 'mcpAuth: Clear appears only when a key is stored');
        console.assert(set.includes('value=""'), 'mcpAuth: the field never carries a stored key');
        const missing = mcpAuthSection({ ...url, mcp_auth_local: false, mcp_requires_auth: true });
        console.assert(missing.includes('mcp-auth-state warn'), 'mcpAuth: fresh clone warns');
        console.assert(missing.includes('missing on this computer'), 'mcpAuth: the warning says which computer');
        console.assert(!missing.includes('mcp-auth-clear'), 'mcpAuth: nothing to Clear when no key is stored here');
        const none = mcpAuthSection({ ...url, mcp_auth_local: false, mcp_requires_auth: false });
        console.assert(!none.includes('mcp-auth-state'), 'mcpAuth: no state line when no key is configured');
        console.assert(!mcpSection({ mcp: '', mcp_auth_local: false, mcp_requires_auth: false }).includes('mcp-auth-input'),
            'mcpAuth: no auth row without an MCP URL');
        console.log('OK: mcp auth section states');
    }

    // The cell itself announces a missing key — no tapping required to find
    // out: the card carries data-mcp-auth="missing" (amber header tint via
    // CSS), the bird's-eye dot wears the dashed halo, and the header warning
    // counts exactly the missing cells (hidden at zero). A set key and an
    // unconfigured MCP both leave the card unmarked.
    function checkMcpAuthCellIndication() {
        const base = { parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1 };
        nodes = [
            { ...base, id: 'set', mcp: 'https://one', mcp_requires_auth: true, mcp_auth_local: true },
            { ...base, id: 'gone', mcp: 'https://two', mcp_requires_auth: true, mcp_auth_local: false },
            { ...base, id: 'none', mcp: 'https://three', mcp_requires_auth: false, mcp_auth_local: false }];
        render();
        console.assert(document.querySelector('.node-card[data-id="gone"][data-mcp-auth="missing"]'),
            'mcpCell: the missing cell carries the marker');
        console.assert(!document.querySelector('.node-card[data-id="set"][data-mcp-auth]'),
            'mcpCell: a set key leaves the card unmarked');
        console.assert(!document.querySelector('.node-card[data-id="none"][data-mcp-auth]'),
            'mcpCell: an unconfigured MCP leaves the card unmarked');
        const warn = $('mcp-auth-warn');
        console.assert(warn && !warn.hidden && warn.querySelector('.gt-warn-count').textContent === '1',
            'mcpCell: the header warning counts exactly the missing cells');
        document.body.classList.add('birds-eye');
        renderBirdsEye();
        console.assert(document.querySelector('.be-dot.mcp-missing'), 'mcpCell: the bird\'s-eye dot wears the dashed halo');
        document.body.classList.remove('birds-eye');
        nodes = [];
        render();
        console.assert($('mcp-auth-warn').hidden, 'mcpCell: zero missing → warning hidden');
        console.log('OK: mcp auth cell indication');
    }

    // AGENT section on every node: composer pill grammar at the panel bottom —
    // the current agent selected + inert, the others clickable, the whole
    // picker locked while the node runs, and an agent gone from the server
    // still rendered so the current fact stays visible.
    function checkAgentSectionEveryNode() {
        const saved = agents;
        agents = ['codex', 'cc_docker', 'mistral-vibe'];
        const base = { id: 'n2', parent_id: 'n1', prompt: 'p', created_at: 2 };
        const html = agentSection({ ...base, agent: 'codex', status: 'success' });
        console.assert(html.includes('>AGENT<'), 'agentSection: label reads AGENT');
        console.assert(html.includes('class="agent-btn selected" data-agent="codex" aria-pressed="true" disabled'),
            'agentSection: current agent selected, pressed and inert');
        console.assert(html.includes('class="agent-btn" data-agent="cc_docker" aria-pressed="false">'),
            'agentSection: other agents offered, clickable');
        console.assert(html.includes('next run'), 'agentSection: hint names what the switch affects');
        const running = agentSection({ ...base, agent: 'codex', status: 'progress' });
        console.assert(running.includes('data-agent="mistral-vibe" aria-pressed="false" disabled'),
            'agentSection: a running node locks the whole picker');
        console.assert(running.includes('unlocks when the run finishes'), 'agentSection: locked hint explains itself');
        const gone = agentSection({ ...base, agent: 'legacy', status: 'success' });
        console.assert(gone.includes('data-agent="legacy"'), 'agentSection: an agent gone from the server still renders');
        agents = [];
        console.assert(agentSection({ ...base, agent: 'codex', status: 'success' }).includes('summary-missing'),
            'agentSection: no agents on the server → muted line, not a broken picker');
        agents = saved;
        console.log('OK: agent section on every node');
    }

    function checkClampGrammar() {
        const probe = document.createElement('div');
        probe.className = 'clamp-10';
        probe.textContent = 'x';
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe);
        console.assert(cs.webkitLineClamp === '10', 'clamp10: ten lines');
        console.assert(cs.webkitBoxOrient === 'vertical' && cs.overflow === 'hidden', 'clamp10: vertical box, hidden tail');
        probe.remove();
        console.log('OK: clamp-10 utility');
    }

    $('composer-text').addEventListener('input', e => {
        const ready = e.target.value.trim().length > 0;
        // scoped to the composer: the panel's AGENT pills share .agent-btn and
        // own their disabled state (current agent / running lock)
        $('composer-agents').querySelectorAll('.agent-btn').forEach(b => { b.disabled = !ready; });
    });

    // ⌘↵ on the modal, bound EXACTLY ONCE at module scope — #composer-text
    // is static body-level DOM (graph.html) and a per-showComposer bind
    // would stack one listener per open (the add-root comment two blocks
    // down is the same rule). composerCmdEnter self-guards on mode.
    OpenLoopPanel.bindCmdEnterSubmit($('composer-text'), composerCmdEnter);

    $('composer-cancel').addEventListener('click', closeComposer);
    $('composer-mcp-toggle').addEventListener('click', () => {
        $('composer-mcp').classList.toggle('open');
    });

    document.querySelectorAll('.be-toggle').forEach(btn =>
        btn.addEventListener('click', () =>
            setMode(viewMode === 'birds' ? 'normal' : 'birds')));

    // body-level static element: bind EXACTLY ONCE — a per-render binding here
    // would stack one listener per 5s refresh (double-open composer)
    $('add-root').addEventListener('click', () => {
        attractPlayed = true; // the pulse never returns once the door is used
        $('add-root').classList.remove('attract');
        openComposer(null);
    });

    // toolbar warning → the first cell still waiting on its key: same
    // arrival as a bird's-eye tap (mode reset, panel open, scroll, beacon)
    $('mcp-auth-warn').addEventListener('click', () => {
        const first = nodes.find(mcpAuthMissing);
        if (first) focusFromBirds(first.id);
    });

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if ($('composer').classList.contains('open')) return closeComposer();
        if (disarmDelete()) return; // first Esc disarms an armed delete, only then other Escape behavior
        if (focusedRunId) return backToNode();
        if (viewMode === 'birds') setMode('normal');
    });

    if (!instanceParam) {
        showError('Missing ?instance= parameter');
    } else {
        (async () => {
            if (ISOLATED_RUN) { runSanityChecks(); return; }
            // One door listener for panel + cells + threads (capture-phase
            // delegation — see bubble.js: a cell's door must open the fold,
            // not the panel).
            OpenLoopBubble.bindExpand();
            // One copy listener, same contract: bubble.js renders the copy
            // button, so it owns the tap — including the execCommand fallback
            // for insecure origins and every re-rendered/swapped-in bubble.
            OpenLoopBubble.bindCopy(null, showError);
            bindCanvasDismiss();
            // Panel physics (clamp, drag, mobile sheet) live in panel.js,
            // shared with workflow-log.html. Shared width memory:
            // localStorage['openloop-panel-w'] is a contract with that page —
            // both pages run the identical clamp.
            OpenLoopPanel.initPanelResize();
            // Width and webfont arrival both change how many lines a text
            // paints — re-gate once geometry settles (never mid-drag).
            document.addEventListener('openloop:panel-resized', regateBubbles);
            if (document.fonts?.ready) document.fonts.ready.then(regateBubbles);
            let resizeTimer = null; // rotation: panel is 100vw on mobile
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(regateBubbles, 150);
            });
            if (localStorage.getItem('openloop-birds-eye') === 'birds') setMode('birds');
            await loadAgents();
            await loadInstances();
            await load();
            const params = new URLSearchParams(location.search);
            focusFromDeepLink(params.get('node'), params.get('run'));
            setInterval(load, 5000);
            startCountdown();
        })();
    }

    // Open the node's panel and focus runId's thread once its logs land — the
    // same arrival path as the notifications deep link. Flag goes AFTER
    // selectNode: openPanel wipes focus state, and closePanel clears the flag.
    function scheduleRunFocus(nodeId, runId) {
        if (!nodes.some(n => n.id === nodeId)) return; // deleted mid-flight: no panel, no flag
        selectNode(nodeId);
        pendingRunFocus = runId; // consumed in loadLogs → consumePendingRunFocus
    }

    // Deep link from notifications.html (?node=<id>&run=<run id>): focus the
    // node's cell, open its right panel and — when &run= is present — open
    // that run's conversation once its logs arrive (consumePendingRunFocus in
    // loadLogs). Silent fallback if the node (or the run) no longer exists;
    // a run without a valid node is ignored — runs are reached via their node.
    function focusFromDeepLink(id, runId) {
        if (!id || !nodes.some(n => n.id === id)) return;
        pendingRunFocus = runId || null;
        focusFromBirds(id);
    }
})();
