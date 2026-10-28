(function () {
    'use strict';

    const TRIGGER  = '@';
    const TOKEN_RE = /[^\s@#]/;     // '#' (the node twin, suggest.js) closes an @-token mid-word
    const MD_TIERS = ['md', 'mdx', 'txt'];
    const GRADE    = { none: 0, exact: 100, prefix: 80, word: 60, substring: 40, subsequence: 20 };
    const PATH_GRADE_PENALTY = 5;
    const DEFAULT_LIST_SCORE = 1;
    const DEFAULT_LIMIT = 8;
    const ISOLATED_RUN = false;

    // ── Tokenizer ────────────────────────────────────────────────────────────

    function mentionTokenBefore(text, caret) {
        let i = caret - 1;
        while (i >= 0 && TOKEN_RE.test(text[i])) i--;
        if (i < 0 || text[i] !== TRIGGER) return null;
        return { query: text.slice(i + 1, caret), start: i };
    }

    // The token may end BEYOND the caret: mid-token editing replaces the whole token.
    function mentionTokenEnd(text, start) {
        let i = start + 1;
        while (i < text.length && TOKEN_RE.test(text[i])) i++;
        return i;
    }

    // ── Ranking ──────────────────────────────────────────────────────────────

    function rankEntries(query, entries, limit) {
        const caseSensitive = query !== query.toLowerCase();
        const q = caseSensitive ? query : query.toLowerCase();
        const hits = [];
        for (const e of entries) {
            const score = q ? scoreEntry(q, e, caseSensitive) : DEFAULT_LIST_SCORE;
            if (score !== null) hits.push({ e, score });
        }
        return hits.sort(compareRanked).slice(0, limit || DEFAULT_LIMIT).map(h => h.e);
    }

    function compareRanked(a, b) {
        return tierOf(a.e) - tierOf(b.e) || b.score - a.score
            || depthOf(a.e) - depthOf(b.e) || (b.e.mtimeMs || 0) - (a.e.mtimeMs || 0)
            || a.e.path.localeCompare(b.e.path);
    }

    function scoreEntry(q, entry, caseSensitive) {
        const base = fold(basenameOf(entry.path), caseSensitive);
        const full = fold(entry.path, caseSensitive);
        const gb = matchGrade(base, q);
        const gp = matchGrade(full, q);
        if (gb > GRADE.none || gp > GRADE.none) {
            return Math.max(gb, gp - PATH_GRADE_PENALTY);
        }
        return subsequenceOf(base, q) ? GRADE.subsequence : null;
    }

    function matchGrade(hay, q) {
        if (hay === q) return GRADE.exact;
        if (hay.startsWith(q)) return GRADE.prefix;
        if (wordStarts(hay, q)) return GRADE.word;
        return hay.includes(q) ? GRADE.substring : GRADE.none;
    }

    function wordStarts(hay, q) {
        let i = hay.indexOf(q);
        while (i !== -1) {
            if (i === 0 || /[\/\-_.]/.test(hay[i - 1])) return true;
            i = hay.indexOf(q, i + 1);
        }
        return false;
    }

    function subsequenceOf(hay, q) {
        let i = 0;
        for (const ch of hay) if (ch === q[i]) i++;
        return i === q.length;
    }

    // ── Accept ───────────────────────────────────────────────────────────────

    function applyMention(text, start, path) {
        const end = mentionTokenEnd(text, start);
        const token = TRIGGER + './' + relPath(path);
        const sep = end < text.length && /\s/.test(text[end]) ? '' : ' ';
        return {
            text: text.slice(0, start) + token + sep + text.slice(end),
            caret: start + token.length + 1
        };
    }

    // ── Small pure helpers ───────────────────────────────────────────────────

    function relPath(path) { return path.replace(/^\.?\//, ''); }

    function basenameOf(path) {
        const cut = path.lastIndexOf('/');
        return cut === -1 ? path : path.slice(cut + 1);
    }

    function depthOf(entry) { return entry.path.split('/').length - 1; }

    function tierOf(entry) {
        const dot = entry.path.lastIndexOf('.');
        const ext = dot === -1 ? '' : entry.path.slice(dot + 1).toLowerCase();
        return MD_TIERS.indexOf(ext) === -1 ? 1 : 0;
    }

    function fold(s, caseSensitive) { return caseSensitive ? s : s.toLowerCase(); }

    // ── Sanity checks — flip ISOLATED_RUN=true to run in DevTools ────────────

    function runMentionSanityChecks() {
        checkTokenGrammar();
        checkRankingTiersAndDefaults();
        checkRankingGrades();
        checkSmartCase();
        checkAcceptRewrite();
        console.log('All mention sanity checks passed.');
    }

    function checkTokenGrammar() {
        console.assert(JSON.stringify(mentionTokenBefore('hello @rea', 10)) === '{"query":"rea","start":6}', 'grammar: @query arms');
        console.assert(JSON.stringify(mentionTokenBefore('hello @', 7)) === '{"query":"","start":6}', 'grammar: bare @ arms with empty query');
        console.assert(JSON.stringify(mentionTokenBefore('@readme', 4)) === '{"query":"rea","start":0}', 'grammar: mid-token caret arms the prefix');
        console.assert(mentionTokenBefore('no token here', 13) === null, 'grammar: no @ → no token');
        console.assert(mentionTokenBefore('@a b', 4) === null, 'grammar: whitespace closes the token');
        console.assert(mentionTokenBefore('@a#b', 3) === null, 'grammar: # closes an @-token mid-word (trigger exclusivity)');
        console.assert(mentionTokenBefore('@rea#nod', 8) === null, 'grammar: a whole #name after @… stays closed');
        console.assert(mentionTokenBefore('@./docs/a.md ', 13) === null, 'grammar: accepted mention + space stays closed');
        console.assert(JSON.stringify(mentionTokenBefore('@./a.md @ne', 11)) === '{"query":"ne","start":8}', 'grammar: second @ arms a fresh token');
        console.log('OK: token grammar');
    }

    function checkRankingTiersAndDefaults() {
        const es = [fileEntry('src/spec.swift'), fileEntry('notes/spec.md')];
        console.assert(rankEntries('spec', es)[0].path === 'notes/spec.md', 'tiers: md outranks swift at equal grade');
        console.assert(rankEntries('', [fileEntry('b.md'), fileEntry('a.swift')])[0].path === 'b.md', 'default: md tier leads the empty-query list');
        console.assert(rankEntries('', [fileEntry('deep/nest/x.md'), fileEntry('top.md')])[0].path === 'top.md', 'default: shallower wins inside a tier');
        console.assert(rankEntries('', [fileEntry('old.md', 1), fileEntry('new.md', 2)])[0].path === 'new.md', 'default: newer wins at equal depth');
        console.assert(rankEntries('', [fileEntry('b.md'), fileEntry('a.md'), fileEntry('c.md')]).map(e => e.path)[1] === 'b.md', 'default: alpha breaks the last tie');
        console.assert(rankEntries('', [fileEntry('a.md'), fileEntry('b.md')], 1).length === 1, 'rank: limit slices the list');
        console.log('OK: ranking tiers + default list');
    }

    function checkRankingGrades() {
        const es = [fileEntry('readme-old.md'), fileEntry('readme.md')];
        console.assert(rankEntries('readme.md', es)[0].path === 'readme.md', 'grades: exact basename beats subsequence');
        console.assert(rankEntries('docs', [fileEntry('docsy.swift'), fileEntry('docs/plan.md')])[0].path === 'docs/plan.md',
            'grades: tier first — an md file wins even when the rival matches better');
        console.assert(rankEntries('rea', [fileEntry('docs/README.md')])[0].path === 'docs/README.md', 'grades: path-only matches still rank (case-insensitive)');
        console.assert(rankEntries('rmm', [fileEntry('readme.md'), fileEntry('zzz.txt')]).length === 1, 'grades: subsequence is the last resort');
        console.assert(rankEntries('xyz', [fileEntry('readme.md')]).length === 0, 'grades: no match → no entry');
        console.log('OK: ranking grades');
    }

    function checkSmartCase() {
        console.assert(rankEntries('Rea', [fileEntry('Readme.md')]).length === 1, 'smart-case: mixed-case query matches same-case name');
        console.assert(rankEntries('Rea', [fileEntry('README.md')]).length === 0, 'smart-case: sensitive query refuses differing case');
        console.assert(rankEntries('REA', [fileEntry('readme.md')]).length === 0, 'smart-case: uppercase query refuses lowercase-only names');
        console.assert(rankEntries('rea', [fileEntry('README.md')]).length === 1, 'smart-case: lowercase query is case-insensitive');
        console.log('OK: smart-case');
    }

    function checkAcceptRewrite() {
        const mid = applyMention('see @rea now', 4, 'docs/plan.md');
        console.assert(mid.text === 'see @./docs/plan.md now', 'accept: full ./-path replaces the whole token, single space kept');
        console.assert(mid.caret === 20 && mid.text[mid.caret - 1] === ' ', 'accept: caret lands one past the closer');
        console.assert(mentionTokenBefore(mid.text, mid.caret) === null, 'accept: grammar closed at the landed caret');
        console.assert(applyMention('@old', 0, 'README.md').text === '@./README.md ', 'accept: trailing space added at end of text');
        console.assert(applyMention('@readme', 0, 'README.md').text === '@./README.md ', 'accept: token beyond the caret is replaced whole');
        console.assert(applyMention('@x', 0, './docs/a.md').text === '@./docs/a.md ', 'accept: already-relative path is not double-prefixed');
        console.assert(mentionTokenBefore(applyMention('@x', 0, 'a.md').text, 8) === null, 'accept: the trailing space closes the grammar');
        console.log('OK: accept rewrite');
    }

    function fileEntry(path, mtimeMs) {
        return { path: path, isMarkdown: true, mtimeMs: mtimeMs || 0, sizeBytes: 1 };
    }

    window.OpenLoopMention = {
        mentionTokenBefore: mentionTokenBefore,
        rankEntries: rankEntries,
        applyMention: applyMention,
        // the #node twin (suggest.js) reuses the ranking grammar on node labels
        GRADE: GRADE,
        matchGrade: matchGrade,
        subsequenceOf: subsequenceOf,
        runMentionSanityChecks: runMentionSanityChecks
    };

    if (ISOLATED_RUN) runMentionSanityChecks();
})();
