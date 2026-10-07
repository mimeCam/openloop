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
        initPanelResize();
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') { closeDetailPanel(); return; }
            if (!(e.metaKey || e.ctrlKey)) return;
            if (e.key === '=' || e.key === '+') { e.preventDefault(); stepZoom(1); }
            else if (e.key === '-')             { e.preventDefault(); stepZoom(-1); }
            else if (e.key === '0')             { e.preventDefault(); applyZoom(1.0); }
        });
        if (ISOLATED_RUN) { runSanityChecks(); return; }
        if (!instance || !session) { showError('Missing instance or session parameter in URL.'); return; }
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
        renderToolbar(data);
        const { tiers, avg } = computeSpeedTiers(logs);
        currentTiers = tiers;
        document.getElementById('wl-avg-duration').textContent = `avg: ${formatDuration(avg)}`;
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
        bindCopyButtons(grid);
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
            `<div class="node-card-meta"><span class="node-card-dur">${formatDuration(log.took)}</span></div>` +
            `</div>`;
    }

    function nodeCardBody() {
        return '';
    }

    function bindCopyButtons(container) {
        container.querySelectorAll('.wl-bubble-copy').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const text = btn.closest('.wl-bubble').querySelector('.wl-bubble-text').textContent;
                navigator.clipboard.writeText(text).then(() => {
                    btn.innerHTML = checkIcon();
                    setTimeout(() => { btn.innerHTML = copyIcon(); }, 1500);
                });
            });
        });
    }

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
        const panel = document.getElementById('detail-panel');
        document.getElementById('detail-panel-inner').innerHTML = renderDetailContent(log);
        panel.classList.add('open');
        document.getElementById('graph-canvas').classList.add('panel-open');
        panel.querySelector('.detail-panel-close').addEventListener('click', closeDetailPanel);
        panel.addEventListener('click', function handleExpand(e) {
            if (!e.target.classList.contains('wl-expand-btn')) return;
            const content = e.target.previousElementSibling;
            if (content && content.classList.contains('wl-bubble-text')) {
                content.classList.remove('truncated');
                content.classList.add('expanded');
                e.target.remove();
            }
        });
        bindCopyButtons(panel);
        bindAvatarFallbacks(panel);
    }

    function closeDetailPanel() {
        document.getElementById('detail-panel').classList.remove('open');
        document.getElementById('graph-canvas').classList.remove('panel-open');
        document.querySelectorAll('.node-card.selected').forEach(c => c.classList.remove('selected'));
    }

    function initPanelResize() {
        const saved = parseInt(localStorage.getItem('openloop-panel-w'));
        if (saved) applyPanelWidth(saved);
        const handle = document.querySelector('.panel-resize');
        handle.addEventListener('pointerdown', startPanelDrag);
        handle.addEventListener('dblclick', resetPanelWidth);
    }

    function resetPanelWidth() {
        applyPanelWidth(420);
        persistPanelWidth(420);
    }

    function startPanelDrag(e) {
        e.preventDefault();
        document.body.classList.add('panel-resizing');
        e.target.setPointerCapture(e.pointerId);
        e.target.classList.add('dragging');
        const move = ev => applyPanelWidth(window.innerWidth - ev.clientX);
        e.target.addEventListener('pointermove', move);
        e.target.addEventListener('pointerup', () => endPanelDrag(e.target, move), { once: true });
    }

    function endPanelDrag(target, move) {
        target.removeEventListener('pointermove', move);
        target.classList.remove('dragging');
        document.body.classList.remove('panel-resizing');
        persistPanelWidth(currentPanelWidth());
    }

    function applyPanelWidth(w) {
        const clamped = Math.max(320, Math.min(w, window.innerWidth * 0.75));
        document.documentElement.style.setProperty('--panel-w', Math.round(clamped) + 'px');
    }

    function currentPanelWidth() {
        return parseInt(document.documentElement.style.getPropertyValue('--panel-w')) || 420;
    }

    function persistPanelWidth(w) {
        localStorage.setItem('openloop-panel-w', String(w));
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
               `<div class="detail-panel-meta">${formatDuration(log.took)}</div>` +
               `</div>` +
               `<button class="detail-panel-close">\u2715</button>` +
               `</div>`;
    }

    function renderDetailContexts(parents) {
        return (parents || []).map(p =>
            `<div class="detail-section context-section"><div class="detail-section-label">CONTEXT · ${escHtml(p.id)}</div>${renderBubble('context', '', p.text)}</div>`
        ).join('');
    }

    function renderDetailBubbles(log) {
        const contexts = renderDetailContexts(log.msg.parents);
        const input    = log.msg.input
            ? `<div class="detail-section input-section"><div class="detail-section-label">INPUT</div>${renderBubble('input', '', log.msg.input)}</div>`
            : '';
        const outCls   = log.success ? 'output' : 'output error';
        const outSect  = log.success ? 'output-section' : 'error-section';
        const result   = `<div class="detail-section ${outSect}"><div class="detail-section-label">${log.success ? 'RESULT' : 'ERROR'}</div>${renderBubble(outCls, '', log.msg.output || '(empty)')}</div>`;
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
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start', inline: 'start' });
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

    // ── Empty / Error states ──────────────────────────────────────────────────
    function showEmpty() { document.getElementById('empty-state').style.display = 'flex'; }

    function showError(msg) {
        const el = document.getElementById('error-state');
        el.style.display = 'block';
        el.textContent = msg;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function formatDuration(s) {
        if (s < 60) return s % 1 === 0 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
        const m = Math.floor(s / 60);
        const r = Math.round(s % 60);
        if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return rm ? `${h}h ${rm}m` : `${h}h`;
    }

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

    function renderBubble(cls, label, text, threshold = 300) {
        const labelHtml = label ? `<span class="wl-bubble-label">${label}</span>` : '';
        const content = text.length > threshold
            ? `<div class="wl-bubble-text truncated">${escHtml(text)}</div><button class="wl-expand-btn">show more</button>`
            : `<div class="wl-bubble-text">${escHtml(text)}</div>`;
        return `<div class="wl-bubble ${cls}">` +
            labelHtml + content +
            `<button class="wl-bubble-copy">${copyIcon()}</button>` +
            `</div>`;
    }

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

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runSanityChecks() {
        checkNodeCardBodyEmpty();
        checkBuildLogMap();
        checkFormatDuration();
        checkRenderDetailHeader();
        checkRenderDetailBubbles();
        checkInnerPersonaFilter();
        console.log('All sanity checks passed.');
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

    function checkFormatDuration() {
        console.assert(formatDuration(3)     === '3s',     'formatDuration: 3s');
        console.assert(formatDuration(2.5)   === '2.5s',   'formatDuration: 2.5s');
        console.assert(formatDuration(60)    === '1m',     'formatDuration: 1m');
        console.assert(formatDuration(90)    === '1m 30s', 'formatDuration: 1m 30s');
        console.assert(formatDuration(3600)  === '1h',     'formatDuration: 1h');
        console.assert(formatDuration(3720)  === '1h 2m',  'formatDuration: 1h 2m');
        console.log('OK: formatDuration');
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

    // ── Boot ──────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', init);
})();
