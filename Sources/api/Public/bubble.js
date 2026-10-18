// bubble.js — shared text-reveal grammar (graph.html + workflow-log.html)
//
// The rule is visual, not typographic: a text that paints in FREE_LINES
// (10) lines or fewer where it lives is shown in full, no chrome; one that
// paints in more folds to CLAMP_LINES (3) lines and offers one quiet
// one-way door, "show more". The line count belongs to the surface, not
// the string: the same text may be free in the wide panel and folded on a
// 240px card, and both readings are correct.
//
// Render contract (one script turn — no frame of unfolded long text ever
// paints): build FREE markup with bubbleHtml(), inject it, then call
// gateBubbles() synchronously. The scrollHeight read forces layout BEFORE
// paint, folding over-limit texts and un-hiding their door in the same
// pass (both pages' panels are only ever translated off-screen, never
// display:none — a hidden box measures 0 lines).
//
// Measurement: line height comes from getComputedStyle px (the unitless
// 1.65 in panel.css resolves to px in Chrome/Firefox/current Safari; older
// WebKit reports the raw ratio — detected, backed out of font-size). The
// compare is a threshold, never an exact count, so sub-pixel drift over
// 10+ wrapped lines cannot mis-gate; and it always measures the FREE pose
// (unfold-measure-refold): a clamped -webkit-box can report
// scrollHeight === clientHeight in some engines.
//
// Cross-browser contract (Safari · Firefox · Chrome): keep the
// -webkit-box / -webkit-line-clamp / overflow:hidden trio — the only
// clamp dialect all three engines speak (Firefox aliases the prefix);
// keep the mask dual-prefixed; no `lh` units anywhere (Safari 16.4+ only).

(function () {
    'use strict';

    // Keep FREE_LINES / CLAMP_LINES in sync with the .wl-bubble-text.truncated
    // clamp in panel.css, and LINE_HEIGHT_FALLBACK with its line-height.
    const FREE_LINES           = 10;   // ≤ 10 painted lines → shown in full
    const CLAMP_LINES          = 3;    // > 10 → folded pose (the CSS clamp)
    const LINE_HEIGHT_FALLBACK = 1.65; // only if computed line-height comes back unitless (old WebKit)
    const LINE_BOX_FLOOR       = 4;    // px — a used line-height is never this small
    const HALF_LINE_EPSILON    = 0.5;  // threshold slack for sub-pixel drift

    const ISOLATED_RUN = false; // flip to true to run sanity checks in DevTools

    function esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function copyIcon() {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">` +
            `<rect x="9" y="9" width="13" height="13" rx="2"/>` +
            `<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>` +
            `</svg>`;
    }

    // Markup only, always FREE: no truncated class, the door hidden. `extra`
    // rides the text element for page typography ('result-snippet',
    // 'summary-text') — never a second truncation voice. There is no char
    // threshold anymore: lines are a property of the reading, and only
    // gateBubbles() may fold — after layout, per surface.
    function bubbleHtml(cls, text, extra) {
        const textCls = extra ? `wl-bubble-text ${extra}` : 'wl-bubble-text';
        return `<div class="wl-bubble ${cls}">` +
            `<div class="${textCls}">${esc(text)}</div>` +
            `<button class="wl-expand-btn" hidden aria-expanded="false">show more</button>` +
            `<button class="wl-bubble-copy">${copyIcon()}</button>` +
            `</div>`;
    }

    // One line box, px. The unitless 1.65 in panel.css resolves to used px
    // in Chrome/Firefox/current Safari; older WebKit reports the raw ratio
    // ("1.65") — anything under LINE_BOX_FLOOR falls back to font-size × 1.65.
    function lineHeightOf(el) {
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return (lh && lh >= LINE_BOX_FLOOR)
            ? lh
            : parseFloat(getComputedStyle(el).fontSize) * LINE_HEIGHT_FALLBACK;
    }

    function linesOf(el) {
        return el.scrollHeight / lineHeightOf(el);
    }

    // Over the free pass? Threshold compare (never an exact count), always
    // on the FREE pose: unfold-measure-refold, because a clamped
    // -webkit-box can report scrollHeight === clientHeight in some engines.
    // The refold is a no-op for texts that were not folded.
    function isOverLimit(el) {
        const folded = el.classList.contains('truncated');
        if (!folded) return linesOf(el) > FREE_LINES + HALF_LINE_EPSILON;
        el.classList.remove('truncated');
        const over = linesOf(el) > FREE_LINES + HALF_LINE_EPSILON;
        el.classList.add('truncated');
        return over;
    }

    function doorOf(text) {
        return text.parentElement.querySelector('.wl-expand-btn');
    }

    // Post-inject pass, same script turn as the innerHTML write: over the
    // pass → fold + unhide the door; within it → free, door stays hidden.
    // OPEN (.expanded) texts are never re-folded — the door never relocks.
    function gateBubbles(container) {
        container.querySelectorAll('.wl-bubble-text').forEach(t => {
            if (t.classList.contains('expanded')) return;
            const over = isOverLimit(t);
            t.classList.toggle('truncated', over);
            const btn = doorOf(t);
            if (btn) btn.hidden = !over;
        });
    }

    // Once per page, at init. Delegated on document in the CAPTURE phase: a
    // door inside a click-target card (grid cells open the panel on click)
    // is heard BEFORE the card's own bubble-phase listener — stopPropagation
    // keeps the tap a fold-opening, not a fold-and-open-panel. One binding
    // also survives every innerHTML rewrite (5s polls, sub-section swaps)
    // with zero listener stacking.
    function bindExpand(root) {
        (root || document).addEventListener('click', onDoorTap, true);
    }

    function onDoorTap(e) {
        const btn = e.target.closest ? e.target.closest('.wl-expand-btn') : null;
        if (!btn || btn.hidden) return;
        e.stopPropagation();
        openDoor(btn);
    }

    // The reveal: the fold dissolves (the mask transition in panel.css) and
    // the door is consumed — there is no "show less"; the grammar is
    // one-way. Focus rides into the text when the door held it (keyboard),
    // so it never falls to <body>; a pointer click keeps focus where it was.
    function openDoor(btn) {
        const text = btn.parentElement.querySelector('.wl-bubble-text');
        if (!text) return;
        const heldFocus = document.activeElement === btn;
        text.classList.remove('truncated');
        text.classList.add('expanded');
        btn.remove();
        if (heldFocus) focusText(text);
    }

    function focusText(text) {
        text.tabIndex = -1;
        text.focus({ preventScroll: true });
    }

    // Expansion memory across the 5s poll re-renders. Only OPEN doors are
    // recorded: a FREE text whose text later grows re-enters in its correct
    // (folded) pose, an OPEN one never relocks — when text grows under an
    // open fold, open wins. Key = first 200 chars, so appended growth
    // (streaming) keeps the key.
    function snapshotExpansion(container) {
        const open = new Map();
        container.querySelectorAll('.wl-bubble-text.expanded')
            .forEach(t => open.set(expansionKey(t), true));
        return open;
    }

    function restoreExpansion(container, snap) {
        container.querySelectorAll('.wl-bubble-text').forEach(t => {
            if (!snap.get(expansionKey(t))) return;
            t.classList.remove('truncated');
            t.classList.add('expanded');
            const btn = doorOf(t);
            if (btn) btn.remove();
        });
    }

    function expansionKey(t) {
        return t.textContent.slice(0, 200);
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runBubbleSanityChecks() {
        checkBubbleHtmlShape();
        if (!layoutWorks()) {
            console.log('Bubble checks: markup verified; gate/door/memory checks skipped — no layout engine (jsdom).');
            return;
        }
        checkLineGate();
        checkDoorOpens();
        checkSnapshotMemory();
        console.log('All bubble sanity checks passed.');
    }

    // scrollHeight is 0 for everything without a layout engine (jsdom) —
    // the gate/door/memory checks are meaningless there. Skip, don't fake
    // (same convention as graph.js's fadeDisplay probe).
    function layoutWorks() {
        const probe = document.createElement('div');
        probe.style.whiteSpace = 'pre';
        probe.textContent = 'a\nb';
        document.body.appendChild(probe);
        const works = probe.scrollHeight > 0;
        probe.remove();
        return works;
    }

    // Focus must work inside the probe, so no visibility:hidden — fixed at
    // the viewport corner instead (checks are a DevTools-only flash).
    function probeHost() {
        const host = document.createElement('div');
        host.style.cssText = 'width:360px;position:fixed;top:0;left:0';
        document.body.appendChild(host);
        return host;
    }

    // Explicit \n breaks make the painted line count deterministic at any
    // probe width (white-space:pre-wrap honors them) — no font guessing.
    function linesText(n) {
        return Array.from({ length: n }, (_, i) => 'line ' + (i + 1)).join('\n');
    }

    function checkBubbleHtmlShape() {
        const html = bubbleHtml('output error', 'hi "there" <&>', 'result-snippet');
        console.assert(html.includes('class="wl-bubble output error"'), 'bubbleHtml: variant classes ride the bubble');
        console.assert(html.includes('class="wl-bubble-text result-snippet"'), 'bubbleHtml: extra class rides the text');
        console.assert(html.includes('&quot;') && html.includes('&lt;&amp;&gt;'), 'bubbleHtml: text is escaped');
        console.assert(html.includes('<button class="wl-expand-btn" hidden aria-expanded="false">'), 'bubbleHtml: door ships hidden');
        console.assert(!html.includes('truncated'), "bubbleHtml: markup is FREE — folding is gateBubbles' job, never a char guess");
        console.assert(!html.includes('wl-bubble-label'), 'bubbleHtml: the dead label param stays dead');
        console.log('OK: bubbleHtml shape (free markup, hidden door, escaped)');
    }

    function checkLineGate() {
        const host = probeHost();
        [[2, false], [10, false], [11, true], [40, true]].forEach(([n, fold]) => {
            host.innerHTML = bubbleHtml('output', linesText(n));
            gateBubbles(host);
            const text = host.querySelector('.wl-bubble-text');
            const door = host.querySelector('.wl-expand-btn');
            console.assert(text.classList.contains('truncated') === fold,
                'gate: ' + n + ' lines → ' + (fold ? 'folded' : 'free'));
            console.assert(door && door.hidden === !fold,
                'gate: ' + n + ' lines → door ' + (fold ? 'offered' : 'hidden'));
            assertClampPose(text, fold);
        });
        host.remove();
        console.log('OK: line gate (≤10 free · ≥11 folds at 3)');
    }

    // Computed clamp styles are engine-dependent in jsdom — skip, don't
    // fake (same convention as graph.js's fadeDisplay probe).
    function assertClampPose(text, fold) {
        const clamp = getComputedStyle(text).webkitLineClamp;
        if (clamp === undefined || clamp === '') return;
        console.assert((clamp === String(CLAMP_LINES)) === fold, 'gate: clamp pose matches the fold');
    }

    function checkDoorOpens() {
        const host = probeHost();
        bindExpand(host);
        let cardTaps = 0;
        const card = document.createElement('div');
        card.addEventListener('click', () => cardTaps++); // the cell's selectNode stand-in
        card.innerHTML = bubbleHtml('output', linesText(40));
        host.appendChild(card);
        gateBubbles(host);
        const door = card.querySelector('.wl-expand-btn');
        door.focus();
        door.click();
        const text = card.querySelector('.wl-bubble-text');
        console.assert(text.classList.contains('expanded') && !text.classList.contains('truncated'), 'door: opens the fold, one-way');
        console.assert(!card.querySelector('.wl-expand-btn'), 'door: consumed on use — no show less');
        console.assert(cardTaps === 0, 'door: the tap never reaches the card (no fold-and-open-panel)');
        console.assert(document.activeElement === text, 'door: focus hands off into the whole text');
        host.remove();
        console.log('OK: door opens in place, is consumed, hands focus off');
    }

    function checkSnapshotMemory() {
        const host = probeHost();
        bindExpand(host);
        host.innerHTML = bubbleHtml('output', linesText(40)) + bubbleHtml('output', linesText(2));
        gateBubbles(host);
        console.assert(snapshotExpansion(host).size === 0, 'snapshot: only OPEN doors recorded — folded and free are not');
        host.querySelector('.wl-expand-btn').click();
        const snap = snapshotExpansion(host);
        host.innerHTML = bubbleHtml('output', linesText(40)) + bubbleHtml('output', linesText(2));
        restoreExpansion(host, snap);
        gateBubbles(host);
        const first = host.querySelectorAll('.wl-bubble-text')[0];
        const doors = [...host.querySelectorAll('.wl-expand-btn')];
        console.assert(first.classList.contains('expanded'), 'snapshot/restore: an open door survives the re-render');
        console.assert(doors.length === 1 && doors[0].hidden, 'snapshot/restore: the free text keeps its hidden door');
        host.remove();
        console.log('OK: expansion memory across re-renders');
    }

    window.OpenLoopBubble = {
        FREE_LINES: FREE_LINES,
        CLAMP_LINES: CLAMP_LINES,
        bubbleHtml: bubbleHtml,
        lineHeightOf: lineHeightOf,
        linesOf: linesOf,
        isOverLimit: isOverLimit,
        gateBubbles: gateBubbles,
        bindExpand: bindExpand,
        snapshotExpansion: snapshotExpansion,
        restoreExpansion: restoreExpansion,
        expansionKey: expansionKey,
        layoutWorks: layoutWorks,
        runBubbleSanityChecks: runBubbleSanityChecks
    };

    if (ISOLATED_RUN) runBubbleSanityChecks();
})();
