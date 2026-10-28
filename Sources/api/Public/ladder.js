// ladder.js — the browser twin of GraphStore.ChainResolver (Swift) plus the NODES panel's tap grammar; pure functions, no DOM.
// Input: GET /graph/nodes — the payload's folder order IS the ladder; the resolver mirrors the Swift grammar exactly.
(function () {
    'use strict';

    const ISOLATED_RUN = false;

    // index

    // byId (nearest copy wins), folders in ladder order (first appearance), and each folder's node list
    function indexEntries(entries) {
        const byId = new Map();
        const folders = [];
        const byFolder = new Map();
        for (const e of entries) {
            if (!byId.has(e.id)) byId.set(e.id, e);
            if (!byFolder.has(e.source_path)) {
                byFolder.set(e.source_path, []);
                folders.push(e.source_path);
            }
            byFolder.get(e.source_path).push(e);
        }
        return { byId, folders, byFolder };
    }

    // chain(of:) twin: the ACTIVE ancestor line, oldest → node; the seen-guard is defensive (the server cannot build a parent cycle)
    function chainOf(id, folder) {
        const byId = new Map(folder.map(e => [e.id, e]));
        const line = [];
        const seen = new Set();
        let cur = byId.get(id);
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            if (cur.active !== false) line.push(cur);
            cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
        return line.reverse();
    }

    // the tap grammar is a TREE relation: an inactive middle node still connects the drawn line (all ancestors, active or not)
    function ancestorLineOf(id, folder) {
        const byId = new Map(folder.map(e => [e.id, e]));
        const line = new Set();
        let cur = byId.get(id);
        while (cur && !line.has(cur.id)) {
            line.add(cur.id);
            cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
        }
        return line;
    }

    // the resolver twin

    // resolve(node, entries) → { ids, idSet, via }: ids = resolved chain oldest-first, idSet = the fill question, via = provenance ('own' | {kind:'pick'} | {kind:'upstream', holder, pick}).
    function resolve(node, entries) {
        const idx = indexEntries(entries);
        const home = idx.byId.get(node.id);
        const homePath = home ? home.source_path : projectPath(entries);
        const homeFolder = (idx.byFolder.get(homePath) || []).concat([nodeEntry(node, homePath)]);
        const own = chainOf(node.id, homeFolder);
        const seen = new Set(own.map(e => e.id));
        const via = {};
        own.forEach(e => { via[e.id] = { kind: 'own' }; });
        // segments first, then the own line; `seen` seeded with the own line — first-occurrence-wins, Swift's rule
        const ids = [];
        const root = own[0] || home || nodeEntry(node, homePath);
        expand(root, homePath, idx, ids, seen, via);
        ids.push(...own.map(e => e.id));
        return { ids, idSet: seen, via };
    }

    // a canvas node absent from the payload still resolves as its own one-node line — a failed fetch must not break the panel
    function nodeEntry(node, path) {
        return {
            id: node.id, parent_id: node.parent_id || null,
            assigned_node_ids: node.assigned_node_ids || [],
            active: node.active !== false, source_path: path
        };
    }

    function projectPath(entries) {
        for (const e of entries) if (e.source === 'project') return e.source_path;
        return '';
    }

    function expand(root, holderPath, idx, ids, seen, via) {
        // only ROOTS carry assignments — the parent check ignores hand-edited mid-line fields
        if (root.parent_id != null) return;
        for (const id of (root.assigned_node_ids || [])) {
            if (id === root.id) continue;
            const target = find(id, holderPath, idx);
            if (!target) continue; // dead id — skipped, never an error
            const line = chainOf(target.id, idx.byFolder.get(target.source_path) || []);
            if (line[0]) expand(line[0], target.source_path, idx, ids, seen, via);
            const prov = holderPath === projectPathOf(idx)
                ? { kind: 'pick', pick: id }
                : { kind: 'upstream', holder: root.id, pick: id };
            for (const e of line) {
                if (seen.has(e.id)) continue;
                seen.add(e.id);
                ids.push(e.id);
                via[e.id] = prov;
            }
        }
    }

    function projectPathOf(idx) {
        for (const path of idx.folders) {
            const folder = idx.byFolder.get(path) || [];
            if (folder.length && folder[0].source === 'project') return path;
        }
        return '';
    }

    // nearest-folder-wins id lookup strictly ABOVE the holder's folder ("above" = later in payload order)
    function find(id, holderPath, idx) {
        const at = idx.folders.indexOf(holderPath);
        if (at < 0) return null;
        for (let i = at + 1; i < idx.folders.length; i++) {
            const hit = (idx.byFolder.get(idx.folders[i]) || []).find(e => e.id === id);
            if (hit) return hit;
        }
        return null;
    }

    // the tap grammar (one pick per chain)

    // tap an empty dot → tip; tap a filled non-pick → the tap wins on its line; tap the pick itself → clear; forks coexist.
    function tapAssign(assignedIds, tappedId, entries) {
        const list = (assignedIds || []).filter(x => x);
        const idx = indexEntries(entries);
        const tapped = idx.byId.get(tappedId);
        if (!tapped) return list;
        const folder = idx.byFolder.get(tapped.source_path) || [];
        const ancOfTapped = ancestorLineOf(tappedId, folder);
        const out = [];
        let wasPick = false;
        for (const id of list) {
            if (id === tappedId) { wasPick = true; continue; }
            const e = idx.byId.get(id);
            const comparable = e && e.source_path === tapped.source_path &&
                (ancOfTapped.has(id) || ancestorLineOf(id, folder).has(tappedId));
            if (comparable) continue; // the tap wins on this line
            out.push(id);
        }
        if (!wasPick) out.push(tappedId);
        return out;
    }

    // rail drawing: spine & branch over one folder

    // every node exactly once, DFS pre-order, children by created_at; root-ness = no parent OR a parent outside the folder
    function segments(folderEntries) {
        const ids = new Set(folderEntries.map(e => e.id));
        const byParent = new Map();
        for (const e of folderEntries) {
            const key = (e.parent_id && ids.has(e.parent_id)) ? e.parent_id : null;
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key).push(e);
        }
        const byCreated = (a, b) =>
            (a.created_at || 0) - (b.created_at || 0) || String(a.id).localeCompare(String(b.id));
        const kidsOf = id => (byParent.get(id) || []).slice().sort(byCreated);
        const seen = new Set();
        const out = [];
        function emit(node, depth) {
            if (seen.has(node.id)) return;
            const seg = { indent: depth, nodes: [] };
            extend(seg, node);
            out.push(seg);
            const kids = kidsOf(seg.nodes[seg.nodes.length - 1].id).filter(k => !seen.has(k.id));
            seg.leaf = !kids.length;
            kids.forEach(k => emit(k, depth + seg.nodes.length));
        }
        function extend(seg, node) {
            seen.add(node.id); // malformed links must never hang the walk
            seg.nodes.push(node);
            const kids = kidsOf(node.id).filter(k => !seen.has(k.id));
            if (kids.length === 1) extend(seg, kids[0]);
        }
        kidsOf(null).forEach(r => emit(r, 0));
        return out;
    }

    // sanity checks — flip ISOLATED_RUN=true to run in DevTools; the headless twin runs in node harnesses

    function runLadderSanityChecks() {
        checkResolverAcrossFolders();
        checkResolverEdges();
        checkTapGrammar();
        checkSegments();
        console.log('All ladder sanity checks passed.');
    }

    // prjB's root picks innerB's A3 (a non-root tip); innerB's root A1 picks the share's R2
    function fixture() {
        const mk = (id, parent, ca, assigned, extra) => Object.assign(
            { id: id, parent_id: parent || null, created_at: ca,
              assigned_node_ids: assigned || [], active: true, status: 'success',
              agent: 'cc', name: id.toLowerCase(), source_path: '' }, extra || {});
        const share = '/share', innerB = '/w/innerB', prjB = '/w/prjB';
        const entries = [
            mk('B1', null, 10, ['A3'], { source_path: prjB, source: 'project' }),
            mk('B2', 'B1', 11, null, { source_path: prjB, source: 'project' }),
            mk('A1', null, 1, ['R2'], { source_path: innerB, source: 'parent' }),
            mk('A2', 'A1', 2, null, { source_path: innerB, source: 'parent' }),
            mk('A3', 'A2', 3, null, { source_path: innerB, source: 'parent' }),
            mk('R1', null, 1, null, { source_path: share, source: 'global' }),
            mk('R2', 'R1', 2, null, { source_path: share, source: 'global' })
        ];
        return { entries, share, innerB, prjB };
    }

    function checkResolverAcrossFolders() {
        const f = fixture();
        const r = resolve(f.entries.find(e => e.id === 'B2'), f.entries);
        console.assert(JSON.stringify(r.ids) === JSON.stringify(['R1', 'R2', 'A1', 'A2', 'A3', 'B1', 'B2']),
            'resolve: the three-folder chain flattens oldest-first (root1→root2→A1→A2→A3→B1→B2)');
        console.assert(r.via['B2'].kind === 'own' && r.via['A3'].pick === 'A3',
            'resolve: own line vs the presented root\'s own pick');
        console.assert(r.via['R2'].kind === 'upstream' && r.via['R2'].holder === 'A1' && r.via['R2'].pick === 'R2',
            'resolve: an upstream root\'s pick names holder and pick (the rides-without-picking fill)');
        console.log('OK: resolver across folders');
    }

    function checkResolverEdges() {
        const f = fixture();
        // switched-off target: the target itself drops out, its ACTIVE ancestors still ride
        const off = f.entries.map(e => e.id === 'A3' ? Object.assign({}, e, { active: false }) : e);
        const rOff = resolve(f.entries.find(e => e.id === 'B2'), off);
        console.assert(JSON.stringify(rOff.ids) === JSON.stringify(['R1', 'R2', 'A1', 'A2', 'B1', 'B2']),
            'resolve: a switched-off target drops out itself; its active ancestors still ride');
        // dormant field on a non-root: ignored
        const dormant = f.entries.map(e => e.id === 'A2' ? Object.assign({}, e, { assigned_node_ids: ['R2'] }) : e);
        const rDormant = resolve(f.entries.find(e => e.id === 'B2'), dormant);
        console.assert(JSON.stringify(rDormant.ids) === JSON.stringify(['R1', 'R2', 'A1', 'A2', 'A3', 'B1', 'B2']),
            'resolve: the field on a non-root sleeps (A2\'s pick of R2 adds nothing — R2 already rides via A1)');
        // dead id: skipped silently
        const dead = f.entries.map(e => e.id === 'B1' ? Object.assign({}, e, { assigned_node_ids: ['A3', 'ghost'] }) : e);
        const rDead = resolve(f.entries.find(e => e.id === 'B2'), dead);
        console.assert(JSON.stringify(rDead.ids) === JSON.stringify(['R1', 'R2', 'A1', 'A2', 'A3', 'B1', 'B2']),
            'resolve: a dead id is skipped, never an error');
        // an own-project id is not a legal target (strictly up the ladder)
        const ownPrj = f.entries.map(e => e.id === 'B1' ? Object.assign({}, e, { assigned_node_ids: ['B2'] }) : e);
        const rOwn = resolve(ownPrj.find(e => e.id === 'B1'), ownPrj);
        console.assert(JSON.stringify(rOwn.ids) === JSON.stringify(['B1']),
            'resolve: the holder\'s own folder is never on the lookup path');
        console.log('OK: resolver edges');
    }

    function checkTapGrammar() {
        const f = fixture();
        // fork fixture inside innerB: A2 → {A3, A3b}
        const forked = f.entries.concat([
            Object.assign({}, f.entries[4], { id: 'A3b', created_at: 4, name: 'a3b' })
        ]);
        const tap = (ids, id) => tapAssign(ids, id, forked);
        console.assert(JSON.stringify(tap([], 'A3')) === '["A3"]',
            'tap: an empty dot becomes the tip');
        console.assert(JSON.stringify(tap(['A3'], 'A2')) === '["A2"]',
            'tap: a filled ancestor re-tips the line (shorten)');
        console.assert(JSON.stringify(tap(['A2'], 'A3')) === '["A3"]',
            'tap: an empty dot below the tip extends it');
        console.assert(JSON.stringify(tap(['A3'], 'A3')) === '[]',
            'tap: the tip itself clears');
        console.assert(JSON.stringify(tap(['A3'], 'A3b')) === '["A3","A3b"]',
            'tap: a sibling branch picks beside the others');
        console.assert(JSON.stringify(tap(['A3', 'A3b'], 'A2')) === '["A2"]',
            'tap: the shared trunk re-tips and drops both branch picks');
        console.assert(JSON.stringify(tap(['A3', 'R1'], 'A2')) === '["R1","A2"]',
            'tap: picks in other folders ride untouched, order kept');
        console.assert(JSON.stringify(tap(['ghost'], 'A3')) === '["ghost","A3"]',
            'tap: a dangling id rides untouched');
        console.log('OK: tap grammar');
    }

    function checkSegments() {
        const f = fixture();
        const segs = segments(f.entries.filter(e => e.source_path === f.innerB));
        console.assert(segs.length === 1 && segs[0].leaf === true &&
            segs[0].nodes.map(n => n.id).join('>') === 'A1>A2>A3',
            'segments: one folder line is one spine, oldest first');
        const forked = f.entries.filter(e => e.source_path === f.innerB).concat([
            Object.assign({}, f.entries[4], { id: 'A3b', created_at: 4 })
        ]);
        const forkSegs = segments(forked);
        console.assert(forkSegs.length === 3 &&
            forkSegs[0].nodes.map(n => n.id).join('>') === 'A1>A2' && forkSegs[0].leaf === false &&
            forkSegs[1].indent === 2 && forkSegs[1].nodes[0].id === 'A3' &&
            forkSegs[2].indent === 2 && forkSegs[2].nodes[0].id === 'A3b',
            'segments: the trunk ends at the fork, both branches continue below, indented past it');
        const orphan = [{ id: 'X', parent_id: 'gone', created_at: 1, active: true }];
        console.assert(segments(orphan).length === 1 &&
            segments(orphan)[0].nodes[0].id === 'X',
            'segments: a dangling parent re-roots (drawn, never hidden)');
        console.log('OK: segments');
    }

    window.OpenLoopLadder = {
        resolve: resolve,
        tapAssign: tapAssign,
        segments: segments,
        runLadderSanityChecks: runLadderSanityChecks
    };

    if (ISOLATED_RUN) runLadderSanityChecks();
})();
