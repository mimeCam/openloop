// squeeze.js — the follow-up squeeze UIX both thread views share (graph.html + workflow-log.html); pages wire their seams via wire().
(function () {
    'use strict';

    const ISOLATED_RUN = false;
    const MIN_TURNS = 2;     // the server re-validates the same floor (squeezeSelection)
    const POSE_LINES = 1;    // one line per turn in the pose (panel.css data-free-lines)

    // single-sourced so both pages say the same thing — pinned by this file's suite
    const COPY = {
        tipEnter: 'Squeeze turns — merge older answers into one block',
        hint: 'Select 2+ adjacent turns to squeeze.',
        busy: 'Squeezing the thread — new turns unlock when the merge lands.',
        lock: 'Squeezing — unlocks when the merge lands.',
        fail: 'Squeeze failed — the turns are unchanged.',
        stale: 'Outdated squeeze marker — the merge never landed; it clears on restart.',
        noteHint: 'Optional — steer the squeeze: what to keep, drop, or name…',
        waiting: 'Squeeze waits for the thread — it unlocks when the composer returns.',
    };

    // ── the page contract ──
    let seam = null;

    function wire(page) {
        const keys = ['metaOf', 'draft', 'restore', 'rerender', 'post', 'landed', 'failed'];
        console.assert(keys.every(k => typeof page[k] === 'function'),
            'squeeze: wire() needs every page seam — ' + keys.join(', '));
        seam = page;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    // ── mode state (one thread at a time; reset() on every exit surface) ──
    let mode = false;
    let sel = new Set();  // selected run ids — always ONE contiguous run over thread order
    let anchor = null;    // the selection's first-tapped id — trims release away from it
    let heldDraft = null; // the composer draft held while the mode is on
    let order = [];       // current thread order (ids) — adjacency is seat order, not id math
    let ops = {};         // live squeeze operation per thread root — a marked row carrying another id is stale

    // ── marker predicates: null = plain, an id = held; a marked row whose id is not the thread's live op is stale ──
    function liveOp(thread) {
        return thread.length ? (ops[thread[0].root_run_id || thread[0].id] || 0) : 0;
    }

    function held(l, thread) {
        return !!l.squeeze_operation_id && l.squeeze_operation_id === liveOp(thread);
    }

    function stale(l, thread) {
        return !!l.squeeze_operation_id && l.squeeze_operation_id !== liveOp(thread);
    }

    // One merge per thread, ever, until it lands — the rows themselves carry the busy state.
    function threadSqueezing(thread) {
        return thread.some(l => held(l, thread));
    }

    function eligible(thread) {
        return !threadSqueezing(thread) &&
            thread.filter(l => l.status === 'success' && l.summary).length >= MIN_TURNS;
    }

    // The pages' waiting grammar: a working (or hand-wanting) tip locks the controls, never hides them.
    function waiting(thread) {
        const tip = thread[thread.length - 1];
        return !!tip && !(tip.status === 'success' && tip.summary);
    }

    // The dot is the only control; the bubble keeps 'show more' via bubble.js's data-free-lines contract.
    function isRow(l, thread) {
        return l.status === 'success' && !!l.summary && !held(l, thread);
    }

    // The squeeze is one visible process: every selected row wears the live marker, the newest one carries the SQUEEZING… title.
    function isLanding(l, thread) {
        if (!held(l, thread)) return false;
        return thread.filter(t => held(t, thread)).pop() === l;
    }

    // ── markup ──
    function icon() {
        return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3"/><path d="M8 4l4 4 4-4"/><path d="M5 12h14"/><path d="M12 21v-3"/><path d="M8 20l4-4 4 4"/></svg>`;
    }

    // The under-label is CSS-visible only where space allows (panel.css hides it under 768px) — the pair earns its area.
    function btnHtml(thread) {
        const hidden = eligible(thread) ? '' : ' hidden';
        const active = mode ? ' active' : '';
        const wait = !mode && waiting(thread) ? ' disabled' : '';
        const title = mode ? 'Exit selection' : (wait ? COPY.waiting : COPY.tipEnter);
        return `<button class="squeeze-btn${active}"${hidden}${wait} aria-label="${esc(title)}" title="${esc(title)}">${icon()}<span class="header-btn-label">squeeze</span></button>`;
    }

    // The reader's seat: a small centered pill right after the newest turn — where the reading ends, the squeeze begins.
    function tailHtml(thread) {
        if (mode || !eligible(thread)) return '';
        const wait = waiting(thread) ? ' disabled' : '';
        const title = wait ? COPY.waiting : COPY.tipEnter;
        return `<div class="squeeze-tail-row"><button class="squeeze-tail"${wait} aria-label="${esc(title)}" title="${esc(title)}">${icon()}<span>Squeeze</span></button></div>`;
    }

    // bubbleHtml escapes — feed firstLine raw text, never pre-escaped.
    function firstLine(text) {
        return text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '—';
    }

    function lineHtml(l) {
        if (l.summary) return OpenLoopBubble.bubbleHtml('summary', l.summary, 'sq-line', POSE_LINES);
        return OpenLoopBubble.bubbleHtml('summary', firstLine(l.prompt), 'sq-line dimmed', POSE_LINES);
    }

    function dotHtml(l, thread) {
        const on = sel.has(l.id);
        const dis = isRow(l, thread) ? '' : ' aria-disabled="true"';
        return `<button class="squeeze-dot${on ? ' sel' : ''}" data-run-id="${esc(l.id)}" role="checkbox" aria-checked="${on}"${dis}` +
            ` aria-label="Select this turn for squeezing">${on ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : ''}</button>`;
    }

    // The pose row: dot + the page's own caption (the seam) + chips + the one-liner.
    function entryHtml(l, thread) {
        console.assert(seam, 'squeeze: wire() runs at page load — render before it is a wiring bug');
        const cls = `run-log squeezed${sel.has(l.id) ? ' sq-selected' : ''}`;
        return `<div class="${cls}" data-run-id="${esc(l.id)}">` +
            dotHtml(l, thread) +
            `<div class="sq-body"><div class="run-log-meta"><span>${seam.metaOf(l, thread)}${titleHtml(l, thread)}${staleHtml(l, thread)}</span></div>` +
            lineHtml(l) + `</div></div>`;
    }

    // The chips also seat in the pages' summary head rows — one source, both surfaces.
    function titleHtml(l, thread) {
        if (!isLanding(l, thread)) return '';
        return ` <span class="detail-section-label squeeze busy" title="${esc(COPY.lock)}">SQUEEZING…</span>`;
    }

    // The dead-op twin: a marker whose operation is gone renders as outdated — recoverable, never a hostage.
    function staleHtml(l, thread) {
        return stale(l, thread) ? ` <span class="detail-section-label squeeze stale" title="${esc(COPY.stale)}">SQUEEZE OUTDATED</span>` : '';
    }

    // The dock replaces the composer while the mode is on — the note placeholder is the ask, like the composer's own.
    function dockHtml() {
        const n = sel.size;
        const ready = n >= MIN_TURNS;
        const hint = ready ? `${n} turns selected — the merge lands on the newest.` : COPY.hint;
        const goTitle = ready ? 'Merges these turns into one knowledge block' : COPY.hint;
        return `<div class="squeeze-bar">` +
            `<div class="squeeze-hint" aria-live="polite">${esc(hint)}</div>` +
            `<button class="regen-submit squeeze-cancel" id="squeeze-cancel">Cancel</button>` +
            `<button class="regen-submit squeeze-go${ready ? '' : ' disabled'}" id="squeeze-go"${ready ? '' : ' disabled'}` +
            ` aria-label="${esc(goTitle)}" title="${esc(goTitle)}">${icon()} Squeeze${ready ? ' ' + n : ''}</button>` +
            `<textarea id="squeeze-note" rows="2" aria-label="Steer the squeeze" placeholder="${esc(COPY.noteHint)}" autocomplete="off" spellcheck="false"></textarea></div>`;
    }

    function dockKey() {
        return `squeeze:${orderedIds().join(',')}`;
    }

    // ── selection grammar: ONE unbroken run over order — the server re-validates the same rule ──
    function onDot(id) {
        console.assert(order.includes(id), 'squeeze: dots render only for thread rows');
        if (!sel.size) return startSel(id);
        if (sel.has(id)) return trimSel(id);
        if (adjacentTo(id)) { sel.add(id); return rerender(); }
        startSel(id);
    }

    function startSel(id) {
        sel = new Set([id]);
        anchor = id;
        rerender();
    }

    function adjacentTo(id) {
        const i = order.indexOf(id);
        return sel.has(order[i - 1]) || sel.has(order[i + 1]);
    }

    function trimSel(id) {
        if (id === anchor) { resetSel(); return rerender(); }
        console.assert(anchor && sel.has(anchor), 'squeeze: a non-empty selection always keeps its anchor');
        const a = order.indexOf(anchor), t = order.indexOf(id);
        const [lo, hi] = a < t ? [a, t] : [t, a];
        sel = new Set(order.slice(lo, hi + 1));
        rerender();
    }

    function orderedIds() {
        return order.filter(id => sel.has(id));
    }

    function resetSel() {
        sel = new Set();
        anchor = null;
    }

    // ── mode lifecycle ──
    function enter() {
        heldDraft = seam.draft();
        mode = true;
        resetSel();
        rerender();
        syncActive();
        if (seam.pose) seam.pose(); // the entering beat, where the page has one
    }

    function exit() {
        mode = false;
        resetSel();
        rerender();
        syncActive();
        seam.restore(heldDraft);
        heldDraft = null;
    }

    function toggle() {
        return mode ? exit() : enter();
    }

    function reset() {
        mode = false;
        resetSel();
        heldDraft = null;
        order = [];
    }

    function rerender() {
        seam.rerender(); // rows + footer re-render; the pages read isMode() in their render branches
    }

    // The active flip must land even when the page's re-render had nothing to redraw.
    function syncActive() {
        const btn = squeezeBtnEl();
        if (btn) btn.classList.toggle('active', mode);
    }

    // ── poll sync ──
    function setOps(map) {
        ops = map || {};
    }

    // Every poll re-feeds seat order; rows may vanish or lose eligibility — the selection never holds ghosts.
    function syncOrder(thread) {
        order = thread.map(l => l.id);
        const live = new Set(thread.filter(l => isRow(l, thread)).map(l => l.id));
        const kept = [...sel].filter(id => live.has(id));
        if (kept.length === sel.size) return;
        sel = new Set(kept);
        if (!sel.has(anchor)) anchor = kept.length > 0 ? kept[0] : null;
    }

    // Survives the 5s poll without a header rewrite — only active/hidden/disabled change, never its seat.
    function syncBtn(thread) {
        const btn = squeezeBtnEl();
        if (!btn) return;
        btn.classList.toggle('active', mode);
        if (mode) return; // the mode stays until the user exits it
        btn.hidden = !eligible(thread);
        const wait = waiting(thread); // the tip's wait state flips in place — the header button never re-renders
        btn.disabled = wait;
        const title = wait ? COPY.waiting : COPY.tipEnter;
        btn.title = title;
        btn.setAttribute('aria-label', title);
    }

    function squeezeBtnEl() {
        return document.querySelector('#detail-panel-inner .squeeze-btn');
    }

    // ── binding (fresh DOM per render — the pages' own per-render convention) ──
    function bindDots(scope) {
        scope.querySelectorAll('.squeeze-dot:not([aria-disabled="true"])').forEach(btn =>
            btn.addEventListener('click', () => onDot(btn.dataset.runId)));
    }

    function bindDock() {
        const cancel = document.getElementById('squeeze-cancel');
        const go = document.getElementById('squeeze-go');
        if (cancel) cancel.addEventListener('click', exit);
        if (go && !go.disabled) go.addEventListener('click', submit);
    }

    // ── submit: the note is read before the mode exit tears the dock down ──
    async function submit() {
        const runIds = orderedIds();
        if (runIds.length < MIN_TURNS) return;
        const note = noteValue();
        exit();
        try {
            await seam.post(runIds, note);
            await seam.landed();
        } catch (e) {
            seam.failed(e);
        }
    }

    function noteValue() {
        const el = document.getElementById('squeeze-note');
        return el && el.value ? el.value.trim() : '';
    }

    function isMode() {
        return mode;
    }

    // ── sanity checks (flip ISOLATED_RUN=true to run in DevTools; hermetic — a stub seam records every call) ──

    function sq(id, over) {
        return { id, root_run_id: 'r1', status: 'success', took: 1, created_at: 1, prompt: 'p', output: 'o', summary: 's', ...(over || {}) };
    }

    function stubSeam() {
        const calls = { order: [], posts: [] };
        return {
            calls: calls,
            metaOf: l => `meta:${l.id}`,
            draft: () => { calls.order.push('draft'); return { text: 'held text', note: 'held note' }; },
            restore: d => { calls.order.push('restore'); calls.restored = d; },
            rerender: () => { calls.order.push('rerender'); },
            pose: () => { calls.order.push('pose'); },
            post: async (ids, note) => { calls.order.push('post'); calls.posts.push({ ids, note }); },
            landed: async () => { calls.order.push('landed'); },
            failed: e => { calls.order.push('failed'); calls.error = e; },
        };
    }

    function checkCopy() {
        console.assert(COPY.tipEnter === 'Squeeze turns — merge older answers into one block', 'copy: tipEnter pinned');
        console.assert(COPY.hint === 'Select 2+ adjacent turns to squeeze.', 'copy: hint pinned');
        console.assert(COPY.busy === 'Squeezing the thread — new turns unlock when the merge lands.', 'copy: busy pinned');
        console.assert(COPY.lock === 'Squeezing — unlocks when the merge lands.', 'copy: lock pinned');
        console.assert(COPY.fail === 'Squeeze failed — the turns are unchanged.', 'copy: fail pinned');
        console.assert(COPY.stale === 'Outdated squeeze marker — the merge never landed; it clears on restart.', 'copy: stale pinned');
        console.assert(COPY.noteHint === 'Optional — steer the squeeze: what to keep, drop, or name…', 'copy: noteHint pinned');
        console.assert(COPY.waiting === 'Squeeze waits for the thread — it unlocks when the composer returns.', 'copy: waiting pinned');
        console.assert(MIN_TURNS === 2 && POSE_LINES === 1, 'copy: the grammar pins (2 turns, 1 pose line)');
        console.log('OK: copy + constants');
    }

    function checkMarkers() {
        const saved = ops;
        ops = { r1: 5 };
        const rows = [sq('r1'), sq('r2', { squeeze_operation_id: 5 })];
        console.assert(held(rows[1], rows) && !stale(rows[1], rows), 'markers: the live op holds its row');
        console.assert(threadSqueezing(rows), 'markers: any held row marks the thread');
        console.assert(isLanding(rows[1], rows) && !isLanding(rows[0], rows), 'markers: the newest held row is the landing');
        ops = {}; // the operation died — its markers linger
        console.assert(!held(rows[1], rows) && stale(rows[1], rows), 'markers: a dead op renders the row stale');
        console.assert(!threadSqueezing(rows), 'markers: a stale marker never blocks');
        const zero = [sq('r1'), sq('r2', { squeeze_operation_id: 0 })];
        console.assert(!held(zero[1], zero) && !stale(zero[1], zero), 'markers: a zero id is no marker — it reads as plain');
        ops = { r1: 4 }; // another operation is live — the old marker is still the stale one
        console.assert(!held(rows[1], rows) && stale(rows[1], rows), 'markers: only the live op\'s rows render as merging');
        ops = saved;
        console.log('OK: marker predicates (live · stale · zero · landing)');
    }

    function checkEligibility() {
        const saved = ops;
        ops = {};
        console.assert(eligible([sq('r1'), sq('r2')]), 'eligible: two summarised successes may squeeze');
        console.assert(!eligible([sq('r1')]), 'eligible: one turn never squeezes');
        console.assert(!eligible([sq('r1'), sq('r2', { summary: null })]), 'eligible: a summary-less turn cannot ride');
        console.assert(!eligible([sq('r1'), sq('r2', { status: 'progress' })]), 'eligible: a running turn cannot ride');
        ops = { r1: 5 };
        console.assert(!eligible([sq('r1', { squeeze_operation_id: 5 }), sq('r2')]), 'eligible: a merging thread offers no second squeeze');
        ops = saved;
        console.log('OK: eligibility');
    }

    function checkGrammar() {
        syncOrder(['a', 'b', 'c', 'd'].map(id => sq(id)));
        onDot('b'); onDot('d');
        console.assert(orderedIds().join() === 'd', 'grammar: a far tap restarts the selection');
        onDot('c'); onDot('b');
        console.assert(orderedIds().join() === 'b,c,d', 'grammar: shoulder taps extend in thread order');
        resetSel();
        onDot('b'); onDot('c'); onDot('d');
        onDot('c');
        console.assert(orderedIds().join() === 'b,c', 'grammar: an inside tap trims toward the anchor');
        onDot('b');
        console.assert(orderedIds().join() === '', 'grammar: tapping the anchor clears the selection');
        reset();
        console.log('OK: selection grammar (restart + extend + trim)');
    }

    function checkPoseMarkup() {
        const row = sq('r1');
        const html = entryHtml(row, [row]);
        console.assert(html.includes('squeeze-dot') && html.includes('sq-line') && html.includes('meta:r1'),
            'pose: dot + one-liner + the page caption through the seam');
        console.assert(html.includes('data-free-lines="1"'), 'pose: the one-liner folds at exactly one line');
        console.assert(dotHtml(sq('r1', { status: 'progress' }), [row]).includes('aria-disabled="true"'),
            'pose: ineligible rows carry a disabled dot');
        console.assert(entryHtml(sq('r1', { summary: null }), [sq('r1', { summary: null })]).includes('dimmed'),
            'pose: a summary-less row shows its dimmed first prompt line');
        console.assert(!btnHtml([sq('r1'), sq('r2')]).includes(' hidden'), 'pose: the toggle shows for a squeezable thread');
        console.assert(btnHtml([sq('r1')]).includes(' hidden'), 'pose: the toggle hides without two squeezable turns');
        console.assert(btnHtml([sq('r1'), sq('r2')]).includes('>squeeze</span>'), 'pose: the toggle carries its under-label');
        console.log('OK: pose + toggle markup');
    }

    // The wait gate: the controls render disabled, never gone — the poll re-enables them in place.
    function checkWaitingLock() {
        const rows = [sq('r1'), sq('r2'), sq('r3', { status: 'progress' })];
        console.assert(waiting(rows) && eligible(rows), 'waiting: a working tip locks without un-eligibling the thread');
        const btn = btnHtml(rows);
        console.assert(btn.includes(' disabled') && !btn.includes(' hidden'), 'waiting: the toggle renders disabled, never hidden');
        console.assert(btn.includes(esc(COPY.waiting)), 'waiting: the disabled toggle carries the wait title');
        const tail = tailHtml(rows);
        console.assert(tail.includes(' disabled') && tail.includes(esc(COPY.waiting)), 'waiting: the tail pill locks under the same title');
        console.assert(!waiting([sq('r1'), sq('r2')]), 'waiting: a settled thread waits for nothing');
        for (const over of [{ status: 'summarizing' }, { status: 'failed' }, { summary: null }]) {
            console.assert(waiting([sq('r1'), sq('r2'), sq('r3', over)]), 'waiting: summarizing · failed · summary-less tips all wait');
        }
        const host = document.createElement('div'); // the header button is static DOM on workflow-log — the poll flips it in place
        host.id = 'detail-panel-inner';
        const btnEl = document.createElement('button');
        btnEl.className = 'squeeze-btn';
        host.appendChild(btnEl);
        document.body.insertBefore(host, document.body.firstChild); // first in tree order — squeezeBtnEl() must find mine, never a live panel's
        syncBtn(rows);
        console.assert(btnEl.disabled && btnEl.title === COPY.waiting, 'waiting: syncBtn flips the live button disabled with its title');
        syncBtn([sq('r1'), sq('r2')]);
        console.assert(!btnEl.disabled && btnEl.title === COPY.tipEnter, 'waiting: a settled thread re-enables the live button');
        host.remove();
        console.log('OK: waiting lock (toggle · pill · live sync)');
    }

    // The end-of-thread pill: eligible threads show it after the newest turn — the mode and merges hide it.
    function checkTailPill() {
        const two = [sq('r1'), sq('r2')];
        const html = tailHtml(two);
        console.assert(html.includes('squeeze-tail') && html.includes('>Squeeze</span>'),
            'tail: an eligible thread shows the pill after the last turn');
        console.assert(html.startsWith('<div class="squeeze-tail-row"><button class="squeeze-tail"'),
            'tail: the pill rides its own centered row');
        console.assert(html.includes(COPY.tipEnter), 'tail: the pill carries the enter tooltip');
        console.assert(tailHtml([sq('r1')]) === '', 'tail: an un-squeezable thread shows nothing');
        enter();
        console.assert(tailHtml(two) === '', 'tail: the mode hides the pill — the dock owns the picking');
        exit();
        const saved = ops;
        ops = { r1: 5 };
        console.assert(tailHtml([sq('r1', { squeeze_operation_id: 5 }), sq('r2')]) === '',
            'tail: a merging thread shows nothing');
        ops = saved;
        console.log('OK: tail pill (seat · tooltip · eligibility · mode)');
    }

    function checkDockStates() {
        syncOrder([sq('a'), sq('b'), sq('c')]);
        enter();
        const few = dockHtml();
        console.assert(few.includes(COPY.hint) && few.includes('disabled'), 'dock: below two the go button sleeps');
        onDot('a'); onDot('b'); onDot('c');
        const go = dockHtml();
        console.assert(go.includes('Squeeze 3') && !go.includes('disabled'), 'dock: the count names itself at ≥2');
        console.assert(dockKey() === 'squeeze:a,b,c', 'dock: the footer key speaks the ordered selection');
        console.assert(go.includes('squeeze-note') && go.includes(COPY.noteHint), 'dock: the steer note rides under a hint placeholder');
        exit();
        reset();
        console.log('OK: dock states');
    }

    function checkDraftHold() {
        const live = seam;
        const stub = stubSeam();
        wire(stub);
        syncOrder([sq('a'), sq('b')]);
        enter();
        console.assert(stub.calls.order.indexOf('draft') === 0 &&
            stub.calls.order.includes('rerender') && stub.calls.order.includes('pose'),
            'draft: enter holds the draft first, then re-renders and plays the beat');
        exit();
        console.assert(stub.calls.order.indexOf('restore') > stub.calls.order.lastIndexOf('rerender'),
            'draft: exit re-renders before restoring — the composer must exist again');
        console.assert(stub.calls.restored && stub.calls.restored.text === 'held text' && stub.calls.restored.note === 'held note',
            'draft: the held draft round-trips whole');
        console.assert(!isMode(), 'draft: exit leaves the mode off');
        seam = live;
        reset();
        console.log('OK: draft hold/restore');
    }

    async function checkSubmitFlow() {
        const live = seam;
        const stub = stubSeam();
        wire(stub);
        syncOrder([sq('a'), sq('b')]);
        enter();
        onDot('a');
        await submit();
        console.assert(stub.calls.posts.length === 0, 'submit: below two turns nothing is sent');
        onDot('b');
        const note = document.createElement('textarea');
        note.id = 'squeeze-note';
        note.value = '  keep the numbers  ';
        document.body.appendChild(note);
        await submit();
        note.remove();
        console.assert(stub.calls.posts.length === 1 && stub.calls.posts[0].ids.join() === 'a,b',
            'submit: the ordered ids go whole');
        console.assert(stub.calls.posts[0].note === 'keep the numbers',
            'submit: the note is read trimmed, before the exit tears the dock');
        console.assert(stub.calls.order.indexOf('restore') < stub.calls.order.indexOf('post'),
            'submit: the mode exits before the POST — the composer is back either way');
        console.assert(stub.calls.order.includes('landed') && !stub.calls.order.includes('failed'),
            'submit: a landed POST takes the landing seam');
        const boom = stubSeam();
        boom.post = async () => { throw new Error('409 in flight'); };
        wire(boom);
        syncOrder([sq('a'), sq('b')]);
        enter();
        onDot('a'); onDot('b');
        await submit();
        console.assert(boom.calls.error && boom.calls.error.message === '409 in flight' &&
            boom.calls.order.includes('failed') && !boom.calls.order.includes('landed'),
            'submit: a failed POST speaks through the failure seam');
        seam = live;
        reset();
        console.log('OK: submit flow (guard · note · ordering · failure)');
    }

    function checkPollSync() {
        syncOrder([sq('a'), sq('b'), sq('c')]);
        onDot('b'); onDot('c');
        syncOrder([sq('a'), sq('c')]); // b vanished under the poll
        console.assert(orderedIds().join() === 'c', 'poll: vanished rows drop out of the selection');
        syncOrder([sq('a'), sq('c', { status: 'progress' })]); // c lost eligibility
        console.assert(orderedIds().join() === '', 'poll: rows that lose eligibility drop out too');
        syncOrder([sq('a'), sq('b'), sq('c')]);
        onDot('b'); onDot('c');
        syncOrder([sq('a'), sq('c')]); // the anchor itself vanished — the first survivor takes the seat
        onDot('c');
        console.assert(orderedIds().join() === '', 'poll: a handed-off anchor still clears on its own tap');
        reset();
        console.log('OK: poll sync (prune + anchor handoff)');
    }

    async function runSanityChecks() {
        const live = seam;
        wire(stubSeam());
        checkCopy();
        checkMarkers();
        checkEligibility();
        checkWaitingLock();
        checkGrammar();
        checkPoseMarkup();
        checkTailPill();
        checkDockStates();
        checkDraftHold();
        await checkSubmitFlow();
        checkPollSync();
        seam = live;
        reset();
        console.log('All squeeze sanity checks passed.');
    }

    window.OpenLoopSqueeze = {
        COPY: COPY,
        wire: wire,
        setOps: setOps,
        isMode: isMode,
        held: held,
        stale: stale,
        threadSqueezing: threadSqueezing,
        eligible: eligible,
        waiting: waiting,
        btnHtml: btnHtml,
        tailHtml: tailHtml,
        entryHtml: entryHtml,
        dotHtml: dotHtml,
        titleHtml: titleHtml,
        staleHtml: staleHtml,
        dockHtml: dockHtml,
        dockKey: dockKey,
        onDot: onDot,
        orderedIds: orderedIds,
        syncOrder: syncOrder,
        syncBtn: syncBtn,
        bindDots: bindDots,
        bindDock: bindDock,
        enter: enter,
        exit: exit,
        toggle: toggle,
        reset: reset,
        submit: submit,
        runSanityChecks: runSanityChecks
    };

    if (ISOLATED_RUN) runSanityChecks();
})();
