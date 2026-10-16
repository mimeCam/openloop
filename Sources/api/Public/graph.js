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

    function renderChain(chain) {
        const crumbs = chain.map((p, i) => {
            const name = p.split('/').filter(Boolean).pop() || p;
            const cls = i === chain.length - 1 ? 'crumb cur' : 'crumb';
            return `<span class="${cls}" title="${esc(p)}">${esc(name)}</span>`;
        });
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
    // (delete bridges children up; orphans re-root). Columns, card names and
    // the panel's CHAIN NAME section all read from these two helpers.
    function rootNodes() {
        const ids = new Set(nodes.map(n => n.id));
        return nodes.filter(n => !n.parent_id || !ids.has(n.parent_id));
    }

    function isRoot(n) {
        return rootNodes().some(r => r.id === n.id);
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
    // One lane per root→leaf chain, ordered by root creation time so lanes
    // keep their vertical position across refreshes; connectors are pure CSS; dot tap → focusFromBirds.

    function nodeIndex(nodes) {
        return new Map(nodes.map(n => [n.id, n]));
    }

    function chainsFrom(nodes) {
        const byId = nodeIndex(nodes);
        const parents = new Set(nodes.map(n => n.parent_id).filter(Boolean));
        const leaves = nodes.filter(n => !parents.has(n.id));
        return leaves.map(l => chainUp(l, byId)).sort(laneOrder);
    }

    function laneOrder(a, b) {
        return a[0].created_at - b[0].created_at || String(a[0].id).localeCompare(String(b[0].id));
    }

    function chainUp(node, byId) {
        const chain = [];
        const seen = new Set();
        let cur = node;
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            chain.unshift(cur);
            cur = byId.get(cur.parent_id);
        }
        return chain;
    }

    function render() {
        const out = viewMode === 'birds' ? renderBirdsEye() : renderGrid();
        syncAddRootAttract();
        return out;
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
        const cols = buildColumns();
        const roots = new Set(rootNodes().map(n => n.id));
        const hint = nodes.length ? '' : `<span id="empty-hint">${emptyHint()}</span>`;
        grid.innerHTML = `<svg id="edge-layer"></svg>` + hint +
            cols.map(col => `<div class="depth-col">${col.map(n => nodeCell(n, roots.has(n.id))).join('')}</div>`).join('');
        bindGraph(grid);
        drawEdges();
        syncBirdsToggle();
    }

    function renderBirdsEye() {
        const host = $('birds-eye');
        const hasNames = nodes.some(n => n.name); // no names → no label text → pixel-identical
        host.innerHTML = nodes.length
            ? chainsFrom(nodes).map((c, i, all) => laneHtml(c, hasNames, i ? all[i - 1][0].id : null)).join('')
            : `<span id="empty-hint">${emptyHint()}</span>`;
        syncBirdsToggle();
        bindBirdsEye(host);
        syncBeLabelHeights(host);
    }

    // Labels wrap now, so one tall name must not shift its lane's dot rail off
    // the shared horizontal grid: measure the tallest strip, apply to all.
    // Runs on every render (the 5s refresh rewrites innerHTML) — nothing to sync.
    function syncBeLabelHeights(host) {
        const strips = host.querySelectorAll('.be-chain-label');
        if (!strips.length) return;
        const max = Math.max(...[...strips].map(s => s.offsetHeight));
        strips.forEach(s => { s.style.minHeight = max + 'px'; });
    }

    function emptyHint() {
        return emptiedByDelete
            ? 'All nodes deleted — tap + to start fresh'
            : 'no runs yet — tap + to start';
    }

    function laneHtml(chain, hasNames, prevRootId) {
        const last = chain.length - 1;
        return `<div class="be-chain">` + chainLabelHtml(chain, hasNames, prevRootId) +
            `<div class="be-lane">` +
            chain.map((n, i) => slotHtml(n, chain[i + 1], i === last, i === 0)).join('') +
            personaTrail(chain[last]) + `</div></div>`;
    }

    // One label per root, not per lane: a braided root emits the name over its
    // first lane only (lanes of one root are adjacent — laneOrder sorts by
    // root created_at). Unnamed and deduped lanes keep an empty strip so every
    // dot rail stays on the same horizontal grid.
    function chainLabelHtml(chain, hasNames, prevRootId) {
        const name = chain[0].name;
        if (!hasNames || !name || chain[0].id === prevRootId) return '<div class="be-chain-label"></div>';
        return `<div class="be-chain-label clamp-10" title="${esc(name)}">${esc(name)}</div>`;
    }

    function slotHtml(n, next, last, head) {
        const cls = 'be-slot' +
            (last ? ' last' : '') +
            (next && next.status === 'progress' ? ' to-progress' : '') +
            (n.active === false ? ' inactive' : '');
        return `<span class="${cls}">${dotHtml(n, head)}${last ? '' : miniPersonas(n)}</span>`;
    }

    function dotLabel(n, head) {
        const k = (n.personas || []).length;
        const took = n.took != null ? ` · ${fmtDur(n.took)}` : '';
        const name = head && n.name ? `${n.name} · ` : '';
        return `${name}${n.agent} · ${n.status}${took}${k ? ` · ${k} persona${k > 1 ? 's' : ''}` : ''}`;
    }

    function dotHtml(n, head) {
        const label = dotLabel(n, head);
        return `<button class="node-status-dot be-dot ${esc(n.status)}" data-id="${esc(n.id)}"` +
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
        host.querySelectorAll('.be-dot, .be-more').forEach(el => {
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

    function nodeCell(n, isRoot) {
        const inactive = n.active ? '' : ' inactive';
        return `<div class="node-cell${inactive}">` +
            nodeNameHtml(n, isRoot) + // before .node-slot: inside it, a title would shift the top:50% insert +
            `<div class="node-slot">${nodeCard(n, isRoot)}` +
            `<button class="node-insert-btn" data-id="${esc(n.id)}" title="Insert before">+</button></div>` +
            personaStrip(n) +
            runButton(n) +
            `</div>`;
    }

    // Chain-head title: ink above the card, never inside it — the card header
    // is machine facts (dur · mcp · dot); a name is a human word that wraps.
    // Dormant names (root became non-root via delete-bridge) render nothing.
    function nodeNameHtml(n, isRoot) {
        if (!isRoot || !n.name) return '';
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

    function runButton(n) {
        const disabled = n.runnable ? '' : ' disabled title="chain not ready — parents need summaries"';
        const counts = n.runs && n.runs.total > 0
            ? `<span class="run-counts">${n.runs.total} | <b class="ok">${n.runs.success}</b> | <b class="bad">${n.runs.failed}</b>${runningTag(n)}</span>`
            : '';
        return `<button class="node-run-btn" data-id="${esc(n.id)}"${disabled}>` +
            `<span class="run-label">Run</span>${counts}</button>`;
    }

    function nodeCard(n, isRoot) {
        return `<div class="node-card" data-id="${esc(n.id)}" data-status="${esc(n.status)}">` +
            `<div class="node-main">` +
            cardHeader(n) + cardBody(n) +
            `</div>` +
            `<button class="node-add-child" title="Add child">+</button>` +
            `</div>`;
    }

    function cardHeader(n) {
        const badge = n.mcp ? '<span class="mcp-badge">mcp</span>' : '';
        return `<div class="node-card-header">` +
            `<span class="node-dur">${esc(headerDur(n))}</span>` +
            badge +
            `<span class="node-status-dot ${esc(n.status)}"></span>` +
            `</div>`;
    }

    function headerDur(n) {
        if (n.took != null) return fmtDur(n.took);
        if (n.status === 'progress') {
            return fmtDur(Math.max(0, Math.round((Date.now() - n.created_at) / 1000)));
        }
        return '–';
    }

    function cardBody(n) {
        if (n.summary) return `<div class="node-card-body">${summaryCard(n)}</div>`;
        const prompt = `<div class="wl-bubble input">` +
            `<div class="wl-bubble-text truncated">${esc(n.prompt)}</div></div>`;
        return `<div class="node-card-body">${prompt}${snippetBubble(n)}</div>`;
    }

    function summaryCard(n) {
        return `<div class="wl-bubble summary">` +
            `<div class="wl-bubble-text truncated summary-text">${esc(n.summary)}</div>` +
            `<button class="wl-bubble-copy">${copyIcon()}</button></div>`;
    }

    function snippetBubble(n) {
        if (n.status === 'progress' || !n.output) return '';
        const cls = n.status === 'failed' ? 'output error' : 'output';
        return `<div class="wl-bubble ${cls}">` +
            `<div class="wl-bubble-text truncated result-snippet">${esc(n.output)}</div>` +
            `<button class="wl-bubble-copy">${copyIcon()}</button></div>`;
    }

    function bindGraph(grid) {
        bindCards(grid);
        bindRunButtons(grid);
        bindInsertButtons(grid);
        bindCopyButtons(grid);
        bindAvatarFallbacks(grid);
        markSelectedCard(grid);
    }

    function bindCards(grid) {
        grid.querySelectorAll('.node-card').forEach(card => {
            card.addEventListener('click', () => selectNode(card.dataset.id));
            card.querySelector('.node-add-child').addEventListener('click', e => {
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
        return `<button class="agent-btn" data-agent="${esc(agent)}" disabled>Run · ${esc(agent)}</button>`;
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
        try {
            await (composerMode === 'run' ? postRun(prompt) : postNode(prompt, agent));
            closeComposer();
            await load();
        } catch (e) {
            showError(`Failed to start run: ${e.message}`);
        }
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
        const snap = expansionSnapshot($('detail-panel-inner'));
        $('detail-panel-inner').innerHTML = panelHtml(n);
        restoreExpansion($('detail-panel-inner'), snap);
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
        bindSummaryButton(n);
        bindRetryButton(n);
        bindDeleteButtons();
        bindCopyButtons($('detail-panel-inner'));
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
        mcpAuthOriginal = $('mcp-auth-input').value.trim();
        bindFieldPair('mcp', () => saveMcp(nodeId), syncMcpButton);
        bindFieldPair('mcp-auth', () => saveMcpAuth(nodeId), syncMcpAuthButton);
    }

    function bindNameField(nodeId) {
        if (!$('name-input')) return; // non-roots render no section
        nameOriginal = $('name-input').value.trim();
        bindFieldPair('name', () => saveName(nodeId), syncNameButton);
    }

    function bindFieldPair(id, save, sync) {
        $(id + '-input').addEventListener('input', sync);
        $(id + '-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') save();
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
        } catch (e) {
            showError(`Failed to save mcp: ${e.message}`);
        }
    }

    async function saveMcpAuth(nodeId) {
        const auth = $('mcp-auth-input').value.trim();
        try {
            await putNode(nodeId, { mcp_auth: auth });
            mcpAuthOriginal = auth;
            syncMcpAuthButton();
            await load();
        } catch (e) {
            showError(`Failed to save authorization: ${e.message}`);
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
        const took = n.took != null ? ` · took ${fmtDur(n.took)}` : '';
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
    // the meta line. A dormant name (no longer a root) still shows here.
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
            personasSection(n) + mcpSection(n) + runsSection() + deleteSection(n);
    }

    // The name field exists only on chain heads: a field on a non-root invites
    // "what does this name, then?" (its lane/card label is dormant by design).
    // No maxlength: the backend has no cap (GraphStore.updateName stores TEXT)
    // and every surface that renders the name wraps it.
    function nameSection(n) {
        if (!isRoot(n)) return '';
        return `<div><div class="detail-section-label">CHAIN NAME</div>` +
            `<div class="name-row">` +
            `<input id="name-input" type="text" value="${esc(n.name || '')}" placeholder="Name this chain…" spellcheck="false" autocomplete="off" aria-label="Chain name">` +
            `<button id="name-save">Save</button>` +
            `</div>` +
            `<div class="mcp-hint">Shows above this root card and its lane in bird's-eye view.</div>` +
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
            renderBubble('input', '', n.prompt) + `</div>`;
    }

    function editPromptHtml(n) {
        return `<div class="detail-section-label prompt">PROMPT</div>` +
            `<textarea id="regen-prompt" spellcheck="false">${esc(n.prompt)}</textarea>` +
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

    function runsSection() {
        return `<div><div class="detail-section-label runs">Runs</div>` +
            `<div id="runs-list"><div class="summary-missing">loading…</div></div></div>`;
    }

    async function loadLogs(nodeId) {
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(nodeId)}/logs`;
        try {
            const data = await fetchJson(url);
            if (selectedId !== nodeId) return;
            runsCache = data.logs;
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
        return [...inner.querySelectorAll('input, textarea')].some(fieldHasTyping);
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

    function renderLogs(logs) {
        const el = $('runs-list');
        if (!el) return;
        const snap = expansionSnapshot(el);
        const roots = rootRuns(logs);
        el.innerHTML = roots.length
            ? roots.map(l => runLogHtml(l, logs)).join('')
            : '<div class="summary-missing">no runs yet</div>';
        bindCopyButtons(el);
        bindRunFocusButtons(el);
        restoreExpansion(el, snap);
        focusPendingRow();
    }

    function expansionSnapshot(container) {
        const open = new Map();
        container.querySelectorAll('.wl-bubble-text').forEach(t => {
            if (!t.classList.contains('truncated')) open.set(expansionKey(t), true);
        });
        return open;
    }

    function restoreExpansion(container, snap) {
        container.querySelectorAll('.wl-bubble-text').forEach(t => {
            if (!snap.get(expansionKey(t))) return;
            t.classList.remove('truncated');
            t.classList.add('expanded');
            const btn = t.parentElement.querySelector('.wl-expand-btn');
            if (btn) btn.remove();
        });
    }

    function expansionKey(t) {
        return t.textContent.slice(0, 200);
    }

    function runLogHtml(l, logs) {
        const cls = l.status === 'failed' ? 'output error' : 'output';
        return `<div class="run-log" data-run-id="${esc(l.id)}">` +
            `<div class="run-log-meta">${runFocusBtn()}<span>${rootMeta(l, logs)}</span></div>` +
            renderBubble('input', '', l.prompt) +
            renderBubble(cls, '', l.output || (l.status === 'progress' ? 'in progress…' : '(empty)')) +
            `<div class="run-log-focus-row">${runFocusBtn()}</div>` +
            `</div>`;
    }

    function rootMeta(l, logs) {
        const n = threadOf(l.id, logs).length - 1;
        return `${runMeta(l)}${n ? ` · <span class="convo-count">+${n}</span>` : ''}`;
    }

    function runMeta(l) {
        const took = l.took != null ? ` · took ${fmtDur(l.took)}` : '';
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

    function focusRun(runId) {
        const root = runsCache.find(l => l.id === runId && !l.parent_run_id);
        if (!root) return;
        focusedRunId = runId;
        renderRunView(root, true);
        $('detail-panel-inner').querySelector('.run-back-btn').focus();
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
        inner.querySelector('.detail-panel-body').classList.add('run-enter');
        bindRunViewControls();
    }

    function refreshThreadMessages(thread) {
        const el = $('thread-messages');
        if (!el) return;
        const snap = expansionSnapshot(el);
        el.innerHTML = thread.map(threadEntryHtml).join('');
        restoreExpansion(el, snap);
        bindThreadMessages(el);
    }

    function bindThreadMessages(el) {
        bindCopyButtons(el);
        bindSummaryEdit(el);
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

    function threadViewHtml(root, thread) {
        return runViewHeader(root, thread) +
            `<div class="detail-panel-body">${messagesHtml(thread)}${threadFooterHtml(thread)}</div>`;
    }

    function messagesHtml(thread) {
        return `<div id="thread-messages">${thread.map(threadEntryHtml).join('')}</div>`;
    }

    function threadFooterHtml(thread) {
        return `<div id="thread-footer">${runFollowupSection(thread[thread.length - 1])}</div>`;
    }

    function threadEntryHtml(l) {
        return `<div class="run-log" data-run-id="${esc(l.id)}">` +
            `<div class="run-log-meta"><span>${runMeta(l)}</span></div>` +
            renderBubble('input', '', l.prompt) +
            runResultSection(l) +
            runSummarySection(l) +
            `</div>`;
    }

    function runBackBtn() {
        return `<button class="run-back-btn" title="Back to node" aria-label="Back to node">` +
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>`;
    }

    function runViewHeader(root, thread) {
        const n = thread.length;
        return `<div class="detail-panel-header">` +
            `<div class="detail-panel-accent"></div>` +
            runBackBtn() +
            `<div class="detail-panel-title">` +
            `<div class="detail-panel-name">Conversation · ${fmtTime(root.created_at)}</div>` +
            `<div class="detail-panel-meta">${n} run${n > 1 ? 's' : ''} · ${runMeta(thread[n - 1])}</div>` +
            `</div>` +
            `<button class="detail-panel-close" title="Close panel" aria-label="Close panel">✕</button>` +
            `</div>`;
    }

    function runSummarySection(l) {
        if (['progress', 'summarizing', 'failed'].includes(l.status)) return '';
        return `<div class="run-summary-section" data-run-id="${esc(l.id)}">${summarySectionInner(l)}</div>`;
    }

    function summarySectionInner(l) {
        const body = l.summary
            ? renderBubble('summary', '', l.summary)
            : '<div class="summary-missing">No summary yet — write one to allow follow-ups.</div>';
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div>` +
            `<span class="summary-actions"><button class="summary-edit-btn" data-run-id="${esc(l.id)}">${l.summary ? 'Edit' : 'Add'}</button></span></div>${body}`;
    }

    function runSummaryEditHtml(l) {
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div></div>` +
            `<textarea id="run-summary-input" spellcheck="false">${esc(l.summary || '')}</textarea>` +
            `<button class="regen-submit" id="run-summary-update" disabled>Update</button>`;
    }

    function startRunSummaryEdit(runId) {
        const l = runsCache.find(x => x.id === runId);
        const section = document.querySelector(`.run-summary-section[data-run-id="${CSS.escape(runId)}"]`);
        if (!l || !section) return;
        runSummaryEditing = true;
        section.innerHTML = runSummaryEditHtml(l);
        bindRunSummaryUpdate(l);
        $('run-summary-input').focus();
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
        if (section) { section.innerHTML = summarySectionInner(updated); bindSummaryEdit(section); }
    }

    async function putRunSummary(runId, summary) {
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(selectedId)}/runs/${encodeURIComponent(runId)}`;
        return await fetchJson(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary })
        });
    }

    function runFollowupSection(tip) {
        if (!tip) return '';
        if (tip.status === 'progress') return runHint('Run in progress…');
        if (tip.status === 'summarizing') return runHint('Summarizing…');
        if (tip.status === 'failed') return failedFooterHtml();
        if (!tip.summary) return runHint('Write a summary above to continue this conversation.');
        return followupComposerHtml();
    }

    function failedFooterHtml() {
        return `<div class="run-followup-hint">This run failed — restart it to try again.` +
            `<button class="regen-submit run-retry" id="run-retry-btn">Retry</button></div>`;
    }

    function followupComposerHtml() {
        return `<div class="run-composer">` +
            `<textarea id="run-followup-text" placeholder="Continue this conversation…" autocomplete="off" spellcheck="false"></textarea>` +
            `<button class="regen-submit" id="run-followup-send" disabled>Send</button>` +
            `</div>`;
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
        text.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitFollowup();
        });
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
        const url = `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(selectedId)}/runs/${encodeURIComponent(runId)}/retry`;
        return fetchJson(url, { method: 'POST' });
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

    function scrollToThreadEnd() {
        const body = $('detail-panel-inner').querySelector('.detail-panel-body');
        if (body) body.scrollTop = body.scrollHeight;
    }

    function runResultSection(l) {
        const progress = l.status === 'progress';
        const failed = l.status === 'failed';
        const cls = failed ? 'detail-section-label result error' : 'detail-section-label result';
        const label = progress ? '<div class="detail-section-label running">RUNNING</div>' : `<div class="${cls}">${failed ? 'ERROR' : 'RESULT'}</div>`;
        const bubble = progress
            ? renderBubble('output', '', 'in progress…')
            : renderBubble(failed ? 'output error' : 'output', '', l.output || '(empty)');
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
            `${n.summary ? renderBubble('summary', '', n.summary) : summaryPlaceholder(n)}` +
            `</div>`;
    }

    function editSummaryButton(n) {
        return n.summary ? '<button class="summary-edit-btn" id="summary-edit-btn">Edit</button>' : '';
    }

    function summaryEditHtml(n) {
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div></div>` +
            `<textarea id="summary-input" spellcheck="false">${esc(n.summary)}</textarea>` +
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
        $('summary-input').focus();
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
        section.scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('regen-submit').addEventListener('click', () => submitRegen(n.id));
        $('regen-prompt').focus();
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
            `<div class="mcp-row">` +
            `<input id="mcp-auth-input" type="text" value="${esc(n.mcp_auth || '')}" placeholder="Authorization header value, e.g. Bearer sk-…" spellcheck="false" autocomplete="off">` +
            `<button id="mcp-auth-save">Save</button>` +
            `</div>` +
            `<div class="mcp-hint">Remote HTTP MCP endpoint and optional Authorization header value (full value, prefix included) for this cell. Config file is generated automatically.</div>` +
            `</div>`;
    }

    function resultSection(n) {
        if (n.status === 'progress') {
            return `<div><div class="detail-section-label running">RUNNING</div>` +
                renderBubble('output', '', 'in progress…') + `</div>`;
        }
        const failed = n.status === 'failed';
        const cls = failed ? 'detail-section-label result error' : 'detail-section-label result';
        const label = failed ? 'ERROR' : 'RESULT';
        const again = failed ? '<button class="summary-regen" id="retry-btn">retry</button>' : '';
        return `<div><div class="${cls}">${label}</div>` +
            renderBubble(failed ? 'output error' : 'output', '', n.output || '(empty)') + again + `</div>`;
    }

    function renderBubble(cls, label, text, threshold = 300) {
        const labelHtml = label ? `<span class="wl-bubble-label">${esc(label)}</span>` : '';
        const content = text.length > threshold
            ? `<div class="wl-bubble-text truncated">${esc(text)}</div><button class="wl-expand-btn">show more</button>`
            : `<div class="wl-bubble-text">${esc(text)}</div>`;
        return `<div class="wl-bubble ${cls}">` +
            labelHtml + content +
            `<button class="wl-bubble-copy">${copyIcon()}</button>` +
            `</div>`;
    }

    function bindCopyButtons(container) {
        container.querySelectorAll('.wl-bubble-copy').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const text = btn.closest('.wl-bubble').querySelector('.wl-bubble-text').textContent;
                flashCopyState(btn, copyText(text));
            });
        });
    }

    function flashCopyState(btn, write) {
        btn.innerHTML = checkIcon();
        clearTimeout(btn.copyTimer);
        write.then(
            () => { btn.copyTimer = setTimeout(() => { btn.innerHTML = copyIcon(); }, 2000); },
            () => {
                btn.innerHTML = copyIcon();
                showError('Copy failed — clipboard unavailable');
            }
        );
    }

    function copyText(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        return legacyCopy(text);
    }

    function legacyCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok ? Promise.resolve() : Promise.reject(new Error('execCommand copy failed'));
    }

    function bindExpandButtons(panel) {
        panel.addEventListener('click', e => {
            if (!e.target.classList.contains('wl-expand-btn')) return;
            const content = e.target.previousElementSibling;
            if (content && content.classList.contains('wl-bubble-text')) {
                content.classList.remove('truncated');
                content.classList.add('expanded');
                e.target.remove();
            }
        });
    }

    function copyIcon() {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">` +
            `<rect x="9" y="9" width="13" height="13" rx="2"/>` +
            `<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>` +
            `</svg>`;
    }

    function checkIcon() {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">` +
            `<path d="M20 6L9 17l-5-5"/>` +
            `</svg>`;
    }

    function fmtTime(ms) {
        return new Date(ms).toTimeString().slice(0, 8);
    }

    function fmtDur(s) {
        if (s == null) return '';
        if (s < 60) return s + 's';
        return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runSanityChecks() {
        checkFmtDur();
        checkClampPanelWidth();
        checkRenderBubbleTruncation();
        checkAddRootPinned();
        checkRunLogHtml();
        checkRunLogEmpty();
        checkRunViewHtml();
        checkNodeTitleAboveCard();
        checkInsertBtnStillCentered();
        checkEdgesStillDrawn();
        checkBeLabelsAlign();
        checkBeNoNamesUnchanged();
        checkNameInputUncapped();
        checkClampGrammar();
        console.log('All sanity checks passed.');
    }

    function checkFmtDur() {
        console.assert(fmtDur(3)    === '3s',     'fmtDur: 3s');
        console.assert(fmtDur(90)   === '1m 30s', 'fmtDur: 1m 30s');
        console.assert(fmtDur(null) === '',       'fmtDur: null');
        console.log('OK: fmtDur');
    }

    function checkRunLogHtml() {
        const l = { id: 'r1', root_run_id: 'r1', status: 'success', took: 2, created_at: Date.now(), prompt: 'p', output: 'o' };
        const html = runLogHtml(l, [l, { id: 'r2', root_run_id: 'r1', parent_run_id: 'r1', created_at: Date.now() + 1, prompt: 'x' }]);
        console.assert(html.includes('data-run-id="r1"'), 'runLog: run id attr');
        console.assert((html.match(/run-focus-btn/g) || []).length === 2, 'runLog: two focus arrows');
        console.assert(html.includes('convo-count">+1'), 'runLog: follow-up count badge');
        console.assert(html.includes('run-log-meta"><button'), 'runLog: header arrow first (left)');
        console.log('OK: runLogHtml arrows');
    }

    function checkRunLogEmpty() {
        const l = { id: 'r2', root_run_id: 'r2', status: 'failed', created_at: Date.now(), prompt: 'p', output: null };
        const html = runLogHtml(l, [l]);
        console.assert(html.includes('(empty)') && !html.includes('in progress'), 'runLog: failed + empty → (empty)');
        console.assert(!html.includes('convo-count'), 'runLog: no badge on single-run convo');
        console.log('OK: runLogHtml empty output');
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

    function checkClampPanelWidth() {
        const clamp = OpenLoopPanel.clampPanelWidth;
        console.assert(clamp(9999, 375)  <= 375,  'clamp: 375px phone must never overflow');
        console.assert(clamp(9999, 1280) === 960, 'clamp: desktop 75% cap');
        console.assert(clamp(200,  300)  === 300, 'clamp: floor never exceeds a tiny viewport');
        console.log('OK: clampPanelWidth (shared panel.js)');
    }

    function checkRenderBubbleTruncation() {
        const short = renderBubble('output', '', 'hi');
        const long  = renderBubble('output', '', 'x'.repeat(301));
        console.assert(!short.includes('wl-expand-btn'), 'bubble: short text has no expand button');
        console.assert(long.includes('wl-expand-btn'),   'bubble: long text truncates with expand button');
        console.log('OK: renderBubble truncation');
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

    function checkNodeTitleAboveCard() {
        nodes = [
            { id: 't1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'Long chain name' },
            { id: 't2', parent_id: 't1', agent: 'a', prompt: 'p', status: 'success', created_at: 2, name: 'dormant' }];
        renderGrid();
        const title = document.querySelector('.node-title');
        const cell = document.querySelector('.node-cell');
        console.assert(title && cell.firstElementChild === title, 'nodeTitle: first child of the cell (before .node-slot)');
        console.assert(title && title.title === 'Long chain name', 'nodeTitle: tooltip carries the full name');
        console.assert(document.querySelectorAll('.node-title').length === 1, 'nodeTitle: child + dormant names render none');
        console.assert(!$('graph-grid').querySelector('.node-name'), 'nodeTitle: legacy .node-name gone from the grid');
        console.log('OK: node title above card');
    }

    function checkInsertBtnStillCentered() {
        if (!document.querySelector('.node-cell')) renderGrid();
        const btn = document.querySelector('.node-slot .node-insert-btn');
        const slot = btn.closest('.node-slot');
        // offsetTop ignores the translateY(-50%), so the visual center sits AT it
        console.assert(Math.abs(btn.offsetTop - slot.offsetHeight / 2) < 1, 'insertBtn: the + stays dead-center despite the title above');
        console.log('OK: insert button centered');
    }

    function checkEdgesStillDrawn() {
        const paths = document.querySelectorAll('#edge-layer path').length;
        console.assert(paths === nodes.length - rootNodes().length, 'edges: re-measured paths === nodes − roots');
        console.log('OK: edges drawn after title shift');
    }

    function checkBeLabelsAlign() {
        nodes = [
            { id: 'b1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'x'.repeat(300) },
            { id: 'b2', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 2, name: 'short' },
            { id: 'b3', parent_id: 'b2', agent: 'a', prompt: 'p', status: 'success', created_at: 3 },
            { id: 'b4', parent_id: 'b2', agent: 'a', prompt: 'p', status: 'success', created_at: 4 },
            { id: 'b5', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 5 }];
        document.body.classList.add('birds-eye'); // #birds-eye must be visible to measure
        renderBirdsEye();
        const strips = [...document.querySelectorAll('.be-chain-label')];
        const heights = strips.map(s => s.offsetHeight);
        const cs = strips.length ? getComputedStyle(strips[0]) : {};
        console.assert(strips.length === 4, 'beLabels: a strip per lane — named, braided-dedup AND unnamed');
        console.assert(Math.max(...heights) - Math.min(...heights) < 1, 'beLabels: strips equalized — rails share one grid');
        console.assert(strips[0].offsetHeight > 14, 'beLabels: long name wrapped — the old 14px clip is gone');
        console.assert(cs.whiteSpace === 'normal' && parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) > 1.2,
            'beLabels: wraps with a living line-height (descenders visible)');
        document.body.classList.remove('birds-eye');
        console.log('OK: birds-eye labels align');
    }

    function checkBeNoNamesUnchanged() {
        nodes = nodes.map(n => ({ ...n, name: null }));
        renderBirdsEye();
        const strips = [...document.querySelectorAll('.be-chain-label')];
        console.assert(strips.every(s => !s.textContent), 'beNoNames: zero names → every strip stays silent (pixel-identical)');
        console.log('OK: birds-eye unchanged without names');
    }

    function checkNameInputUncapped() {
        const root = { id: 'n1', parent_id: null, agent: 'a', prompt: 'p', status: 'success', created_at: 1, name: 'x' };
        nodes = [root];
        const html = nameSection(root);
        console.assert(!html.includes('maxlength'), 'nameInput: the UI-only 64-char cap is gone');
        console.assert(html.includes('above this root card'), 'nameInput: hint names the primary surface');
        console.log('OK: name input uncapped');
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
        document.querySelectorAll('.agent-btn').forEach(b => { b.disabled = !ready; });
    });

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
            bindExpandButtons($('detail-panel-inner'));
            bindCanvasDismiss();
            // Panel physics (clamp, drag, mobile sheet) live in panel.js,
            // shared with workflow-log.html. Shared width memory:
            // localStorage['openloop-panel-w'] is a contract with that page —
            // both pages run the identical clamp.
            OpenLoopPanel.initPanelResize();
            if (localStorage.getItem('openloop-birds-eye') === 'birds') setMode('birds');
            await loadAgents();
            await loadInstances();
            await load();
            focusFromDeepLink(new URLSearchParams(location.search).get('node'));
            setInterval(load, 5000);
            startCountdown();
        })();
    }

    // Deep link from notifications.html (?node=<id>): focus the node's cell
    // and open its right panel. Silent fallback if the node no longer exists.
    function focusFromDeepLink(id) {
        if (!id || !nodes.some(n => n.id === id)) return;
        focusFromBirds(id);
    }
})();
