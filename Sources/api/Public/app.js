document.addEventListener('DOMContentLoaded', function() {
    console.log('DEBUG: DOMContentLoaded, app.js loaded');
    const content = document.getElementById('content');
    const refreshBtn = document.getElementById('refreshBtn');
    console.log('DEBUG: content element:', content);
    console.log('DEBUG: refreshBtn element:', refreshBtn);

    let autoRefreshInterval;
    let countdownInterval;
    let countdownValue = 30;
    let personaCache = {};
    let workflowCache = {};
    let instanceStateCache = {};
    let currentInlineEditor = null;
    let savedInlineEditor = null;
    let expandedInstances = new Set();
    let instancePersonas = {};
    let instanceWorkflows = {};
    let instancePersonaStats = {};
    let instancePersonaLogs = {};
    let instanceManualWorkflows = {};
    let globalDragState = { active: false, personaId: null, personaName: null };
    let currentLang = localStorage.getItem('openloop-lang') || 'en';
    let currentHelpDoc = null;
    let instanceParentMap = {};
    let parentInstanceData = {};
    let globalSharePaths = new Set();

    function toSlug(value) {
        return value
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    function updateSlugPreview(editor) {
        const idInput = editor.querySelector('[data-field="id"]');
        const nameInput = editor.querySelector('[data-field="name"]');
        const preview = editor.querySelector('.slug-preview');
        if (!preview) return;

        const idVal = idInput ? idInput.value.trim() : '';
        const nameVal = nameInput ? nameInput.value.trim() : '';
        const source = idVal || nameVal;
        const slug = toSlug(source);

        if (slug) {
            preview.querySelector('.slug-value').textContent = slug;
            preview.classList.add('visible');
        } else {
            preview.classList.remove('visible');
        }
    }

    function setEditingState(personaList, editingNode) {
        personaList?.classList.add('editing');
        editingNode?.classList.add('is-editing');
    }

    function clearEditingState() {
        document.querySelector('.persona-list.editing')?.classList.remove('editing');
        document.querySelector('.persona-node.is-editing')?.classList.remove('is-editing');
    }

    function getInstanceColor(path, rootPath, depth) {
        const hueSource = rootPath || path;
        let hash = 0;
        for (let i = 0; i < hueSource.length; i++) {
            hash = hueSource.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = Math.abs(hash % 360);
        const d = depth || 0;
        const saturation = Math.max(22, 40 - d * 8);
        const lightness = Math.min(97, 90 + d * 3);
        return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    }

    function getInstanceHue(path, rootPath) {
        const hueSource = rootPath || path;
        let hash = 0;
        for (let i = 0; i < hueSource.length; i++) {
            hash = hueSource.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Math.abs(hash % 360);
    }

    // ─── Parent Instance Sections ───

    function getParentChain(path) {
        const chain = [];
        let current = path;
        const visited = new Set();
        while (instanceParentMap[current] !== undefined && !visited.has(current)) {
            visited.add(current);
            const parent = instanceParentMap[current];
            if (!parent || !instanceParentMap.hasOwnProperty(parent)) break;
            chain.push(parent);
            current = parent;
        }
        globalSharePaths.forEach(gp => {
            if (!chain.includes(gp)) chain.push(gp);
        });
        return chain;
    }

    function renderParentSectionsHtml(parentPaths, mode, currentInstancePath) {
        if (!parentPaths || parentPaths.length === 0) return '';
        let sections = '';
        parentPaths.forEach(pp => {
            const isGlobal = globalSharePaths.has(pp);
            const parts = pp.split('/').filter(c => c.length > 0);
            const name = parts[parts.length - 1] || pp;
            const dotStyle = isGlobal
                ? 'background:hsl(38, 55%, 58%)'
                : `background:hsl(${getInstanceHue(pp, pp)}, 45%, 58%)`;
            const label = isGlobal
                ? 'Global (system-wide)'
                : `Parent: ${escapeHtml(name)}`;
            sections += `
            <div class="parent-section" data-parent-path="${escapeHtml(pp)}" data-current-instance-path="${escapeHtml(currentInstancePath || '')}"${isGlobal ? ' data-global-share="true"' : ''}>
                <div class="parent-section-header" role="button" aria-expanded="false" tabindex="0" data-mode="${mode}">
                    <span class="parent-section-dot" style="${dotStyle}"></span>
                    <svg class="parent-section-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    <span class="parent-section-label">${label}</span>
                    <span class="parent-section-count">\u2014</span>
                </div>
                <div class="parent-section-body"></div>
            </div>`;
        });
        return `<div class="parent-sections-divider"></div>${sections}`;
    }

    async function fetchParentPersonas(parentPath) {
        if (!parentInstanceData[parentPath]) parentInstanceData[parentPath] = {};
        if (parentInstanceData[parentPath].personas) return parentInstanceData[parentPath].personas;
        const personas = await fetchPersonas(parentPath);
        parentInstanceData[parentPath].personas = personas;
        return personas;
    }

    async function fetchParentWorkflows(parentPath) {
        if (!parentInstanceData[parentPath]) parentInstanceData[parentPath] = {};
        if (parentInstanceData[parentPath].workflows) return parentInstanceData[parentPath].workflows;
        const workflows = await fetchWorkflows(parentPath);
        parentInstanceData[parentPath].workflows = workflows;
        return workflows;
    }

    async function toggleParentSectionExpand(header) {
        const section = header.closest('.parent-section');
        const body = section.querySelector('.parent-section-body');
        const parentPath = section.dataset.parentPath;
        const mode = header.dataset.mode;
        const isExpanded = header.getAttribute('aria-expanded') === 'true';
        const isGlobal = section.dataset.globalShare === 'true';

        if (isExpanded) {
            header.setAttribute('aria-expanded', 'false');
            body.classList.remove('open');
            return;
        }

        header.setAttribute('aria-expanded', 'true');

        if (!body.innerHTML.trim()) {
            body.innerHTML = '<div class="parent-section-empty">Loading\u2026</div>';
            body.classList.add('open');
            try {
                if (mode === 'personas') {
                    const personas = await fetchParentPersonas(parentPath);
                    const countBadge = header.querySelector('.parent-section-count');
                    if (countBadge) countBadge.textContent = personas.length + ' persona' + (personas.length !== 1 ? 's' : '');
                    const emptyMsg = isGlobal
                        ? 'No system-wide personas. Add personas to ~/.local/share/openloop/personas/ to share across all projects.'
                        : 'No personas in this instance.';
                    body.innerHTML = personas.length === 0
                        ? `<div class="parent-section-empty">${emptyMsg}</div>`
                        : '<div class="persona-list">' + renderPersonasHtml(personas, parentPath) + '</div>';
                } else if (mode === 'workflows') {
                    const workflows = await fetchParentWorkflows(parentPath);
                    const countBadge = header.querySelector('.parent-section-count');
                    if (countBadge) countBadge.textContent = workflows.length + ' workflow' + (workflows.length !== 1 ? 's' : '');
                    const emptyMsg = isGlobal
                        ? 'No system-wide workflows. Add workflows to ~/.local/share/openloop/workflows/ to share across all projects.'
                        : 'No workflows in this instance.';
                    body.innerHTML = workflows.length === 0
                        ? `<div class="parent-section-empty">${emptyMsg}</div>`
                        : '<div class="workflow-list">' + renderWorkflowsHtml(workflows, parentPath) + '</div>';
                }
            } catch (err) {
                console.error('Failed to load parent instance data:', err);
                body.innerHTML = '<div class="parent-section-error">Failed to load. <button class="parent-section-retry">Retry</button></div>';
            }
        } else {
            body.classList.add('open');
        }

        // Re-apply active search filter to include newly rendered items
        const subview = section.closest('.subview');
        if (subview) {
            const searchInput = subview.querySelector('.subview-search');
            if (searchInput && searchInput.value) applySubviewFilter(searchInput);
        }
    }

    async function togglePickerParentSection(header, selector, instancePath, workflowId) {
        const section = header.closest('.parent-section');
        const body = section.querySelector('.parent-section-body');
        const parentPath = section.dataset.parentPath;
        const mode = header.dataset.mode;
        const isExpanded = header.getAttribute('aria-expanded') === 'true';
        const isGlobal = section.dataset.globalShare === 'true';

        if (isExpanded) {
            header.setAttribute('aria-expanded', 'false');
            body.classList.remove('open');
            return;
        }

        header.setAttribute('aria-expanded', 'true');

        if (!body.innerHTML.trim()) {
            body.innerHTML = '<div class="parent-section-empty">Loading\u2026</div>';
            body.classList.add('open');
            try {
                if (mode === 'personas') {
                    const pp = await fetchParentPersonas(parentPath);
                    const countBadge = header.querySelector('.parent-section-count');
                    if (countBadge) countBadge.textContent = pp.length + ' item' + (pp.length !== 1 ? 's' : '');
                    const emptyMsg = isGlobal ? 'No system-wide personas.' : 'No personas in this instance.';
                    body.innerHTML = pp.length === 0
                        ? `<div class="parent-section-empty">${emptyMsg}</div>`
                        : pp.map(p => `<div class="persona-selector-item" data-persona-id="${escapeHtml(p.id)}">${getAvatarHtml(p.avatar)}<div class="persona-selector-info"><div class="persona-selector-name-row"><span class="persona-selector-name">${escapeHtml(p.name)}</span>${p.role ? `<span class="persona-selector-role">${escapeHtml(p.role)}</span>` : ''}</div>${p.about ? `<span class="persona-selector-about">${escapeHtml(p.about)}</span>` : ''}</div></div>`).join('');
                } else if (mode === 'workflows') {
                    const ww = await fetchParentWorkflows(parentPath);
                    const filtered = ww.filter(w => w.id !== workflowId);
                    const countBadge = header.querySelector('.parent-section-count');
                    if (countBadge) countBadge.textContent = filtered.length + ' item' + (filtered.length !== 1 ? 's' : '');
                    const emptyMsg = isGlobal ? 'No system-wide workflows.' : 'No workflows in this instance.';
                    body.innerHTML = filtered.length === 0
                        ? `<div class="parent-section-empty">${emptyMsg}</div>`
                        : filtered.map(w => `<div class="persona-selector-item workflow-selector-item" data-workflow-id="${escapeHtml(w.id)}"><span class="workflow-selector-icon">\u25CB</span><div class="persona-selector-info"><div class="persona-selector-name-row"><span class="persona-selector-name">${escapeHtml(w.name)}</span></div>${w.desc ? `<span class="persona-selector-about">${escapeHtml(w.desc)}</span>` : ''}</div></div>`).join('');
                }
            } catch (err) {
                console.error('Failed to load parent instance data:', err);
                body.innerHTML = '<div class="parent-section-error">Failed to load. <button class="parent-section-retry">Retry</button></div>';
            }
        } else {
            body.classList.add('open');
        }

        // Re-apply active search filter to include newly rendered items
        applySelectorFilter(selector);
    }

    async function fetchInstances(isAutoRefresh = false) {
        console.log('DEBUG: fetchInstances called, isAutoRefresh:', isAutoRefresh);
        if (isAutoRefresh && (currentInlineEditor || expandedInstances.size > 0)) {
            console.log('DEBUG: Skipping fetch due to inline editor or expanded instances');
            return;
        }

        try {
            if (!isAutoRefresh) {
                content.innerHTML = '<div class="loading">Loading instances...<div class="loading-hint">To launch an instance, run <code>openloop</code> from your project folder in the terminal</div><div class="loading-hint">Instances are launched by running <code>openloop</code> - launch button appears for stopped/unused instances</div></div>';
            }

            console.log('DEBUG: Fetching /api/instances...');
            const response = await fetch('/api/instances');
            console.log('DEBUG: Response received, status:', response.status);
            const data = await response.json();

            console.log('DEBUG: Raw API response:', data);

            if (data.instances && data.instances.length > 0) {
                const tree = buildTreeFromPaths(data.instances);
                await Promise.all(tree.instances.map(instance => fetchPersonaCount(instance.fullPath)));
                await Promise.all(tree.instances.map(instance => fetchWorkflowCount(instance.fullPath)));
                renderTree(tree);
            } else {
                content.innerHTML = '<div class="empty-state">No instances found<div class="empty-hint">To launch an instance, run <code>openloop</code> from your project folder in the terminal</div></div>';
            }
        } catch (error) {
            console.error('Failed to fetch instances:', error);
            console.error('Error details:', error.message, error.stack);
            if (!isAutoRefresh) {
                content.innerHTML = `<div class="error">Failed to load instances: ${error.message}</div>`;
            }
        }
    }

    const confirmMessages = {
        disable: 'Disable auto-start for this instance? It will keep running until stopped.',
        stop: 'Stop this instance? The process will be terminated.',
        delete: 'Delete this instance\'s service registration? This cannot be undone.'
    };

    const postActionMessages = {
        stop: 'Stop requested. It may take up to 1 minute for the instance status to update. Please wait ~1 minute and refresh to see the updated status before Delete.'
    };

    const lifecycleRequest = (action, encodedPath) => fetch(
        action === 'delete' ? `/api/instances/${encodedPath}/delete` : `/api/instances/${encodedPath}/${action}`,
        { method: action === 'delete' ? 'DELETE' : 'POST' }
    );

    async function performLifecycle(action, encodedPath) {
        const res = await lifecycleRequest(action, encodedPath);
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
        expandedInstances.clear();
        if (postActionMessages[action]) alert(postActionMessages[action]);
        fetchInstances();
    }

    window.lifecycleAction = async function(action, encodedPath) {
        if (!confirm(confirmMessages[action])) return;
        try { await performLifecycle(action, encodedPath); }
        catch (e) { alert(`Could not ${action} instance — ${e.message}. Refreshing...`); fetchInstances(); }
    };

    function buildTreeFromPaths(instancesData) {
        // Build a map of path -> parentPath from API data
        const parentMap = {};
        globalSharePaths = new Set();
        instancesData.forEach(d => {
            parentMap[d.path] = d.parentPath || null;
            if (d.isGlobalShare) globalSharePaths.add(d.path);
        });
        instanceParentMap = parentMap;

        // Compute depth and rootPath for each instance
        function computeDepthAndRoot(path) {
            let depth = 0;
            let current = path;
            const visited = new Set();
            while (parentMap[current] && !visited.has(current)) {
                visited.add(current);
                const parent = parentMap[current];
                // Only count if parent actually exists in our instance list
                if (!parentMap.hasOwnProperty(parent)) break;
                depth++;
                current = parent;
            }
            return { depth, rootPath: current };
        }

        const instances = instancesData.filter(d => !d.isGlobalShare).map(instanceData => {
            const path = instanceData.path;
            const parts = path.split('/').filter(c => c.length > 0);
            const name = parts[parts.length - 1] || path;
            const isExpanded = expandedInstances.has(path);
            const state = instanceData.state || instanceStateCache[path];
            const stateAvailable = state && state.lastLoopAtUnixMs !== null;
            if (stateAvailable) {
                instanceStateCache[path] = state;
                console.log('DEBUG: Instance state for', path, ':', state);
            }
            const { depth, rootPath } = computeDepthAndRoot(path);
            return {
                name: name,
                fullPath: path,
                expanded: isExpanded,
                personasLoaded: isExpanded && instancePersonas[path] !== undefined,
                personas: instancePersonas[path] || [],
                workflowsLoaded: isExpanded && instanceWorkflows[path] !== undefined,
                workflows: instanceWorkflows[path] || [],
                state: state,
                manualActive: instanceData.manualActive || 0,
                manualCompleted: instanceData.manualCompleted || 0,
                depth: depth,
                rootPath: rootPath,
                parentPath: parentMap[path] || null,
                configEnabled: instanceData.configEnabled ?? null,
                processRunning: instanceData.processRunning ?? null
            };
        });

        // Compute child counts for each instance
        const childCounts = {};
        instances.forEach(inst => {
            if (inst.parentPath) {
                childCounts[inst.parentPath] = (childCounts[inst.parentPath] || 0) + 1;
            }
        });
        instances.forEach(inst => {
            inst.childCount = childCounts[inst.fullPath] || 0;
        });

        // Sort: depth-first traversal grouped by root, siblings alphabetical
        const byRoot = {};
        instances.forEach(inst => {
            const r = inst.rootPath;
            if (!byRoot[r]) byRoot[r] = [];
            byRoot[r].push(inst);
        });
        Object.values(byRoot).forEach(group => {
            group.sort((a, b) => {
                if (a.depth !== b.depth) return a.depth - b.depth;
                return a.name.localeCompare(b.name);
            });
        });
        // Roots in alphabetical order
        const rootOrder = Object.keys(byRoot).sort((a, b) => {
            const nameA = a.split('/').filter(c => c.length > 0).pop() || a;
            const nameB = b.split('/').filter(c => c.length > 0).pop() || b;
            return nameA.localeCompare(nameB);
        });
        // Flatten into depth-first order
        const sorted = [];
        function addChildren(rootPath, parentPath, depth) {
            const children = byRoot[rootPath].filter(i => {
                if (depth === 0) return i.depth === 0 && i.fullPath === rootPath;
                return i.depth === depth && parentMap[i.fullPath] === parentPath;
            });
            children.forEach(child => {
                sorted.push(child);
                addChildren(rootPath, child.fullPath, depth + 1);
            });
        }
        rootOrder.forEach(root => {
            addChildren(root, null, 0);
        });

        return {
            instances: sorted
        };
    }

    function renderTree(tree) {
        // Group instances into family wrappers for the carpet background
        let html = '';
        let currentRoot = null;
        let familyInstances = [];

        function flushFamily() {
            if (familyInstances.length === 0) return;
            const hue = getInstanceHue(familyInstances[0].fullPath, familyInstances[0].rootPath);
            html += `<div class="instance-family" style="--hue:${hue}">`;
            familyInstances.forEach(inst => {
                html += renderInstanceNode(inst);
            });
            html += `</div>`;
        }

        tree.instances.forEach(instance => {
            if (instance.rootPath !== currentRoot) {
                flushFamily();
                currentRoot = instance.rootPath;
                familyInstances = [];
            }
            familyInstances.push(instance);
        });
        flushFamily();

        content.innerHTML = `
            <div class="tree-container" role="tree" aria-label="Instance tree">
                <div class="instances-list">
                    ${html}
                </div>
            </div>
        `;

        tree.instances.filter(i => i.expanded).forEach(instance => {
            const node = document.querySelector(`.instance-node[data-path="${escapeHtml(instance.fullPath)}"]`);
            if (node) {
                loadManualWorkflowsForInstance(instance.fullPath, node);
            }
        });
    }

    function formatPath(path, parentPath) {
        if (!path) return '/';
        if (!parentPath || parentPath === path) return escapeHtml(path);
        const suffix = path.slice(parentPath.length + 1); // skip the '/' separator
        const sharedPrefix = parentPath.length > 35
            ? '…/'
            : escapeHtml(parentPath) + '/';
        return `<span class="path-shared">${sharedPrefix}</span><span class="path-unique">${escapeHtml(suffix)}</span>`;
    }

    function renderActionStrip(configEnabled, processRunning, instancePath) {
        const [btnLabel, btnClass, btnAction] = configEnabled
            ? ['Disable', 'warn', 'disable']
            : processRunning ? ['Stop', 'caution', 'stop'] : ['Delete', 'danger', 'delete'];
        const enc = encodeURIComponent(instancePath);
        const dotClass = processRunning ? 'online' : 'offline';
        return `<div class="instance-action-strip">
            <span class="status-dot ${dotClass}"></span>
            <button class="instance-action-btn ${btnClass}"
                onclick="event.stopPropagation(); lifecycleAction('${btnAction}', '${enc}')">${btnLabel}</button>
        </div>`;
    }

    function renderStatusLabels(configEnabled, processRunning) {
        const procText = processRunning ? 'running' : 'stopped';
        const cfgText = configEnabled ? 'enabled' : 'disabled';
        return `<div class="instance-status-labels">
            <!-- <span class="status-text">Status: ${procText}</span> -->
            <!-- <span class="status-sep">&middot;</span> -->
            <span class="status-text">Auto-load: ${cfgText}</span>
        </div>`;
    }

    function renderInstanceNode(instance) {
        const pathHtml = formatPath(instance.fullPath, instance.parentPath);
        const depth = instance.depth || 0;
        const rootPath = instance.rootPath || instance.fullPath;
        const bgColor = getInstanceColor(instance.fullPath, rootPath, depth);
        const hue = getInstanceHue(instance.fullPath, rootPath);

        let headerRightHtml = '';
        let cellFooterHtml = '';
        let isRunning = false;
        let expandedContentHtml = '';
        let personaCountHtml = '';
        let workflowCountHtml = '';
        let manualBadgesHtml = '';

        const stateAvailable = instance.state && instance.state.lastLoopAtUnixMs !== null;
        const cfgEnabled = instance.configEnabled;
        const procRunning = instance.processRunning;

        if (cfgEnabled !== undefined && cfgEnabled !== null) {
            headerRightHtml = renderActionStrip(cfgEnabled, procRunning, instance.fullPath);
            cellFooterHtml = renderStatusLabels(cfgEnabled, procRunning);
            isRunning = procRunning;
        } else if (stateAvailable) {
            const now = Date.now();
            const lastLoopDate = new Date(instance.state.lastLoopAtUnixMs);
            const secondsSinceLastLoop = (now - lastLoopDate.getTime()) / 1000;
            isRunning = secondsSinceLastLoop < 120;
            headerRightHtml = `<span class="instance-status ${isRunning ? 'running' : 'stopped'}" title="${isRunning ? 'Running' : 'Stopped'}">${isRunning ? '' : '∞'}</span>`;
        } else {
            headerRightHtml = `<span class="instance-status stopped" title="Offline">∞</span>`;
        }

        personaCountHtml = getPersonaCountHtml(instance.fullPath, instance.state);
        workflowCountHtml = getWorkflowCountHtml(instance.fullPath, instance.state);
        manualBadgesHtml = getManualWorkflowBadgesHtml(instance.manualActive, instance.manualCompleted);

        let childCountHtml = '';
        if (instance.childCount > 0) {
            const label = instance.childCount === 1 ? '1 child' : `${instance.childCount} children`;
            childCountHtml = `<span class="parent-child-count">${label}</span>`;
        }

        if (instance.expanded) {
            const personasHtml = renderPersonasHtml(instance.personas, instance.fullPath);
            const workflowsHtml = renderWorkflowsHtml(instance.workflows, instance.fullPath);
            expandedContentHtml = renderExpandedContentHtml(instance.fullPath, personasHtml, workflowsHtml);
        }

        const badgesRowHtml = (personaCountHtml || workflowCountHtml || manualBadgesHtml || childCountHtml)
            ? `<div class="instance-badges">${personaCountHtml}${workflowCountHtml}${manualBadgesHtml}${childCountHtml}</div>`
            : '';

        const iconSaturation = Math.max(25, 50 - depth * 8);
        const iconLightness = Math.min(72, 55 + depth * 6);
        const iconColor = `hsl(${hue}, ${iconSaturation}%, ${iconLightness}%)`;

        return `
            <div class="instance-node ${instance.expanded ? 'expanded' : ''}"
                 role="treeitem"
                 aria-expanded="${instance.expanded}"
                 data-path="${instance.fullPath}"
                 data-depth="${depth}"
                 style="--indent:${depth};--hue:${hue};--depth:${depth}">
                <div class="instance-row" style="background-color: ${bgColor}">
                    <div class="instance-header">
                        <span class="instance-toggle">${instance.expanded ? '▾' : '▸'}</span>
                        <span class="instance-icon" style="color:${iconColor};-webkit-text-fill-color:${iconColor}">●</span>
                        <div class="instance-name-group">
                            <span class="instance-name">${escapeHtml(instance.name)}</span><span class="info-icon" data-doc="instance" title="What is an instance?">ⓘ</span>
                        </div>
                        ${headerRightHtml}
                    </div>
                    <div class="instance-path-row">
                        <span class="instance-path" title="${escapeHtml(instance.fullPath)}">${pathHtml}</span>
                    </div>
                    ${badgesRowHtml}
                    ${cellFooterHtml}
                </div>
                ${expandedContentHtml}
            </div>
        `;
    }

    async function fetchPersonaCount(path) {
        if (personaCache[path] !== undefined) return personaCache[path];
        
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/personas`);
            const data = await response.json();
            personaCache[path] = data.personas ? data.personas.length : 0;
            return personaCache[path];
        } catch (error) {
            console.error('Failed to fetch persona count:', error);
            return 0;
        }
    }

    async function fetchPersonas(path) {
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/personas`);
            const data = await response.json();
            return data.personas || [];
        } catch (error) {
            console.error('Failed to fetch personas:', error);
            return [];
        }
    }

    async function fetchWorkflowCount(path) {
        if (workflowCache[path] !== undefined) return workflowCache[path];
        
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/workflows`);
            const data = await response.json();
            workflowCache[path] = data.workflows ? data.workflows.length : 0;
            return workflowCache[path];
        } catch (error) {
            console.error('Failed to fetch workflow count:', error);
            return 0;
        }
    }

    async function fetchWorkflows(path) {
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/workflows`);
            const data = await response.json();
            return data.workflows || [];
        } catch (error) {
            console.error('Failed to fetch workflows:', error);
            return [];
        }
    }

    async function fetchManualWorkflows(path) {
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/manual-workflows`);
            const data = await response.json();
            return data.workflows || [];
        } catch (error) {
            console.error('Failed to fetch manual workflows:', error);
            return [];
        }
    }

    async function launchManualWorkflow(path, workflowId, ask) {
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/manual-workflows`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    workflow_id: workflowId,
                    ask: ask
                })
            });
            if (!response.ok) {
                throw new Error(`Failed to launch workflow: ${response.statusText}`);
            }
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Failed to launch manual workflow:', error);
            throw error;
        }
    }

    async function validateManualWorkflow(path, workflowId, ask) {
        const response = await fetch(`/api/instances/${encodeURIComponent(path)}/manual-workflows/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflow_id: workflowId, ask: ask })
        });
        if (response.status === 422) {
            const data = await response.json();
            return { valid: false, errors: data.errors || [] };
        }
        if (!response.ok) {
            throw new Error(`Could not reach server. Please try again.`);
        }
        return { valid: true, errors: [] };
    }

    function showValidationErrors(launcher, errors) {
        const existing = launcher.querySelector('.launcher-validation-errors');
        if (existing) existing.remove();

        const errorsHtml = errors.length > 0
            ? errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')
            : '<li>Workflow verification failed. Check workflow configuration.</li>';

        const panel = document.createElement('div');
        panel.className = 'launcher-validation-errors';
        panel.setAttribute('role', 'alert');
        panel.innerHTML = `
            <div class="error-title" aria-live="assertive">
                <span class="error-icon">\u2717</span>
                Workflow verification failed
                <span class="info-icon" data-doc="workflow-levels" title="How levels work">ⓘ</span>
            </div>
            <ul>${errorsHtml}</ul>
        `;

        const actionsDiv = launcher.querySelector('.launcher-actions');
        actionsDiv.parentNode.insertBefore(panel, actionsDiv);
    }

    async function deleteManualWorkflow(path, runId, btn) {
        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(path)}/manual-workflows/${encodeURIComponent(runId)}`, {
                method: 'DELETE'
            });
            if (!response.ok) {
                throw new Error(`Failed to delete workflow: ${response.statusText}`);
            }
            const node = btn.closest('.manual-workflow-node');
            if (node) {
                node.remove();
            }
        } catch (error) {
            console.error('Failed to delete manual workflow:', error);
            alert(`Failed to remove: ${error.message}`);
        }
    }

    async function loadManualWorkflowsForInstance(path, node) {
        try {
            const manualWorkflows = await fetchManualWorkflows(path);
            instanceManualWorkflows[path] = manualWorkflows;

            const container = node.querySelector('.manual-workflows-list[data-instance-path="' + escapeHtml(path) + '"]');
            if (container) {
                container.innerHTML = renderManualWorkflowsHtml(manualWorkflows, path);
            }
        } catch (error) {
            console.error('Failed to load manual workflows:', error);
            const container = node.querySelector('.manual-workflows-list[data-instance-path="' + escapeHtml(path) + '"]');
            if (container) {
                container.innerHTML = '<div class="subview-empty">Failed to load manual workflows</div>';
            }
        }
    }

    function renderManualWorkflowsHtml(workflows, path) {
        if (workflows.length === 0) {
            return '<div class="subview-empty">No manual workflows running</div>';
        }

        return workflows.sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).map(w => {
            const statusClass = w.status === 'running' ? 'running' : (w.status === 'completed' ? 'completed' : 'failed');
            const statusIcon = w.status === 'running' ? '⟳' : (w.status === 'completed' ? '✓' : '✗');
            const startDate = new Date(w.started_at);
            const timeStr = startDate.toLocaleTimeString() + ' ' + startDate.toLocaleDateString();

            return `
                <div class="manual-workflow-node" data-run-id="${escapeHtml(w.id)}" data-instance-path="${escapeHtml(path)}">
                    <div class="manual-workflow-header">
                        <span class="manual-workflow-status ${statusClass}" title="${w.status}">${statusIcon}</span>
                        <span class="manual-workflow-workflow-id">${escapeHtml(w.workflow_id)}</span>
                        <span class="manual-workflow-time">${escapeHtml(timeStr)}</span>
                        <button class="manual-workflow-delete" data-run-id="${escapeHtml(w.id)}" data-instance-path="${escapeHtml(path)}" title="Remove">×</button>
                    </div>
                    <div class="manual-workflow-ask">${escapeHtml(w.ask)}</div>
                    ${w.output ? `<div class="manual-workflow-output">${renderLogContent(w.output)}</div>` : ''}
                </div>
            `;
        }).join('');
    }

    function openManualWorkflowLauncher(instancePath, workflowId, workflowName, workflowAsk, triggerBtn) {
        closeManualWorkflowLauncher();

        const launcherHtml = `
            <div class="manual-workflow-launcher" data-instance-path="${escapeHtml(instancePath)}" data-workflow-id="${escapeHtml(workflowId)}">
                <div class="launcher-header">
                    <h3>Launch Workflow: ${escapeHtml(workflowName)}</h3>
                    <button class="launcher-close-btn">&times;</button>
                </div>
                <div class="launcher-body">
                    <div class="form-group">
                        <label for="workflow-ask-input">Ask (task description):</label>
                        <textarea id="workflow-ask-input" class="workflow-ask-input" rows="6" placeholder="Enter the task for this workflow...">${escapeHtml(workflowAsk)}</textarea>
                    </div>
                    <div class="launcher-actions">
                        <button class="launcher-cancel-btn">Cancel</button>
                        <button class="launcher-launch-btn">Launch</button>
                    </div>
                </div>
            </div>
        `;

        const launcher = document.createElement('div');
        launcher.className = 'inline-editor manual-workflow-launcher-wrapper';
        launcher.innerHTML = launcherHtml;

        if (triggerBtn && triggerBtn.closest('.workflow-node')) {
            triggerBtn.closest('.workflow-node').parentNode.insertBefore(launcher, triggerBtn.closest('.workflow-node').nextSibling);
        } else {
            content.appendChild(launcher);
        }

        currentInlineEditor = launcher;

        const closeBtn = launcher.querySelector('.launcher-close-btn');
        const cancelBtn = launcher.querySelector('.launcher-cancel-btn');
        const launchBtn = launcher.querySelector('.launcher-launch-btn');
        const askInput = launcher.querySelector('#workflow-ask-input');

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeManualWorkflowLauncher();
        });

        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeManualWorkflowLauncher();
        });

        launchBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const ask = askInput.value.trim();

            if (!ask) {
                alert('Please enter a task description');
                return;
            }

            const existingErrors = launcher.querySelector('.launcher-validation-errors');
            if (existingErrors) existingErrors.remove();

            launchBtn.disabled = true;
            launchBtn.innerHTML = '<span class="launcher-btn-spinner"></span> Verifying workflow\u2026';

            try {
                const validation = await validateManualWorkflow(instancePath, workflowId, ask);

                if (!validation.valid) {
                    showValidationErrors(launcher, validation.errors);
                    launchBtn.disabled = false;
                    launchBtn.textContent = 'Launch';
                    return;
                }

                launchBtn.innerHTML = '<span class="launcher-btn-spinner"></span> Launching\u2026';
                await launchManualWorkflow(instancePath, workflowId, ask);
                closeManualWorkflowLauncher();

                const instanceNode = document.querySelector('.instance-node[data-path="' + escapeHtml(instancePath) + '"]');
                if (instanceNode) {
                    await loadManualWorkflowsForInstance(instancePath, instanceNode);
                }
            } catch (error) {
                alert(`Failed to launch workflow: ${error.message}`);
                launchBtn.disabled = false;
                launchBtn.textContent = 'Launch';
            }
        });

        askInput.addEventListener('input', () => {
            const errorPanel = launcher.querySelector('.launcher-validation-errors');
            if (errorPanel) errorPanel.remove();
        });

        askInput.focus();

        launcher.addEventListener('click', (e) => e.stopPropagation());
    }

    function closeManualWorkflowLauncher() {
        if (currentInlineEditor && currentInlineEditor.classList.contains('manual-workflow-launcher-wrapper')) {
            currentInlineEditor.remove();
            currentInlineEditor = null;
        }
    }

    function openPersonaSelector(levelIndex, slotIndex, personas, editor, instancePath, workflowId, allWorkflows) {
        closePersonaSelector();

        const filteredWorkflows = (allWorkflows || []).filter(w => w.id !== workflowId);
        const parentChain = getParentChain(instancePath);
        const pickerParentPersonasHtml = renderParentSectionsHtml(parentChain, 'personas');
        const pickerParentWorkflowsHtml = renderParentSectionsHtml(parentChain, 'workflows');

        const personasHtml = personas.map(p => `
            <div class="persona-selector-item" data-persona-id="${escapeHtml(p.id)}">
                ${getAvatarHtml(p.avatar)}
                <div class="persona-selector-info">
                    <div class="persona-selector-name-row">
                        <span class="persona-selector-name">${escapeHtml(p.name)}</span>
                        ${p.role ? `<span class="persona-selector-role">${escapeHtml(p.role)}</span>` : ''}
                    </div>
                    ${p.about ? `<span class="persona-selector-about">${escapeHtml(p.about)}</span>` : ''}
                </div>
            </div>
        `).join('');

        const workflowsHtml = filteredWorkflows.map(w => `
            <div class="persona-selector-item workflow-selector-item" data-workflow-id="${escapeHtml(w.id)}">
                <span class="workflow-selector-icon">○</span>
                <div class="persona-selector-info">
                    <div class="persona-selector-name-row">
                        <span class="persona-selector-name">${escapeHtml(w.name)}</span>
                    </div>
                    ${w.desc ? `<span class="persona-selector-about">${escapeHtml(w.desc)}</span>` : ''}
                </div>
            </div>
        `).join('');

        const selectorHtml = `
            <div class="persona-selector" data-level="${levelIndex}" data-slot="${slotIndex}">
                <div class="persona-selector-header">
                    <div class="persona-selector-title-group">
                        <h3>Add to Level</h3>
                        <span class="persona-selector-hint">Select a persona or workflow to add to this level</span>
                    </div>
                    <button class="persona-selector-close-btn">&times;</button>
                </div>
                <div class="picker-tabs">
                    <button class="picker-tab active" data-tab="personas">Personas</button>
                    <button class="picker-tab" data-tab="workflows">Workflows</button>
                </div>
                <div class="selector-search-wrapper">
                    <svg class="selector-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
                    <input class="selector-search" type="text" placeholder="Search personas…" aria-label="Search personas" autocomplete="off" spellcheck="false">
                </div>
                <div class="persona-selector-body">
                    <div class="picker-panel picker-personas-panel">
                        ${personas.length > 0 ? personasHtml : ''}
                        ${pickerParentPersonasHtml}
                        ${personas.length === 0 && parentChain.length === 0 ? '<div class="persona-selector-empty">No personas available.<br>Create a persona first to add it to this workflow.</div>' : ''}
                    </div>
                    <div class="picker-panel picker-workflows-panel" style="display:none">
                        ${filteredWorkflows.length > 0 ? workflowsHtml : ''}
                        ${pickerParentWorkflowsHtml}
                        ${filteredWorkflows.length === 0 && parentChain.length === 0 ? '<div class="persona-selector-empty">No other workflows available.<br>Create another workflow to use it as an inner step here.</div>' : ''}
                    </div>
                </div>
            </div>
        `;

        const selector = document.createElement('div');
        selector.className = 'inline-editor persona-selector-wrapper';
        selector.innerHTML = selectorHtml;
        content.appendChild(selector);

        savedInlineEditor = currentInlineEditor;
        currentInlineEditor = selector;

        const closeBtn = selector.querySelector('.persona-selector-close-btn');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closePersonaSelector();
        });

        selector.addEventListener('click', (e) => {
            const parentHeader = e.target.closest('.parent-section-header');
            if (parentHeader) {
                e.stopPropagation();
                togglePickerParentSection(parentHeader, selector, instancePath, workflowId);
                return;
            }
            const parentItem = e.target.closest('.parent-section-body .persona-selector-item');
            if (parentItem) {
                e.stopPropagation();
                const parentPath = parentItem.closest('.parent-section').dataset.parentPath;
                const parentP = (parentInstanceData[parentPath] || {}).personas || [];
                const merged = personas.concat(parentP);
                if (parentItem.classList.contains('workflow-selector-item')) {
                    addPersonaToLevel(editor, instancePath, workflowId, levelIndex, slotIndex, ':' + parentItem.dataset.workflowId, merged);
                } else {
                    addPersonaToLevel(editor, instancePath, workflowId, levelIndex, slotIndex, parentItem.dataset.personaId, merged);
                }
                closePersonaSelector();
                return;
            }
            const retryBtn = e.target.closest('.parent-section-retry');
            if (retryBtn) {
                e.stopPropagation();
                const section = retryBtn.closest('.parent-section');
                const hdr = section.querySelector('.parent-section-header');
                section.querySelector('.parent-section-body').innerHTML = '';
                hdr.setAttribute('aria-expanded', 'false');
                togglePickerParentSection(hdr, selector, instancePath, workflowId);
                return;
            }
            e.stopPropagation();
        });

        const searchInput = selector.querySelector('.selector-search');
        const searchWrapper = selector.querySelector('.selector-search-wrapper');

        selector.querySelectorAll('.picker-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.stopPropagation();
                selector.querySelectorAll('.picker-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const targetPanel = tab.dataset.tab;
                selector.querySelector('.picker-personas-panel').style.display = targetPanel === 'personas' ? '' : 'none';
                selector.querySelector('.picker-workflows-panel').style.display = targetPanel === 'workflows' ? '' : 'none';
                searchInput.value = '';
                const label = targetPanel === 'personas' ? 'personas' : 'workflows';
                searchInput.placeholder = 'Search ' + label + '…';
                searchInput.setAttribute('aria-label', 'Search ' + label);
                clearSelectorSearch(selector);
            });
        });

        searchInput.addEventListener('input', () => applySelectorFilter(selector));

        const personaItems = selector.querySelectorAll('.persona-selector-item:not(.workflow-selector-item)');
        personaItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const personaId = item.dataset.personaId;
                addPersonaToLevel(editor, instancePath, workflowId, levelIndex, slotIndex, personaId, personas);
                closePersonaSelector();
            });
        });

        const workflowItems = selector.querySelectorAll('.workflow-selector-item');
        workflowItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const wfId = item.dataset.workflowId;
                addPersonaToLevel(editor, instancePath, workflowId, levelIndex, slotIndex, ':' + wfId, personas);
                closePersonaSelector();
            });
        });

        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                if (searchInput.value) {
                    searchInput.value = '';
                    clearSelectorSearch(selector);
                } else {
                    closePersonaSelector();
                    document.removeEventListener('keydown', handleEscape);
                }
            }
        };
        document.addEventListener('keydown', handleEscape);

        const handleClickOutside = (e) => {
            if (!selector.contains(e.target)) {
                closePersonaSelector();
                document.removeEventListener('click', handleClickOutside);
            }
        };
        setTimeout(() => document.addEventListener('click', handleClickOutside), 0);
    }

    function closePersonaSelector() {
        if (currentInlineEditor && currentInlineEditor.classList.contains('persona-selector-wrapper')) {
            currentInlineEditor.remove();
            currentInlineEditor = savedInlineEditor;
            savedInlineEditor = null;
        }
    }

    function formatTimestamp(unixMs) {
        const d = new Date(unixMs);
        return d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
    }

    function renderLogContent(text, truncateThreshold = 300) {
        const copyBtn = '<button class="log-copy-btn" title="Copy text"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>';
        if (text.length > truncateThreshold) {
            return `${copyBtn}<div class="log-bubble-content truncated">${escapeHtml(text)}</div><span class="log-expand-btn">show more</span>`;
        }
        return `${copyBtn}<div class="log-bubble-content">${escapeHtml(text)}</div>`;
    }

    function renderPersonaLogsHtml(logs, personaId) {
        const filtered = logs.filter(l => {
            return l.personaId === personaId;
        });

        if (filtered.length === 0) {
            return '<div class="logs-empty">No logs for this persona</div>';
        }

        return filtered.map(log => {
            const inputBubbles = [];
            
            log.msg.parents.forEach(p => {
                inputBubbles.push(`
                    <div class="log-bubble context">
                        <span class="log-bubble-subtitle">Context from ${escapeHtml(p.id)}</span>
                        ${renderLogContent(p.text)}
                    </div>
                `);
            });
            
            if (log.msg.input) {
                inputBubbles.push(`
                    <div class="log-bubble input">
                        <span class="log-bubble-subtitle">INPUT MESSAGE${log.workflowId ? ` (${escapeHtml(log.workflowId)})` : ''}</span>
                        ${renderLogContent(log.msg.input)}
                    </div>
                `);
            }
            
            return `
            <div class="log-entry">
                <div class="log-date">${formatTimestamp(log.started_at)}</div>
                ${inputBubbles.join('')}
                <div class="log-bubble output ${log.success ? '' : 'error'}">
                    <span class="log-bubble-subtitle">output</span>
                    ${renderLogContent(log.msg.output || '(empty)')}
                </div>
                <div class="log-duration">took ${log.took}s</div>
            </div>
        `;
        }).join('');
    }

    function renderExpandLink(log, instancePath) {
        if (!log.session) return '';
        const url = `/workflow-log.html?instance=${encodeURIComponent(instancePath)}&session=${encodeURIComponent(log.session)}`;
        return `<a href="${url}" target="_blank" class="log-expand-link">expand ↗</a>`;
    }

    function renderWorkflowLogsHtml(logs, instancePath) {
        if (logs.length === 0) {
            return '<div class="logs-empty">No logs for this workflow</div>';
        }

        return logs.map(log => {
            const inputBubbles = [];

            log.msg.parents.forEach(p => {
                inputBubbles.push(`
                    <div class="log-bubble context">
                        <span class="log-bubble-subtitle">Context from ${escapeHtml(p.id)}</span>
                        ${renderLogContent(p.text)}
                    </div>
                `);
            });

            if (log.msg.input) {
                inputBubbles.push(`
                    <div class="log-bubble input">
                        <span class="log-bubble-subtitle">INPUT MESSAGE${log.workflowId ? ` (${escapeHtml(log.workflowId)})` : ''}</span>
                        ${renderLogContent(log.msg.input)}
                    </div>
                `);
            }

            return `
            <div class="log-entry">
                <div class="log-date">${formatTimestamp(log.started_at)}</div>
                ${inputBubbles.join('')}
                ${renderExpandLink(log, instancePath)}
                <div class="log-bubble output ${log.success ? '' : 'error'}">
                    <span class="log-bubble-subtitle">output</span>
                    ${renderLogContent(log.msg.output || '(empty)')}
                </div>
                <div class="log-duration">took ${log.took}s</div>
            </div>
        `;
        }).join('');
    }

    async function toggleInstance(event) {
        const node = event.currentTarget;
        const path = node.dataset.path;
        
        if (!path) return;

        if (!personaCache[path]) {
            await fetchPersonaCount(path);
        }
        if (!workflowCache[path]) {
            await fetchWorkflowCount(path);
        }
        
        node.classList.toggle('expanded');
        const expanded = node.classList.contains('expanded');
        
        if (expanded) {
            expandedInstances.add(path);
        } else {
            expandedInstances.delete(path);
        }

        const toggleIcon = node.querySelector('.instance-toggle');
        if (toggleIcon) {
            toggleIcon.textContent = expanded ? '▾' : '▸';
        }
        node.setAttribute('aria-expanded', expanded);

        const instanceRow = node.querySelector('.instance-row');
        const depth = parseInt(node.dataset.depth) || 0;
        const rootPath = node.style.getPropertyValue('--hue') ? path : path;
        const hue = parseInt(node.style.getPropertyValue('--hue')) || getInstanceHue(path, path);
        const bgColor = getInstanceColor(path, depth === 0 ? path : path, depth);
        if (instanceRow) {
            instanceRow.style.backgroundColor = bgColor;
            const state = instanceStateCache[path];

            const footer = instanceRow.querySelector('.instance-footer');
            const badgesRow = instanceRow.querySelector('.instance-badges');
            if (badgesRow) {
                const existingPersonaCount = badgesRow.querySelector('.persona-count');
                if (existingPersonaCount) existingPersonaCount.remove();
                const existingWorkflowCount = badgesRow.querySelector('.workflow-count');
                if (existingWorkflowCount) existingWorkflowCount.remove();
                const existingManualActive = badgesRow.querySelector('.manual-count-active');
                if (existingManualActive) existingManualActive.remove();
                const existingManualDone = badgesRow.querySelector('.manual-count-done');
                if (existingManualDone) existingManualDone.remove();
                badgesRow.insertAdjacentHTML('beforeend', getPersonaCountHtml(path, state));
                badgesRow.insertAdjacentHTML('beforeend', getWorkflowCountHtml(path, state));
            }
        }

        const existingExpandedContent = node.querySelector('.expanded-content');
        if (existingExpandedContent) {
            existingExpandedContent.remove();
        }

        if (expanded) {
            const [personas, workflows] = await Promise.all([
                fetchPersonas(path),
                fetchWorkflows(path)
            ]);
            instancePersonas[path] = personas;
            instanceWorkflows[path] = workflows;

            const personasHtml = renderPersonasHtml(personas, path);
            const workflowsHtml = renderWorkflowsHtml(workflows, path);
            const expandedContentHtml = renderExpandedContentHtml(path, personasHtml, workflowsHtml);
            node.insertAdjacentHTML('beforeend', expandedContentHtml);

            loadManualWorkflowsForInstance(path, node);
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function parsePersonaRef(input) {
        if (input.startsWith(':')) {
            return { id: input, isRW: false };
        }
        if (input.endsWith(':rw') && input.length > 3) {
            return { id: input.slice(0, -3), isRW: true };
        }
        return { id: input, isRW: false };
    }

    function formatEverySecsHint(secs) {
        if (secs === -1) return 'startup — runs once when service starts or resumes (after reboot, reinstall, or update)';
        if (secs === 0) return 'manual — never repeats';
        if (secs === 1) return 'continuous loop';
        if (secs < 60) return `every ${secs} seconds`;
        if (secs < 3600) {
            const mins = Math.floor(secs / 60);
            return mins === 1 ? 'every minute' : `every ${mins} minutes`;
        }
        const hours = Math.floor(secs / 3600);
        return hours === 1 ? 'every hour' : `every ${hours} hours`;
    }

    function getAvatarHtml(avatar) {
        if (!avatar) {
            return '<span class="persona-icon">○</span>';
        }
        return `<img class="persona-avatar" src="${escapeHtml(avatar)}" alt="" onerror="this.outerHTML='<span class=\\'persona-icon\\'>○</span>'">`;
    }

    function getPersonaStats(path, personaId) {
        const key = `${path}:${personaId}`;
        return instancePersonaStats[key] || { errors: 0, success: 0, total: 0 };
    }

    function renderPersonasHtml(personas, path) {
        if (personas.length === 0) return '<div class="subview-empty">No personas</div>';
        return personas.map(p => {
            const stat = getPersonaStats(path, p.id);
            return `
            <div class="persona-node"
                 role="treeitem"
                 draggable="true"
                 data-instance-path="${escapeHtml(path)}"
                 data-persona-id="${escapeHtml(p.id)}"
                 data-persona-name="${escapeHtml(p.name)}">
                <span class="persona-grip" title="Drag to workflow">⋮⋮</span>
                ${getAvatarHtml(p.avatar)}
                <span class="persona-label">${escapeHtml(p.name)}</span>
                <span class="persona-role">${escapeHtml(p.role || '')}</span>
                <div class="persona-stats" data-persona-id="${escapeHtml(p.id)}">
                    <span class="stat-errors" title="Errors">${stat.errors}</span>
                    <span class="stat-success" title="Success">${stat.success}</span>
                    <span class="stat-total">/ ${stat.total}</span>
                </div>
                <button class="persona-knowledge-btn" data-persona-id="${escapeHtml(p.id)}" data-persona-name="${escapeHtml(p.name)}" data-instance-path="${escapeHtml(path)}" title="Knowledge files"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></button>
                <button class="persona-logs-btn" data-persona-id="${escapeHtml(p.id)}" data-persona-name="${escapeHtml(p.name)}" title="View logs">→</button>
            </div>
        `}).join('');
    }

    function renderWorkflowsHtml(workflows, path) {
        if (workflows.length === 0) return '<div class="subview-empty">No workflows</div>';
        return workflows.map(w => `
            <div class="workflow-node"
                 data-instance-path="${escapeHtml(path)}"
                 data-workflow-id="${escapeHtml(w.id)}">
                <span class="workflow-icon">○</span>
                <div class="workflow-content">
                    <div class="workflow-id-row">
                        <span class="workflow-id">${escapeHtml(w.id)}</span><span class="info-icon" data-doc="workflow" title="What is a workflow?">ⓘ</span>
                    </div>
                    <span class="workflow-label">${escapeHtml(w.name)}</span>
                    <span class="workflow-desc">${escapeHtml(w.desc || '')}</span>
                    <button class="workflow-launch-btn" data-instance-path="${escapeHtml(path)}" data-workflow-id="${escapeHtml(w.id)}" data-workflow-name="${escapeHtml(w.name)}" data-workflow-ask="${escapeHtml(w.ask || '')}" title="Launch workflow manually">▶ Launch</button>
                </div>
            </div>
        `).join('');
    }

    function renderExpandedContentHtml(path, personasHtml, workflowsHtml) {
        return `
            <div class="expanded-content">
                <div class="subview personas-column">
                    <div class="subview-header">
                        <span>Personas</span>
                        <div class="subview-search-wrapper">
                            <svg class="subview-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
                            <input class="subview-search" type="text" placeholder="Filter…" data-filter="personas" data-instance-path="${escapeHtml(path)}" aria-label="Filter personas" autocomplete="off" spellcheck="false">
                        </div>
                    </div>
                    <button class="add-item-btn" data-action="create-persona" data-instance-path="${escapeHtml(path)}">+ Add Persona</button>
                    <div class="persona-list">${personasHtml}</div>
                    ${renderParentSectionsHtml(getParentChain(path), 'personas', path)}
                </div>
                <div class="subview workflows-column">
                    <div class="subview-header">
                        <span>Workflows</span>
                        <div class="subview-search-wrapper">
                            <svg class="subview-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>
                            <input class="subview-search" type="text" placeholder="Filter…" data-filter="workflows" data-instance-path="${escapeHtml(path)}" aria-label="Filter workflows" autocomplete="off" spellcheck="false">
                        </div>
                    </div>
                    <button class="add-item-btn" data-action="create-workflow" data-instance-path="${escapeHtml(path)}">+ Add Workflow</button>
                    <div class="workflow-list">${workflowsHtml}</div>
                    ${renderParentSectionsHtml(getParentChain(path), 'workflows', path)}
                    <div class="manual-workflows-section">
                        <div class="subview-header">Manual Workflows <button class="text-btn manual-workflows-refresh" data-instance-path="${escapeHtml(path)}">Refresh</button></div>
                        <div class="manual-workflows-list" data-instance-path="${escapeHtml(path)}">
                            <div class="loading-manual-workflows">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function getPersonaCountHtml(path, state, totalFromFetch) {
        const total = totalFromFetch !== undefined ? totalFromFetch : (personaCache[path] !== undefined ? personaCache[path] : 0);
        return `<span class="persona-count">Personas: ${total}</span>`;
    }

    function getWorkflowCountHtml(path, state, totalFromFetch) {
        const stateAvailable = state && state.lastLoopAtUnixMs !== null;
        let activeCount = 0;
        let total = 0;

        if (stateAvailable) {
            activeCount = state.activeRunningWorkflows || 0;
            total = (state.activeRunningWorkflows || 0) + (state.inactiveWorkflows || 0);
        } else {
            if (totalFromFetch !== undefined) {
                total = totalFromFetch;
            } else {
                total = workflowCache[path] !== undefined ? workflowCache[path] : 0;
            }
        }

        return `<span class="workflow-count">Workflows: ${activeCount}/${total}</span>`;
    }

    function getManualWorkflowBadgesHtml(active, completed) {
        let html = '';
        if (active > 0)
            html += '<span class="manual-count-active has-active">Manual: ' + active + ' active</span>';
        if (completed > 0)
            html += '<span class="manual-count-done">Manual: ' + completed + ' done</span>';
        return html;
    }

    async function fetchPersonaLogs(path, personaId = null, offset = 0, count = 5) {
        try {
            let url = `/api/instances/${encodeURIComponent(path)}/logs/personas`;
            const params = [];
            if (personaId) {
                params.push(`personaId=${encodeURIComponent(personaId)}`);
            }
            params.push(`offset=${offset}`);
            params.push(`count=${count}`);
            if (params.length > 0) {
                url += `?${params.join('&')}`;
            }
            const response = await fetch(url);
            const data = await response.json();
            const stats = data.stats || {};
            Object.keys(stats).forEach(key => {
                instancePersonaStats[`${path}:${key}`] = stats[key];
            });
            return data;
        } catch (error) {
            console.error('Failed to fetch persona logs:', error);
            return { logs: [], stats: {}, offset: 0, count: 5, total: 0 };
        }
    }

    async function fetchWorkflowLogs(path, workflowId, offset = 0, count = 5) {
        try {
            let url = `/api/instances/${encodeURIComponent(path)}/logs/workflows/${encodeURIComponent(workflowId)}`;
            const params = [];
            params.push(`offset=${offset}`);
            params.push(`count=${count}`);
            if (params.length > 0) {
                url += `?${params.join('&')}`;
            }
            const response = await fetch(url);
            const data = await response.json();
            return data;
        } catch (error) {
            console.error('Failed to fetch workflow logs:', error);
            return { logs: [], offset: 0, count: 5, total: 0 };
        }
    }

    async function refreshInstanceContent(path) {
        const node = document.querySelector(`.instance-node[data-path="${escapeHtml(path)}"]`);
        if (!node || !node.classList.contains('expanded')) return;

        const [personas, workflows] = await Promise.all([
            fetchPersonas(path),
            fetchWorkflows(path)
        ]);
        instancePersonas[path] = personas;
        instanceWorkflows[path] = workflows;
        personaCache[path] = personas.length;
        workflowCache[path] = workflows.length;

        const existingContent = node.querySelector('.expanded-content');
        const prevFilters = {};
        if (existingContent) {
            existingContent.querySelectorAll('.subview-search').forEach(inp => {
                if (inp.value) prevFilters[inp.dataset.filter] = inp.value;
            });
            existingContent.remove();
        }

        const personasHtml = renderPersonasHtml(personas, path);
        const workflowsHtml = renderWorkflowsHtml(workflows, path);
        const expandedContentHtml = renderExpandedContentHtml(path, personasHtml, workflowsHtml);
        node.insertAdjacentHTML('beforeend', expandedContentHtml);

        Object.entries(prevFilters).forEach(([key, val]) => {
            const inp = node.querySelector(`.subview-search[data-filter="${key}"]`);
            if (inp) { inp.value = val; applySubviewFilter(inp); }
        });

        loadManualWorkflowsForInstance(path, node);

        const instanceRow = node.querySelector('.instance-row');
        if (instanceRow) {
            const badgesRow = instanceRow.querySelector('.instance-badges');
            if (badgesRow) {
                const existingPersonaCount = badgesRow.querySelector('.persona-count');
                if (existingPersonaCount) existingPersonaCount.remove();
                const existingWorkflowCount = badgesRow.querySelector('.workflow-count');
                if (existingWorkflowCount) existingWorkflowCount.remove();
                const existingManualActive = badgesRow.querySelector('.manual-count-active');
                if (existingManualActive) existingManualActive.remove();
                const existingManualDone = badgesRow.querySelector('.manual-count-done');
                if (existingManualDone) existingManualDone.remove();

                const state = instanceStateCache[path];
                badgesRow.insertAdjacentHTML('beforeend', getPersonaCountHtml(path, state, personas.length));
                badgesRow.insertAdjacentHTML('beforeend', getWorkflowCountHtml(path, state, workflows.length));
            }
        }
    }

    function startAutoRefresh() {
        autoRefreshInterval = setInterval(() => fetchInstances(true), 30000);
        startCountdown();
    }

    function stopAutoRefresh() {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
        }
        stopCountdown();
    }

    function updateCountdown() {
        const el = document.getElementById('refreshCountdown');
        if (!el) return;
        if (currentInlineEditor) {
            el.textContent = '--';
            el.classList.add('paused');
            el.classList.remove('warning');
            return;
        }
        el.classList.remove('paused');
        el.textContent = countdownValue + 's';
        el.classList.toggle('warning', countdownValue <= 10);
        countdownValue--;
        if (countdownValue < 0) countdownValue = 30;
    }

    function startCountdown() {
        countdownValue = 30;
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
    }

    function stopCountdown() {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }

    function resetCountdown() {
        countdownValue = 30;
        updateCountdown();
    }

    refreshBtn.addEventListener('click', () => {
        personaCache = {};
        workflowCache = {};
        instanceStateCache = {};
        expandedInstances.clear();
        instancePersonas = {};
        instanceWorkflows = {};
        parentInstanceData = {};
        closeInlinePersonaEditor();
        resetCountdown();
        fetchInstances();
    });
    
    content.addEventListener('click', (e) => {
        if (currentInlineEditor && currentInlineEditor.contains(e.target)) {
            return;
        }

        const parentSectionHeader = e.target.closest('.parent-section-header');
        if (parentSectionHeader && parentSectionHeader.closest('.expanded-content')) {
            e.stopPropagation();
            toggleParentSectionExpand(parentSectionHeader);
            return;
        }

        const parentRetryBtn = e.target.closest('.parent-section-retry');
        if (parentRetryBtn && parentRetryBtn.closest('.expanded-content')) {
            e.stopPropagation();
            const section = parentRetryBtn.closest('.parent-section');
            const hdr = section.querySelector('.parent-section-header');
            section.querySelector('.parent-section-body').innerHTML = '';
            hdr.setAttribute('aria-expanded', 'false');
            toggleParentSectionExpand(hdr);
            return;
        }

        if (e.target.classList.contains('info-icon')) {
            e.stopPropagation();
            openHelpPanel(e.target.dataset.doc);
            return;
        }

        const refreshBtn = e.target.closest('.logs-refresh-btn');
        if (refreshBtn) {
            e.stopPropagation();
            return;
        }

        const manualRefreshBtn = e.target.closest('.manual-workflows-refresh');
        if (manualRefreshBtn) {
            e.stopPropagation();
            const instancePath = manualRefreshBtn.dataset.instancePath;
            const node = document.querySelector(`.instance-node[data-path="${escapeHtml(instancePath)}"]`);
            if (node) {
                const container = node.querySelector('.manual-workflows-list');
                if (container) {
                    container.innerHTML = '<div class="loading-manual-workflows">Loading...</div>';
                }
                loadManualWorkflowsForInstance(instancePath, node);
            }
            return;
        }

        const deleteBtn = e.target.closest('.manual-workflow-delete');
        if (deleteBtn) {
            e.stopPropagation();
            const runId = deleteBtn.dataset.runId;
            const instancePath = deleteBtn.dataset.instancePath;
            if (runId && instancePath) {
                deleteManualWorkflow(instancePath, runId, deleteBtn);
            }
            return;
        }

        if (e.target.classList.contains('log-expand-btn')) {
            e.stopPropagation();
            const content = e.target.previousElementSibling;
            if (content && content.classList.contains('log-bubble-content')) {
                content.classList.remove('truncated');
                content.classList.add('expanded');
                e.target.remove();
            }
            return;
        }

        const copyBtn = e.target.closest('.log-copy-btn');
        if (copyBtn) {
            e.stopPropagation();
            const bubble = copyBtn.closest('.log-bubble');
            const bubbleContent = bubble.querySelector('.log-bubble-content');
            if (bubbleContent) {
                const text = bubbleContent.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.classList.add('copied');
                    setTimeout(() => copyBtn.classList.remove('copied'), 1500);
                }).catch(err => {
                    console.error('Failed to copy:', err);
                });
            }
            return;
        }

        const addBtn = e.target.closest('.add-item-btn');
        if (addBtn) {
            e.stopPropagation();
            const action = addBtn.dataset.action;
            const instancePath = addBtn.dataset.instancePath;
            if (action === 'create-persona') {
                openInlinePersonaCreator(instancePath, addBtn);
            } else if (action === 'create-workflow') {
                openInlineWorkflowCreator(instancePath, addBtn);
            }
            return;
        }

        const launchBtn = e.target.closest('.workflow-launch-btn');
        if (launchBtn) {
            e.stopPropagation();
            const instancePath = launchBtn.dataset.instancePath;
            const workflowId = launchBtn.dataset.workflowId;
            const workflowName = launchBtn.dataset.workflowName;
            const workflowAsk = launchBtn.dataset.workflowAsk || '';
            openManualWorkflowLauncher(instancePath, workflowId, workflowName, workflowAsk, launchBtn);
            return;
        }

        const knowledgeBtn = e.target.closest('.persona-knowledge-btn');
        if (knowledgeBtn) {
            e.stopPropagation();
            const instPath = knowledgeBtn.dataset.instancePath;
            const pid = knowledgeBtn.dataset.personaId;
            const pname = knowledgeBtn.dataset.personaName || pid;
            window.open('files.html?instance=' + encodeURIComponent(instPath) + '&persona=' + encodeURIComponent(pid) + '&name=' + encodeURIComponent(pname), '_blank');
            return;
        }

        const personaNode = e.target.closest('.persona-node');
        if (personaNode) {
            if (currentInlineEditor && currentInlineEditor.dataset.personaId === personaNode.dataset.personaId && currentInlineEditor.dataset.instancePath === personaNode.dataset.instancePath) {
                closeInlinePersonaEditor();
                return;
            }
            openInlinePersonaEditor(personaNode, personaNode.dataset.instancePath, personaNode.dataset.personaId);
            return;
        }

        const workflowNode = e.target.closest('.workflow-node');
        if (workflowNode) {
            if (currentInlineEditor && currentInlineEditor.dataset.instancePath === workflowNode.dataset.instancePath && currentInlineEditor.dataset.workflowId === workflowNode.dataset.workflowId) {
                closeInlineWorkflowEditor();
                return;
            }
            openInlineWorkflowEditor(workflowNode, workflowNode.dataset.instancePath, workflowNode.dataset.workflowId);
            return;
        }

        const instanceRow = e.target.closest('.instance-row');
        if (instanceRow) {
            const instanceNode = instanceRow.closest('.instance-node');
            closeInlinePersonaEditor();
            closeInlineWorkflowEditor();
            toggleInstance({ currentTarget: instanceNode });
        }
    });

    content.addEventListener('dragstart', (e) => {
        const personaNode = e.target.closest('.persona-node');
        if (personaNode) {
            e.dataTransfer.setData('text/plain', personaNode.dataset.personaId);
            e.dataTransfer.effectAllowed = 'copy';
            personaNode.classList.add('dragging');
            globalDragState.active = true;
            globalDragState.personaId = personaNode.dataset.personaId;
            
            if (currentInlineEditor) {
                currentInlineEditor.classList.add('dragging-active');
            }
        }
    });

    content.addEventListener('dragend', (e) => {
        const personaNode = e.target.closest('.persona-node');
        if (personaNode) {
            personaNode.classList.remove('dragging');
            globalDragState.active = false;
            globalDragState.personaId = null;
            
            if (currentInlineEditor) {
                currentInlineEditor.classList.remove('dragging-active');
            }
        }
    });

    function setLanguage(lang) {
        currentLang = lang;
        localStorage.setItem('openloop-lang', lang);
        
        document.querySelectorAll('.lang-btn').forEach(btn => {
            const isActive = btn.dataset.lang === lang;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive);
        });
        
        if (currentHelpDoc) {
            openHelpPanel(currentHelpDoc);
        }
    }
    
    function initLanguageButtons() {
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                setLanguage(btn.dataset.lang);
            });
            
            const isActive = btn.dataset.lang === currentLang;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', isActive);
        });
    }
    
    initLanguageButtons();

    console.log('DEBUG: About to call fetchInstances()');
    fetchInstances();
    console.log('DEBUG: About to call startAutoRefresh()');
    startAutoRefresh();

    async function fetchMarkdown(filename) {
        const langResponse = await fetch(`/docs/${filename}.${currentLang}.md`);
        if (langResponse.ok) {
            return await langResponse.text();
        }
        
        if (currentLang !== 'en') {
            const enResponse = await fetch(`/docs/${filename}.en.md`);
            if (enResponse.ok) {
                return await enResponse.text();
            }
        }
        
        throw new Error('Content not found');
    }

    async function openHelpPanel(fileName, scrollToHeading) {
        currentHelpDoc = fileName;
        try {
            const mdContent = await fetchMarkdown(fileName);
            const panelContent = document.getElementById('help-panel-content');
            panelContent.innerHTML = marked.parse(mdContent);

            if (scrollToHeading) {
                requestAnimationFrame(() => {
                    const headings = panelContent.querySelectorAll('h1, h2, h3');
                    for (const h of headings) {
                        if (h.textContent.trim() === scrollToHeading) {
                            h.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            h.style.transition = 'background 0.8s ease';
                            h.style.background = 'rgba(52, 199, 89, 0.08)';
                            h.style.borderRadius = '6px';
                            h.style.padding = '4px 8px';
                            setTimeout(() => { h.style.background = 'transparent'; }, 1500);
                            break;
                        }
                    }
                });
            } else {
                panelContent.scrollTop = 0;
            }
            document.getElementById('help-panel-content').onclick = (e) => {
                const link = e.target.closest('a');
                if (!link) return;
                
                const href = link.getAttribute('href');
                if (!href) return;
                
                const docName = href.replace(/\.md$/, '');
                const knownDocs = ['persona', 'workflow', 'workflow-levels', 'instance'];
                
                if (knownDocs.includes(docName)) {
                    e.preventDefault();
                    openHelpPanel(docName);
                }
            };
            document.getElementById('help-panel').classList.add('open');
            document.getElementById('help-backdrop').classList.add('open');
        } catch (err) {
            document.getElementById('help-panel-content').innerHTML = '<p>Help content not found</p>';
            document.getElementById('help-panel').classList.add('open');
            document.getElementById('help-backdrop').classList.add('open');
        }
    }

    function closeHelpPanel() {
        currentHelpDoc = null;
        document.getElementById('help-panel').classList.remove('open');
        document.getElementById('help-backdrop').classList.remove('open');
    }

    document.getElementById('help-panel-close').addEventListener('click', closeHelpPanel);
    document.getElementById('help-backdrop').addEventListener('click', closeHelpPanel);
    
    document.getElementById('help-panel-open-tab').addEventListener('click', () => {
        const docParam = currentHelpDoc ? `?doc=${encodeURIComponent(currentHelpDoc)}` : '';
        window.open(`/docs.html${docParam}`, '_blank');
    });

    function closeInlinePersonaEditor() {
        const ctx = currentInlineEditor?.closest('.expanded-content');
        if (currentInlineEditor) {
            currentInlineEditor.remove();
            currentInlineEditor = null;
        }
        const root = ctx || document;
        const logsPanel = root.querySelector('.logs-panel');
        if (logsPanel) {
            logsPanel.remove();
        }
        root.querySelectorAll('.workflow-logs-panel').forEach(panel => {
            panel.remove();
        });
        const workflowsColumn = root.querySelector('.workflows-column');
        if (workflowsColumn) {
            workflowsColumn.style.display = '';
        }
        clearEditingState();
    }

    function closeInlineWorkflowEditor() {
        if (currentInlineEditor) {
            const logsPanel = currentInlineEditor.nextElementSibling;
            if (logsPanel && logsPanel.classList.contains('workflow-logs-panel')) {
                logsPanel.remove();
            }
            currentInlineEditor.remove();
            currentInlineEditor = null;
        }
        clearEditingState();
    }

    function resolveLogInstancePath(personaNode, defaultPath) {
        const parentSection = personaNode.closest('.parent-section');
        if (parentSection && parentSection.dataset.currentInstancePath) {
            return parentSection.dataset.currentInstancePath;
        }
        return defaultPath;
    }

    async function openInlinePersonaEditor(personaNode, instancePath, personaId) {
        closeInlinePersonaEditor();

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/personas/${encodeURIComponent(personaId)}`);
            if (!response.ok) throw new Error('Failed to load persona');
            const persona = await response.json();

            const logInstancePath = resolveLogInstancePath(personaNode, instancePath);

            let logsOffset = 0;
            const logsCount = 5;
            let logsTotal = 0;
            let currentLogs = [];

            const refreshLogs = async (offset) => {
                const logsData = await fetchPersonaLogs(logInstancePath, personaId, offset, logsCount);
                logsOffset = logsData.offset || 0;
                logsTotal = logsData.total || 0;
                currentLogs = logsData.logs || [];
                updateLogsPanel();
            };

            const updateLogsPanel = () => {
                const logsPanel = document.querySelector('.logs-panel-content');
                if (logsPanel) {
                    const logsHtml = renderPersonaLogsHtml(currentLogs, personaId);
                    logsPanel.innerHTML = logsHtml;
                    logsPanel.scrollTop = 0;

                    const paginationPanels = document.querySelectorAll('.logs-pagination');
                    const start = logsOffset + 1;
                    const end = Math.min(logsOffset + logsCount, logsTotal);
                    const paginationText = logsTotal > 0 ? `${start} - ${end} (of ${logsTotal})` : 'No logs';

                    paginationPanels.forEach(panel => {
                        const textEl = panel.querySelector('.logs-pagination-text');
                        if (textEl) {
                            textEl.textContent = paginationText;
                        }

                        const prevBtn = panel.querySelector('.logs-prev-btn');
                        const nextBtn = panel.querySelector('.logs-next-btn');

                        if (prevBtn) {
                            prevBtn.disabled = logsOffset <= 0;
                        }
                        if (nextBtn) {
                            nextBtn.disabled = logsOffset + logsCount >= logsTotal;
                        }
                    });

                    const paginationTop = document.querySelector('.logs-pagination-top');
                    if (paginationTop) {
                        const rect = paginationTop.getBoundingClientRect();
                        if (rect.top < 0) {
                            paginationTop.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    }
                }
            };

            const avatarPreviewHtml = persona.avatar
                ? `<img class="avatar-preview-img" src="${escapeHtml(persona.avatar)}" alt="" onerror="this.outerHTML='<span class=\\'avatar-preview-placeholder\\'>○</span>'">`
                : '<span class="avatar-preview-placeholder">○</span>';

            const editorHtml = `
                <div class="persona-editor-inline">
                    <button class="persona-editor-close" title="Close">&times;</button>
                    <div class="persona-field">
                        <label>Name</label>
                        <input type="text" class="persona-input" data-field="name" value="${escapeHtml(persona.name || '')}">
                    </div>
                    <div class="persona-field avatar-field">
                        <label>Avatar</label>
                        <div class="avatar-input-row">
                            <div class="avatar-preview">${avatarPreviewHtml}</div>
                            <div class="avatar-inputs">
                                <input type="text" class="persona-input avatar-url-input" data-field="avatar" placeholder="https://example.com/avatar.png" value="${escapeHtml(persona.avatar || '')}">
                            </div>
                        </div>
                    </div>
                    <div class="persona-field">
                        <label>Role</label>
                        <input type="text" class="persona-input" data-field="role" value="${escapeHtml(persona.role || '')}" placeholder="2-3 words position title, like: UIX Designer, Frontend engineer">
                    </div>
                    <div class="persona-field">
                        <label>Agent</label>
                        <input type="text" class="persona-input" data-field="agent" placeholder="Can be empty" value="${escapeHtml(persona.agent || '')}">
                        <div class="persona-agent-presets">
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker">cc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker-swift">cc_docker-swift</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker">oc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker-swift">oc_docker-swift</button>
                        </div>
                    </div>
                    <div class="persona-field">
                        <label>About</label>
                        <textarea class="persona-input persona-textarea" data-field="about" rows="4" placeholder="This is system_prompt (will be used as system prompt for LLMs)">${escapeHtml(persona.about || '')}</textarea>
                    </div>
                    <div class="persona-field">
                        <label>Task</label>
                        <textarea class="persona-input persona-textarea" data-field="task" rows="5">${escapeHtml(persona.task || '')}</textarea>
                    </div>
                    <button class="delete-btn" data-action="delete-persona">Delete</button>
                </div>
            `;
            personaNode.insertAdjacentHTML('afterend', editorHtml);
            currentInlineEditor = personaNode.nextElementSibling;
            currentInlineEditor.dataset.instancePath = instancePath;

            const personaList = personaNode.closest('.persona-list');
            setEditingState(personaList, personaNode);
            currentInlineEditor.dataset.personaId = personaId;

            const expandedContent = personaNode.closest('.expanded-content');
            if (expandedContent) {
                const workflowsColumn = expandedContent.querySelector('.workflows-column');
                if (workflowsColumn) {
                    workflowsColumn.style.display = 'none';
                }

                const logsPanelHtml = `
                    <div class="logs-panel">
                        <div class="logs-panel-header">
                            <button class="logs-back-btn" title="Back to personas">&larr;</button>
                            <span class="logs-panel-title">Logs: ${escapeHtml(persona.name)}</span>
                        </div>
                        <div class="logs-pagination logs-pagination-top">
                            <button class="logs-prev-btn" title="Previous logs">&larr;</button>
                            <span class="logs-pagination-text"></span>
                            <button class="logs-next-btn" title="Next logs">&rarr;</button>
                            <button class="logs-refresh-btn" title="Refresh logs">↻</button>
                        </div>
                        <div class="logs-panel-content"></div>
                        <div class="logs-pagination logs-pagination-bottom">
                            <button class="logs-prev-btn" title="Previous logs">&larr;</button>
                            <span class="logs-pagination-text"></span>
                            <button class="logs-next-btn" title="Next logs">&rarr;</button>
                            <button class="logs-refresh-btn" title="Refresh logs">↻</button>
                        </div>
                    </div>
                `;
                
                const existingLogsPanel = expandedContent.querySelector('.logs-panel');
                if (existingLogsPanel) existingLogsPanel.remove();
                
                expandedContent.insertAdjacentHTML('beforeend', logsPanelHtml);

                const paginationPanels = expandedContent.querySelectorAll('.logs-pagination');
                paginationPanels.forEach(paginationPanel => {
                    const prevBtn = paginationPanel.querySelector('.logs-prev-btn');
                    const nextBtn = paginationPanel.querySelector('.logs-next-btn');
                    const refreshBtn = paginationPanel.querySelector('.logs-refresh-btn');

                    prevBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (logsOffset > 0) {
                            refreshLogs(Math.max(0, logsOffset - logsCount));
                        }
                    });

                    nextBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (logsOffset + logsCount < logsTotal) {
                            refreshLogs(logsOffset + logsCount);
                        }
                    });

                    if (refreshBtn) {
                        refreshBtn.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            refreshBtn.classList.add('loading');
                            const originalText = refreshBtn.textContent;
                            try {
                                await refreshLogs(logsOffset);
                                refreshBtn.classList.remove('loading');
                                refreshBtn.classList.add('success');
                                refreshBtn.textContent = '✓';
                                setTimeout(() => {
                                    refreshBtn.classList.remove('success');
                                    refreshBtn.textContent = originalText;
                                }, 1500);
                            } catch (err) {
                                refreshBtn.classList.remove('loading');
                                refreshBtn.classList.add('error');
                                refreshBtn.textContent = '✗';
                                setTimeout(() => {
                                    refreshBtn.classList.remove('error');
                                    refreshBtn.textContent = originalText;
                                }, 1500);
                            }
                        });
                    }
                });

                await refreshLogs(0);
                instancePersonaLogs[instancePath] = currentLogs;
            }

            currentInlineEditor.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            currentInlineEditor.addEventListener('focusin', (e) => {
                e.stopPropagation();
            });

            currentInlineEditor.querySelectorAll('.persona-input').forEach(input => {
                input.addEventListener('blur', (e) => {
                    if (e.target.value !== e.target.defaultValue) {
                        saveInlinePersonaField(currentInlineEditor, e.target.dataset.field, e.target.value);
                        e.target.defaultValue = e.target.value;
                    }
                });
            });

            currentInlineEditor.querySelectorAll('.agent-preset-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const agent = btn.dataset.agent;
                    const input = currentInlineEditor.querySelector('[data-field="agent"]');
                    if (input) {
                        input.value = agent;
                        if (agent !== input.defaultValue) {
                            saveInlinePersonaField(currentInlineEditor, 'agent', agent);
                            input.defaultValue = agent;
                        }
                    }
                });
            });

            const avatarUrlInput = currentInlineEditor.querySelector('.avatar-url-input');
            if (avatarUrlInput) {
                let avatarDebounce;
                avatarUrlInput.addEventListener('input', (e) => {
                    clearTimeout(avatarDebounce);
                    avatarDebounce = setTimeout(() => {
                        const url = e.target.value.trim();
                        updateAvatarPreview(currentInlineEditor, url);
                        saveInlinePersonaField(currentInlineEditor, 'avatar', url);
                        e.target.defaultValue = url;
                    }, 500);
                });
            }

            const deleteBtn = currentInlineEditor.querySelector('[data-action="delete-persona"]');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const personaName = currentInlineEditor.querySelector('[data-field="name"]')?.value || personaId;
                    if (confirm(`Delete persona "${personaName}"?`)) {
                        deletePersona(instancePath, personaId, currentInlineEditor);
                    }
                });
            }

            const closeBtn = currentInlineEditor.querySelector('.persona-editor-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeInlinePersonaEditor();
                });
            }

            const backBtn = document.querySelector('.logs-back-btn');
            if (backBtn) {
                backBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeInlinePersonaEditor();
                });
            }

        } catch (err) {
            console.error('Failed to load persona:', err);
        }
    }

    function updateAvatarPreview(editor, avatar) {
        const preview = editor.querySelector('.avatar-preview');
        if (!preview) return;

        if (avatar) {
            preview.innerHTML = `<img class="avatar-preview-img" src="${escapeHtml(avatar)}" alt="" onerror="this.outerHTML='<span class=\\'avatar-preview-placeholder\\'>○</span>'">`;
        } else {
            preview.innerHTML = '<span class="avatar-preview-placeholder">○</span>';
        }
    }

   

    async function saveInlinePersonaField(editor, field, value) {
        const instancePath = editor.dataset.instancePath;
        const personaId = editor.dataset.personaId;
        
        const fieldContainer = editor.querySelector(`[data-field="${field}"]`).parentElement;
        const existingIndicator = fieldContainer.querySelector('.save-indicator');
        if (existingIndicator) existingIndicator.remove();
        
        const savingIndicator = document.createElement('span');
        savingIndicator.className = 'save-indicator saving';
        savingIndicator.textContent = '⏳';
        fieldContainer.appendChild(savingIndicator);

        try {
            const updateData = {};
            updateData[field] = value;
            
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/personas/${encodeURIComponent(personaId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData)
            });
            
            if (!response.ok) throw new Error('Failed to save');
            
            savingIndicator.className = 'save-indicator saved';
            savingIndicator.textContent = '✓';
            
            setTimeout(() => {
                savingIndicator.classList.add('fade-out');
                setTimeout(() => savingIndicator.remove(), 300);
            }, 1500);
        } catch (err) {
            console.error('Failed to save:', err);
            savingIndicator.className = 'save-indicator error';
            savingIndicator.textContent = '⚠';
            
            setTimeout(() => savingIndicator.remove(), 3000);
        }
    }

    async function openInlineWorkflowEditor(workflowNode, instancePath, workflowId) {
        closeInlinePersonaEditor();
        
        document.querySelectorAll('.workflow-logs-panel').forEach(panel => {
            panel.remove();
        });
        
        if (currentInlineEditor) {
            closeInlineWorkflowEditor();
        }

        try {
            const [workflowResponse, personasResponse, workflowsListResponse] = await Promise.all([
                fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows/${encodeURIComponent(workflowId)}`),
                fetch(`/api/instances/${encodeURIComponent(instancePath)}/personas`),
                fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows`)
            ]);

            if (!workflowResponse.ok) throw new Error('Failed to load workflow');

            const workflow = await workflowResponse.json();
            const personasData = await personasResponse.json();
            const personas = personasData.personas || [];
            const workflowsData = await workflowsListResponse.json();
            const allWorkflows = workflowsData.workflows || [];
            const levels = workflow.levels || [];

            const levelsHtml = renderLevels(levels, personas, allWorkflows);

            const scheduleHint = formatEverySecsHint(workflow.every_secs || 0);

            let workflowLogsOffset = 0;
            const workflowLogsCount = 5;
            let workflowLogsTotal = 0;
            let currentWorkflowLogs = [];

            const refreshWorkflowLogs = async (offset) => {
                const logsData = await fetchWorkflowLogs(instancePath, workflowId, offset, workflowLogsCount);
                workflowLogsOffset = logsData.offset || 0;
                workflowLogsTotal = logsData.total || 0;
                currentWorkflowLogs = logsData.logs || [];
                updateWorkflowLogsPanel();
            };

            const updateWorkflowLogsPanel = () => {
                const logsPanel = document.querySelector('.workflow-logs-panel-content');
                if (logsPanel) {
                    const logsHtml = renderWorkflowLogsHtml(currentWorkflowLogs, instancePath);
                    logsPanel.innerHTML = logsHtml;
                    logsPanel.scrollTop = 0;

                    const paginationPanels = document.querySelectorAll('.workflow-logs-pagination');
                    const start = workflowLogsOffset +1;
                    const end = Math.min(workflowLogsOffset + workflowLogsCount, workflowLogsTotal);
                    const paginationText = workflowLogsTotal > 0 ? `${start} - ${end} (of ${workflowLogsTotal})` : 'No logs';

                    paginationPanels.forEach(panel => {
                        const textEl = panel.querySelector('.workflow-logs-pagination-text');
                        if (textEl) {
                            textEl.textContent = paginationText;
                        }

                        const prevBtn = panel.querySelector('.workflow-logs-prev-btn');
                        const nextBtn = panel.querySelector('.workflow-logs-next-btn');

                        if (prevBtn) {
                            prevBtn.disabled = workflowLogsOffset <= 0;
                        }
                        if (nextBtn) {
                            nextBtn.disabled = workflowLogsOffset + workflowLogsCount >= workflowLogsTotal;
                        }
                    });

                    const paginationTop = document.querySelector('.workflow-logs-pagination-top');
                    if (paginationTop) {
                        const rect = paginationTop.getBoundingClientRect();
                        if (rect.top < 0) {
                            paginationTop.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    }
                }
            };

            const editorHtml = `
                <div class="workflow-editor-inline">
                    <div class="wf-header">
                        <div class="wf-title-row">
                            <input type="text" class="wf-name-input" data-field="name" value="${escapeHtml(workflow.name || workflowId)}" placeholder="Workflow name">
                            <div class="wf-header-actions">
                                <span class="wf-save-indicator"></span>
                                <button class="delete-btn" data-action="delete-workflow">Delete</button>
                            </div>
                        </div>
                        <input type="text" class="wf-desc-input" data-field="desc" value="${escapeHtml(workflow.desc || '')}" placeholder="Description (optional)">
                        <div class="wf-agent-field">
                            <label>Agent</label>
                            <input type="text" class="wf-agent-input" data-field="agent" value="${escapeHtml(workflow.agent || 'oc_docker')}" placeholder="oc_docker">
                        </div>
                        <div class="wf-agent-presets">
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker">cc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker-swift">cc_docker-swift</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker">oc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker-swift">oc_docker-swift</button>
                        </div>
                        <div class="wf-ask-field">
                            <label>Ask</label>
                            <textarea class="wf-ask-input" data-field="ask" rows="3" placeholder="Default task prompt for this workflow...">${escapeHtml(workflow.ask || '')}</textarea>
                        </div>
                        <span class="wf-subtitle">Workflow Levels <span class="wf-hint">(drag personas from the left or click +)</span></span>
                    </div>
                    <div class="wf-body">
                        <div class="wf-schedule-field">
                            <label>Repeat every</label>
                            <input type="text" class="wf-schedule-input" data-field="every_secs" pattern="[0-9\-]*" inputmode="numeric" maxlength="7" value="${workflow.every_secs || 0}">
                            <span class="wf-schedule-unit">seconds</span>
                            <span class="info-icon" data-doc="workflow-schedule" title="Learn about scheduling">ⓘ</span>
                            <span class="wf-schedule-hint">(${scheduleHint})</span>
                        </div>
                        <div class="wf-schedule-presets">
                            <button type="button" class="preset-btn" data-secs="-1">startup</button>
                            <button type="button" class="preset-btn" data-secs="0">manual</button>
                            <button type="button" class="preset-btn" data-secs="600">10m</button>
                            <button type="button" class="preset-btn" data-secs="3600">1h</button>
                            <button type="button" class="preset-btn" data-secs="86400">24h</button>
                        </div>
                        <div class="wf-canvas">
                            <div class="wf-levels-container" data-instance-path="${escapeHtml(instancePath)}" data-workflow-id="${escapeHtml(workflowId)}">${levelsHtml}</div>
                            <button class="wf-add-level-btn">+ Add Level</button>
                        </div>
                    </div>
                </div>
                <div class="workflow-logs-panel">
                    <div class="logs-panel-header">
                        <span class="logs-panel-title">Workflow Logs</span>
                    </div>
                    <div class="workflow-logs-pagination workflow-logs-pagination-top">
                        <button class="workflow-logs-prev-btn" title="Previous logs">&larr;</button>
                        <span class="workflow-logs-pagination-text"></span>
                        <button class="workflow-logs-next-btn" title="Next logs">&rarr;</button>
                        <button class="logs-refresh-btn" title="Refresh logs">↻</button>
                    </div>
                    <div class="workflow-logs-panel-content"></div>
                    <div class="workflow-logs-pagination workflow-logs-pagination-bottom">
                        <button class="workflow-logs-prev-btn" title="Previous logs">&larr;</button>
                        <span class="workflow-logs-pagination-text"></span>
                        <button class="workflow-logs-next-btn" title="Next logs">&rarr;</button>
                        <button class="logs-refresh-btn" title="Refresh logs">↻</button>
                    </div>
                </div>
            `;
            workflowNode.insertAdjacentHTML('afterend', editorHtml);
            currentInlineEditor = workflowNode.nextElementSibling;
            currentInlineEditor.dataset.instancePath = instancePath;
            currentInlineEditor.dataset.workflowId = workflowId;
            currentInlineEditor._allWorkflows = allWorkflows;

            currentInlineEditor.addEventListener('click', (e) => e.stopPropagation());
            currentInlineEditor.addEventListener('focusin', (e) => e.stopPropagation());

            currentInlineEditor.querySelectorAll('.info-icon').forEach(icon => {
                icon.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openHelpPanel(icon.dataset.doc);
                });
            });

            const nameInput = currentInlineEditor.querySelector('[data-field="name"]');
            if (nameInput) {
                nameInput.addEventListener('blur', (e) => {
                    const value = e.target.value.trim();
                    if (value !== e.target.defaultValue) {
                        saveWorkflowField(currentInlineEditor, instancePath, workflowId, 'name', value);
                        e.target.defaultValue = value;
                    }
                });
            }

            const descInput = currentInlineEditor.querySelector('[data-field="desc"]');
            if (descInput) {
                descInput.addEventListener('blur', (e) => {
                    const value = e.target.value.trim();
                    if (value !== e.target.defaultValue) {
                        saveWorkflowField(currentInlineEditor, instancePath, workflowId, 'desc', value);
                        e.target.defaultValue = value;
                    }
                });
            }

            const agentInput = currentInlineEditor.querySelector('[data-field="agent"]');
            if (agentInput) {
                agentInput.addEventListener('blur', (e) => {
                    const value = e.target.value.trim();
                    if (value !== e.target.defaultValue) {
                        saveWorkflowField(currentInlineEditor, instancePath, workflowId, 'agent', value);
                        e.target.defaultValue = value;
                    }
                });
            }

            const askInput = currentInlineEditor.querySelector('.wf-ask-input');
            if (askInput) {
                askInput.defaultValue = askInput.value;
                askInput.addEventListener('blur', (e) => {
                    const value = e.target.value.trim();
                    if (value !== e.target.defaultValue) {
                        saveWorkflowField(currentInlineEditor, instancePath, workflowId, 'ask', value);
                        e.target.defaultValue = value;
                    }
                });
            }

            currentInlineEditor.querySelectorAll('.agent-preset-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const agent = btn.dataset.agent;
                    const input = currentInlineEditor.querySelector('[data-field="agent"]');
                    if (input) {
                        input.value = agent;
                        if (agent !== input.defaultValue) {
                            saveWorkflowField(currentInlineEditor, instancePath, workflowId, 'agent', agent);
                            input.defaultValue = agent;
                        }
                    }
                });
            });

            const everySecsInput = currentInlineEditor.querySelector('[data-field="every_secs"]');
            if (everySecsInput) {
                everySecsInput.addEventListener('input', (e) => {
                    const hint = currentInlineEditor.querySelector('.wf-schedule-hint');
                    if (hint) {
                        hint.textContent = `(${formatEverySecsHint(parseInt(e.target.value) || 0)})`;
                    }
                });
                everySecsInput.addEventListener('blur', (e) => {
                    const value = parseInt(e.target.value) || 0;
                    if (value !== parseInt(e.target.defaultValue)) {
                        saveWorkflowEverySecs(currentInlineEditor, instancePath, workflowId, value);
                        e.target.defaultValue = value;
                    }
                });
            }

            currentInlineEditor.querySelectorAll('.preset-btn[data-secs]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const secs = btn.dataset.secs;
                    const input = currentInlineEditor.querySelector('[data-field="every_secs"]');
                    if (input) {
                        input.value = secs;
                        input.dispatchEvent(new Event('input'));
                        const value = parseInt(secs) || 0;
                        if (value !== parseInt(input.defaultValue)) {
                            saveWorkflowEverySecs(currentInlineEditor, instancePath, workflowId, value);
                            input.defaultValue = value;
                        }
                    }
                });
            });

            setupWorkflowDragDrop(currentInlineEditor, instancePath, workflowId, personas, allWorkflows);

            const workflowDeleteBtn = currentInlineEditor.querySelector('[data-action="delete-workflow"]');
            if (workflowDeleteBtn) {
                workflowDeleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete workflow "${workflowId}"?`)) {
                        deleteWorkflow(instancePath, workflowId, currentInlineEditor);
                    }
                });
            }

            currentInlineEditor.querySelector('.wf-add-level-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                addLevel(currentInlineEditor, instancePath, workflowId, personas);
            });

            const paginationPanels = currentInlineEditor.parentElement.querySelectorAll('.workflow-logs-pagination');
            paginationPanels.forEach(paginationPanel => {
                const prevBtn = paginationPanel.querySelector('.workflow-logs-prev-btn');
                const nextBtn = paginationPanel.querySelector('.workflow-logs-next-btn');

                prevBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (workflowLogsOffset > 0) {
                        refreshWorkflowLogs(Math.max(0, workflowLogsOffset - workflowLogsCount));
                    }
                });

                nextBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (workflowLogsOffset + workflowLogsCount < workflowLogsTotal) {
                        refreshWorkflowLogs(workflowLogsOffset + workflowLogsCount);
                    }
                });

                const refreshBtn = paginationPanel.querySelector('.logs-refresh-btn');
                if (refreshBtn) {
                    refreshBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        refreshBtn.classList.add('loading');
                        const originalText = refreshBtn.textContent;
                        try {
                            await refreshWorkflowLogs(workflowLogsOffset);
                            refreshBtn.classList.remove('loading');
                            refreshBtn.classList.add('success');
                            refreshBtn.textContent = '✓';
                            setTimeout(() => {
                                refreshBtn.classList.remove('success');
                                refreshBtn.textContent = originalText;
                            }, 1500);
                        } catch (err) {
                            refreshBtn.classList.remove('loading');
                            refreshBtn.classList.add('error');
                            refreshBtn.textContent = '✗';
                            setTimeout(() => {
                                refreshBtn.classList.remove('error');
                                refreshBtn.textContent = originalText;
                            }, 1500);
                        }
                    });
                }
            });

            await refreshWorkflowLogs(0);
        } catch (err) {
            console.error('Failed to load workflow:', err);
        }
    }

    function renderLevels(levels, personas, workflows) {
        if (levels.length === 0) {
            levels = [[]];
        }

        const showReorder = levels.length >= 3;
        const isBottomLevel = (idx) => idx === levels.length - 1;

        return levels.map((level, levelIndex) => {
            const slotsHtml = level.map((entryId, slotIndex) => {
                const ref = parsePersonaRef(entryId);
                const persona = personas.find(p => p.id === ref.id);
                let displayName = persona ? persona.name : ref.id;
                let slotClass = 'wf-slot filled';

                let isWorkflowRef = false;
                if (!persona && ref.id.startsWith(':')) {
                    const wfId = ref.id.substring(1);
                    const wf = (workflows || []).find(w => w.id === wfId);
                    displayName = wf ? wf.name : ref.id;
                    slotClass += ' wf-workflow-ref';
                    isWorkflowRef = true;
                }

                const isSolo = level.length === 1;
                const isBottom = isBottomLevel(levelIndex);
                const showToggle = !isWorkflowRef && isSolo && !isBottom;

                let toggleHtml = '';
                if (showToggle) {
                    const rwActive = ref.isRW;
                    toggleHtml = `
                        <div class="wf-mode-toggle" role="radiogroup" aria-label="Execution mode for ${escapeHtml(ref.id)}">
                            <button class="wf-mode-opt${!rwActive ? ' active' : ''}" data-mode="ro" role="radio" aria-checked="${!rwActive}" tabindex="0">ro</button>
                            <button class="wf-mode-opt${rwActive ? ' active active-rw' : ''}" data-mode="rw" role="radio" aria-checked="${rwActive}" tabindex="0">rw</button>
                        </div>
                    `;
                }

                return `
                    <div class="${slotClass}" data-level="${levelIndex}" data-slot="${slotIndex}" data-persona-id="${escapeHtml(entryId)}">
                        <span class="wf-slot-name">${escapeHtml(displayName)}</span>
                        ${toggleHtml}
                        <button class="wf-slot-remove" title="Remove">×</button>
                    </div>
                `;
            }).join('');

            const reorderBtns = showReorder ? `
                <div class="wf-level-reorder-btns">
                    ${levelIndex > 0 ? '<button class="wf-level-move-up" title="Move level up" aria-label="Move level up">▲</button>' : ''}
                    ${levelIndex < levels.length - 1 ? '<button class="wf-level-move-down" title="Move level down" aria-label="Move level down">▼</button>' : ''}
                </div>
            ` : '';

            const dragHandle = showReorder ? '<span class="wf-level-drag-handle" title="Drag to reorder">⠿</span>' : '';

            const readonlyFooter = level.length >= 2 ? `
                    <div class="wf-level-readonly-footer" role="status">
                        <span class="wf-level-readonly-text">All read-only</span>
                        <span class="info-icon wf-level-readonly-info" data-doc="workflow" data-section="Multi-Persona Levels Run in Read-Only Mode" title="Learn why this level runs in read-only mode" tabindex="0" aria-label="Learn why this level runs in read-only mode">ⓘ</span>
                    </div>
                ` : '';

            return `
                <div class="wf-level${showReorder ? ' wf-level-reorderable' : ''}" data-level="${levelIndex}" draggable="${showReorder ? 'true' : 'false'}">
                    <div class="wf-level-header">
                        ${dragHandle}
                        <span class="wf-level-label">Level ${levelIndex}</span>
                        ${levelIndex > 0 ? '<button class="wf-level-remove" title="Remove level">×</button>' : ''}
                    </div>
                    <div class="wf-level-slots">
                        ${slotsHtml}
                        <div class="wf-slot placeholder" data-level="${levelIndex}" data-slot="${level.length}">
                            <span class="wf-slot-plus">+</span>
                        </div>
                    </div>
                    ${reorderBtns}
                    ${readonlyFooter}
                </div>
            `;
        }).join('');
    }

    function setupWorkflowDragDrop(editor, instancePath, workflowId, personas, allWorkflows) {
        const levelsContainer = editor.querySelector('.wf-levels-container');
        
        levelsContainer.addEventListener('dragover', (e) => {
            const slot = e.target.closest('.wf-slot');
            if (slot && slot.classList.contains('placeholder')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                slot.classList.add('drag-over');
            } else if (slot && slot.classList.contains('filled')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'none';
            }
        });

        levelsContainer.addEventListener('dragleave', (e) => {
            const slot = e.target.closest('.wf-slot');
            if (slot) {
                slot.classList.remove('drag-over');
            }
        });

        levelsContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const slot = e.target.closest('.wf-slot');
            if (!slot) return;
            
            slot.classList.remove('drag-over');
            
            if (!slot.classList.contains('placeholder')) {
                slot.classList.add('drop-rejected');
                setTimeout(() => slot.classList.remove('drop-rejected'), 300);
                return;
            }
            
            const personaId = e.dataTransfer.getData('text/plain');
            if (!personaId) return;

            const levelIndex = parseInt(slot.dataset.level);
            const slotIndex = parseInt(slot.dataset.slot);

            addPersonaToLevel(editor, instancePath, workflowId, levelIndex, slotIndex, personaId, personas);
        });

        levelsContainer.addEventListener('click', (e) => {
            const readonlyInfo = e.target.closest('.wf-level-readonly-info');
            if (readonlyInfo) {
                e.stopPropagation();
                openHelpPanel(readonlyInfo.dataset.doc, readonlyInfo.dataset.section);
                return;
            }

            const modeBtn = e.target.closest('.wf-mode-opt');
            if (modeBtn) {
                e.stopPropagation();
                const slot = modeBtn.closest('.wf-slot');
                const levelIndex = parseInt(slot.dataset.level);
                const slotIndex = parseInt(slot.dataset.slot);
                const currentId = slot.dataset.personaId;
                const ref = parsePersonaRef(currentId);
                const newMode = modeBtn.dataset.mode;

                const levels = getLevelsFromEditor(editor);
                if (newMode === 'rw') {
                    levels[levelIndex][slotIndex] = ref.id + ':rw';
                } else {
                    levels[levelIndex][slotIndex] = ref.id;
                }
                refreshLevelsUI(editor, levels, personas);
                saveWorkflowLevels(editor, instancePath, workflowId, levels);
                return;
            }

            if (e.target.classList.contains('wf-slot-remove')) {
                const slot = e.target.closest('.wf-slot');
                const levelIndex = parseInt(slot.dataset.level);
                const slotIndex = parseInt(slot.dataset.slot);
                removePersonaFromLevel(editor, instancePath, workflowId, levelIndex, slotIndex, personas);
            }
            
            if (e.target.classList.contains('wf-level-remove')) {
                const level = e.target.closest('.wf-level');
                const levelIndex = parseInt(level.dataset.level);
                removeLevel(editor, instancePath, workflowId, levelIndex, personas);
            }

            if (e.target.classList.contains('wf-level-move-up')) {
                const level = e.target.closest('.wf-level');
                const levelIndex = parseInt(level.dataset.level);
                moveLevel(editor, instancePath, workflowId, levelIndex, -1, personas);
                return;
            }

            if (e.target.classList.contains('wf-level-move-down')) {
                const level = e.target.closest('.wf-level');
                const levelIndex = parseInt(level.dataset.level);
                moveLevel(editor, instancePath, workflowId, levelIndex, 1, personas);
                return;
            }
            
            const placeholderSlot = e.target.closest('.wf-slot.placeholder');
            if (placeholderSlot && !e.target.classList.contains('wf-slot-remove')) {
                const levelIndex = parseInt(placeholderSlot.dataset.level);
                const slotIndex = parseInt(placeholderSlot.dataset.slot);
                openPersonaSelector(levelIndex, slotIndex, personas, editor, instancePath, workflowId, allWorkflows);
            }
        });

        setupLevelDragReorder(levelsContainer, editor, instancePath, workflowId, personas);
    }

    function setupLevelDragReorder(levelsContainer, editor, instancePath, workflowId, personas) {
        let draggedLevel = null;

        levelsContainer.addEventListener('dragstart', (e) => {
            const level = e.target.closest('.wf-level.wf-level-reorderable');
            if (!level) return;
            if (e.target.closest('.wf-slot') || e.target.closest('.wf-level-reorder-btns')) return;
            draggedLevel = level;
            level.classList.add('wf-level-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/x-wf-level', level.dataset.level);
            requestAnimationFrame(() => {
                level.classList.add('wf-level-dragging-opacity');
            });
        });

        levelsContainer.addEventListener('dragend', (e) => {
            const level = e.target.closest('.wf-level');
            if (!level) return;
            level.classList.remove('wf-level-dragging', 'wf-level-dragging-opacity');
            draggedLevel = null;
            levelsContainer.querySelectorAll('.wf-level-drag-over-top, .wf-level-drag-over-bottom').forEach(el => {
                el.classList.remove('wf-level-drag-over-top', 'wf-level-drag-over-bottom');
            });
        });

        levelsContainer.addEventListener('dragover', (e) => {
            if (!draggedLevel) return;
            if (e.target.closest('.wf-slot')) return;
            const targetLevel = e.target.closest('.wf-level');
            if (!targetLevel || targetLevel === draggedLevel) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            levelsContainer.querySelectorAll('.wf-level-drag-over-top, .wf-level-drag-over-bottom').forEach(el => {
                el.classList.remove('wf-level-drag-over-top', 'wf-level-drag-over-bottom');
            });

            const rect = targetLevel.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            const isTop = e.clientY < midY;
            const fromIdx = parseInt(draggedLevel.dataset.level);
            const toIdx = parseInt(targetLevel.dataset.level);

            if ((fromIdx < toIdx && isTop) || (fromIdx > toIdx && !isTop)) return;

            targetLevel.classList.add(isTop ? 'wf-level-drag-over-top' : 'wf-level-drag-over-bottom');
        });

        levelsContainer.addEventListener('dragleave', (e) => {
            const targetLevel = e.target.closest('.wf-level');
            if (targetLevel) {
                targetLevel.classList.remove('wf-level-drag-over-top', 'wf-level-drag-over-bottom');
            }
        });

        levelsContainer.addEventListener('drop', (e) => {
            if (!draggedLevel) return;
            if (e.target.closest('.wf-slot')) return;
            e.preventDefault();
            const targetLevel = e.target.closest('.wf-level');
            if (!targetLevel || targetLevel === draggedLevel) return;

            const fromIndex = parseInt(draggedLevel.dataset.level);
            const toIndex = parseInt(targetLevel.dataset.level);

            levelsContainer.querySelectorAll('.wf-level-drag-over-top, .wf-level-drag-over-bottom').forEach(el => {
                el.classList.remove('wf-level-drag-over-top', 'wf-level-drag-over-bottom');
            });

            const levels = getLevelsFromEditor(editor);
            const rect = targetLevel.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            let insertIndex = e.clientY < midY ? toIndex : toIndex + 1;
            if (fromIndex < insertIndex) insertIndex--;

            if (fromIndex === insertIndex) return;

            const moved = levels.splice(fromIndex, 1)[0];
            levels.splice(insertIndex, 0, moved);
            refreshLevelsUI(editor, levels, personas);
            saveWorkflowLevels(editor, instancePath, workflowId, levels);

            const movedLevel = levelsContainer.querySelectorAll('.wf-level')[insertIndex];
            if (movedLevel) {
                movedLevel.classList.add('wf-level-moved');
                setTimeout(() => movedLevel.classList.remove('wf-level-moved'), 400);
            }

            draggedLevel = null;
        });
    }

    async function addPersonaToLevel(editor, instancePath, workflowId, levelIndex, slotIndex, personaId, personas) {
        const levels = getLevelsFromEditor(editor);
        
        while (levels.length <= levelIndex) {
            levels.push([]);
        }

        if (slotIndex >= levels[levelIndex].length) {
            levels[levelIndex].push(personaId);
        } else {
            levels[levelIndex][slotIndex] = personaId;
        }

        if (levels[levelIndex].length > 1) {
            levels[levelIndex] = levels[levelIndex].map(entry => {
                const ref = parsePersonaRef(entry);
                return ref.id;
            });
        }

        await saveWorkflowLevels(editor, instancePath, workflowId, levels);
        refreshLevelsUI(editor, levels, personas);
    }

    async function removePersonaFromLevel(editor, instancePath, workflowId, levelIndex, slotIndex, personas) {
        const levels = getLevelsFromEditor(editor);
        
        if (levels[levelIndex] && slotIndex < levels[levelIndex].length) {
            levels[levelIndex].splice(slotIndex, 1);
        }

        await saveWorkflowLevels(editor, instancePath, workflowId, levels);
        refreshLevelsUI(editor, levels, personas);
    }

    function addLevel(editor, instancePath, workflowId, personas) {
        const levels = getLevelsFromEditor(editor);
        levels.push([]);
        refreshLevelsUI(editor, levels, personas);
        saveWorkflowLevels(editor, instancePath, workflowId, levels);
    }

    async function removeLevel(editor, instancePath, workflowId, levelIndex, personas) {
        const levels = getLevelsFromEditor(editor);
        if (levels.length > 1 && levelIndex > 0) {
            levels.splice(levelIndex, 1);
            await saveWorkflowLevels(editor, instancePath, workflowId, levels);
            refreshLevelsUI(editor, levels, personas);
        }
    }

    async function moveLevel(editor, instancePath, workflowId, levelIndex, direction, personas) {
        const levels = getLevelsFromEditor(editor);
        const newIndex = levelIndex + direction;
        if (newIndex < 0 || newIndex >= levels.length) return;
        const temp = levels[levelIndex];
        levels[levelIndex] = levels[newIndex];
        levels[newIndex] = temp;
        refreshLevelsUI(editor, levels, personas);
        await saveWorkflowLevels(editor, instancePath, workflowId, levels);
        const container = editor.querySelector('.wf-levels-container');
        const movedLevel = container.querySelectorAll('.wf-level')[newIndex];
        if (movedLevel) {
            movedLevel.classList.add('wf-level-moved');
            setTimeout(() => movedLevel.classList.remove('wf-level-moved'), 400);
        }
    }

    function getLevelsFromEditor(editor) {
        const levelNodes = editor.querySelectorAll('.wf-level');
        const levels = [];
        levelNodes.forEach(levelNode => {
            const slots = [];
            levelNode.querySelectorAll('.wf-slot.filled').forEach(slot => {
                slots.push(slot.dataset.personaId);
            });
            levels.push(slots);
        });
        return levels;
    }

    function refreshLevelsUI(editor, levels, personas) {
        const container = editor.querySelector('.wf-levels-container');
        container.innerHTML = renderLevels(levels, personas, editor._allWorkflows || []);
    }

    async function saveWorkflowLevels(editor, instancePath, workflowId, levels) {
        const indicator = editor.querySelector('.wf-save-indicator');
        indicator.textContent = '⏳';
        indicator.className = 'wf-save-indicator saving';

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows/${encodeURIComponent(workflowId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ levels })
            });
            
            if (!response.ok) throw new Error('Failed to save');
            
            indicator.textContent = '✓';
            indicator.className = 'wf-save-indicator saved';
            
            setTimeout(() => {
                indicator.textContent = '';
            }, 2000);
        } catch (err) {
            console.error('Failed to save workflow:', err);
            indicator.textContent = '⚠';
            indicator.className = 'wf-save-indicator error';
        }
    }

    async function saveWorkflowEverySecs(editor, instancePath, workflowId, everySecs) {
        const indicator = editor.querySelector('.wf-save-indicator');
        indicator.textContent = '⏳';
        indicator.className = 'wf-save-indicator saving';

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows/${encodeURIComponent(workflowId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ every_secs: everySecs })
            });
            
            if (!response.ok) throw new Error('Failed to save');
            
            indicator.textContent = '✓';
            indicator.className = 'wf-save-indicator saved';
            
            setTimeout(() => {
                indicator.textContent = '';
            }, 2000);
        } catch (err) {
            console.error('Failed to save workflow schedule:', err);
            indicator.textContent = '⚠';
            indicator.className = 'wf-save-indicator error';
        }
    }

    async function saveWorkflowField(editor, instancePath, workflowId, field, value) {
        const indicator = editor.querySelector('.wf-save-indicator');
        indicator.textContent = '⏳';
        indicator.className = 'wf-save-indicator saving';

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows/${encodeURIComponent(workflowId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value })
            });
            
            if (!response.ok) throw new Error('Failed to save');
            
            indicator.textContent = '✓';
            indicator.className = 'wf-save-indicator saved';
            
            setTimeout(() => {
                indicator.textContent = '';
            }, 2000);
        } catch (err) {
            console.error('Failed to save workflow field:', err);
            indicator.textContent = '⚠';
            indicator.className = 'wf-save-indicator error';
        }
    }

    function openInlinePersonaCreator(instancePath, insertAfterBtn) {
        if (currentInlineEditor) {
            currentInlineEditor.remove();
            currentInlineEditor = null;
            clearEditingState();
        }

        const creatorHtml = `
            <div class="persona-creator-inline">
                <div class="creator-header">
                    <span class="creator-title">New Persona</span>
                </div>
                <div class="creator-body">
                    <div class="persona-field">
                        <label>Name</label>
                        <input type="text" class="persona-input creator-field" data-field="name" placeholder="Enter persona name">
                    </div>
                    <div class="persona-field">
                        <label>ID</label>
                        <input type="text" class="persona-input creator-field" data-field="id" placeholder="auto-generated from name">
                        <span class="slug-preview"><span class="slug-arrow">→</span><span class="slug-value"></span></span>
                    </div>
                    <div class="persona-field">
                        <label>Avatar URL</label>
                        <input type="text" class="persona-input creator-field" data-field="avatar" placeholder="https://example.com/avatar.png">
                    </div>
                    <div class="persona-field">
                        <label>Role</label>
                        <input type="text" class="persona-input creator-field" data-field="role" placeholder="2-3 words position title, like: UIX Designer, Frontend engineer">
                    </div>
                    <div class="persona-field">
                        <label>Agent</label>
                        <input type="text" class="persona-input creator-field" data-field="agent" placeholder="Can be empty">
                        <div class="persona-agent-presets">
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker">cc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker-swift">cc_docker-swift</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker">oc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker-swift">oc_docker-swift</button>
                        </div>
                    </div>
                    <div class="persona-field">
                        <label>About</label>
                        <textarea class="persona-input persona-textarea creator-field" data-field="about" rows="3" placeholder="This is system_prompt (will be used as system prompt for LLMs)"></textarea>
                    </div>
                    <div class="persona-field">
                        <label>Task</label>
                        <textarea class="persona-input persona-textarea creator-field" data-field="task" rows="5" placeholder="Task description for this persona. 3 sentences max. Begin with a VERB. Example: 'Suggest an improvement or a small feature to develop during the next sprint. You call the shots and decide what gets built first. Over-scoping kills projects. Your reply should be exactly 1 sentence.'"></textarea>
                    </div>
                    <div class="creator-actions">
                        <button class="creator-cancel-btn">Cancel</button>
                        <button class="creator-create-btn">Create</button>
                    </div>
                </div>
            </div>
        `;
        insertAfterBtn.insertAdjacentHTML('afterend', creatorHtml);
        currentInlineEditor = insertAfterBtn.nextElementSibling;
        currentInlineEditor.dataset.instancePath = instancePath;

        currentInlineEditor.addEventListener('click', (e) => e.stopPropagation());
        currentInlineEditor.addEventListener('focusin', (e) => e.stopPropagation());

        const idInput = currentInlineEditor.querySelector('[data-field="id"]');
        const nameInput = currentInlineEditor.querySelector('[data-field="name"]');
        if (nameInput) {
            nameInput.focus();
        }

        [idInput, nameInput].forEach(input => {
            if (input) input.addEventListener('input', () => updateSlugPreview(currentInlineEditor));
        });
        updateSlugPreview(currentInlineEditor);

        currentInlineEditor.querySelectorAll('.agent-preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const agent = btn.dataset.agent;
                const input = currentInlineEditor.querySelector('[data-field="agent"]');
                if (input) {
                    input.value = agent;
                }
            });
        });

        currentInlineEditor.querySelector('.creator-cancel-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            currentInlineEditor.remove();
            currentInlineEditor = null;
            clearEditingState();
        });

        currentInlineEditor.querySelector('.creator-create-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            createPersona(instancePath, currentInlineEditor);
        });
    }

    function openInlineWorkflowCreator(instancePath, insertAfterBtn) {
        if (currentInlineEditor) {
            currentInlineEditor.remove();
            currentInlineEditor = null;
            clearEditingState();
        }

        const creatorHtml = `
            <div class="workflow-creator-inline">
                <div class="creator-header">
                    <span class="creator-title">New Workflow</span>
                </div>
                <div class="creator-body">
                    <div class="persona-field">
                        <label>Name</label>
                        <input type="text" class="persona-input creator-field" data-field="name" placeholder="Enter workflow name">
                    </div>
                    <div class="persona-field">
                        <label>ID</label>
                        <input type="text" class="persona-input creator-field" data-field="id" placeholder="auto-generated from name">
                        <span class="slug-preview"><span class="slug-arrow">→</span><span class="slug-value"></span></span>
                    </div>
                    <div class="persona-field">
                        <label>Description</label>
                        <textarea class="persona-input persona-textarea creator-field" data-field="desc" rows="2" placeholder="Optional"></textarea>
                    </div>
                    <div class="persona-field">
                        <label>Agent</label>
                        <input type="text" class="persona-input creator-field" data-field="agent" value="oc_docker" placeholder="oc_docker">
                        <div class="persona-agent-presets">
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker">cc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="cc_docker-swift">cc_docker-swift</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker">oc_docker</button>
                            <button type="button" class="preset-btn agent-preset-btn" data-agent="oc_docker-swift">oc_docker-swift</button>
                        </div>
                    </div>
                    <div class="wf-schedule-field">
                        <label>Repeat every</label>
                        <input type="text" class="wf-schedule-input creator-field" data-field="every_secs" pattern="[0-9\-]*" inputmode="numeric" maxlength="7" value="0">
                        <span class="wf-schedule-unit">seconds</span>
                        <span class="info-icon" data-doc="workflow-schedule" title="Learn about scheduling">ⓘ</span>
                        <span class="wf-schedule-hint">(manual — never repeats)</span>
                    </div>
                    <div class="wf-schedule-presets">
                        <button type="button" class="preset-btn" data-secs="-1">startup</button>
                        <button type="button" class="preset-btn" data-secs="0">manual</button>
                        <button type="button" class="preset-btn" data-secs="600">10m</button>
                        <button type="button" class="preset-btn" data-secs="3600">1h</button>
                        <button type="button" class="preset-btn" data-secs="86400">24h</button>
                    </div>
                    <div class="creator-actions">
                        <button class="creator-cancel-btn">Cancel</button>
                        <button class="creator-create-btn">Create</button>
                    </div>
                </div>
            </div>
        `;
        insertAfterBtn.insertAdjacentHTML('afterend', creatorHtml);
        currentInlineEditor = insertAfterBtn.nextElementSibling;
        currentInlineEditor.dataset.instancePath = instancePath;

        currentInlineEditor.addEventListener('click', (e) => e.stopPropagation());
        currentInlineEditor.addEventListener('focusin', (e) => e.stopPropagation());

        currentInlineEditor.querySelectorAll('.info-icon').forEach(icon => {
            icon.addEventListener('click', (e) => {
                e.stopPropagation();
                openHelpPanel(icon.dataset.doc);
            });
        });

        const everySecsInput = currentInlineEditor.querySelector('[data-field="every_secs"]');
        if (everySecsInput) {
            everySecsInput.addEventListener('input', (e) => {
                const hint = currentInlineEditor.querySelector('.wf-schedule-hint');
                if (hint) {
                    hint.textContent = `(${formatEverySecsHint(parseInt(e.target.value) || 0)})`;
                }
            });
        }

        currentInlineEditor.querySelectorAll('.preset-btn[data-secs]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const secs = btn.dataset.secs;
                const input = currentInlineEditor.querySelector('[data-field="every_secs"]');
                if (input) {
                    input.value = secs;
                    input.dispatchEvent(new Event('input'));
                }
            });
        });

        currentInlineEditor.querySelectorAll('.agent-preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const agent = btn.dataset.agent;
                const input = currentInlineEditor.querySelector('[data-field="agent"]');
                if (input) {
                    input.value = agent;
                }
            });
        });

        const idInput = currentInlineEditor.querySelector('[data-field="id"]');
        const nameInput = currentInlineEditor.querySelector('[data-field="name"]');
        if (nameInput) {
            nameInput.focus();
        }

        [idInput, nameInput].forEach(input => {
            if (input) input.addEventListener('input', () => updateSlugPreview(currentInlineEditor));
        });
        updateSlugPreview(currentInlineEditor);

        currentInlineEditor.querySelector('.creator-cancel-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            currentInlineEditor.remove();
            currentInlineEditor = null;
            clearEditingState();
        });

        currentInlineEditor.querySelector('.creator-create-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            createWorkflow(instancePath, currentInlineEditor);
        });
    }

    async function createPersona(instancePath, editor) {
        const createBtn = editor.querySelector('.creator-create-btn');
        const fields = editor.querySelectorAll('.creator-field');
        
        const data = {};
        fields.forEach(field => {
            const value = field.value.trim();
            data[field.dataset.field] = value;
        });

        if (!data.name) {
            alert('Name is required');
            return;
        }

        data.id = toSlug(data.id || data.name) || null;

        createBtn.textContent = 'Creating...';
        createBtn.disabled = true;

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/personas`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: data.id,
                    name: data.name,
                    avatar: data.avatar || null,
                    role: data.role || '',
                    agent: data.agent || null,
                    about: data.about || '',
                    task: data.task || ''
                })
            });

            if (!response.ok) throw new Error('Failed to create persona');

            editor.remove();
            currentInlineEditor = null;
            clearEditingState();
            
            refreshInstanceContent(instancePath);
        } catch (err) {
            console.error('Failed to create persona:', err);
            createBtn.textContent = 'Create';
            createBtn.disabled = false;
            alert('Failed to create persona');
        }
    }

    async function createWorkflow(instancePath, editor) {
        const createBtn = editor.querySelector('.creator-create-btn');
        const fields = editor.querySelectorAll('.creator-field');
        
        const data = {};
        fields.forEach(field => {
            const value = field.value.trim();
            data[field.dataset.field] = value;
        });

        if (!data.name) {
            alert('Name is required');
            return;
        }

        data.id = toSlug(data.id || data.name) || `workflow-${Date.now()}`;

        createBtn.textContent = 'Creating...';
        createBtn.disabled = true;

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: data.id,
                    name: data.name,
                    desc: data.desc || '',
                    agent: data.agent || '',
                    every_secs: parseInt(data.every_secs) ?? 0
                })
            });

            if (!response.ok) throw new Error('Failed to create workflow');

            editor.remove();
            currentInlineEditor = null;
            clearEditingState();
            
            refreshInstanceContent(instancePath);
        } catch (err) {
            console.error('Failed to create workflow:', err);
            createBtn.textContent = 'Create';
            createBtn.disabled = false;
            alert('Failed to create workflow');
        }
    }

    async function deletePersona(instancePath, personaId, editor) {
        const deleteBtn = editor.querySelector('[data-action="delete-persona"]');
        if (deleteBtn) {
            deleteBtn.textContent = 'Deleting...';
            deleteBtn.disabled = true;
        }

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/personas/${encodeURIComponent(personaId)}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                if (response.status === 404) {
                    alert('This persona no longer exists');
                } else {
                    throw new Error('Failed to delete');
                }
                if (deleteBtn) {
                    deleteBtn.textContent = 'Delete';
                    deleteBtn.disabled = false;
                }
                return;
            }

            closeInlinePersonaEditor();
            delete personaCache[instancePath];
            refreshInstanceContent(instancePath);
        } catch (err) {
            console.error('Failed to delete persona:', err);
            if (deleteBtn) {
                deleteBtn.textContent = 'Delete';
                deleteBtn.disabled = false;
            }
            alert('Failed to delete persona');
        }
    }

    async function deleteWorkflow(instancePath, workflowId, editor) {
        const deleteBtn = editor.querySelector('[data-action="delete-workflow"]');
        if (deleteBtn) {
            deleteBtn.textContent = 'Deleting...';
            deleteBtn.disabled = true;
        }

        try {
            const response = await fetch(`/api/instances/${encodeURIComponent(instancePath)}/workflows/${encodeURIComponent(workflowId)}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                if (response.status === 404) {
                    alert('This workflow no longer exists');
                } else {
                    throw new Error('Failed to delete');
                }
                if (deleteBtn) {
                    deleteBtn.textContent = 'Delete';
                    deleteBtn.disabled = false;
                }
                return;
            }

            const logsPanel = editor.nextElementSibling;
            if (logsPanel && logsPanel.classList.contains('workflow-logs-panel')) {
                logsPanel.remove();
            }
            editor.remove();
            currentInlineEditor = null;
            clearEditingState();
            delete workflowCache[instancePath];
            refreshInstanceContent(instancePath);
        } catch (err) {
            console.error('Failed to delete workflow:', err);
            if (deleteBtn) {
                deleteBtn.textContent = 'Delete';
                deleteBtn.disabled = false;
            }
            alert('Failed to delete workflow');
        }
    }

    function filterPersonas(subview, query) {
        subview.querySelectorAll('.persona-node').forEach(n => {
            const name = (n.dataset.personaName || '').toLowerCase();
            const id   = (n.dataset.personaId || '').toLowerCase();
            const visible = name.includes(query) || id.includes(query);
            n.style.display = visible ? '' : 'none';
            const label = n.querySelector('.persona-label');
            if (label) {
                if (query && visible) {
                    label.innerHTML = highlightMatch(label.textContent, query);
                } else {
                    label.textContent = label.textContent;
                }
            }
        });
    }

    function filterWorkflows(subview, query) {
        subview.querySelectorAll('.workflow-node').forEach(n => {
            const labelEl = n.querySelector('.workflow-label');
            const idEl    = n.querySelector('.workflow-id');
            const labelText = (labelEl?.textContent || '').toLowerCase();
            const idText    = (idEl?.textContent || '').toLowerCase();
            const visible = labelText.includes(query) || idText.includes(query);
            n.style.display = visible ? '' : 'none';
            if (query && visible) {
                if (labelEl) labelEl.innerHTML = highlightMatch(labelEl.textContent, query);
                if (idEl) idEl.innerHTML = highlightMatch(idEl.textContent, query);
            } else {
                if (labelEl) labelEl.textContent = labelEl.textContent;
                if (idEl) idEl.textContent = idEl.textContent;
            }
        });
    }

    function highlightMatch(text, query) {
        if (!query) return text;
        const idx = text.toLowerCase().indexOf(query);
        if (idx === -1) return text;
        return text.slice(0, idx)
             + '<mark>' + text.slice(idx, idx + query.length) + '</mark>'
             + text.slice(idx + query.length);
    }

    function filterSelectorItems(panel, query, selector) {
        let anyVisible = false;
        panel.querySelectorAll('.persona-selector-item').forEach(item => {
            const name = (item.querySelector('.persona-selector-name')?.textContent || '').toLowerCase();
            const role = (item.querySelector('.persona-selector-role')?.textContent || '').toLowerCase();
            const id = (item.dataset.personaId || item.dataset.workflowId || '').toLowerCase();
            const visible = !query || name.includes(query) || role.includes(query) || id.includes(query);
            item.style.display = visible ? '' : 'none';
            if (visible) anyVisible = true;
            const label = item.querySelector('.persona-selector-name');
            if (label) label.innerHTML = (query && visible) ? highlightMatch(label.textContent, query) : label.textContent;
        });
        toggleNoResults(panel, query, !anyVisible);
    }

    function applySelectorFilter(selector) {
        const query = selector.querySelector('.selector-search').value.toLowerCase();
        const activeTab = selector.querySelector('.picker-tab.active').dataset.tab;
        const panel = activeTab === 'personas'
            ? selector.querySelector('.picker-personas-panel')
            : selector.querySelector('.picker-workflows-panel');
        filterSelectorItems(panel, query, selector);
    }

    function clearSelectorSearch(selector) {
        const searchInput = selector.querySelector('.selector-search');
        if (searchInput) searchInput.value = '';
        selector.querySelectorAll('.persona-selector-item').forEach(item => {
            item.style.display = '';
            const label = item.querySelector('.persona-selector-name');
            if (label) label.textContent = label.textContent;
        });
        selector.querySelectorAll('.picker-panel').forEach(p => {
            const noResults = p.querySelector('.selector-no-results');
            if (noResults) noResults.remove();
        });
    }

    function toggleNoResults(panel, query, show) {
        let el = panel.querySelector('.selector-no-results');
        if (!show) { if (el) el.remove(); return; }
        if (!el) {
            el = document.createElement('div');
            el.className = 'selector-no-results';
            panel.appendChild(el);
        }
        const type = panel.classList.contains('picker-personas-panel') ? 'personas' : 'workflows';
        el.innerHTML = query ? 'No matching ' + type + '.<br>Try a different search term.' : '';
    }

    function applySubviewFilter(input) {
        const query = input.value.toLowerCase();
        const subview = input.closest('.subview');
        if (input.dataset.filter === 'personas') filterPersonas(subview, query);
        else filterWorkflows(subview, query);
    }

    document.addEventListener('input', e => {
        if (e.target.classList.contains('subview-search')) applySubviewFilter(e.target);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (e.target.classList.contains('subview-search') && e.target.value) {
                e.target.value = '';
                applySubviewFilter(e.target);
                return;
            }
            closeHelpPanel();
            closeInlinePersonaEditor();
            closeInlineWorkflowEditor();
        }

        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('parent-section-header')) {
            e.preventDefault();
            e.target.click();
        }
    });
});
