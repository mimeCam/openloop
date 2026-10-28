// suggest.js — the suggestion dropdown every composer field shares: @ files (mention.js ranking) + # nodes (RUN routes only, armed per field).
// Data is lazy, cached per instance; the dropdown is a singleton on document.body so it survives the pages' 5s poll re-renders.
(function () {
    'use strict';

    const FILE_TRIGGER = '@';
    const NODE_TRIGGER = '#';
    const NODE_TOKEN_RE = /[^\s#@]/;   // @ closes a #-token, exactly as # closes an @-token (mention.js)
    const FILE_LIMIT = 8;
    const NODE_LIMIT = 8;
    const MIN_DROP_WIDTH = 240;
    const ISOLATED_RUN = false;

    // single-sourced so every field says the same thing — showComposer swaps per mode
    const HINT = 'Type @file to attach · #node to reuse a node’s tools';
    const HINT_FILES = 'Type @file to attach';

    // lazy per-instance data

    // fetch-once-per-page-load; a rejected load evicts its entry so the next trigger retries
    const fileCache = new Map();   // instance -> Promise<{files, truncated}>
    const nodeCache = new Map();   // instance -> Promise<{nodes}>

    function cached(cache, key, load) {
        if (!cache.has(key)) {
            cache.set(key, load().catch(err => { cache.delete(key); throw err; }));
        }
        return cache.get(key);
    }

    function filesAt(instance) {
        return cached(fileCache, instance, () =>
            fetch(`/api/instances/${encodeURIComponent(instance)}/files`).then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            }));
    }

    function nodesAt(instance) {
        return cached(nodeCache, instance, () =>
            fetch(`/api/instances/${encodeURIComponent(instance)}/graph/nodes`).then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            }));
    }

    // # tokenizer (the mention.js twin; each trigger closes the other)

    function nodeTokenBefore(text, caret) {
        let i = caret - 1;
        while (i >= 0 && NODE_TOKEN_RE.test(text[i])) i--;
        if (i < 0 || text[i] !== NODE_TRIGGER) return null;
        return { query: text.slice(i + 1, caret), start: i };
    }

    // the token may end BEYOND the caret — mid-token editing replaces it whole
    function nodeTokenEnd(text, start) {
        let i = start + 1;
        while (i < text.length && NODE_TOKEN_RE.test(text[i])) i++;
        return i;
    }

    // accept keeps #name as PLAIN TEXT (the human's anchor); the id is recorded separately — multi-word names ride the token
    function applyNodeRef(text, start, label) {
        const end = nodeTokenEnd(text, start);
        const token = NODE_TRIGGER + label;
        const sep = end < text.length && /\s/.test(text[end]) ? '' : ' ';
        return {
            text: text.slice(0, start) + token + sep + text.slice(end),
            caret: start + token.length + 1
        };
    }

    // # ranking — mention.js's grades on node labels instead of paths

    function nodeLabel(node) {
        const name = (node.name || '').trim();
        if (name) return name;
        return node.agent || String(node.id).slice(0, 8);
    }

    function rankNodes(query, nodes, limit) {
        const M = window.OpenLoopMention;
        const cap = limit || NODE_LIMIT;
        if (!query) {
            // default list: the API's ladder order, active nodes promoted
            return nodes.slice().sort((a, b) => (b.active === true) - (a.active === true)).slice(0, cap);
        }
        const caseSensitive = query !== query.toLowerCase();
        const q = caseSensitive ? query : query.toLowerCase();
        const fold = s => caseSensitive ? s : s.toLowerCase();
        const hits = [];
        for (const n of nodes) {
            const label = fold(nodeLabel(n));
            let score = M.matchGrade(label, q);
            if (!score) score = M.subsequenceOf(label, q) ? M.GRADE.subsequence : 0;
            if (score) hits.push({ n, score });
        }
        hits.sort((a, b) => b.score - a.score || nodes.indexOf(a.n) - nodes.indexOf(b.n));
        return hits.slice(0, cap).map(h => h.n);
    }

    // accepted # records — keyed by FIELD ID, not the element: the poll rewrites the element, ids are stable

    const refRecords = new Map();   // fieldId -> Map<nodeId, label>

    function recordsFor(field) {
        const id = field && field.id;
        if (!id) return null;
        if (!refRecords.has(id)) refRecords.set(id, new Map());
        return refRecords.get(id);
    }

    function recordNodeRef(field, node) {
        const recs = recordsFor(field);
        if (recs) recs.set(node.id, nodeLabel(node));
    }

    // recorded ids whose #label is still literally present — deleting the mention deletes the reference
    function nodeIdsFor(field) {
        const recs = field && field.id ? refRecords.get(field.id) : null;
        if (!recs || !recs.size) return [];
        const text = field.value || '';
        const ids = [];
        for (const [id, label] of recs) {
            if (text.includes(NODE_TRIGGER + label)) ids.push(id);
        }
        return ids;
    }

    function resetRefs(field) {
        if (field && field.id) refRecords.delete(field.id);
    }

    // the dropdown (singleton on body — outlives poll re-renders)

    let drop = null;          // the live <div id="suggest-drop">, when open
    let openState = null;     // {field, instance, place, items, active}

    function ensureDropdown() {
        if (drop) return drop;
        drop = document.createElement('div');
        drop.id = 'suggest-drop';
        drop.className = 'suggest-drop';
        drop.setAttribute('role', 'listbox');
        drop.setAttribute('aria-label', 'Suggestions');
        drop.hidden = true;
        // pointerdown (not click) is where focus is decided — swallow it so a row press never blurs the field
        drop.addEventListener('pointerdown', e => e.preventDefault());
        drop.addEventListener('click', e => {
            const item = e.target.closest('[data-sug-idx]');
            if (item && openState) acceptItem(parseInt(item.dataset.sugIdx, 10));
        });
        document.body.appendChild(drop);
        return drop;
    }

    function closeDropdown() {
        if (!drop) return;
        drop.hidden = true;
        drop.textContent = '';
        if (openState && openState.field.isConnected) {
            openState.field.removeAttribute('aria-activedescendant');
            openState.field.setAttribute('aria-expanded', 'false');
        }
        openState = null;
    }

    function positionDropdown(field, place) {
        const rect = field.getBoundingClientRect();
        drop.style.left = `${Math.max(8, Math.round(rect.left))}px`;
        drop.style.width = `${Math.max(MIN_DROP_WIDTH, Math.round(rect.width))}px`;
        if (place === 'above') {
            // bottom-pinned docks: the list unfolds UP, out from under the composer
            drop.style.top = 'auto';
            drop.style.bottom = `${Math.max(8, Math.round(window.innerHeight - rect.top + 6))}px`;
        } else {
            drop.style.bottom = 'auto';
            drop.style.top = `${Math.round(rect.bottom + 6)}px`;
        }
    }

    function rowNodes(rowsHtml) {
        drop.innerHTML = rowsHtml;
        drop.hidden = false;
    }

    function itemHtml(idx, inner, aria) {
        return `<div class="suggest-item" role="option" id="suggest-opt-${idx}" data-sug-idx="${idx}" aria-label="${aria}">${inner}</div>`;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    // the file's weight: line count when known, size as the capped fallback; ≥1000 lines (~10k tokens) wears amber
    const HEAVY_LINES = 1000;

    function fileRowHtml(idx, entry) {
        const md = entry.isMarkdown ? ' md' : '';
        return itemHtml(idx,
            `<span class="sug-path${md}">${esc(entry.path)}</span>` + fileMetaHtml(entry),
            `${esc(entry.path)} · ${fileMetaText(entry)}`);
    }

    function fileMetaHtml(entry) {
        const heavy = entry.lines != null && entry.lines >= HEAVY_LINES ? ' heavy' : '';
        return `<span class="sug-lines${heavy}" title="${esc(fileMetaTitle(entry))}">${esc(fileMetaText(entry))}</span>`;
    }

    function fileMetaText(entry) {
        return entry.lines != null ? fmtLines(entry.lines) : fmtBytes(entry.sizeBytes);
    }

    function fileMetaTitle(entry) {
        return entry.lines != null
            ? `${fmtLines(entry.lines)} · ${fmtBytes(entry.sizeBytes)}`
            : `too large to count lines · ${fmtBytes(entry.sizeBytes)}`;
    }

    function fmtLines(n) {
        return `${n.toLocaleString('en-US')} lines`;
    }

    function fmtBytes(b) {
        if (b == null) return '?';
        if (b < 1024) return `${b} B`;
        const steps = [['GB', 1073741824], ['MB', 1048576], ['KB', 1024]];
        for (const [unit, floor] of steps) {
            if (b >= floor) {
                const v = b / floor;
                return `${v >= 9.95 ? Math.round(v) : Math.round(v * 10) / 10} ${unit}`;
            }
        }
    }

    function nodeRowHtml(idx, node) {
        const label = esc(nodeLabel(node));
        const src = esc(node.source || '');
        const count = node.chain_mcp_count || 0;
        return `<div class="suggest-item${node.active === false ? ' off' : ''}" role="option" id="suggest-opt-${idx}"
            data-sug-idx="${idx}" aria-label="${NODE_TRIGGER}${label} · ${count} MCPs along its resolved chain · from ${src}">
            <span class="sug-name">${NODE_TRIGGER}${label}</span>
            <span class="sug-meta">
                <span class="sug-mcp" title="MCP endpoints along this node’s resolved chain (its own + ancestors’ + standing assignments’)">${count} mcp</span>
                <span class="sug-src ${src}">${src}</span>
            </span>
        </div>`;
    }

    function msgRowHtml(text, isFoot) {
        return `<div class="${isFoot ? 'sug-foot' : 'suggest-empty'}">${esc(text)}</div>`;
    }

    function setActive(idx) {
        if (!openState) return;
        openState.active = idx;
        const rows = drop.querySelectorAll('.suggest-item');
        rows.forEach((row, i) => {
            const on = i === idx;
            row.classList.toggle('active', on);
            if (on) row.setAttribute('aria-selected', 'true'); else row.removeAttribute('aria-selected');
        });
        const cur = rows[idx];
        if (cur) {
            cur.scrollIntoView({ block: 'nearest' });
            openState.field.setAttribute('aria-activedescendant', cur.id);
        }
    }

    // open + refresh

    // each armed token bumps the generation — a late answer to an older query must never clobber the newer one
    let refreshGen = 0;

    function renderFileItems(token, files, truncated) {
        if (!files.length) {
            openState.items = [];
            rowNodes(msgRowHtml(`no files match “${token.query}”`));
            return;
        }
        openState.items = files.map(f => ({ kind: 'file', entry: f }));
        rowNodes(files.map((f, i) => fileRowHtml(i, f)).join('') +
            (truncated ? msgRowHtml('file list truncated · type more letters to narrow', true) : ''));
        setActive(0);
    }

    function renderNodeItems(token, nodes) {
        if (!nodes.length) {
            openState.items = [];
            rowNodes(msgRowHtml(`no nodes match “${token.query}”`));
            return;
        }
        openState.items = nodes.map(n => ({ kind: 'node', node: n }));
        rowNodes(nodes.map((n, i) => nodeRowHtml(i, n)).join(''));
        setActive(0);
    }

    function refresh(field, instance, place) {
        const text = field.value || '';
        const caret = field.selectionStart;
        if (caret === null || caret !== field.selectionEnd) { closeDropdown(); return; }  // no selections

        // the per-field # switch — read live so a mode flip takes effect on the next keystroke
        const bind = bound.get(field);
        const nodeTok = (!bind || bind.nodes !== false) ? nodeTokenBefore(text, caret) : null;
        const fileTok = window.OpenLoopMention.mentionTokenBefore(text, caret);
        // an @-token and a #-token can never both be armed — whichever exists wins
        const tok = nodeTok || fileTok;
        if (!tok) { closeDropdown(); return; }
        const trigger = text[tok.start];
        if (openState && openState.field === field && drop && !drop.hidden &&
            openState.trigger === trigger && openState.query === tok.query) {
            positionDropdown(field, place);   // caret moved inside the same token: just re-seat
            return;
        }
        if (openState) {
            if (openState.field !== field) closeDropdown();
            openState = null;
            if (drop) drop.textContent = '';
        }
        openState = { field, instance, place, items: [], active: 0, trigger, query: tok.query, gen: ++refreshGen };
        const gen = openState.gen;
        field.setAttribute('aria-autocomplete', 'list');
        field.setAttribute('aria-expanded', 'true');
        ensureDropdown();          // create-on-open: nothing before this point ever needed it
        positionDropdown(field, place);
        rowNodes(msgRowHtml('loading…'));
        if (trigger === FILE_TRIGGER) {
            filesAt(instance).then(data => {
                if (!openState || openState.field !== field || openState.gen !== gen) return;
                const files = (data.files || []).map(f => ({
                    path: f.path, isMarkdown: f.isMarkdown, mtimeMs: f.mtimeMs,
                    sizeBytes: f.sizeBytes, lines: f.lines
                }));
                renderFileItems(tok, window.OpenLoopMention.rankEntries(tok.query, files, FILE_LIMIT), data.truncated);
            }).catch(() => {
                if (!openState || openState.field !== field || openState.gen !== gen) return;
                rowNodes(msgRowHtml('couldn’t load the file list'));
            });
        } else {
            nodesAt(instance).then(data => {
                if (!openState || openState.field !== field || openState.gen !== gen) return;
                renderNodeItems(tok, rankNodes(tok.query, data.nodes || []));
            }).catch(() => {
                if (!openState || openState.field !== field || openState.gen !== gen) return;
                rowNodes(msgRowHtml('couldn’t load the node list'));
            });
        }
    }

    // accept

    function acceptItem(idx) {
        if (!openState || !openState.items[idx]) return;
        const item = openState.items[idx];
        const field = openState.field;
        const text = field.value || '';
        const caret = field.selectionStart;
        // re-derive the token at the caret — no token (caret left it) means stale, just close
        const tok = item.kind === 'file'
            ? window.OpenLoopMention.mentionTokenBefore(text, caret)
            : nodeTokenBefore(text, caret);
        if (!tok) { closeDropdown(); return; }
        const apply = item.kind === 'file'
            ? window.OpenLoopMention.applyMention(text, tok.start, item.entry.path)
            : applyNodeRef(text, tok.start, nodeLabel(item.node));
        if (item.kind === 'node') recordNodeRef(field, item.node);
        field.value = apply.text;
        field.setSelectionRange(apply.caret, apply.caret);
        closeDropdown();
        // the pages keep their own listeners (draft save, send pill state) — re-fire input so they see the text
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
    }

    // keyboard

    function onKeyDown(e) {
        const field = e.target;
        const bind = bound.get(field);
        if (!bind || !openState || openState.field !== field || !drop || drop.hidden) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            if (!openState.items.length) return;
            const n = openState.items.length;
            const dir = e.key === 'ArrowDown' ? 1 : -1;
            setActive((openState.active + dir + n) % n);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (e.metaKey || e.ctrlKey || e.altKey) return;   // ⌘↵/Ctrl+↵ belongs to the submit binding
            if (!openState.items.length) { closeDropdown(); return; }
            e.preventDefault();
            e.stopPropagation();
            acceptItem(openState.active);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();   // the pages' Escape (close panel/composer) must not fire under the dropdown
            closeDropdown();
        }
    }

    // binding

    const bound = new WeakMap();   // field -> {instance, place}

    function bindField(field, opts) {
        if (!field) return;
        const instance = opts && opts.instance;
        const place = (opts && opts.place) === 'above' ? 'above' : 'below';
        // nodes:false disarms the # trigger for this field (default: on)
        const nodes = !(opts && opts.nodes === false);
        bound.set(field, { instance, place, nodes });

        field.addEventListener('input', () => { if (document.activeElement === field) refresh(field, instance, place); });
        // caret moves without input: arrows, click-into-token, focus via tab
        field.addEventListener('keyup', e => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            refresh(field, instance, place);
        });
        field.addEventListener('click', () => refresh(field, instance, place));
        field.addEventListener('keydown', onKeyDown);
        field.addEventListener('blur', () => {
            // a row press never lands here (pointerdown is swallowed upstream); a real blur closes
            if (openState && openState.field === field) closeDropdown();
        });
    }

    // flip the # trigger on an already-bound field — the modal composer's mode switch
    function setNodeRefs(field, on) {
        const bind = field && bound.get(field);
        if (bind) bind.nodes = on !== false;
    }

    // follow the field while anything scrolls; if the poll rewrite detached the field, the dropdown is moot
    window.addEventListener('scroll', () => {
        if (!openState || !drop || drop.hidden) return;
        if (!openState.field.isConnected) { closeDropdown(); return; }
        positionDropdown(openState.field, openState.place);
    }, true);
    window.addEventListener('resize', () => {
        if (!openState || !drop || drop.hidden) return;
        if (!openState.field.isConnected) { closeDropdown(); return; }
        positionDropdown(openState.field, openState.place);
    });

    // pins the real DOM open path — refresh must create the dropdown before positioning it
    function checkRefreshOpens() {
        const field = document.createElement('textarea');
        field.id = 'sanity-suggest-refresh';
        document.body.appendChild(field);           // refresh fires only on the focused field
        bindField(field, { instance: 'sanity', place: 'above' });
        field.value = '#wri';
        field.focus();
        field.setSelectionRange(4, 4);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const d = document.getElementById('suggest-drop');
        console.assert(d && !d.hidden, 'open: typing #wri creates the dropdown and shows it');
        console.assert(d && /loading|node/.test(d.textContent), 'open: the open path renders a row');
        closeDropdown();
        field.remove();
        console.log('OK: refresh opens the dropdown');
    }

    // sanity checks — flip ISOLATED_RUN=true to run in DevTools

    // the per-field # switch through the real DOM path
    function checkNodeRefsSwitch() {
        const field = document.createElement('textarea');
        field.id = 'sanity-suggest-nodes-off';
        document.body.appendChild(field);
        bindField(field, { instance: 'sanity', place: 'above', nodes: false });
        field.value = '#wri';
        field.focus();
        field.setSelectionRange(4, 4);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        const d = document.getElementById('suggest-drop');
        console.assert(d && d.hidden, 'nodesOff: # stays plain text — the dropdown never opens');
        setNodeRefs(field, true);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        console.assert(d && !d.hidden, 'nodesOn: setNodeRefs re-arms # on the bound field');
        closeDropdown();
        setNodeRefs(field, false);
        field.value = '@not';
        field.setSelectionRange(4, 4);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        console.assert(d && !d.hidden, 'filesOn: @ still opens with # disarmed');
        closeDropdown();
        field.remove();
        console.log('OK: per-field # switch');
    }

    function runSuggestSanityChecks() {
        checkNodeTokenGrammar();
        checkTriggerExclusivity();
        checkRankNodes();
        checkApplyNodeRef();
        checkRefRecords();
        checkRefreshOpens();
        checkNodeRefsSwitch();
        checkFileMeta();
        console.log('All suggest sanity checks passed.');
    }

    // the row markup and the two formatters — the server-side halves are pinned by TextSniffTests
    function checkFileMeta() {
        const light = { path: 'notes.md', isMarkdown: true, mtimeMs: 1, sizeBytes: 1_234, lines: 42 };
        const heavy = { path: 'big/table.csv', isMarkdown: false, mtimeMs: 1, sizeBytes: 4_500_000, lines: 48_120 };
        const capped = { path: 'huge.log', isMarkdown: false, mtimeMs: 1, sizeBytes: 9 * 1024 * 1024, lines: null };
        const lightRow = fileRowHtml(0, light);
        console.assert(lightRow.includes('42 lines'), 'fileMeta: the row speaks its line count');
        console.assert(!lightRow.includes('heavy'), 'fileMeta: a light file stays quiet gray');
        const heavyRow = fileRowHtml(1, heavy);
        console.assert(heavyRow.includes('48,120 lines') && heavyRow.includes('heavy'),
            'fileMeta: a heavy file formats with grouping and wears amber');
        console.assert(heavyRow.includes('· 48,120 lines'), 'fileMeta: the aria label carries the count');
        const cappedRow = fileRowHtml(2, capped);
        console.assert(cappedRow.includes('9 MB'), 'fileMeta: a capped file falls back to its size');
        console.assert(fileMetaTitle(capped).includes('too large to count lines'),
            'fileMeta: the capped title says why there is no count');
        console.assert(fmtLines(0) === '0 lines' && fmtLines(1000) === '1,000 lines',
            'fileMeta: line formatting groups thousands');
        console.assert(fmtBytes(0) === '0 B' && fmtBytes(2047) === '2 KB' &&
            fmtBytes(2 * 1048576) === '2 MB' && fmtBytes(3 * 1073741824) === '3 GB' &&
            fmtBytes(null) === '?',
            'fileMeta: byte formatting rounds to one decimal, unknown speaks ?');
        console.log('OK: file meta (lines · size)');
    }

    function checkNodeTokenGrammar() {
        console.assert(JSON.stringify(nodeTokenBefore('hi #write', 9)) === '{"query":"write","start":3}', 'grammar: #query arms');
        console.assert(JSON.stringify(nodeTokenBefore('hi #', 4)) === '{"query":"","start":3}', 'grammar: bare # arms empty');
        console.assert(nodeTokenBefore('no token', 8) === null, 'grammar: no # -> no token');
        console.assert(nodeTokenBefore('#a b', 4) === null, 'grammar: whitespace closes the token');
        console.assert(nodeTokenBefore('#Full Name', 10) === null, 'grammar: space inside a name closes (single-token grammar)');
        console.log('OK: # token grammar');
    }

    function checkTriggerExclusivity() {
        const M = window.OpenLoopMention;
        console.assert(nodeTokenBefore('#a@b', 4) === null, 'exclusivity: @ closes a #-token mid-word');
        console.assert(nodeTokenBefore('#nod@rea', 8) === null, 'exclusivity: a whole @mention after #… stays closed');
        console.assert(M.mentionTokenBefore('@a#b', 3) === null, 'exclusivity: # closes an @-token mid-word (mention.js)');
        console.assert(nodeTokenBefore('@rea', 4) === null, 'exclusivity: an @-token alone does not arm #');
        console.assert(M.mentionTokenBefore('#rea', 4) === null, 'exclusivity: a #-token alone does not arm @');
        console.log('OK: trigger exclusivity');
    }

    function checkRankNodes() {
        const nodes = [
            { id: '1', name: 'writer', agent: 'claude', active: true, source: 'project', chain_mcp_count: 2 },
            { id: '2', name: 'reader', agent: 'gpt', active: true, source: 'global', chain_mcp_count: 0 },
            { id: '3', name: '', agent: 'gemini', active: true, source: 'parent', chain_mcp_count: 1 }
        ];
        console.assert(rankNodes('wri', nodes)[0].id === '1', 'rank: prefix leads');
        console.assert(rankNodes('gem', nodes)[0].id === '3', 'rank: agent is the fallback label of a nameless node');
        console.assert(rankNodes('wrr', nodes)[0].id === '1', 'rank: subsequence is the last resort');
        console.assert(rankNodes('xyz', nodes).length === 0, 'rank: no match at all -> empty');
        console.assert(rankNodes('rea', nodes)[0].id === '2', 'rank: substring still ranks');
        const d = rankNodes('', [{ id: '4', name: 'z', active: false }, { id: '5', name: 'a', active: true }]);
        console.assert(d[0].id === '5' && d.length === 2, 'rank: default list promotes active nodes, keeps all');
        console.assert(rankNodes('wri', nodes, 1).length === 1, 'rank: limit slices');
        console.log('OK: node ranking');
    }

    function checkApplyNodeRef() {
        const one = applyNodeRef('see #wri now', 4, 'writer');
        console.assert(one.text === 'see #writer now', 'accept: whole label replaces the token, single space kept');
        console.assert(one.caret === 12 && one.text[one.caret - 1] === ' ', 'accept: caret lands one past the closer');
        const multi = applyNodeRef('use #sq here', 4, 'SQL Fixer');
        console.assert(multi.text === 'use #SQL Fixer here', 'accept: multi-word name rides inside the token');
        console.assert(applyNodeRef('#old', 0, 'x').text === '#x ', 'accept: trailing space at end of text');
        console.assert(applyNodeRef('#x', 0, 'y').text === '#y ', 'accept: token beyond the caret is replaced whole');
        console.log('OK: node accept');
    }

    function checkRefRecords() {
        const field = document.createElement('textarea');
        field.id = 'sanity-suggest-field';
        bindField(field, { instance: 'sanity', place: 'above' });
        recordNodeRef(field, { id: 'n1', name: 'writer' });
        field.value = 'reuse #writer for this';
        console.assert(JSON.stringify(nodeIdsFor(field)) === '["n1"]', 'records: live #name -> id out');
        field.value = 'reuse nothing here';
        console.assert(nodeIdsFor(field).length === 0, 'records: deleting the mention drops the id');
        resetRefs(field);
        field.value = 'reuse #writer again';
        console.assert(nodeIdsFor(field).length === 0, 'records: reset clears the record');
        console.log('OK: node reference records');
    }

    window.OpenLoopSuggest = {
        HINT: HINT,
        HINT_FILES: HINT_FILES,
        bindField: bindField,
        setNodeRefs: setNodeRefs,
        nodeIds: nodeIdsFor,
        reset: resetRefs,
        runSuggestSanityChecks: runSuggestSanityChecks
    };

    if (ISOLATED_RUN) runSuggestSanityChecks();
})();
