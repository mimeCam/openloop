// notifications.js — /notifications.html page logic.
// ?instance=<path> → that instance's notifications; no param → all instances.
// Read state changes via the explicit buttons or "open ↗" (followed link = seen); title deep links never mark.
(function () {
    'use strict';

    const instanceParam = new URLSearchParams(location.search).get('instance');
    const POLL_SECONDS = 30; // list + running badge both ride this cadence
    let items = [];
    const ISOLATED_RUN = false; // flip to true to run sanity checks in DevTools

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
        return (await fetchJson(`${instBase(inst)}?limit=100`)).items || [];
    }

    async function loadAll() {
        const data = await fetchJson('/api/instances');
        const lists = await Promise.all(
            (data.instances || []).map(i =>
                fetchJson(`${instBase(i.path)}?limit=100`)
                    .then(r => r.items || [])
                    .catch(() => [])
            )
        );
        return lists.flat().sort((a, b) => b.ended_at - a.ended_at);
    }

    // ── running-tasks badge (grammar cloned from app.js updateRunningBubble) ──
    // Same /api/instances counters as the home page badge. ?instance= scopes
    // this page, so the badge follows the page's scope, not the fleet's.
    const runningBadgeLabelCap = 99;
    let lastRunningTotal = 0;

    function scopedInstances(data, param) {
        const all = data.instances || [];
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
        if (!items.length) {
            $('list').innerHTML = '<div class="empty">No notifications yet</div>';
            return;
        }
        $('list').innerHTML = items.map(rowHtml).join('');
        bindRows();
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
            `<div class="notif-body">` +
            `<div class="notif-head">` +
            `<span class="notif-kind">${kindLabel(n)}</span>` +
            `<span class="notif-title"><a href="${deepLink(n)}" target="_blank" rel="noopener">${esc(n.title)}</a></span>` +
            `<span class="notif-status ${n.success ? 'ok' : 'fail'}">${n.success ? '✓ succeeded' : '✗ failed'}</span>` +
            `</div>` +
            `<div class="notif-meta">` +
            `<span>${fmtTook(n.took)}</span>` +
            `<span>${relTime(n.ended_at)}</span>` +
            `<span title="${esc(n.instance_path)}">${esc(shortPath(n.instance_path))}</span>` +
            `</div>` +
            (n.prompt ? promptHtml(n) : '') +
            `</div>` +
            `<a class="notif-open" href="${deepLink(n)}" target="_blank" rel="noopener" data-kind="${esc(n.kind)}" data-ref="${esc(n.id)}" data-inst="${esc(n.instance_path)}">open ↗</a>` +
            (n.read ? '' : `<button class="mark-read-btn" data-kind="${esc(n.kind)}" data-ref="${esc(n.id)}" data-inst="${esc(n.instance_path)}">mark read</button>`) +
            `</div>`;
    }

    // The clamp can bite when chars fill ~3 wrapped lines OR when extra
    // newlines overflow 3 rendered lines — both need the "show more" out;
    // a clamp with no escape hatch is trapped content.
    function isLongPrompt(p) {
        return p.length > PROMPT_THRESHOLD || p.split('\n').length > 3;
    }

    // Sole render site of the user's ask. The clamp is CSS-only — the full
    // text always ships in the markup (screen readers get everything); JS
    // never substrings user text.
    function promptHtml(n) {
        if (!n.prompt) return '';
        if (expanded.has(expandKey(n))) return `<div class="notif-prompt expanded">${esc(n.prompt)}</div>`;
        if (!isLongPrompt(n.prompt)) return `<div class="notif-prompt">${esc(n.prompt)}</div>`;
        return `<div class="notif-prompt truncated" title="${esc(n.prompt)}">${esc(n.prompt)}</div>` +
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

    function bindRows() {
        $('list').querySelectorAll('.mark-read-btn').forEach(btn =>
            btn.addEventListener('click', () => markRead(btn.dataset)));
        // "open ↗" doubles as the read receipt — target="_blank" lets the mark POST ride along with navigation.
        $('list').querySelectorAll('.notif-open').forEach(a =>
            a.addEventListener('click', () => {
                const n = items.find(x => x.id === a.dataset.ref && x.instance_path === a.dataset.inst);
                if (n && !n.read) markRead(a.dataset);
            }));
        $('list').querySelectorAll('.notif-more').forEach(btn =>
            btn.addEventListener('click', () => expandPrompt(btn)));
        $('mark-all').onclick = markAllRead;
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

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runSanityChecks() {
        checkDeepLink();
        checkPromptClamp();
        checkOpenMarksRead();
        checkRunningBadge();
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

    if (ISOLATED_RUN) runSanityChecks();
    else { load(); setInterval(load, POLL_SECONDS * 1000); }
})();
