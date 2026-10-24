// panel.js — shared right-side detail panel (graph.html + workflow-log.html)
//
// One panel, two poses: desktop = resizable sidebar, <=768px = full-width sheet
// (the sheet rules live in panel.css; this file is the shared physics).
//
// Width memory is SHARED across both pages via localStorage['openloop-panel-w']:
// tune the sidebar on one page and the other greets you with your width — but
// only on desktop; a desktop-saved width must never reach a phone (see the
// guard in initPanelResize).

(function () {
    'use strict';

    // Keep PANEL_DEFAULT_W in sync with --panel-w in panel.css,
    // and MOBILE_BP in sync with the @media (max-width: 768px) breakpoint
    // there (and with the project-wide breakpoint convention in styles.css).
    const PANEL_DEFAULT_W = 420;
    const PANEL_MIN_W     = 320;
    const PANEL_MAX_FRAC  = 0.75;
    const MOBILE_BP       = 768;
    const PANEL_W_KEY     = 'openloop-panel-w';

    const ISOLATED_RUN = false; // flip to true to run sanity checks in DevTools

    function isMobileWidth() { return window.innerWidth <= MOBILE_BP; }

    function clampPanelWidth(w, vw) {
        const floor = Math.min(PANEL_MIN_W, vw); // the floor must never exceed the viewport itself
        return Math.max(floor, Math.min(w, vw * PANEL_MAX_FRAC));
    }

    function shouldRestoreSavedWidth(saved) {
        return !!saved && !isMobileWidth();
    }

    function applyPanelWidth(w) {
        document.documentElement.style.setProperty('--panel-w',
            Math.round(clampPanelWidth(w, window.innerWidth)) + 'px');
    }

    function currentPanelWidth() {
        return parseInt(document.documentElement.style.getPropertyValue('--panel-w')) || PANEL_DEFAULT_W;
    }

    function persistPanelWidth(w) {
        localStorage.setItem(PANEL_W_KEY, String(w));
    }

    function resetPanelWidth() {
        applyPanelWidth(PANEL_DEFAULT_W);
        persistPanelWidth(PANEL_DEFAULT_W);
        announcePanelResized();
    }

    function initPanelResize() {
        const saved = parseInt(localStorage.getItem(PANEL_W_KEY));
        if (shouldRestoreSavedWidth(saved)) applyPanelWidth(saved); // desktop-saved width must not reach a phone
        const handle = document.querySelector('.panel-resize');
        handle.addEventListener('pointerdown', startPanelDrag);
        handle.addEventListener('dblclick', resetPanelWidth);
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
        announcePanelResized();
    }

    // Width settled (drag end or dblclick reset) — never mid-drag, where
    // live re-clamping would feel like the text fighting the cursor.
    // Surfaces that measure painted lines (bubble.js's gate) listen and
    // re-gate: a wider panel can free a folded text, a narrower one folds
    // a free one. OPEN stays OPEN — the door never relocks.
    function announcePanelResized() {
        document.dispatchEvent(new CustomEvent('openloop:panel-resized'));
    }

    // ── Reveal-into-view (shared by graph.js + workflow-log.js) ──────────────
    // When text turns into an editing field, glide the whole editing island
    // (label + field + commit button) fully into view — but only if needed:
    // block:'nearest' is a no-op when already visible. The panel body is the
    // only scroll container on both pages, so nothing else ever moves.
    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function revealOpts(reduced) {
        return { behavior: reduced ? 'auto' : 'smooth', block: 'nearest' };
    }

    function reveal(el) {
        if (el) el.scrollIntoView(revealOpts(reducedMotion()));
    }

    // One conversion = one sequence, identical on both pages: focus first
    // (the OS keyboard is up and the browser has done its own caret scroll),
    // caret to the end of the text (dominant intent: read through, tweak the
    // tail), then correct the geometry so label + field + button share one
    // glance. reveal() then only moves what focus left hidden.
    function focusEditor(input, section) {
        if (!input) return;
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
        reveal(section || input);
    }

    // ── Beacon-into-view (shared by graph.js + workflow-log.js deep links) ──
    // "This one, specifically": ring the arriving row, then center it — but
    // only when the view doesn't already show it. Every thread entry now
    // lands at its tip (the newest turn), and a second scroll would fight
    // that glide; a row the landing already seated keeps its seat, the ring
    // alone does the pointing. Reduced motion → jump, never glide.
    function rowInView(row, scroller) {
        const r = row.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        return r.top >= s.top && r.bottom <= s.bottom;
    }

    function beaconIntoView(row, scroller) {
        if (!row) return;
        row.classList.add('beacon');
        setTimeout(() => row.classList.remove('beacon'), 900);
        if (!scroller || rowInView(row, scroller)) return;
        row.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }

    // ── Armed-confirm micro state machine (shared by both pages' per-turn
    // delete). The thread rows' quiet icon buttons need the Danger-zone
    // grammar at 24px: first click arms (fill + fuse + label swap), second
    // click inside 3s commits, and timeout, blur, or re-render (fresh DOM,
    // fresh listeners) silently disarms — every ambiguity resolves to the
    // SAFE direction. Each button owns its own timer; no page state needed,
    // so an armed button can never outlive its row.
    function armedButton(btn, restLabel, armedLabel, onCommit) {
        let timer = null;
        const disarm = () => {
            clearTimeout(timer);
            btn.classList.remove('armed');
            btn.setAttribute('aria-label', restLabel);
            btn.title = restLabel;
        };
        const arm = () => {
            btn.classList.add('armed');
            btn.setAttribute('aria-label', armedLabel);
            btn.title = armedLabel;
            timer = setTimeout(disarm, 3000);
        };
        btn.addEventListener('blur', disarm);
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            if (btn.classList.contains('armed')) { disarm(); onCommit(btn); return; }
            arm();
        });
    }

    // ── ⌘↵/Ctrl+↵ = submit — ONE grammar for every composer on both pages.
    // Two pages once hand-wrote this keydown and drifted apart (graph.js
    // lost the pieces), so the gesture now lives here, once. WHY blur
    // BEFORE onSubmit: both pages' refresh paths treat a FOCUSED field as
    // a draft in progress (see fieldHasTyping in graph.js) — after a
    // submit the field is neither a draft nor being edited, so the caret
    // must leave it or the refresh silently stalls behind the typing
    // guard (the "⌘↵ sends but the view never updates" bug). The blur is
    // the fix, not a nicety — do not "simplify" it away; graph.js's
    // sanity check pins it.
    function bindCmdEnterSubmit(field, onSubmit) {
        field.addEventListener('keydown', e => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault(); // the shortcut must never type a newline
            field.blur();
            onSubmit();
        });
    }

    // ── Duration grammar (shared by graph.js + workflow-log.js) ──────────────
    // s is SECONDS — never ms, never a timestamp diff (that span includes the post-answer summarization pass).
    const SECONDS_PER_MINUTE = 60;
    const MINUTES_PER_HOUR = 60;
    const MINUTES_ONLY_AFTER = 2 * SECONDS_PER_MINUTE;

    function fmtDur(s) {
        if (s == null || isNaN(s) || s < 0) return '';
        if (s < SECONDS_PER_MINUTE) return s % 1 ? s.toFixed(1) + 's' : Math.round(s) + 's';
        if (s < MINUTES_ONLY_AFTER) {
            const r = Math.round(s % SECONDS_PER_MINUTE);
            return r === SECONDS_PER_MINUTE ? '2m' : (r ? '1m ' + r + 's' : '1m'); // carry — never "1m 60s"
        }
        const m = Math.round(s / SECONDS_PER_MINUTE);
        if (m < MINUTES_PER_HOUR) return m + 'm';
        return m % MINUTES_PER_HOUR ? Math.floor(m / MINUTES_PER_HOUR) + 'h ' + (m % MINUTES_PER_HOUR) + 'm'
            : Math.floor(m / MINUTES_PER_HOUR) + 'h';
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runPanelSanityChecks() {
        checkClampPanelWidth();
        checkRestoreGuard();
        checkRevealOpts();
        checkFmtDur();
        checkArmedButton();
        checkBindCmdEnterSubmit();
        checkBeaconIntoView();
        console.log('All panel sanity checks passed.');
    }

    // The duration grammar is pinned once here — the pages only pin their wiring.
    function checkFmtDur() {
        const f = fmtDur;
        console.assert(f(null) === '' && f(undefined) === '' && f(-1) === '', 'fmtDur: in-flight/invalid guard → empty segment');
        console.assert(f(3) === '3s' && f(59) === '59s' && f(2.5) === '2.5s', 'fmtDur: measurement regime — seconds, one decimal when fractional');
        console.assert(f(60) === '1m' && f(90) === '1m 30s' && f(119) === '1m 59s', 'fmtDur: the 1m band keeps its seconds');
        console.assert(f(119.6) === '2m' && f(119.9) === '2m', 'fmtDur: rounded r=60 carries into the next minute');
        console.assert(f(120) === '2m' && f(125) === '2m' && f(150) === '3m', 'fmtDur: past 2m — rounded whole minutes, no seconds');
        console.assert(f(3600) === '1h' && f(3660) === '1h 1m' && f(5400) === '1h 30m', 'fmtDur: hour tier always present');
        console.log('OK: fmtDur');
    }

    function checkBindCmdEnterSubmit() {
        const field = document.createElement('textarea');
        document.body.appendChild(field);
        let submits = 0;
        bindCmdEnterSubmit(field, () => submits++);
        field.focus();
        const cmdEnter = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true });
        field.dispatchEvent(cmdEnter);
        console.assert(cmdEnter.defaultPrevented, 'cmdEnter: default prevented — no newline rides the shortcut');
        console.assert(submits === 1, 'cmdEnter: ⌘↵ submits exactly once');
        console.assert(document.activeElement !== field, 'cmdEnter: focus leaves the field — the typing guard must not stall the refresh');
        field.focus();
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        console.assert(submits === 1, 'cmdEnter: plain Enter does not submit');
        field.remove();
        console.log('OK: bindCmdEnterSubmit');
    }

    function checkArmedButton() {
        const btn = document.createElement('button');
        let commits = 0;
        armedButton(btn, 'Delete this turn', 'Confirm — delete this turn', () => commits++);
        btn.click();
        console.assert(btn.classList.contains('armed'), 'armedButton: first click arms');
        console.assert(btn.getAttribute('aria-label') === 'Confirm — delete this turn', 'armedButton: aria swaps on arm');
        btn.dispatchEvent(new Event('blur'));
        console.assert(!btn.classList.contains('armed'), 'armedButton: blur disarms');
        console.assert(btn.title === 'Delete this turn', 'armedButton: title restores on disarm');
        btn.click();
        btn.click();
        console.assert(commits === 1, 'armedButton: second click inside the window commits');
        btn.click();
        console.assert(commits === 1, 'armedButton: unarmed click after commit does not fire');
        console.log('OK: armedButton');
    }

    function checkClampPanelWidth() {
        console.assert(clampPanelWidth(9999, 375)  <= 375,  'clamp: 375px phone must never overflow');
        console.assert(clampPanelWidth(960,  375)  <= 375,  'clamp: desktop-saved width fits a phone');
        console.assert(clampPanelWidth(9999, 1280) === 960, 'clamp: desktop 75% cap');
        console.assert(clampPanelWidth(200,  300)  === 300, 'clamp: floor never exceeds a tiny viewport');
        console.assert(clampPanelWidth(400,  1280) === 400, 'clamp: in-range width passes through');
        console.log('OK: clampPanelWidth');
    }

    function checkRestoreGuard() {
        console.assert(shouldRestoreSavedWidth(0)    === false, 'guard: nothing saved -> nothing restored');
        console.assert(shouldRestoreSavedWidth(null) === false, 'guard: null key -> nothing restored');
        console.log('OK: restore guard (phone gate is isMobileWidth(), breakpoint ' + MOBILE_BP + 'px)');
    }

    function checkRevealOpts() {
        console.assert(revealOpts(true).behavior  === 'auto',    'reveal: reduced motion → jump, no glide');
        console.assert(revealOpts(false).behavior === 'smooth',  'reveal: default → smooth glide');
        console.assert(revealOpts(false).block    === 'nearest', 'reveal: scroll only if needed');
        console.log('OK: revealOpts');
    }

    // The beacon's one rule, pinned: the ring always, the centering scroll
    // only for a row the scroller does not already show. The fold half needs
    // a layout engine — jsdom's zero rects read everything as in-view, so
    // skip, don't fake (the fadeDisplay convention).
    function checkBeaconIntoView() {
        const scroller = document.createElement('div');
        const row = document.createElement('div');
        scroller.appendChild(row);
        document.body.appendChild(scroller);
        let centered = 0;
        row.scrollIntoView = () => { centered++; };
        beaconIntoView(row, scroller);
        console.assert(row.classList.contains('beacon'), 'beacon: the row always rings');
        console.assert(centered === 0, 'beacon: a row inside the scroller\'s span never scrolls');
        if (!panelLayoutWorks()) {
            console.log('beacon: fold check skipped — no layout engine (jsdom)');
        } else {
            const filler = document.createElement('div');
            filler.style.height = '400px';
            scroller.style.cssText = 'height:100px;overflow:auto';
            scroller.insertBefore(filler, row); // the row sinks below the fold
            beaconIntoView(row, scroller);
            console.assert(centered === 1, 'beacon: a row out of view centers itself — once');
        }
        scroller.remove();
        console.log('OK: beaconIntoView');
    }

    // jsdom lays out nothing — every rect is zero. A probe with real height
    // tells the two engines apart (bubble.js's layoutWorks, rect edition).
    function panelLayoutWorks() {
        const probe = document.createElement('div');
        probe.style.height = '40px';
        document.body.appendChild(probe);
        const works = probe.getBoundingClientRect().height > 0;
        probe.remove();
        return works;
    }

    window.OpenLoopPanel = {
        PANEL_DEFAULT_W: PANEL_DEFAULT_W,
        isMobileWidth: isMobileWidth,
        clampPanelWidth: clampPanelWidth,
        applyPanelWidth: applyPanelWidth,
        currentPanelWidth: currentPanelWidth,
        persistPanelWidth: persistPanelWidth,
        resetPanelWidth: resetPanelWidth,
        initPanelResize: initPanelResize,
        reducedMotion: reducedMotion,
        revealOpts: revealOpts,
        reveal: reveal,
        beaconIntoView: beaconIntoView,
        focusEditor: focusEditor,
        armedButton: armedButton,
        bindCmdEnterSubmit: bindCmdEnterSubmit,
        fmtDur: fmtDur,
        runPanelSanityChecks: runPanelSanityChecks
    };

    if (ISOLATED_RUN) runPanelSanityChecks();
})();
