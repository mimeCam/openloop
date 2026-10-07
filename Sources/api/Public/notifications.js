// notifications.js — /notifications.html page logic.
// ?instance=<path> → that instance's notifications; no param → all instances.
// Read state changes ONLY through the explicit buttons — deep links never mark.
(function () {
    'use strict';

    const instanceParam = new URLSearchParams(location.search).get('instance');
    let items = [];

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
            `<span class="notif-kind">${n.kind === 'workflow' ? 'workflow' : 'node run'}</span>` +
            `<span class="notif-title"><a href="${deepLink(n)}" target="_blank" rel="noopener">${esc(n.title)}</a></span>` +
            `<span class="notif-status ${n.success ? 'ok' : 'fail'}">${n.success ? '✓ succeeded' : '✗ failed'}</span>` +
            `</div>` +
            `<div class="notif-meta">` +
            `<span>${fmtTook(n.took)}</span>` +
            `<span>${relTime(n.ended_at)}</span>` +
            `<span title="${esc(n.instance_path)}">${esc(shortPath(n.instance_path))}</span>` +
            `</div>` +
            (n.prompt ? `<div class="notif-prompt">${esc(n.prompt)}</div>` : '') +
            `</div>` +
            `<a class="notif-open" href="${deepLink(n)}" target="_blank" rel="noopener">open ↗</a>` +
            (n.read ? '' : `<button class="mark-read-btn" data-kind="${esc(n.kind)}" data-ref="${esc(n.id)}" data-inst="${esc(n.instance_path)}">mark read</button>`) +
            `</div>`;
    }

    function kindIcon(n) {
        return n.kind === 'workflow'
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
            : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>';
    }

    function deepLink(n) {
        const inst = encodeURIComponent(n.instance_path);
        return n.kind === 'workflow'
            ? `/workflow-log.html?instance=${inst}&session=${encodeURIComponent(n.session || n.id)}`
            : `/graph.html?instance=${inst}&node=${encodeURIComponent(n.node_id || '')}`;
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
        $('mark-all').onclick = markAllRead;
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

    load();
    setInterval(load, 30000);
})();
