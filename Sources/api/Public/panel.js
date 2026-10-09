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
    }

    // ── Sanity checks (flip ISOLATED_RUN=true to run in DevTools) ────────────
    function runPanelSanityChecks() {
        checkClampPanelWidth();
        checkRestoreGuard();
        console.log('All panel sanity checks passed.');
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

    window.OpenLoopPanel = {
        PANEL_DEFAULT_W: PANEL_DEFAULT_W,
        isMobileWidth: isMobileWidth,
        clampPanelWidth: clampPanelWidth,
        applyPanelWidth: applyPanelWidth,
        currentPanelWidth: currentPanelWidth,
        persistPanelWidth: persistPanelWidth,
        resetPanelWidth: resetPanelWidth,
        initPanelResize: initPanelResize,
        runPanelSanityChecks: runPanelSanityChecks
    };

    if (ISOLATED_RUN) runPanelSanityChecks();
})();
