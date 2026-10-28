// workflow-log.js — graph-view session log

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────────────────
    let minimapObserver  = null;
    let resizeObserver   = null;
    let zoomLevel        = 1.0;
    let minimapCollapsed = false;
    let logMap           = new Map();
    let currentTiers     = null;
    let currentLogs      = null;
    let currentNodeMap   = new Map();
    let personaIndex     = new Map();
    const ZOOM_STEPS    = [0.25, 0.50, 0.75, 1.00, 1.25, 1.50];
    const ISOLATED_RUN  = false;
    // Panel physics (clamp, drag, mobile sheet) live in panel.js,
    // shared with graph.html via window.OpenLoopPanel.

    // ── Follow-up thread state (the panel's second, exclusive mode) ─────────
    let instanceParam     = null;   // set in init, threads POST against it
    let sessionParam      = null;
    let sessionSuccess    = false;  // every session log row succeeded
    let threadMode        = false;  // panel shows the follow-up thread
    let threadAutoOpened  = false;  // auto-open fires once per page load
    let threadAutoSeeded  = false;  // auto-seed fires once per page load (page open is the only trigger)
    let seedInFlight      = false;  // a seed POST is airborne — the dock waits, never a CTA
    const SEED_RACE_STATUS = 409;   // another tab seeded first — benign on the auto path
    let threadRows        = [];     // graph run logs anchored on the session
    let threadJson        = '';     // change guard for polling re-renders
    let threadFooterKey   = null;   // footer re-render guard (draft preserve)
    let threadPoll        = null;
    let threadSummaryEditing = false;
    let pendingThreadFocus = null;  // ?run=<id> — beacon after first render

    // ── Entry ────────────────────────────────────────────────────────────────
    function init() {
        const params   = new URLSearchParams(window.location.search);
        const instance = params.get('instance');
        const session  = params.get('session');
        document.getElementById('wl-close-btn').addEventListener('click', () => window.close());
        document.getElementById('empty-reload').addEventListener('click', () => location.reload());
        document.getElementById('wl-zoom-in') .addEventListener('click', () => stepZoom(1));
        document.getElementById('wl-zoom-out').addEventListener('click', () => stepZoom(-1));
        document.getElementById('wl-zoom-label').addEventListener('click', () => applyZoom(1.0));
        document.getElementById('followup-open-btn').addEventListener('click', () => openFollowUpPanel());
        // Shared width memory: localStorage['openloop-panel-w'] is a contract
        // with graph.html — both pages run the identical clamp in panel.js.
        OpenLoopPanel.initPanelResize();
        // One door listener for both panel modes (persona view + follow-up
        // thread), bound once — the old per-open handlers stacked.
        OpenLoopBubble.bindExpand();
        // One copy listener, same contract — with the execCommand fallback
        // for insecure origins and the error surface this page never had.
        OpenLoopBubble.bindCopy(null, showError);
        // Width and webfont arrival change how many lines a text paints —
        // re-gate the panel once geometry settles (never mid-drag).
        document.addEventListener('openloop:panel-resized', regatePanelBubbles);
        if (document.fonts?.ready) document.fonts.ready.then(regatePanelBubbles);
        let resizeTimer = null; // rotation: the panel is 100vw on mobile
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(regatePanelBubbles, 150);
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') { closeDetailPanel(); return; }
            if (!(e.metaKey || e.ctrlKey)) return;
            if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(1); }
            else if (e.key === '-')             { e.preventDefault(); stepZoom(-1); }
            else if (e.key === '0')             { e.preventDefault(); applyZoom(1.0); }
        });
        if (ISOLATED_RUN) { runSanityChecks(); return; }
        if (!instance || !session) { showError('Missing instance or session parameter in URL.'); return; }
        instanceParam = instance;
        sessionParam  = session;
        pendingThreadFocus = params.get('run'); // session_run deep links
        document.getElementById('wl-session-id').textContent = session;
        loadAndRender(instance, session);
    }

    async function loadAndRender(instance, session) {
        try {
            await loadPersonas(instance);
            const url = `/api/instances/${encodeURIComponent(instance)}/logs/sessions/${encodeURIComponent(session)}`;
            render(await fetchJson(url));
        } catch (err) {
            showError(`Failed to load logs: ${err.message}`);
        }
    }

    async function fetchJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function loadPersonas(instance) {
        try {
            const data = await fetchJson('/api/instances');
            await Promise.all(personaSources(data.instances, instance).map(fetchPersonasAt));
        } catch { }
    }

    function personaSources(instances, self) {
        const chain = parentChainOf(instances, self);
        const globals = instances.filter(i => i.isGlobalShare && !chain.includes(i.path)).map(i => i.path);
        return [self, ...chain.slice(0, -1), ...globals].filter(Boolean);
    }

    async function fetchPersonasAt(path) {
        try {
            const data = await fetchJson(`/api/instances/${encodeURIComponent(path)}/personas`);
            (data.personas || []).forEach(p => personaIndex.set(p.id, p));
        } catch { }
    }

    function parentChainOf(instances, self) {
        const parentOf = Object.fromEntries(instances.map(i => [i.path, i.parentPath]));
        return chainToRoot(self, parentOf).reverse();
    }

    function chainToRoot(path, parentOf) {
        const out = [];
        for (let cur = path; cur && !out.includes(cur); cur = parentOf[cur]) out.push(cur);
        return out;
    }

    function render(data) {
        if (!data.logs || !data.logs.length) { showEmpty(); return; }
        const logs = data.logs.filter(l => l.personaId != null);
        if (!logs.length) { showEmpty(); return; }
        // Follow-ups gate on the whole session having succeeded — the
        // backend enforces the same via the run_ends row.
        sessionSuccess = data.logs.every(l => l.success);
        syncFollowupButton();
        if (sessionSuccess && !threadAutoOpened) {
            threadAutoOpened = true; // auto-open once, then the button reopens
            openFollowUpPanel();
        }
        renderToolbar(data);
        const { tiers, avg } = computeSpeedTiers(logs);
        currentTiers = tiers;
        document.getElementById('wl-avg-duration').textContent = `avg: ${OpenLoopPanel.fmtDur(avg)}`;
        placeNodes(data.levels, logs, tiers);
        const nodeMap = buildNodeMap();
        currentLogs = logs;
        currentNodeMap = nodeMap;
        requestAnimationFrame(() => {
            drawEdges(logs, nodeMap);
            buildMinimap(data.levels, logs, tiers);
            watchCanvasResize(() => drawEdges(logs, nodeMap));
        });
    }

    // ── Toolbar ───────────────────────────────────────────────────────────────
    function renderToolbar(data) {
        document.getElementById('wl-workflow-name').textContent = data.logs[0]?.workflowId || '';
        applyStatusDot(data.logs);
        applyTimeRange(data.logs);
    }

    function applyStatusDot(logs) {
        if (!logs.every(l => l.success)) {
            document.getElementById('wl-status-dot').classList.add('error');
        }
    }

    function applyTimeRange(logs) {
        const starts = logs.map(l => l.started_at).sort((a, b) => a - b);
        const ends   = logs.map(l => l.ended_at).sort((a, b) => a - b);
        const fmt    = ms => new Date(ms).toTimeString().slice(0, 8);
        document.getElementById('wl-time-range').textContent =
            `${fmt(starts[0])} \u2192 ${fmt(ends[ends.length - 1])}`;
    }

    // ── Graph layout ──────────────────────────────────────────────────────────
    function placeNodes(levels, logs, tiers) {
        const grid     = document.getElementById('graph-grid');
        const lvs      = levels.length ? levels : deriveLevels(logs);
        const byLevel  = groupLogsByLevel(logs);
        const colsHtml = lvs.map(lv => levelColumn(lv, byLevel.get(lv.levelIndex) || [], tiers)).join('');
        grid.innerHTML = `<svg id="edge-layer"></svg>${colsHtml}`;
        buildLogMap(logs);
        bindCards(grid);
    }

    function bindCards(grid) {
        bindCardHover(grid);
        bindCardClick(grid);
        bindAvatarFallbacks(grid);
    }

    function deriveLevels(logs) {
        const seen = new Set();
        return logs
            .map(l => l.level ?? 0)
            .filter(lv => !seen.has(lv) && seen.add(lv))
            .sort((a, b) => a - b)
            .map(lv => ({ levelIndex: lv, label: `L${lv + 1}` }));
    }

    function groupLogsByLevel(logs) {
        const map = new Map();
        for (const log of logs) {
            const key = log.level ?? 0;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(log);
        }
        return map;
    }

    function levelColumn(lv, logs, tiers) {
        const header = `<div class="col-header">${escHtml(lv.label)}</div>`;
        const cards  = logs.map(log => renderNodeCard(log, tiers)).join('');
        return `<div class="level-col" data-level="${lv.levelIndex}">${header}${cards}</div>`;
    }

    function renderNodeCard(log, tiers) {
        const name       = log.personaId || 'unknown';
        const speedAttr  = tiers ? ` data-speed="${tiers.get(name) || 'blue'}"` : '';
        const body       = nodeCardBody();
        const bodyHtml   = body ? `<div class="node-card-body">${body}</div>` : '';
        return `<div class="node-card is-persona" data-persona-id="${escHtml(name)}"${speedAttr}>${nodeCardHeader(log, name)}${bodyHtml}</div>`;
    }

    function nodeCardHeader(log, name) {
        return `<div class="node-card-header">` +
            personaAvatar(name) +
            `<span class="node-card-name">${escHtml(name)}</span>` +
            `<div class="node-card-meta"><span class="node-card-dur">${OpenLoopPanel.fmtDur(log.took)}</span></div>` +
            `</div>`;
    }

    function nodeCardBody() {
        return '';
    }

    // Copy buttons: markup AND behavior live in bubble.js (bindCopy, bound
    // once at init) — this file's per-render twin called
    // navigator.clipboard.writeText bare, which throws on insecure origins
    // (http on a LAN IP/hostname) and left every copy button dead.

    function bindCardHover(container) {
        container.querySelectorAll('.node-card').forEach(card => {
            card.addEventListener('mouseenter', () => highlightEdges(card.dataset.personaId, true));
            card.addEventListener('mouseleave', () => highlightEdges(null, false));
        });
    }

    // ── Log map ───────────────────────────────────────────────────────────────
    function buildLogMap(logs) {
        logMap = new Map();
        for (const log of logs) logMap.set(log.personaId, log);
    }

    // ── Detail panel ──────────────────────────────────────────────────────────
    function bindCardClick(container) {
        container.querySelectorAll('.node-card.is-persona').forEach(card => {
            card.addEventListener('click', () => {
                const log = logMap.get(card.dataset.personaId);
                if (!log) return;
                document.querySelectorAll('.node-card.selected').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                openDetailPanel(log);
            });
        });
        document.getElementById('graph-canvas').addEventListener('click', e => {
            if (!e.target.closest('.node-card')) closeDetailPanel();
        });
    }

    function openDetailPanel(log) {
        exitThreadMode(); // the panel's two modes are mutually exclusive
        const panel = document.getElementById('detail-panel');
        const inner = document.getElementById('detail-panel-inner');
        inner.innerHTML = renderDetailContent(log);
        OpenLoopBubble.gateBubbles(inner); // same script turn: no flash of unfolded text
        panel.classList.add('open');
        document.getElementById('graph-canvas').classList.add('panel-open');
        panel.querySelector('.detail-panel-close').addEventListener('click', closeDetailPanel);
        bindAvatarFallbacks(panel);
    }

    function closeDetailPanel() {
        exitThreadMode();
        document.getElementById('detail-panel').classList.remove('open');
        document.getElementById('graph-canvas').classList.remove('panel-open');
        document.querySelectorAll('.node-card.selected').forEach(c => c.classList.remove('selected'));
    }

    // A wider panel can free a folded text, a narrower one folds a free
    // one (the panel is the only text surface here — cells render no body).
    // OPEN stays OPEN: the gate never re-folds an expanded text.
    function regatePanelBubbles() {
        OpenLoopBubble.gateBubbles(document.getElementById('detail-panel-inner'));
    }

    function renderDetailContent(log) {
        return renderDetailHeader(log) + `<div class="detail-panel-body">${renderDetailBubbles(log)}</div>`;
    }

    function renderDetailHeader(log) {
        const name = escHtml(log.personaId || 'unknown');
        return `<div class="detail-panel-header">` +
               `<div class="detail-panel-accent"></div>` +
               personaAvatar(log.personaId) +
               `<div class="detail-panel-title">` +
               `<div class="detail-panel-name">${name}</div>` +
               `<div class="detail-panel-meta">took ${OpenLoopPanel.fmtDur(log.took)}</div>` +
               `</div>` +
               `<button class="detail-panel-close" aria-label="Close details">\u2715</button>` +
               `</div>`;
    }

    function renderDetailContexts(parents) {
        return (parents || []).map(p =>
            `<div class="detail-section context-section"><div class="detail-section-label">CONTEXT · ${escHtml(p.id)}</div>${OpenLoopBubble.bubbleHtml('context', p.text)}</div>`
        ).join('');
    }

    function renderDetailBubbles(log) {
        const contexts = renderDetailContexts(log.msg.parents);
        const input    = log.msg.input
            ? `<div class="detail-section input-section"><div class="detail-section-label">INPUT</div>${OpenLoopBubble.bubbleHtml('input', log.msg.input)}</div>`
            : '';
        const outCls   = log.success ? 'output' : 'output error';
        const outSect  = log.success ? 'output-section' : 'error-section';
        const result   = `<div class="detail-section ${outSect}"><div class="detail-section-label">${log.success ? 'RESULT' : 'ERROR'}</div>${OpenLoopBubble.bubbleHtml(outCls, log.msg.output || '(empty)')}</div>`;
        return contexts + input + result;
    }

    // ── Edge drawing ──────────────────────────────────────────────────────────
    function buildNodeMap() {
        const map = new Map();
        document.querySelectorAll('.node-card').forEach(card => map.set(card.dataset.personaId, card));
        return map;
    }

    function drawEdges(logs, nodeMap) {
        const svg  = document.getElementById('edge-layer');
        const grid = document.getElementById('graph-grid');
        if (!svg || !grid) return;
        svg.setAttribute('width', grid.scrollWidth);
        svg.setAttribute('height', grid.scrollHeight);
        svg.innerHTML = '';
        logs.forEach(log => drawLogEdges(log, nodeMap, svg));
    }

    function drawLogEdges(log, nodeMap, svg) {
        const toId = log.personaId;
        const toEl = nodeMap.get(toId);
        if (!toEl) return;
        (log.msg.parents || []).forEach(p => {
            const fromEl = nodeMap.get(p.id);
            if (fromEl) svg.appendChild(edgePath(fromEl, toEl, p.id, toId));
        });
    }

    function elPosInGrid(el) {
        const grid   = document.getElementById('graph-grid');
        const er = el.getBoundingClientRect();
        const gr = grid.getBoundingClientRect();
        return {
            x: (er.left - gr.left) / zoomLevel,
            y: (er.top  - gr.top)  / zoomLevel,
            w: er.width  / zoomLevel,
            h: er.height / zoomLevel
        };
    }

    function edgeGeometry(fromEl, toEl) {
        const f = elPosInGrid(fromEl);
        const t = elPosInGrid(toEl);
        const x1 = f.x + f.w / 2, y1 = f.y + f.h;   // bottom-center
        const x2 = t.x + t.w / 2, y2 = t.y;           // top-center
        return { x1, y1, x2, y2, cy: (y1 + y2) / 2 };
    }

    function svgEl(tag, attrs) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
    }

    function edgePath(fromEl, toEl, fromId, toId) {
        const { x1, y1, x2, y2, cy } = edgeGeometry(fromEl, toEl);
        const g = svgEl('g', {});
        g.dataset.from = fromId; g.dataset.to = toId;
        g.appendChild(svgEl('path', {
            d: `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`,
            stroke: 'var(--edge-color)', 'stroke-width': '1.5',
            fill: 'none', 'stroke-linecap': 'round'
        }));
        g.appendChild(svgEl('circle', { cx: x2, cy: y2, r: '3.5', fill: '#34c759', opacity: '0.6' }));
        return g;
    }

    function watchCanvasResize(fn) {
        if (resizeObserver) resizeObserver.disconnect();
        resizeObserver = new ResizeObserver(fn);
        resizeObserver.observe(document.getElementById('graph-grid'));
    }

    function highlightEdges(personaId, active) {
        const svg = document.getElementById('edge-layer');
        if (!svg) return;
        svg.querySelectorAll('g').forEach(g => {
            const hit = active && (g.dataset.from === personaId || g.dataset.to === personaId);
            g.style.opacity = active ? (hit ? '1' : '0.15') : '';
            const path = g.querySelector('path');
            if (!path) return;
            path.setAttribute('stroke', hit ? 'var(--edge-color-hover)' : 'var(--edge-color)');
            path.setAttribute('stroke-width', hit ? '2' : '1.5');
        });
    }

    // ── Zoom ──────────────────────────────────────────────────────────────────
    function applyZoom(level) {
        zoomLevel = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], level));
        document.getElementById('graph-grid').style.zoom = zoomLevel;
        document.getElementById('graph-grid').style.setProperty('--node-col-width', `calc(100vw / ${zoomLevel})`);
        document.getElementById('wl-zoom-label').textContent = Math.round(zoomLevel * 100) + '%';
        document.getElementById('wl-zoom-out').disabled = zoomLevel <= ZOOM_STEPS[0];
        document.getElementById('wl-zoom-in') .disabled = zoomLevel >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
        if (currentLogs) {
            const nodeMap = buildNodeMap();
            currentNodeMap = nodeMap;
            requestAnimationFrame(() => drawEdges(currentLogs, nodeMap));
        }
    }

    function stepZoom(dir) {
        const cur  = ZOOM_STEPS.findIndex(s => Math.abs(s - zoomLevel) < 0.01);
        const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (cur === -1 ? 3 : cur) + dir))];
        applyZoom(next);
    }

    function fitZoom() {
        const canvas = document.getElementById('graph-canvas');
        const grid   = document.getElementById('graph-grid');
        const scaleH = (window.innerHeight - 48) / grid.scrollHeight;
        const scaleW = window.innerWidth / grid.scrollWidth;
        return Math.max(0.08, Math.min(scaleH, scaleW, 1.0));
    }

    // ── Mini-map ──────────────────────────────────────────────────────────────
    function buildMinimap(levels, logs, tiers) {
        const map        = document.getElementById('minimap');
        const workflowId = logs[0]?.workflowId || 'Workflow';
        const lvs        = levels.length ? levels : deriveLevels(logs);
        const groups     = groupPersonasByLevel(lvs, logs);
        const groupsHtml = lvs.map(lv => minimapLevelGroup(lv, groups.get(lv.levelIndex) || [], tiers)).join('');
        map.innerHTML    = minimapHtml(workflowId, groupsHtml);
        wireMinimapDots(map);
        wireMinimapToggle(map);
        setupMinimapObserver();
    }

    function minimapHtml(workflowId, groupsHtml) {
        const toggle = `<button class="wl-icon-btn mm-toggle-btn" title="Collapse" aria-label="Collapse" aria-expanded="true">&#x2303;</button>`;
        const label  = `<div class="mm-workflow-label">${escHtml(workflowId)}</div>`;
        const levels = `<div class="mm-levels">${groupsHtml}</div>`;
        return toggle + label + levels;
    }

    function wireMinimapDots(map) {
        map.querySelectorAll('.mm-persona-dot').forEach(dot =>
            dot.addEventListener('click', () => onMinimapTap(dot.dataset.personaId))
        );
    }

    function wireMinimapToggle(map) {
        map.querySelector('.mm-toggle-btn').addEventListener('click', toggleMinimap);
        // Phones start collapsed: the map is a pill, not a wall (UX spec §4.3)
        if (OpenLoopPanel.isMobileWidth() && !minimapCollapsed) toggleMinimap();
    }

    function toggleMinimap() {
        minimapCollapsed = !minimapCollapsed;
        const map = document.getElementById('minimap');
        const label  = map.querySelector('.mm-workflow-label');
        const levels = map.querySelector('.mm-levels');
        const btn    = map.querySelector('.mm-toggle-btn');
        if (minimapCollapsed) {
            label.style.display  = 'none';
            levels.style.display = 'none';
            map.classList.add('collapsed');
        } else {
            map.classList.remove('collapsed');
            label.style.display  = '';
            levels.style.display = '';
        }
        btn.title = minimapCollapsed ? 'Expand' : 'Collapse';
        btn.setAttribute('aria-label', minimapCollapsed ? 'Expand' : 'Collapse');
        btn.setAttribute('aria-expanded', minimapCollapsed ? 'false' : 'true');
        btn.innerHTML = minimapCollapsed ? '&#x2304;' : '&#x2303;';
    }

    function minimapLevelGroup(lv, entries, tiers) {
        const dots = entries.map(e => {
            const tier = tiers ? tiers.get(e.id) : null;
            const spdAttr = tier ? ` data-speed="${tier}"` : '';
            return `<button class="mm-persona-dot" data-persona-id="${escHtml(e.id)}"${spdAttr}>${escHtml(e.id.slice(0, 6))}</button>`;
        }).join('');
        return `<div class="mm-level-group"><div class="mm-level-label">${escHtml(lv.label)}</div>${dots}</div>`;
    }

    function groupPersonasByLevel(levels, logs) {
        const result = new Map();
        for (const lv of levels) result.set(lv.levelIndex, []);
        for (const log of logs) {
            const key = log.level ?? 0;
            if (!result.has(key)) result.set(key, []);
            result.get(key).push({ id: log.personaId || 'unknown' });
        }
        return result;
    }

    function flashDot(personaId) {
        const dot = document.querySelector(`.mm-persona-dot[data-persona-id="${CSS.escape(personaId)}"]`);
        if (!dot) return;
        dot.style.filter = 'brightness(1.5)';
        setTimeout(() => { dot.style.filter = ''; }, 150);
    }

    function glowCard(card) {
        const tier = card.dataset.speed || 'green';
        const colors = { green: [52,199,89], blue: [10,132,255], red: [255,69,58] };
        const [r,g,b] = colors[tier];
        card.style.transition = 'box-shadow 600ms ease';
        card.style.boxShadow  = `0 4px 32px rgba(${r},${g},${b},0.28), 0 0 0 2px rgba(${r},${g},${b},0.35)`;
        setTimeout(() => { card.style.boxShadow = ''; }, 1200);
    }

    function onMinimapTap(personaId) {
        const card = document.querySelector(`.node-card[data-persona-id="${CSS.escape(personaId)}"]`);
        if (!card) return;
        flashDot(personaId);
        const reduced = OpenLoopPanel.reducedMotion();
        card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start', inline: 'start' });
        requestAnimationFrame(() => glowCard(card));
    }

    function setupMinimapObserver() {
        if (minimapObserver) minimapObserver.disconnect();
        minimapObserver = new IntersectionObserver(
            entries => entries.forEach(highlightActiveDot),
            { root: document.getElementById('graph-canvas'), threshold: 0.5 }
        );
        document.querySelectorAll('.node-card').forEach(card => minimapObserver.observe(card));
    }

    function highlightActiveDot(entry) {
        const pid = entry.target.dataset.personaId;
        const dot = document.querySelector(`.mm-persona-dot[data-persona-id="${CSS.escape(pid)}"]`);
        if (dot) dot.classList.toggle('active', entry.isIntersecting);
    }

    // ── Follow-up thread (session RUN conversation) ───────────────────────────
    // graph_run_logs rows anchored on the session UUID — run 0 is the seeded
    // original answer, the rest are follow-up turns. The panel's second,
    // exclusive mode: same shell as persona logs, different body + footer.

    const threadUrl = suffix =>
        `/api/instances/${encodeURIComponent(instanceParam)}/graph/sessions/${encodeURIComponent(sessionParam)}${suffix || ''}`;

    async function threadFetchJson(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) {
            const body = (await res.text()).slice(0, 200);
            const err = new Error(body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`);
            err.status = res.status; // callers gate on codes, never on message prose
            throw err;
        }
        return res.json();
    }

    function syncFollowupButton() {
        document.getElementById('followup-open-btn')
            .classList.toggle('visible', sessionSuccess);
    }

    function openFollowUpPanel() {
        threadMode = true;
        document.querySelectorAll('.node-card.selected').forEach(c => c.classList.remove('selected'));
        const panel = document.getElementById('detail-panel');
        document.getElementById('detail-panel-inner').innerHTML = threadShellHtml();
        panel.classList.add('open');
        document.getElementById('graph-canvas').classList.add('panel-open');
        panel.querySelector('.detail-panel-close').addEventListener('click', closeDetailPanel);
        threadJson = '';
        threadFooterKey = null;
        startThreadPoll();
        loadThread(true);
    }

    // Header → scroll body (messages only) → dock (the pinned footer).
    // The composer lives in the dock, outside the scroll body: reading a
    // long thread and writing the next turn are one glance, not a scroll
    // round trip. #thread-footer inside it is the state machine's slot —
    // renderThreadFooter rewrites only that inner div, never the dock.
    function threadShellHtml() {
        return `<div class="detail-panel-header">` +
            `<div class="detail-panel-accent"></div>` +
            `<div class="detail-panel-title">` +
            `<div class="detail-panel-name">Follow-up conversation</div>` +
            `<div class="detail-panel-meta" id="thread-meta">loading…</div>` +
            `</div>` +
            `<button class="detail-panel-close" aria-label="Close details">✕</button>` +
            `</div>` +
            `<div class="detail-panel-body">` +
            `<div id="thread-messages"><div class="summary-missing">loading…</div></div>` +
            `</div>` +
            `<div class="detail-panel-footer" role="region" aria-label="Follow-up composer">` +
            `<div class="detail-panel-accent"></div>` +
            `<div id="thread-footer" aria-live="polite"></div>` +
            `</div>`;
    }

    function startThreadPoll() {
        stopThreadPoll();
        threadPoll = setInterval(() => loadThread(false), 5000);
    }

    function stopThreadPoll() {
        if (threadPoll) { clearInterval(threadPoll); threadPoll = null; }
    }

    function exitThreadMode() {
        stopThreadPoll();
        threadMode = false;
        threadSummaryEditing = false;
        threadFooterKey = null;
    }

    function refreshThread(scrollEnd) {
        // an explicit action (send/seed/retry/summary save) supersedes any
        // open summary edit — fresh state must re-render immediately
        threadSummaryEditing = false;
        threadJson = '';
        threadFooterKey = null;
        loadThread(scrollEnd);
    }

    async function loadThread(scrollEnd) {
        if (!threadMode) return;
        try {
            const data = await threadFetchJson(threadUrl('/logs'));
            if (!threadMode) return; // closed while fetching
            maybeAutoSeedThread(data.logs);
            const json = JSON.stringify(data.logs);
            if (json !== threadJson && !threadSummaryEditing) {
                threadRows = data.logs || [];
                threadJson = json;
                renderThreadMessages();
                renderThreadFooter();
            }
            // An open lands at the tip first — the newest turn is the news —
            // then a ?run= deep link may retake its own seat (beaconIntoView
            // centers only what the landing left out of view).
            if (scrollEnd) scrollToThreadEnd();
            focusPendingThreadRun();
        } catch (e) {
            showError(`Failed to load follow-up thread: ${e.message}`);
        }
    }

    // once per page load — the first loadThread observation decides, fire or not
    function maybeAutoSeedThread(logs) {
        if (threadAutoSeeded) return;
        threadAutoSeeded = true;
        if (sessionSuccess && !logs.length) submitThreadSeed(true);
    }

    function threadTip() {
        // logs arrive created_at DESC, but compute explicitly (mirrors
        // graph.js's threadOf(...).pop()): the newest row is the tip
        if (!threadRows.length) return null;
        return threadRows.reduce((tip, l) => l.created_at > tip.created_at ? l : tip, threadRows[0]);
    }

    function renderThreadMessages() {
        const el = document.getElementById('thread-messages');
        if (!el) return;
        const snap = OpenLoopBubble.snapshotExpansion(el); // the 5s poll must not re-fold an open door
        const rows = [...threadRows].sort((a, b) => a.created_at - b.created_at);
        el.innerHTML = rows.length
            ? rows.map(threadEntryHtml).join('')
            : '<div class="summary-missing">No follow-up turns yet.</div>';
        OpenLoopBubble.restoreExpansion(el, snap);
        OpenLoopBubble.gateBubbles(el);
        el.querySelectorAll('.summary-edit-btn').forEach(btn =>
            btn.addEventListener('click', () => startThreadSummaryEdit(btn.dataset.runId)));
        bindThreadDelete(el);
        const meta = document.getElementById('thread-meta');
        if (meta) meta.textContent = threadHeaderMeta(rows);
    }

    function threadHeaderMeta(rows) {
        const tip = threadTip();
        const turns = `${rows.length} turn${rows.length === 1 ? '' : 's'}`;
        return tip ? `${turns} · ${threadRunMeta(tip)}` : turns;
    }

    // The thread reads as a chat, not a report: no RESULT/SUMMARY headings, the bubbles speak (state labels stay).
    // The summary is the main answer (5 free lines), the raw result a 2-line reference — depths ride bubble.js's data-free-lines.
    const THREAD_RESULT_LINES = 2;
    const THREAD_SUMMARY_LINES = 5;

    function threadEntryHtml(l) {
        return `<div class="run-log" data-run-id="${escHtml(l.id)}">` +
            `<div class="run-log-meta"><span>${escHtml(l.id.slice(0, 8))} · ${escHtml(threadRunMeta(l))}</span>${threadDelBtn(l)}</div>` +
            `<div class="detail-section prompt-section"><div class="detail-section-label prompt">PROMPT</div>` +
            OpenLoopBubble.bubbleHtml('input', l.prompt) +
            `</div>` +
            threadResultSection(l) +
            threadSummarySection(l) +
            auditSection(l) +
            `</div>`;
    }

    function threadRunMeta(l) {
        const took = l.took != null ? ` · took ${OpenLoopPanel.fmtDur(l.took)}` : '';
        return `${l.status}${took} · ${ago(l.created_at)}`;
    }

    // The thread's direct answer: no RESULT heading, the bubble is the message (state labels stay); fold depth 2 — a reference copy under the summary.
    function threadResultSection(l) {
        if (l.status === 'progress') {
            return `<div><div class="detail-section-label running">RUNNING</div>` +
                OpenLoopBubble.bubbleHtml('output', 'in progress…', null, THREAD_RESULT_LINES) + `</div>`;
        }
        const failed = l.status === 'failed';
        const label = failed ? `<div class="detail-section-label result error">ERROR</div>` : '';
        return `<div>${label}${OpenLoopBubble.bubbleHtml(failed ? 'output error' : 'output', l.output || '(empty)', null, THREAD_RESULT_LINES)}</div>`;
    }

    function threadSummarySection(l) {
        if (l.status === 'progress' || l.status === 'summarizing') return '';
        return `<div class="run-summary-section" data-run-id="${escHtml(l.id)}">${threadSummaryInner(l)}</div>`;
    }

    // The summarized answer is the thread's main message: no SUMMARY heading, the bubble speaks — fold depth 5 vs the result's 2.
    // The audit title word takes the old SUMMARY heading's seat in the head row — band and coloring come from the verdict alone.
    function threadSummaryInner(l) {
        const body = l.summary
            ? OpenLoopBubble.bubbleHtml('summary', l.summary, null, THREAD_SUMMARY_LINES)
            : '<div class="summary-missing">No summary yet — write one to allow follow-ups.</div>';
        return `<div class="summary-head">` +
            auditTitleHtml(l) +
            `<span class="summary-actions">` +
            `<button class="summary-edit-btn" data-run-id="${escHtml(l.id)}">${l.summary ? 'Edit' : 'Add'}</button>` +
            `</span></div>${body}`;
    }

    // The advisory scope audit's render grammar — character-identical twins in graph.js, pinned by both sanity suites.
    // nil → nothing; 'analyzing' → ANALYZING…; < AUDIT_WARN_CHARS → ANALYZED: OK; ≤ AUDIT_BAD_CHARS → ANALYSIS: ISSUE FOUND + the ANALYSIS bubble; past it → the same title in red + bubble.
    const AUDIT_WARN_CHARS = 100;
    const AUDIT_BAD_CHARS = 200;

    function auditBand(l) {
        const text = (l.audit || '').trim();
        if (text) return text.length < AUDIT_WARN_CHARS ? 'ok' : (text.length <= AUDIT_BAD_CHARS ? 'warn' : 'bad');
        return l.audit_status === 'analyzing' ? 'busy' : null;
    }

    function auditTitleHtml(l) {
        const band = auditBand(l);
        if (band === 'busy') return '<div class="detail-section-label audit busy" title="Analyzing the recorded turn against the ask…">ANALYZING…</div>';
        if (band === 'ok') return '<div class="detail-section-label audit ok" title="All clear">ANALYZED: OK</div>';
        if (band === 'warn' || band === 'bad') return `<div class="detail-section-label audit ${band}" title="Scope analysis found findings — read the ANALYSIS note below">ANALYSIS: ISSUE FOUND</div>`;
        return '';
    }

    function auditSection(l) {
        const band = auditBand(l);
        if (band !== 'warn' && band !== 'bad') return '';
        return `<div class="audit-section"><div class="detail-section-label audit ${band}">ANALYSIS</div>` +
            OpenLoopBubble.bubbleHtml(band === 'bad' ? 'output error' : 'output', l.audit) + `</div>`;
    }

    // Mirrors graph.js's runSummaryEditHtml — same 7-line canvas, same
    // self-describing label — extracted from startThreadSummaryEdit so the
    // markup is assertable and the two pages stay symmetric.
    function threadSummaryEditHtml(l) {
        return `<div class="summary-head">` +
            `<div class="detail-section-label summary">SUMMARY</div></div>` +
            `<textarea id="thread-summary-input" rows="7" aria-label="Edit summary" placeholder="Write a summary to allow follow-ups…" spellcheck="false" autocomplete="off">${escHtml(l.summary || '')}</textarea>` +
            `<button class="regen-submit" id="thread-summary-update" disabled>Update</button>`;
    }

    function startThreadSummaryEdit(runId) {
        const l = threadRows.find(x => x.id === runId);
        const section = document.querySelector(`.run-summary-section[data-run-id="${CSS.escape(runId)}"]`);
        if (!l || !section) return;
        threadSummaryEditing = true;
        section.innerHTML = threadSummaryEditHtml(l);
        bindThreadSummaryUpdate(l);
        OpenLoopPanel.focusEditor(document.getElementById('thread-summary-input'), section);
    }

    function bindThreadSummaryUpdate(l) {
        const input = document.getElementById('thread-summary-input');
        const update = document.getElementById('thread-summary-update');
        const dirty = () => {
            const v = input.value.trim();
            update.disabled = !(v && v !== (l.summary || ''));
        };
        input.addEventListener('input', dirty);
        update.addEventListener('click', () => submitThreadSummary(l.id));
        dirty();
    }

    async function submitThreadSummary(runId) {
        const summary = document.getElementById('thread-summary-input').value.trim();
        if (!summary) return;
        threadSummaryEditing = false;
        try {
            await threadFetchJson(
                `/api/instances/${encodeURIComponent(instanceParam)}/graph/${encodeURIComponent(sessionParam)}/runs/${encodeURIComponent(runId)}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ summary })
                }
            );
            refreshThread(false);
        } catch (e) {
            showError(`Failed to save summary: ${e.message}`);
            refreshThread(false);
        }
    }

    // Footer variants mirror graph.js's thread footer: empty → seed,
    // progress/summarizing → wait, failed → retry, success w/o summary →
    // hint, success + summary → composer.
    function renderThreadFooter() {
        const footer = document.getElementById('thread-footer');
        if (!footer) return;
        const tip = threadTip();
        const key = threadFooterKeyOf(tip);
        if (key === threadFooterKey) return; // preserve the composer draft
        const draft = footerComposerDraft();
        threadFooterKey = key;
        footer.innerHTML = threadFooterHtml(tip);
        bindThreadFooter();
        restoreFooterDraft(draft);
        // the dock is pinned — every state change is already in view; the
        // old reveal() call died with the scrolling composer
    }

    function threadFooterKeyOf(tip) {
        if (!threadRows.length) return seedInFlight ? 'seeding' : 'empty';
        return tip ? `${tip.id}:${tip.status}:${tip.summary ? 1 : 0}` : 'empty';
    }

    function threadFooterHtml(tip) {
        if (!threadRows.length) {
            if (seedInFlight) return `<div class="run-followup-hint">Summarizing the answer…</div>`;
            return `<div class="run-followup-hint">Seed the original answer to start the follow-up thread.` +
                `<button class="regen-submit run-seed" id="thread-seed-btn">Seed original answer</button></div>`;
        }
        if (!tip) return '';
        if (tip.status === 'progress') {
            return `<div class="run-followup-hint">Run in progress — the panel refreshes while it works.</div>`;
        }
        if (tip.status === 'summarizing') {
            return `<div class="run-followup-hint">Summarizing the answer…</div>`;
        }
        if (tip.status === 'failed') {
            return `<div class="run-followup-hint">This run failed — restart it to try again.` +
                `<button class="regen-submit run-retry" id="thread-retry-btn">Retry</button></div>`;
        }
        if (!tip.summary) {
            return `<div class="run-followup-hint">Write a summary above to continue this conversation.</div>`;
        }
        // The composer capsule: field + send circle in one row (the skin
        // lives in panel.css). rows=3, not the editors' 7 — a pinned dock
        // must not eat the stream; resize + the 40vh cap bound it. The
        // mention hint rides above the capsule (suggest.js single-sources it).
        return `<div class="mcp-hint suggest-hint">${escHtml(OpenLoopSuggest.HINT)}</div>` +
            `<div class="run-composer">` +
            `<textarea id="thread-followup-text" rows="3" aria-label="Continue conversation" placeholder="Continue this conversation…" autocomplete="off" spellcheck="false"></textarea>` +
            `<button class="composer-send" id="thread-followup-send" aria-label="Send follow-up (⌘↵)" title="Send follow-up (⌘↵)" aria-keyshortcuts="Meta+Enter Control+Enter" disabled>${sendIcon()}</button>` +
            `</div>`;
    }

    function footerComposerDraft() {
        const el = document.getElementById('thread-followup-text');
        return el ? el.value : null;
    }

    function restoreFooterDraft(draft) {
        if (draft == null) return;
        const el = document.getElementById('thread-followup-text');
        if (!el) return;
        el.value = draft;
        const send = document.getElementById('thread-followup-send');
        if (send) send.disabled = !draft.trim();
    }

    function bindThreadFooter() {
        const seed = document.getElementById('thread-seed-btn');
        // arrow-wrapped: a bare handler would pass the click Event in as a truthy `auto`
        if (seed) seed.addEventListener('click', () => submitThreadSeed(false));
        const retry = document.getElementById('thread-retry-btn');
        if (retry) retry.addEventListener('click', submitThreadRetry);
        const send = document.getElementById('thread-followup-send');
        const text = document.getElementById('thread-followup-text');
        if (send && text) {
            const sync = () => { send.disabled = !text.value.trim(); };
            text.addEventListener('input', sync);
            // One grammar with graph.html (panel.js) — the drift between the
            // two hand-written keydowns is what caused graph's ⌘↵ bug. The
            // blur is belt-and-braces here (loadThread has no focus gate),
            // and matches the button path: focus leaves a sent field.
            OpenLoopPanel.bindCmdEnterSubmit(text, submitFollowupTurn);
            // per-render bind: 'above' — the dock is bottom-pinned, the list unfolds upward
            OpenLoopSuggest.bindField(text, { instance: instanceParam, place: 'above' });
            send.addEventListener('click', submitFollowupTurn);
        }
    }

    async function submitThreadSeed(auto) {
        if (seedInFlight) return; // one seed airborne at a time — double-taps die at the source
        seedInFlight = true;
        renderThreadFooter(); // the dock swaps to the waiting pose — the CTA leaves the DOM
        try {
            await threadFetchJson(threadUrl('/seed'), { method: 'POST' });
            seedInFlight = false;
            refreshThread(true);
        } catch (e) { landSeedFailure(e, auto); }
    }

    // the auto-path race loss resyncs silently; every other failure speaks and restores the CTA
    function landSeedFailure(e, auto) {
        seedInFlight = false;
        if (auto === true && e.status === SEED_RACE_STATUS) { refreshThread(false); return; }
        showError(`Failed to seed the original answer: ${e.message}`);
        renderThreadFooter();
    }

    async function submitThreadRetry() {
        const tip = threadTip();
        if (!tip) return;
        try {
            await threadFetchJson(threadUrl(`/runs/${encodeURIComponent(tip.id)}/retry`), { method: 'POST' });
            refreshThread(true); // a retry acts on the tip — land there (graph.js's retry does)
        } catch (e) {
            showError(`Failed to restart the run: ${e.message}`);
        }
    }

    // — per-turn delete (the shared RUN contract, session-anchored) —
    // `next` reparents to `deleted.parent` server-side; an emptied thread
    // falls to the seed footer for free. Same Danger-zone grammar as the
    // node page (quiet → armed 3s fuse via panel.js armedButton → splice
    // beat → refresh). Copy is character-identical to graph.js's
    // THREAD_DEL_COPY — pinned by both sanity suites.
    const THREAD_DEL_COPY = {
        rest: 'Delete this turn. Follow-ups move up to this run’s parent — nothing else changes.',
        armed: 'Confirm — delete this turn',
        busy: 'This turn is running — deletion unlocks when it finishes.',
    };

    function threadDelBtn(l) {
        const busy = l.status === 'progress' || l.status === 'summarizing';
        const title = busy ? THREAD_DEL_COPY.busy : THREAD_DEL_COPY.rest;
        return `<button class="run-del-btn" data-run-id="${escHtml(l.id)}"${busy ? ' disabled' : ''}` +
            ` aria-label="${escHtml(title)}" title="${escHtml(title)}">${trashIcon()}</button>`;
    }

    function bindThreadDelete(scope) {
        scope.querySelectorAll('.run-del-btn:not(:disabled)').forEach(btn =>
            OpenLoopPanel.armedButton(btn, THREAD_DEL_COPY.rest, THREAD_DEL_COPY.armed, commitThreadDelete));
    }

    function commitThreadDelete(btn) {
        const runId = btn.dataset.runId;
        btn.classList.add('deleting');
        document.querySelectorAll('.run-del-btn').forEach(b => { b.disabled = true; });
        delThreadRun(runId, threadFocusIndex(runId));
    }

    async function delThreadRun(runId, focusIndex) {
        const beat = threadSpliceBeat(runId);
        try {
            const res = await fetch(threadUrl(`/runs/${encodeURIComponent(runId)}`), { method: 'DELETE' });
            if (res.status !== 404 && !res.ok) throw await threadDeleteError(res);
            await beat;
            await refreshThreadNow(false);
            focusThreadRowAt(focusIndex);
        } catch (e) {
            showError(e.message);
            await refreshThreadNow(false);
            focusThreadRowAt(focusIndex);
        }
    }

    async function threadDeleteError(res) {
        if (res.status === 409) return new Error('Still running — let the run finish, then delete.');
        return new Error(`Failed to delete the turn: ${res.status} ${(await res.text()).slice(0, 140)}`);
    }

    // refreshThread's reset, awaitable — the focus handoff must land AFTER
    // the re-render, not race it.
    async function refreshThreadNow(scrollEnd) {
        threadSummaryEditing = false;
        threadJson = '';
        threadFooterKey = null;
        await loadThread(scrollEnd);
    }

    function threadSpliceBeat(runId) {
        const row = document.querySelector(`.run-log[data-run-id="${CSS.escape(runId)}"]`);
        if (!row || OpenLoopPanel.reducedMotion()) return Promise.resolve();
        row.classList.add('run-del-dying');
        return new Promise(done => setTimeout(done, 150));
    }

    // Keyboard handoff: focus sat ON the deleted button, so the refresh must
    // not strand it at document top — land on the surviving row at the same
    // index; an emptied thread lands on the dock's seed CTA instead.
    function threadFocusIndex(runId) {
        if (!document.activeElement || !document.activeElement.closest('.run-del-btn')) return -1;
        const rows = [...document.querySelectorAll('#thread-messages .run-log')];
        return Math.max(rows.findIndex(r => r.dataset.runId === runId), 0);
    }

    function focusThreadRowAt(index) {
        if (index < 0) return;
        const rows = document.querySelectorAll('#thread-messages .run-log');
        if (!rows.length) return focusSeedButton();
        const row = rows[Math.min(index, rows.length - 1)];
        row.tabIndex = -1;
        row.focus();
    }

    function focusSeedButton() {
        const seed = document.getElementById('thread-seed-btn');
        if (seed) seed.focus();
    }

    // Mirrors graph.js's trashIcon — the same 14px glyph the node delete uses.
    function trashIcon() {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">` +
            `<path d="M3 6h18"/><path d="M8 6V4h8v2"/>` +
            `<path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
    }

    async function submitFollowupTurn() {
        const text = document.getElementById('thread-followup-text');
        const tip = threadTip();
        if (!text || !text.value.trim() || !tip) return;
        const prompt = text.value.trim();
        const refIds = OpenLoopSuggest.nodeIds(text);
        const body = { prompt, parent_run_id: tip.id };
        if (refIds.length) body.node_ids = refIds;
        try {
            await threadFetchJson(threadUrl('/run'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            OpenLoopSuggest.reset(text);
            refreshThread(true);
        } catch (e) {
            showError(`Failed to continue the conversation: ${e.message}`);
        }
    }

    // Open and send are the sanctioned scrolls: arriving at a thread glides
    // the body to the newest turn, and so does sending one (instant under
    // reduced motion). While merely reading + typing, nothing ever scrolls —
    // that is the dock's contract. Mirrors graph.js's twin (a deep link may
    // then retake its own seat — see loadThread's ordering note).
    function scrollToThreadEnd() {
        const body = document.querySelector('#detail-panel-inner .detail-panel-body');
        if (!body) return;
        const end = body.scrollHeight;
        // Element.scrollTo is universal in browsers; the offline harness's
        // jsdom may not ship it — scrollTop reaches the same end, instantly.
        if (typeof body.scrollTo === 'function') body.scrollTo({ top: end, behavior: OpenLoopPanel.reducedMotion() ? 'auto' : 'smooth' });
        else body.scrollTop = end;
    }

    // session_run deep links (?run=<id>): ring + center on first sight — the
    // shared beacon (panel.js) centers the row only when the open's tip
    // landing left it out of view. Unknown row (drift) → leave the thread
    // alone, flag stays for the next poll.
    function focusPendingThreadRun() {
        if (!pendingThreadFocus) return;
        const id = pendingThreadFocus;
        const row = document.querySelector(`.run-log[data-run-id="${CSS.escape(id)}"]`);
        if (!row) return; // row not in the thread (drift) — leave the thread alone
        pendingThreadFocus = null;
        OpenLoopPanel.beaconIntoView(row, document.querySelector('#detail-panel-inner .detail-panel-body'));
    }

    function ago(unixMs) {
        const diff = Math.floor((Date.now() - unixMs) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    // ── Empty / Error states ──────────────────────────────────────────────────
    function showEmpty() { document.getElementById('empty-state').style.display = 'flex'; }

    function showError(msg) {
        const el = document.getElementById('error-state');
        el.style.display = 'block';
        el.textContent = msg;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    // duration formatting lives in panel.js (OpenLoopPanel.fmtDur) — the two pages' private twins drifted apart once

    function computeSpeedTiers(logs) {
        if (!logs.length) return { tiers: new Map(), avg: 0 };
        const avg = logs.reduce((s, l) => s + l.took, 0) / logs.length;
        const tiers = new Map();
        for (const log of logs) {
            const key = log.personaId;
            if (log.took < avg * 0.5)      tiers.set(key, 'green');
            else if (log.took <= avg * 1.5) tiers.set(key, 'blue');
            else                            tiers.set(key, 'red');
        }
        return { tiers, avg };
    }

    // The bubble grammar (markup, the line gate, the door, expansion memory)
    // lives in bubble.js, shared with graph.html — the char-gated
    // renderBubble this file used to carry is gone, and with it the two
    // per-open expand handlers that stacked a listener on #detail-panel
    // every time the panel opened.

    function personIcon() {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round">` +
            `<circle cx="12" cy="8" r="4"/>` +
            `<path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>` +
            `</svg>`;
    }

    function personaAvatar(personaId) {
        const p = personaIndex.get(personaId);
        const name = (p && p.name) || personaId || '?';
        if (p && p.avatar) {
            return `<img class="node-card-avatar is-persona" src="${escHtml(p.avatar)}" alt="${escHtml(name)}">`;
        }
        return `<div class="node-card-avatar is-persona">${escHtml(initialOf(name))}</div>`;
    }

    function initialOf(name) {
        return (name || '?').trim().charAt(0).toUpperCase() || '?';
    }

    function bindAvatarFallbacks(root) {
        root.querySelectorAll('img.node-card-avatar').forEach(img => {
            img.addEventListener('error', () => {
                const div = document.createElement('div');
                div.className = img.className;
                div.textContent = initialOf(img.alt);
                img.replaceWith(div);
            }, { once: true });
        });
    }


    function sendIcon() {
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    async function runSanityChecks() {
        checkNodeCardBodyEmpty();
        checkBuildLogMap();
        checkFormatDuration();
        checkRenderDetailHeader();
        checkRenderDetailBubbles();
        checkInnerPersonaFilter();
        checkThreadTip();
        checkThreadFooterStates();
        await checkThreadAutoSeed();
        checkThreadEditFields();
        checkThreadDelete();
        checkAuditBand();
        checkThreadFoldDepths();
        checkDeepLinkBeacon();
        checkDockStructure();
        checkSuggestWiring();
        console.log('All sanity checks passed.');
    }

    // the session dock carries the shared hint line — the dropdown itself is pinned by suggest.js's suite
    function checkSuggestWiring() {
        const mk = (status, summary) => {
            const saved = threadRows;
            threadRows = [{ id: 'r1', created_at: 1, status, summary, output: 'x' }];
            const html = threadFooterHtml(threadTip());
            threadRows = saved;
            return html;
        };
        const composer = mk('success', 's');
        console.assert(composer.includes('mcp-hint suggest-hint'), 'suggest: the session dock carries the mention hint line');
        console.assert(composer.includes('@file') && composer.includes('#node'), 'suggest: the dock hint names both triggers');
        console.log('OK: suggest wiring (session dock hint line)');
    }

    function checkNodeCardBodyEmpty() {
        const html = nodeCardBody();
        console.assert(html === '', 'nodeCardBody: must return empty string');
        console.log('OK: nodeCardBody returns ""');
    }

    function checkBuildLogMap() {
        buildLogMap([{ personaId: 'Alice' }, { personaId: 'Bob' }]);
        console.assert(logMap.get('Alice')?.personaId === 'Alice', 'logMap: Alice missing');
        console.assert(logMap.get('Bob')?.personaId   === 'Bob',   'logMap: Bob missing');
        console.log('OK: buildLogMap');
    }

    function checkRenderDetailHeader() {
        const log  = { personaId: 'Bob', took: 2.5 };
        const html = renderDetailHeader(log);
        console.assert(html.includes('Bob'),  'renderDetailHeader: name missing');
        console.assert(html.includes('2.5s'), 'renderDetailHeader: duration missing');
        console.assert(!html.includes(':'),   'renderDetailHeader: should not contain timestamp');
        console.log('OK: renderDetailHeader');
    }

    // The RULE lives in panel.js (checkFmtDur pins the full table); this pins the wiring only.
    function checkFormatDuration() {
        console.assert(OpenLoopPanel.fmtDur(2.5) === '2.5s',
            'formatDuration wiring: shared helper reachable, decimals keep one place');
        console.assert(threadRunMeta({ status: 'success', took: 150, created_at: Date.now() }).includes('took 3m'),
            'formatDuration wiring: a >2m turn renders "took 3m" in the thread meta');
        console.log('OK: formatDuration wiring');
    }

    function checkRenderDetailBubbles() {
        const log = { msg: { parents: [{ id: 'P1', text: 'ctx' }], input: 'hi', output: 'bye' }, success: true };
        const html = renderDetailBubbles(log);
        console.assert(html.includes('INPUT'),   'renderDetailBubbles: INPUT missing');
        console.assert(html.includes('RESULT'),  'renderDetailBubbles: RESULT missing');
        console.assert(html.includes('CONTEXT'), 'renderDetailBubbles: CONTEXT missing');
        console.log('OK: renderDetailBubbles');
    }

    function checkInnerPersonaFilter() {
        const logs = [
            { workflowId: 'MainWF', personaId: null },
            { workflowId: 'MainWF', personaId: 'Alice' },
            { workflowId: 'Inner', personaId: null },
            { workflowId: 'Inner', personaId: 'Charlie' },
        ];
        const filtered = logs.filter(l => l.personaId != null);
        console.assert(filtered.length === 2, 'filter: expected 2');
        console.assert(filtered[0].personaId === 'Alice', 'filter: Alice');
        console.assert(filtered[1].personaId === 'Charlie', 'filter: Charlie');
        console.log('OK: innerPersonaFilter');
    }

    function checkThreadTip() {
        const saved = threadRows;
        threadRows = [
            { id: 'r2', created_at: 30, status: 'success', summary: null },  // newest first (API order)
            { id: 'r0', created_at: 10, status: 'success', summary: 's' },
            { id: 'r1', created_at: 20, status: 'failed', summary: null },
        ];
        console.assert(threadTip()?.id === 'r2', 'threadTip: newest row wins regardless of order');
        console.assert(threadFooterKeyOf(threadTip()) === 'r2:success:0', 'footerKey: id:status:summary shape');
        threadRows = [];
        console.assert(threadTip() === null, 'threadTip: empty thread → null');
        console.assert(threadFooterKeyOf(threadTip()) === 'empty', 'footerKey: empty thread key');
        threadRows = saved;
        console.log('OK: threadTip');
    }

    function checkThreadFooterStates() {
        const mk = (status, summary) => {
            const saved = threadRows;
            threadRows = [{ id: 'r1', created_at: 1, status, summary, output: 'x' }];
            const html = threadFooterHtml(threadTip());
            threadRows = saved;
            return html;
        };
        console.assert(mk('progress').includes('Run in progress'), 'footer: progress waits');
        console.assert(mk('summarizing').includes('Summarizing'), 'footer: summarizing waits');
        const failed = mk('failed');
        console.assert(failed.includes('Retry') && failed.includes('failed'), 'footer: failed retries');
        console.assert(mk('success').includes('Write a summary'), 'footer: success w/o summary hints');
        console.assert(mk('success', 'sum').includes('thread-followup-text'), 'footer: success + summary composes');
        const savedRows = threadRows, savedKey = threadFooterKey;
        threadRows = [];
        console.assert(threadFooterHtml(null).includes('Seed original answer'), 'footer: empty thread seeds');
        threadRows = savedRows;
        threadFooterKey = savedKey;
        console.log('OK: threadFooterStates');
    }

    // hermetic (stubbed fetch, zero network): the decision, the seeding pose, the failure paths
    async function checkThreadAutoSeed() {
        const inner = document.getElementById('detail-panel-inner');
        inner.innerHTML = threadShellHtml();
        await checkAutoSeedDecision();
        checkSeedInFlightPose();
        await checkSeedFailurePaths();
        closeDetailPanel();
        console.log('OK: thread auto-seed');
    }

    async function checkAutoSeedDecision() {
        const saved = autoSeedStateSave();
        const calls = stubSeedFetch(200);
        assertSeedNeverFires(calls, false, []);            // a failed session never fires
        assertSeedNeverFires(calls, true, [{ id: 'r1' }]); // rows exist — something already ran
        resetSeedCaseState();
        maybeAutoSeedThread([]); // the page-open state: successful session, empty thread
        console.assert(threadAutoSeeded && seedInFlight, 'autoSeed: flags flip before the POST resolves');
        maybeAutoSeedThread([]); // the 5s poll re-entering loadThread
        console.assert(calls.seed === 1, 'autoSeed: exactly one POST across every observation');
        await settleSeedCase(); // the success continuation lands before the restore
        autoSeedStateRestore(saved);
    }

    function assertSeedNeverFires(calls, success, logs) {
        resetSeedCaseState();
        sessionSuccess = success;
        maybeAutoSeedThread(logs);
        console.assert(calls.seed === 0 && threadAutoSeeded,
            'autoSeed: a failed session or existing rows never fire — the page-open decision is spent');
    }

    // 'seeding' must differ from 'empty' or the footer swap never re-renders
    function checkSeedInFlightPose() {
        const savedRows = threadRows, savedSeed = seedInFlight;
        threadRows = [];
        assertSeedingPose(true);
        assertSeedingPose(false);
        threadRows = savedRows; seedInFlight = savedSeed;
    }

    function assertSeedingPose(inFlight) {
        seedInFlight = inFlight;
        const pose = threadFooterHtml(null);
        const key = threadFooterKeyOf(null);
        console.assert(key === (inFlight ? 'seeding' : 'empty'),
            `seedPose: footer key distinguishes ${inFlight ? 'seeding' : 'empty'}`);
        console.assert(pose.includes(inFlight ? 'Summarizing the answer…' : 'Seed original answer') &&
            !pose.includes(inFlight ? 'thread-seed-btn' : 'Summarizing the answer…'),
            `seedPose: ${inFlight ? 'an airborne seed renders the waiting pose, never the CTA'
                                   : 'the CTA returns once nothing is airborne'}`);
    }

    // the race loss is silent on the auto path (resync follows); a manual tap speaks — a human acted
    async function checkSeedFailurePaths() {
        const saved = autoSeedStateSave();
        await runSeedCase(SEED_RACE_STATUS, true, false); // auto + race → silent, then resync
        await runSeedCase(500, true, true);               // auto + server error → speaks
        await runSeedCase(SEED_RACE_STATUS, false, true); // manual + race → speaks — a human acted
        autoSeedStateRestore(saved);
    }

    async function runSeedCase(status, auto, expectError) {
        const calls = stubSeedFetch(status);
        resetSeedCaseState();
        threadMode = true; // the race case's resync (refreshThread → loadThread) must be live
        renderThreadFooter(); // the manual path taps the real, really-bound CTA
        if (auto) maybeAutoSeedThread([]);
        else document.getElementById('thread-seed-btn').click();
        assertDockSwappedToWaiting();
        await settleSeedCase();
        assertSeedCase(calls, status, auto, expectError);
    }

    function settleSeedCase() {
        // one macrotask: the POST outcome and the resync's fetch land before the timer fires
        return new Promise(done => setTimeout(done, 0));
    }

    function assertDockSwappedToWaiting() {
        const dock = document.getElementById('thread-footer').innerHTML;
        console.assert(dock.includes('Summarizing the answer…') && !dock.includes('thread-seed-btn'),
            'seedFail: the dock swaps to the waiting pose synchronously — the CTA leaves the DOM');
    }

    function assertSeedCase(calls, status, auto, expectError) {
        const errored = document.getElementById('error-state').style.display === 'block';
        console.assert(errored === expectError,
            `seedFail ${status} ${auto ? 'auto' : 'manual'}: error banner ${expectError ? 'expected' : 'must not appear'}`);
        console.assert(calls.seed === 1, `seedFail ${status}: exactly one seed POST — never a double-fire`);
        console.assert(calls.logs === (auto && status === SEED_RACE_STATUS ? 1 : 0),
            `seedFail ${status}: the race case resyncs, every other failure does not`);
    }

    // hermetic stub: /seed answers `status`, /logs answers empty; the counters record the hits
    function stubSeedFetch(status) {
        const calls = { seed: 0, logs: 0 };
        window.fetch = async (url, opts = {}) => {
            const isSeed = String(url).endsWith('/seed');
            calls[isSeed ? 'seed' : 'logs']++;
            return isSeed
                ? { ok: status < 400, status, text: async () => 'reason phrase', json: async () => ({}) }
                : { ok: true, status: 200, json: async () => ({ logs: [] }) };
        };
        return calls;
    }

    function resetSeedCaseState() {
        threadRows = [];
        threadJson = '';
        threadFooterKey = null;
        seedInFlight = false;
        sessionSuccess = true; // the CTA and the auto-seed only exist for a successful session
        threadAutoSeeded = false;
        document.getElementById('error-state').style.display = 'none';
    }

    function autoSeedStateSave() {
        return {
            fetch: window.fetch, sessionSuccess, threadAutoSeeded, seedInFlight,
            rows: threadRows, json: threadJson, key: threadFooterKey, mode: threadMode,
        };
    }

    function autoSeedStateRestore(s) {
        window.fetch = s.fetch;
        sessionSuccess = s.sessionSuccess;
        threadAutoSeeded = s.threadAutoSeeded;
        seedInFlight = s.seedInFlight;
        threadRows = s.rows;
        threadJson = s.json;
        threadFooterKey = s.key;
        threadMode = s.mode;
        document.getElementById('error-state').style.display = 'none';
    }

    // Text→field conversions open a 7-line canvas — one grammar with
    // graph.html (see its checkEditFieldGrammar). The dock composer is NOT
    // one of them: it is a compact rows=3 capsule pinned at the panel bottom
    // (a 7-row canvas would eat the dock it lives in). The composer branch
    // needs a non-empty threadRows or threadFooterHtml takes the seed branch.
    function checkThreadEditFields() {
        const edit = threadSummaryEditHtml({ id: 'r1', summary: null });
        console.assert(edit.includes('rows="7"'), 'editFields: thread summary 7 rows');
        console.assert(edit.includes('aria-label="Edit summary"'), 'editFields: thread summary self-describes');
        console.assert(edit.includes('Write a summary to allow follow-ups'), 'editFields: empty Add teaches');
        const saved = threadRows;
        threadRows = [{ id: 'r1', created_at: 1, status: 'success', summary: 's' }];
        const composer = threadFooterHtml(threadTip());
        threadRows = saved;
        console.assert(composer.includes('rows="3"'), 'editFields: dock composer stays compact rows=3');
        console.assert(composer.includes('aria-label="Continue conversation"'), 'editFields: composer self-describes');
        console.assert(composer.includes('composer-send'), 'editFields: composer sends via the icon circle');
        console.log('OK: thread edit fields (7-row editors, 3-row dock composer)');
    }

    // Per-turn delete: a quiet icon in every thread row's meta, disabled
    // while the turn is in flight, copy character-identical to graph.js's
    // THREAD_DEL_COPY — the cross-page single source this check enforces.
    // Deleting the last row falls to the seed footer (already pinned by
    // checkThreadFooterStates).
    function checkThreadDelete() {
        const ok = { id: 'sr1', root_run_id: 'sr1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o' };
        const html = threadEntryHtml(ok);
        console.assert(html.includes('run-del-btn" data-run-id="sr1"'), 'threadDel: every turn row carries the delete button');
        console.assert(html.includes(`title="${escHtml(THREAD_DEL_COPY.rest)}"`), 'threadDel: rest title teaches the splice');
        console.assert(html.indexOf('<span>') < html.indexOf('run-del-btn'), 'threadDel: caption leads, button follows it inline');
        for (const status of ['progress', 'summarizing']) {
            const busy = threadEntryHtml({ ...ok, id: 'sr9', status });
            console.assert(busy.includes('disabled') && busy.includes(`title="${escHtml(THREAD_DEL_COPY.busy)}"`),
                `threadDel: ${status} renders disabled with the busy title`);
        }
        console.assert(THREAD_DEL_COPY.armed === 'Confirm — delete this turn', 'threadDel: armed copy pinned');
        console.assert(THREAD_DEL_COPY.rest.includes('Follow-ups move up to this run’s parent — nothing else changes'),
            'threadDel: teaching hint pinned');
        console.log('OK: per-turn delete markup');
    }

    // The audit band grammar, pinned on both pages (the audit trio renders character-identical) — an empty audit string is neutral: "not audited" is not "audited clean".
    function checkAuditBand() {
        const clean = { audit: null, audit_status: null };
        console.assert(auditBand(clean) === null, 'auditBand: no audit → nothing renders');
        console.assert(auditTitleHtml(clean) === '' && auditSection(clean) === '',
            'auditBand: neutral renders neither title word nor bubble');
        console.assert(auditBand({ audit: '   ' }) === null, 'auditBand: whitespace-only audit is neutral');
        const busy = { audit: null, audit_status: 'analyzing' };
        console.assert(auditBand(busy) === 'busy', 'auditBand: the marker reads busy');
        console.assert(auditTitleHtml(busy).includes('audit busy') && auditTitleHtml(busy).includes('ANALYZING…') && auditSection(busy) === '',
            'auditBand: busy renders the ANALYZING title word only — no bubble');
        const ok = { audit: 'All clear' };
        console.assert(ok.audit.length < 100 && auditBand(ok) === 'ok',
            'auditBand: the mandated clean line stays under 100 chars');
        console.assert(auditTitleHtml(ok).includes('audit ok') && auditTitleHtml(ok).includes('ANALYZED: OK'),
            'auditBand: clean → the ANALYZED: OK title word, the verdict text never shown as content');
        console.assert(auditSection(ok) === '', 'auditBand: clean renders no analysis bubble');
        const warn = { audit: 'beyond scope: '.repeat(8) }; // 13 × 8 = 104 chars
        console.assert(auditBand(warn) === 'warn', 'auditBand: 100–200 chars → warn');
        console.assert(auditTitleHtml(warn).includes('audit warn') && auditTitleHtml(warn).includes('ISSUE FOUND') && auditSection(warn).includes('ANALYSIS'),
            'auditBand: warn → the issue title word plus the analysis bubble');
        const bad = { audit: 'x'.repeat(201) };
        console.assert(auditBand(bad) === 'bad', 'auditBand: over 200 chars → bad');
        console.assert(auditTitleHtml(bad).includes('audit bad') && auditSection(bad).includes('ANALYSIS'),
            'auditBand: bad → the red issue title word plus the bubble');
        const row = threadEntryHtml({ id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o', summary: 's', ...warn });
        console.assert(row.indexOf('wl-bubble summary') < row.indexOf('ANALYSIS'),
            'auditBand: the analysis bubble rides after the summary');
        console.log('OK: audit band grammar');
    }

    // The thread's fold hierarchy, pinned on both pages — result 2, summary 5, no RESULT/SUMMARY headings.
    function checkThreadFoldDepths() {
        const html = threadEntryHtml({ id: 'r1', root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o', summary: 's' });
        console.assert(html.includes('data-free-lines="2"'), 'foldDepths: the raw result folds at two lines');
        console.assert(html.includes('data-free-lines="5"'), 'foldDepths: the summary folds at five lines');
        console.assert(!html.includes('>RESULT<') && !html.includes('>SUMMARY<'),
            'foldDepths: the chat cells carry no answer headings');
        console.log('OK: thread fold depths (result 2 · summary 5 · no headings)');
    }

    // ?run= deep link: consumed on first sight, ringed, and centered only
    // when the view doesn't already show it — the shared helper owns that
    // geometry (panel.js pins it); this pins the consumption + handoff. The
    // fold half needs a layout engine — jsdom's zero rects read everything
    // as in-view, so skip, don't fake (the checkDockStructure convention).
    function checkDeepLinkBeacon() {
        const inner = document.getElementById('detail-panel-inner');
        const savedRows = threadRows;
        inner.innerHTML = threadShellHtml();
        threadRows = [{ id: 'r1', created_at: 1, status: 'success', took: 1, prompt: 'p', output: 'o', summary: 's' }];
        renderThreadMessages();
        pendingThreadFocus = 'r1';
        const row = inner.querySelector('.run-log[data-run-id="r1"]');
        let centered = 0;
        row.scrollIntoView = () => { centered++; };
        focusPendingThreadRun();
        console.assert(pendingThreadFocus === null, 'deepLink: consumed on first sight');
        console.assert(row.classList.contains('beacon'), 'deepLink: the arriving row rings');
        if (!OpenLoopBubble.layoutWorks()) {
            console.log('deepLink: center check skipped — no layout engine (jsdom)');
        } else {
            const body = inner.querySelector('.detail-panel-body');
            const spacer = document.createElement('div');
            spacer.style.height = '4000px';
            row.parentElement.insertBefore(spacer, row); // the row sinks below the fold (rows nest in #thread-messages)
            pendingThreadFocus = 'r1';
            focusPendingThreadRun();
            console.assert(centered === 1, 'deepLink: an off-view row centers itself — once');
            spacer.remove();
        }
        threadRows = savedRows;
        closeDetailPanel();
        console.log('OK: deep-link beacon');
    }

    // ── The dock (pinned panel footer) — mirrors graph.js's footer checks ───
    // Same triad contract: header → scroll body (the only scroller) → dock.
    // Renders the shell hermetically (no network), then proves structure,
    // immovability under body scroll, fade suppression and the composer cap.
    // The footer needs a non-empty threadRows or threadFooterHtml takes the
    // seed branch instead of the composer (same setup as checkThreadEditFields).
    function checkDockStructure() {
        const inner = document.getElementById('detail-panel-inner');
        inner.innerHTML = threadShellHtml();
        const savedRows = threadRows;
        threadRows = [{ id: 'r1', created_at: 1, status: 'success', summary: 's' }];
        document.getElementById('thread-footer').innerHTML = threadFooterHtml(threadTip());
        threadRows = savedRows;
        const footer = inner.querySelector('.detail-panel-footer');
        const body = inner.querySelector('.detail-panel-body');
        console.assert(footer, 'dock: the shell renders the footer');
        console.assert(footer.parentElement === inner, 'dock: direct child of #detail-panel-inner');
        console.assert(footer.previousElementSibling === body, 'dock: flex sibling AFTER the scroll body');
        const text = document.getElementById('thread-followup-text');
        console.assert(text && text.closest('.detail-panel-footer') === footer, 'dock: the composer lives in the dock');
        const spacer = document.createElement('div');
        spacer.style.flex = '0 0 4000px'; // flex-shrink would collapse a bare height — the body must actually overflow
        body.appendChild(spacer); // guarantee the body CAN scroll — else immovability is vacuous
        const top = footer.getBoundingClientRect().top;
        body.scrollTop = 60;
        console.assert(body.scrollTop === 60, 'dock: precondition — the body actually scrolled');
        console.assert(Math.abs(footer.getBoundingClientRect().top - top) < 0.5, 'dock: footer top invariant under body scroll');
        body.scrollTop = 0;
        spacer.remove();
        // Strict in every browser; engines without pseudo-element computed
        // styles (jsdom in the offline harness) return the ELEMENT's style —
        // probe with a sentinel and skip the fade assert rather than fake it.
        const probe = document.createElement('div');
        const probeStyle = document.createElement('style');
        probe.id = 'pseudo-probe';
        probeStyle.textContent = '#pseudo-probe::after { display: table; }';
        document.head.appendChild(probeStyle);
        document.body.appendChild(probe);
        const pseudoWork = getComputedStyle(probe, '::after').display === 'table';
        probe.remove();
        probeStyle.remove();
        console.assert(!pseudoWork || getComputedStyle(body, '::after').display === 'none',
            'dock: bottom fade suppressed while the dock exists');
        const cap = parseFloat(getComputedStyle(text).maxHeight);
        console.assert(cap > 0 && cap <= window.innerHeight * 0.45, 'dock: composer max-height ≤ 45% of the viewport');
        closeDetailPanel();
        console.log('OK: dock structure, immovable, fade suppressed, composer capped');
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);
})();
