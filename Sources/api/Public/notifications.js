// notifications.js — /notifications.html page logic.
// ?instance=<path> → that instance's notifications; no param → all instances.
// Read state changes via the explicit buttons or "open ↗" (followed link = seen); title deep links never mark.
(function () {
    'use strict';

    const instanceParam = new URLSearchParams(location.search).get('instance');
    const POLL_SECONDS = 30; // list + running badge both ride this cadence
    let items = [];
    const ISOLATED_RUN = false; // flip to true to run sanity checks in DevTools

    // ── list filter — multi-word AND over title / instance_path / ask ──
    const FETCH_LIMIT = 100;
    const ANNOUNCE_DELAY_MS = 400;
    // TODO: filter — no ?q= URL persistence yet
    let query = '';
    let fetchCapReached = false;
    let announceTimer = 0;

    // ── prompt disclosure (grammar cloned from graph.js renderBubble) ──
    const PROMPT_THRESHOLD = 300; // ≈3 wrapped lines at 12px — same figure as graph.js renderBubble default
    // expandKeys the user opened, kept outside the DOM so rows survive the
    // 30s poll and every markRead/markAll re-render
    const expanded = new Set();
    // composite identity — loadAll() flattens every instance into one list, so
    // n.id alone collides across instances; markRead() keys rows the same way
    const expandKey = n => `${n.instance_path}/${n.id}`;

    const $ = id => document.getElementById(id);

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s ?? '';
        return d.innerHTML.replace(/"/g, '&quot;');
    }

    // ── filter helpers ──
    // TODO: filter — scoped mode (?instance=) drops the path chip, so a path-only match shows no highlight
    const queryTokens = q => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

    const notifText = n => `${n.title} ${n.instance_path} ${n.prompt || ''}`.toLowerCase();

    const matches = (n, tokens) => {
        if (!tokens.length) return true;
        const hay = notifText(n);
        return tokens.every(t => hay.includes(t));
    };

    // earliest hit of any token at/after pos — greedy left-to-right, so overlapping tokens never nest
    function firstHit(s, pos, tokens) {
        let best = null;
        for (const t of tokens) {
            const i = s.indexOf(t, pos);
            if (i !== -1 && (best === null || i < best.i)) best = { i, t };
        }
        return best;
    }

    // escape-first: split on hits, esc() every chunk — hostile text stays inert
    // TODO: promote hl()/esc() to a shared asset the day a second page needs it
    function hl(text, tokens) {
        const low = text.toLowerCase();
        let out = '', pos = 0;
        for (;;) {
            const hit = firstHit(low, pos, tokens);
            if (!hit) return out + esc(text.slice(pos));
            out += esc(text.slice(pos, hit.i)) +
                `<mark class="hl">${esc(text.slice(hit.i, hit.i + hit.t.length))}</mark>`;
            pos = hit.i + hit.t.length;
        }
    }

    const chipHidesHit = (n, tokens) => {
        const short = shortPath(n.instance_path).toLowerCase();
        return tokens.some(t => n.instance_path.toLowerCase().includes(t) && !short.includes(t));
    };

    // mirrors isLongPrompt's clamp clauses
    const clampHead = p => p.split('\n').slice(0, 3).join('\n').slice(0, PROMPT_THRESHOLD);

    function promptHitState(p, tokens) {
        if (!tokens.length) return 'none';
        const low = p.toLowerCase();
        if (!tokens.some(t => low.includes(t))) return 'none';
        const head = clampHead(p).toLowerCase();
        return tokens.some(t => head.includes(t)) ? 'visible' : 'below-fold';
    }

    const instBase = inst => `/api/instances/${encodeURIComponent(inst)}/notifications`;

    async function fetchJson(url, opts) {
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text(); // read/mark endpoints return an empty 200
        return text ? JSON.parse(text) : null;
    }

    async function load() {
        refreshRunning();
        try {
            items = instanceParam ? await loadOne(instanceParam) : await loadAll();
        } catch (e) {
            $('list').innerHTML = `<div class="error-banner">Failed to load notifications: ${esc(e.message)}</div>`;
            return;
        }
        render();
    }

    async function loadOne(inst) {
        const list = (await fetchJson(`${instBase(inst)}?limit=${FETCH_LIMIT}`)).items;
        console.assert(Array.isArray(list), 'loadOne: .items is contract-guaranteed (NotificationsResponse)');
        if (list.length >= FETCH_LIMIT) fetchCapReached = true;
        return list;
    }

    async function loadAll() {
        const data = await fetchJson('/api/instances');
        console.assert(Array.isArray(data.instances), 'loadAll: .instances is contract-guaranteed (InstanceListResponse)');
        const lists = await Promise.all(
            data.instances.map(i => loadOne(i.path).catch(() => []))
        );
        return lists.flat().sort((a, b) => b.ended_at - a.ended_at);
    }

    // ── running-tasks badge (grammar cloned from app.js updateRunningBubble) ──
    // Same /api/instances counters as the home page badge. ?instance= scopes
    // this page, so the badge follows the page's scope, not the fleet's.
    const runningBadgeLabelCap = 99;
    let lastRunningTotal = 0;

    function scopedInstances(data, param) {
        console.assert(Array.isArray(data.instances), 'scopedInstances: .instances is contract-guaranteed (InstanceListResponse)');
        const all = data.instances;
        return param ? all.filter(i => i.path === param) : all;
    }

    const runningBreakdown = insts => insts.reduce((acc, d) => ({
        workflows: acc.workflows + (d.state?.activeRunningWorkflows || 0),
        manual: acc.manual + (d.manualActive || 0),
        runs: acc.runs + (d.runningGraphRuns || 0) + (d.runningSessionRuns || 0)
    }), { workflows: 0, manual: 0, runs: 0 });

    const runningLabel = total =>
        total > runningBadgeLabelCap ? runningBadgeLabelCap + '+' : String(total);

    function runningTooltip(b, total, scopePath) {
        const scope = scopePath ? ` — ${shortPath(scopePath)}` : '';
        return `Running tasks${scope}: ${total}\n` +
            `${b.workflows} workflows · ${b.manual} manual · ${b.runs} graph & convo runs\n` +
            `updates every ${POLL_SECONDS} s`;
    }

    function popOnce(el) {
        el.classList.remove('badge-pop');
        void el.offsetWidth;
        el.classList.add('badge-pop');
    }

    function updateRunningBadge(instances) {
        const badge = $('running-badge'), count = $('running-count');
        if (!badge || !count) return;
        const b = runningBreakdown(instances);
        const total = b.workflows + b.manual + b.runs;
        badge.title = runningTooltip(b, total, instanceParam);
        const label = runningLabel(total);
        if (count.textContent !== label) count.textContent = label;
        badge.classList.toggle('is-running', total > 0);
        if (total > 0 && lastRunningTotal === 0) popOnce(badge);
        lastRunningTotal = total;
    }

    // Status, not content: a failed fetch keeps the last known count — the
    // list owns this page's only error surface.
    function refreshRunning() {
        fetchJson('/api/instances')
            .then(data => updateRunningBadge(scopedInstances(data, instanceParam)))
            .catch(() => {});
    }

    function render() {
        renderHeader();
        const tokens = queryTokens(query);
        const visible = tokens.length ? items.filter(n => matches(n, tokens)) : items;
        renderFilterChrome(visible, tokens);
        $('list').innerHTML = listHtml(visible, tokens);
        bindRows();
    }

    function listHtml(visible, tokens) {
        if (!items.length) return emptyHtml();
        if (!visible.length) return noMatchHtml(tokens);
        return (tokens.length ? statusHtml(visible) : '') + visible.map(rowHtml).join('');
    }

    function renderFilterChrome(visible, tokens) {
        $('filter-input').disabled = !items.length && !tokens.length;
        announceFilter(visible, tokens);
    }

    function announceFilter(visible, tokens) {
        clearTimeout(announceTimer);
        announceTimer = setTimeout(announce, ANNOUNCE_DELAY_MS, visible, tokens);
    }

    function announce(visible, tokens) {
        const q = tokens.join(' ');
        $('filter-live').textContent = !tokens.length ? '' :
            visible.length ? `${visible.length} results for “${q}”` : `No results for “${q}”`;
    }

    function emptyHtml() {
        return `<div class="empty">` +
            `<div class="empty-icon" aria-hidden="true">${bellIcon()}</div>` +
            `<div class="empty-title">All caught up</div>` +
            `<div class="empty-hint">Finished workflows, follow-ups and node runs land here. Updates every ${POLL_SECONDS} s.</div>` +
            `</div>`;
    }

    function statusHtml(visible) {
        const set = new Set(visible);
        const hiddenUnread = items.filter(n => !n.read && !set.has(n)).length;
        return `<div class="filter-status">Showing ${visible.length} of ${items.length}` +
            (hiddenUnread ? ` · ${hiddenUnread} unread hidden` : '') +
            ` · <button class="filter-clear" type="button">clear</button></div>`;
    }

    function noMatchHtml(tokens) {
        return `<div class="empty">` +
            `<div class="empty-icon" aria-hidden="true">${searchXIcon()}</div>` +
            `<div class="empty-title">No matches for “${esc(tokens.join(' '))}”</div>` +
            `<div class="empty-hint">Every word must appear in the workflow or node name, the project path, or your ask.</div>` +
            noMatchNotes() +
            `<button class="mark-all-btn visible filter-clear" type="button">Clear filter</button>` +
            `</div>`;
    }

    function noMatchNotes() {
        const unread = items.filter(n => !n.read).length;
        const cap = fetchCapReached ? `Only the newest ${FETCH_LIMIT} items per instance are loaded — older items aren't searched.` : '';
        return (cap ? `<div class="empty-hint">${cap}</div>` : '') +
            (unread ? `<div class="empty-hint">${unread} unread hidden by this filter.</div>` : '');
    }

    function searchXIcon() {
        return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/><path d="m21 21-4.3-4.3"/></svg>';
    }

    function bellIcon() {
        return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
    }

    function renderHeader() {
        const unread = items.filter(n => !n.read).length;
        const pill = $('unread-pill');
        pill.textContent = unread > 99 ? '99+' : String(unread);
        pill.classList.toggle('zero', unread === 0);
        $('mark-all').classList.toggle('visible', unread > 0);
    }

    function rowHtml(n) {
        return `<div class="notif${n.read ? '' : ' unread'}" data-id="${esc(n.id)}">` +
            `<span class="notif-icon ${n.success ? 'ok' : 'fail'}">${kindIcon(n)}</span>` +
            `<div class="notif-body">${headHtml(n)}${metaHtml(n)}${promptHtml(n)}</div>` +
            actionsHtml(n) +
            `</div>`;
    }

    function headHtml(n, scoped = !!instanceParam) {
        const tokens = queryTokens(query);
        const full = !scoped && tokens.length && chipHidesHit(n, tokens);
        const label = full ? n.instance_path : shortPath(n.instance_path);
        const chip = scoped ? '' :
            `<span class="notif-path" title="${esc(n.instance_path)}">${hl(label, tokens)}</span>` +
            `<span class="notif-sep" aria-hidden="true">·</span>`;
        return `<div class="notif-head">${chip}` +
            `<span class="notif-title"><a href="${deepLink(n)}" target="_blank" rel="noopener">${hl(n.title, tokens)}</a></span>` +
            `</div>`;
    }

    function metaHtml(n) {
        const took = fmtTook(n.took);
        return `<div class="notif-meta">` +
            `<span class="notif-kind">${kindLabel(n)}</span>` +
            `<span class="notif-status ${n.success ? 'ok' : 'fail'}">${n.success ? '✓ succeeded' : '✗ failed'}</span>` +
            (took ? `<span>${took}</span>` : '') +
            `<span>${relTime(n.ended_at)}</span>` +
            `</div>`;
    }

    function actionsHtml(n) {
        const ds = `data-kind="${esc(n.kind)}" data-ref="${esc(n.id)}" data-inst="${esc(n.instance_path)}"`;
        return `<a class="notif-open" href="${deepLink(n)}" target="_blank" rel="noopener" ${ds}>open ↗</a>` +
            (n.read ? '' : `<button class="mark-read-btn" ${ds}>mark read</button>`);
    }

    // The clamp can bite when chars fill ~3 wrapped lines OR when extra
    // newlines overflow 3 rendered lines — both need the "show more" out;
    // a clamp with no escape hatch is trapped content.
    function isLongPrompt(p) {
        return p.length > PROMPT_THRESHOLD || p.split('\n').length > 3;
    }

    // Sole render site of the user's ask. The clamp is CSS-only — the full
    // text always ships in the markup (screen readers get everything); JS
    // never substrings user text. Clamp math stays on the raw string —
    // highlighted HTML is longer than the text it wraps.
    function promptHtml(n) {
        if (!n.prompt) return '';
        const tokens = queryTokens(query);
        if (expanded.has(expandKey(n))) return `<div class="notif-prompt expanded">${hl(n.prompt, tokens)}</div>`;
        if (!isLongPrompt(n.prompt)) return `<div class="notif-prompt">${hl(n.prompt, tokens)}</div>`;
        if (promptHitState(n.prompt, tokens) === 'below-fold')
            return `<div class="notif-prompt expanded">${hl(n.prompt, tokens)}</div>`;
        return `<div class="notif-prompt truncated" title="${esc(n.prompt)}">${hl(n.prompt, tokens)}</div>` +
            `<button class="notif-more" data-key="${esc(expandKey(n))}">show more</button>`;
    }

    function kindLabel(n) {
        if (n.kind === 'workflow') return 'workflow';
        if (n.kind === 'session_run') return 'follow-up';
        return 'node run';
    }

    function kindIcon(n) {
        if (n.kind === 'workflow') {
            return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
        }
        if (n.kind === 'session_run') {
            return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.7L3 21l1.8-5.6a8.38 8.38 0 0 1-.8-3.9 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z"/></svg>';
        }
        return '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>';
    }

    // Three kinds, two pages:
    //   workflow    → workflow-log.html?session=<uuid>
    //   session_run → workflow-log.html?session=<uuid>&run=<run id> (the
    //                 follow-up thread on the session's log page)
    //   node_run    → graph.html?node=<node id>&run=<run id> — n.id IS the
    //                 run id (NotificationHandler refId = graph_run_log id).
    function deepLink(n) {
        const inst = encodeURIComponent(n.instance_path);
        if (n.kind === 'workflow') {
            return `/workflow-log.html?instance=${inst}&session=${encodeURIComponent(n.session || n.id)}`;
        }
        if (n.kind === 'session_run') {
            return `/workflow-log.html?instance=${inst}` +
                `&session=${encodeURIComponent(n.session || n.node_id || '')}` +
                `&run=${encodeURIComponent(n.id)}`;
        }
        return `/graph.html?instance=${inst}&node=${encodeURIComponent(n.node_id || '')}` +
            `&run=${encodeURIComponent(n.id)}`;
    }

    function fmtTook(s) {
        if (s == null) return '';
        if (s < 60) return `${s}s`;
        if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
        return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }

    function relTime(unixMs) {
        const diff = Math.floor((Date.now() - unixMs) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    }

    function shortPath(p) {
        return '…/' + String(p).split('/').filter(Boolean).pop();
    }

    const scopeLabel = p => (p ? ` — ${shortPath(p)}` : '');

    function renderScope() {
        const el = $('toolbar-scope');
        el.textContent = scopeLabel(instanceParam);
        el.title = instanceParam || '';
    }

    function bindRows() {
        const root = $('list');
        root.querySelectorAll('.mark-read-btn').forEach(btn =>
            btn.addEventListener('click', () => markRead(btn.dataset)));
        root.querySelectorAll('.notif-open').forEach(bindOpenMarksRead);
        root.querySelectorAll('.notif-more').forEach(btn =>
            btn.addEventListener('click', () => expandPrompt(btn)));
        root.querySelectorAll('.filter-clear').forEach(btn =>
            btn.addEventListener('click', clearFilter));
        $('mark-all').onclick = markAllRead;
    }

    // "open ↗" doubles as the read receipt — target="_blank" lets the mark POST ride along with navigation.
    // BIND, never fire — bindRows runs on every render (load, poll, filter); a bare markRead would mark the whole list read on page load.
    function bindOpenMarksRead(a) {
        a.addEventListener('click', () => {
            const n = items.find(x => x.id === a.dataset.ref && x.instance_path === a.dataset.inst);
            if (n && !n.read) markRead(a.dataset);
        });
    }

    // One-way reveal: remember the key (so the next poll re-render keeps it
    // open), un-clamp, drop the button. No collapse — "open ↗" owns full
    // fidelity.
    function expandPrompt(btn) {
        expanded.add(btn.dataset.key);
        const promptEl = btn.previousElementSibling;
        promptEl.classList.remove('truncated');
        promptEl.classList.add('expanded');
        btn.remove();
    }

    async function markRead(ds) {
        const url = `${instBase(ds.inst)}/${encodeURIComponent(ds.kind)}/${encodeURIComponent(ds.ref)}/read`;
        try {
            await fetchJson(url, { method: 'POST' });
            const n = items.find(x => x.id === ds.ref && x.instance_path === ds.inst);
            if (n) n.read = true;
            render();
        } catch (e) {
            alert(`Failed to mark read: ${e.message}`);
        }
    }

    async function markAllRead() {
        const targets = [...new Set(items.filter(n => !n.read).map(n => n.instance_path))];
        try {
            await Promise.all(
                targets.map(inst => fetchJson(`${instBase(inst)}/read-all`, { method: 'POST' }))
            );
            items.forEach(n => { n.read = true; });
            render();
        } catch (e) {
            alert(`Failed to mark all read: ${e.message}`);
        }
    }

    // ── filter wiring ──
    function bindFilter() {
        const input = $('filter-input');
        // FETCH_LIMIT owns the cap — the tooltip must never hardcode it
        input.title = `Searches loaded notifications — newest ${FETCH_LIMIT} per instance.
Multiple words: every word must match somewhere.
Press / to focus · Esc to clear`;
        input.addEventListener('input', () => { applyQuery(input.value); trimFilter(input); });
        input.addEventListener('keydown', onFilterKey);
        $('filter-x').addEventListener('click', clearFilter);
        document.addEventListener('keydown', onGlobalKey);
    }

    function applyQuery(q) {
        if (q === query) return;
        const was = queryTokens(query).length > 0, now = queryTokens(q).length > 0;
        query = q;
        if (!was && now) scrollTop();
        $('list').classList.toggle('fade-in', was && !now);
        render();
    }

    function trimFilter(input) {
        input.closest('.filter-wrap').classList.toggle('armed', input.value !== '');
    }

    function onFilterKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        if (e.target.value) { e.target.value = ''; applyQuery(''); trimFilter(e.target); }
        else e.target.blur();
    }

    function clearFilter() {
        const input = $('filter-input');
        input.value = '';
        input.focus();
        applyQuery('');
        trimFilter(input);
    }

    function onGlobalKey(e) {
        if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = document.activeElement?.tagName;
        if (tag && /INPUT|TEXTAREA|SELECT/.test(tag)) return;
        e.preventDefault();
        const input = $('filter-input');
        if (!input.disabled) { input.focus(); input.select(); }
    }

    function scrollTop() {
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runSanityChecks() {
        checkDeepLink();
        checkPromptClamp();
        checkOpenMarksRead();
        checkRunningBadge();
        checkHeroLayout();
        checkFilterMatch();
        checkFilterHighlight();
        checkFilterRender();
        console.log('All sanity checks passed.');
    }

    function checkDeepLink() {
        const inst = encodeURIComponent('/tmp/demo');
        const nodeRun = { kind: 'node_run', id: 'r/1 x', instance_path: '/tmp/demo', node_id: 'n1' };
        console.assert(deepLink(nodeRun) ===
            `/graph.html?instance=${inst}&node=n1&run=${encodeURIComponent('r/1 x')}`,
            'deepLink: node_run carries &run=<run id> (encoded), node kept');
        const wf = { kind: 'workflow', id: 'sess/1', instance_path: '/tmp/demo', session: 'sess/1' };
        console.assert(deepLink(wf) === `/workflow-log.html?instance=${inst}&session=sess%2F1`,
            'deepLink: workflow link byte-identical to today');
        console.assert(!deepLink({ ...nodeRun, kind: 'workflow', session: 's' }).includes('&run='),
            'deepLink: &run= never leaks into workflow links');
        const su = { kind: 'session_run', id: 'r 9', instance_path: '/tmp/demo', session: 'sess/9', node_id: 'sess/9' };
        console.assert(deepLink(su) ===
            `/workflow-log.html?instance=${inst}&session=sess%2F9&run=${encodeURIComponent('r 9')}`,
            'deepLink: session_run goes to workflow-log with session + run');
        console.assert(deepLink({ ...su, session: null }) ===
            `/workflow-log.html?instance=${inst}&session=sess%2F9&run=r%209`,
            'deepLink: session_run falls back to node_id when session missing');
        console.assert(kindLabel(su) === 'follow-up' && kindLabel(nodeRun) === 'node run' &&
            kindLabel(wf) === 'workflow', 'kindLabel: all three kinds labeled');
        console.log('OK: deepLink');
    }

    function checkPromptClamp() {
        const mk = (prompt, path) => ({ id: 'r1', instance_path: path, prompt });
        console.assert(promptHtml(mk('ok', '/a')) === '<div class="notif-prompt">ok</div>',
            'promptHtml: short ask renders plain, no button');
        const long = promptHtml(mk('x'.repeat(301), '/a'));
        console.assert(long.includes('notif-prompt truncated') &&
            long.includes('data-key="/a/r1"') && long.includes('>show more</button>'),
            'promptHtml: >300 chars clamp + carry key + offer show more');
        console.assert(promptHtml(mk('a\nb\nc\nd', '/a')).includes('notif-more'),
            'promptHtml: 4 short lines still get the escape hatch (newline clause)');
        expanded.add('/b/r1');
        const open = promptHtml(mk('y'.repeat(301), '/b'));
        console.assert(open.startsWith('<div class="notif-prompt expanded">') && !open.includes('notif-more'),
            'promptHtml: remembered key renders expanded, button gone');
        expanded.clear();
        const hostile = promptHtml(mk('<script>x</script>' + 'a'.repeat(400), '/c'));
        console.assert(!hostile.includes('<script>') && hostile.includes('notif-more'),
            'promptHtml: user text escaped on every render path');
        const quoted = promptHtml({ id: 'r"1', instance_path: '/d', prompt: 'z'.repeat(301) });
        console.assert(quoted.includes('data-key="/d/r&quot;1"'),
            'promptHtml: data-key attribute escaped');
        console.assert(expandKey(mk('p', '/x')) === '/x/r1' && expandKey(mk('p', '/y')) === '/y/r1',
            'expandKey: composite (instance_path, id) — same id, two instances, two keys');
        console.log('OK: prompt clamp');
    }

    // "open ↗" must carry the same payload the mark-read POST needs (kind/ref/inst).
    function checkOpenMarksRead() {
        const base = { kind: 'node_run', instance_path: '/tmp/demo', node_id: 'n1',
            success: true, took: 4, ended_at: Date.now(), title: 't' };
        const html = rowHtml({ ...base, id: 'r 1', read: false });
        // anchor the regex on the open <a> — the mark-read button carries identical attributes
        console.assert(/<a class="notif-open"[^>]*\bdata-kind="node_run"[^>]*\bdata-ref="r 1"[^>]*\bdata-inst="\/tmp\/demo"/.test(html),
            'rowHtml: open anchor carries kind/ref/inst for the implicit mark');
        const quoted = rowHtml({ ...base, id: 'r"1', read: false });
        console.assert(/<a class="notif-open"[^>]*\bdata-ref="r&quot;1"/.test(quoted),
            'rowHtml: open payload attributes escaped');
        // Regression pin (mark-all-on-reload bug): a render/poll is not a user action — binding attaches, never fires.
        const savedItems = items, realMarkRead = markRead;
        items = [{ ...base, id: 'r 1', instance_path: '/tmp/demo', read: false }];
        let posted = 0;
        markRead = () => { posted++; };
        const bound = [];
        bindOpenMarksRead({
            dataset: { kind: 'node_run', ref: 'r 1', inst: '/tmp/demo' },
            addEventListener: (type, fn) => bound.push([type, fn])
        });
        console.assert(bound.length === 1 && bound[0][0] === 'click' && posted === 0,
            'bindOpenMarksRead: binds one click listener, marks nothing during render');
        bound[0][1](); // the user's click — only now may the POST fire
        markRead = realMarkRead;
        items = savedItems;
        console.assert(posted === 1,
            'bindOpenMarksRead: the listener fires the mark exactly once per click');
        console.log('OK: open marks read');
    }

    function checkRunningBadge() {
        const fleet = [
            { path: '/a', state: { activeRunningWorkflows: 2 }, manualActive: 1,
              runningGraphRuns: 3, runningSessionRuns: 4 },
            { path: '/b', state: null, manualActive: 0 } // stopped: missing counters must read as 0
        ];
        const b = runningBreakdown(fleet);
        console.assert(b.workflows === 2 && b.manual === 1 && b.runs === 7,
            'runningBreakdown: sums the three counters, tolerates null state / missing fields');
        console.assert(runningLabel(0) === '0' && runningLabel(99) === '99' && runningLabel(100) === '99+',
            'runningLabel: caps at 99, plus sign beyond');
        const data = { instances: fleet };
        console.assert(scopedInstances(data, null).length === 2,
            'scopedInstances: no param → whole fleet');
        console.assert(scopedInstances(data, '/a').length === 1 && scopedInstances(data, '/a')[0].path === '/a',
            'scopedInstances: param → only that instance');
        console.assert(scopedInstances(data, '/gone').length === 0,
            'scopedInstances: unknown instance → empty (badge reads 0, never the fleet)');
        console.assert(runningTooltip(b, 10, '/x/y/demo').startsWith('Running tasks — …/demo: 10\n'),
            'runningTooltip: scoped title leads with short path + total');
        console.assert(runningTooltip(b, 10, null).startsWith('Running tasks: 10\n'),
            'runningTooltip: fleet title carries no scope');
        console.log('OK: running badge');
    }

    function checkHeroLayout() {
        const base = { kind: 'node_run', id: 'r1', instance_path: '/x/y/openloop',
            node_id: 'n1', success: false, took: 1628, ended_at: Date.now(),
            title: 'nightly-agents-digest', prompt: null, read: false };
        const html = rowHtml(base);
        const head = html.slice(html.indexOf('notif-head'), html.indexOf('notif-meta'));
        console.assert(head.indexOf('notif-path') < head.indexOf('notif-title') &&
            head.includes(`title="${esc(base.instance_path)}"`) &&
            head.includes(`>${esc(shortPath(base.instance_path))}<`),
            'hero: escaped shortPath chip leads the head, full-path tooltip kept');
        console.assert(!head.includes('notif-status') &&
            html.indexOf('notif-status') > html.indexOf('notif-meta') &&
            /notif-status fail[^<]*>✗ failed</.test(html),
            'status: demoted below the hero, glyph + word survive the demotion');
        console.assert(html.indexOf('notif-meta') < html.indexOf('notif-kind') &&
            html.indexOf('notif-kind') < html.indexOf('notif-status'),
            'meta: kind opens the sentence, status follows');
        const hostile = rowHtml({ ...base, instance_path: '/x/"y"<z>/openloop' });
        console.assert(!hostile.includes('<z>') && hostile.includes('&lt;z&gt;') &&
            hostile.includes('&quot;y&quot;'),
            'hero: hostile path (quotes + angle brackets) escaped in the loudest pixel');
        console.assert(headHtml(base, true).includes('notif-title') &&
            !headHtml(base, true).includes('notif-path') &&
            headHtml(base, false).includes('notif-path'),
            'hero: scoped mode drops the chip, fleet keeps it — one renderer');
        console.assert(headHtml(base, false).includes(`href="${deepLink(base)}"`),
            'hero: title deep link unchanged (deepLink regression pin)');
        const long = rowHtml({ ...base, prompt: 'x'.repeat(301) });
        console.assert(long.includes('</div><button class="notif-more" data-key="/x/y/openloop/r1">'),
            'adjacency: .notif-more still the immediate sibling after .notif-prompt');
        console.assert(scopeLabel('/a/b') === ' — …/b' &&
            scopeLabel('') === '' && scopeLabel(null) === '',
            'scopeLabel: scoped toolbar suffix, empty for fleet');
        const noTook = metaHtml({ ...base, took: null });
        console.assert(!noTook.includes('<span></span>') &&
            noTook.split('<span').length - 1 === 3,
            'meta: took-less rows (interrupted runs) drop the slot — kind, status, ago; no dangling separator');
        console.log('OK: hero layout');
    }

    // ── filter sanity (the 5 checks above must stay green UNMODIFIED) ──
    function checkFilterMatch() {
        const n = { title: 'Deploy Migration', instance_path: '/x/y/Demo', prompt: 'fix the C++ build' };
        const t = q => queryTokens(q);
        console.assert(JSON.stringify(t('  Fix  DIGEST ')) === '["fix","digest"]',
            'queryTokens: split on whitespace, lowercase, drop empties');
        console.assert(matches(n, t('fix build')) && matches(n, t('DEMO MIGRATION')),
            'matches: multi-word AND across fields, case-insensitive both directions');
        console.assert(!matches(n, t('digest')) && !matches(n, t('(deploy)?')),
            'matches: absent word (or regex-shaped literal) filters the row out');
        console.assert(matches(n, t('C++')),
            'matches: literal text, never a RegExp — C++ finds C++');
        console.assert(matches(n, []),
            'matches: [] ⇒ filter off — old render path byte-identical');
        console.assert(notifText({ title: 'A', instance_path: 'B', prompt: null }) === 'a b ',
            'notifText: null prompt tolerated');
        console.log('OK: filter match');
    }

    function checkFilterHighlight() {
        const mark = s => `<mark class="hl">${esc(s)}</mark>`;
        const t = q => queryTokens(q);
        console.assert(hl('Fix the deploy', t('fix DEPLOY')) === `${mark('Fix')} the ${mark('deploy')}`,
            'hl: hits marked, source casing kept, query case ignored');
        console.assert(hl('abc', []) === esc('abc') && hl('', t('x')) === '',
            'hl: identity hl(s,[])===esc(s) — the regression pin; empty text safe');
        const both = hl('deploy ploy', t('deploy ploy'));
        console.assert(both === `${mark('deploy')} ${mark('ploy')}`,
            'hl: overlapping tokens never nest — greedy left-to-right');
        const hostile = hl('<script>x</script> deploy', t('script'));
        const stripped = hostile.replace(/<\/?mark[^>]*>/g, '');
        console.assert(!hostile.includes('<script') && stripped === esc('<script>x</script> deploy'),
            'hl: hostile item text stays escaped inside and around marks');
        const hostileQuery = hl('a<b>c', t('<b>'));
        console.assert(!hostileQuery.includes('<b>'),
            'hl: html-shaped query treated as literal text, rendered inert');
        console.log('OK: filter highlight');
    }

    function checkFilterRender() {
        const savedItems = items, savedQuery = query;
        const base = { kind: 'node_run', node_id: 'n1', success: true, took: 1, ended_at: 1, read: false };
        items = [
            { ...base, id: 'r1', instance_path: '/x/deep/project', title: 'deploy-migration', prompt: 'x'.repeat(301) },
            { ...base, id: 'r2', instance_path: '/x/y/other', title: 'unrelated', read: true, prompt: 'a'.repeat(301) + ' deploy' }
        ];
        query = 'deep';
        const tokens = queryTokens(query);
        console.assert(chipHidesHit(items[0], tokens) && !chipHidesHit(items[1], tokens),
            'render: path hit hidden by the short chip detected');
        const row = rowHtml(items[0]);
        console.assert(!row.includes('>…/project<') && row.includes('<mark class="hl">deep</mark>'),
            'render: hidden path hit reveals full path, glowing');
        console.assert(row.includes('notif-prompt truncated') && row.includes('data-key="/x/deep/project/r1"'),
            'render: clamp math untouched — hitless prompt keeps show-more + same key');
        query = 'deploy';
        const row2 = rowHtml(items[1]);
        console.assert(row2.includes('<mark class="hl">deploy</mark>') &&
            row2.includes('notif-prompt expanded') && !row2.includes('notif-more') &&
            !expanded.has('/x/y/other/r2'),
            'render: hit below the fold auto-expands (derived; expanded Set untouched)');
        query = 'zzz';
        const no = noMatchHtml(queryTokens(query));
        console.assert(no.includes('No matches for “zzz”') && no.includes('Clear filter'),
            'render: no-match state echoes the query and offers the escape hatch');
        query = savedQuery;
        items = savedItems;
        console.log('OK: filter render');
    }

    if (ISOLATED_RUN) runSanityChecks();
    else { renderScope(); bindFilter(); load(); setInterval(load, POLL_SECONDS * 1000); }
})();
