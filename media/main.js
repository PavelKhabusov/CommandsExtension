// @ts-check

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	const container = document.getElementById('commands-container');
	const refreshBtn = document.getElementById('refreshBtn');
	const addBtn = document.getElementById('addBtn');
	const addForm = document.getElementById('add-command-form');

	const clearBtn = document.getElementById('clearBtn');
	const collapseBtn = document.getElementById('collapseBtn');
	const searchInput = /** @type {HTMLInputElement|null} */ (document.getElementById('searchInput'));

	let groupsCollapsed = false;
	/** @type {Set<string>} */
	const collapsedGroups = new Set();
	let collapsedGroupsInitialized = false;
	let currentFavorites = /** @type {string[]} */ ([]);
	let currentGroups = /** @type {{ name: string; source?: string }[]} */ ([]);
	let activeTerminals = /** @type {string[]} */ ([]);
	let confirmCommands = /** @type {string[]} */ ([]);
	/** @type {Map<string, any>} */
	const uploadStatusMap = new Map();
	/** @type {Map<string, 'clean' | 'stale'>} */
	const uploadStalenessMap = new Map();
	/** @type {Set<string>} */
	const uploadActiveKeys = new Set();
	let lastUploadGroups = /** @type {any[]} */ ([]);
	let marketplaceCollapsed = /** @type {boolean | undefined} */ (undefined);
	let uploadsCollapsed = /** @type {boolean | undefined} */ (undefined);
	// Combined Operations state
	let lastCombinedOps = /** @type {any[]} */ ([]);
	/** @type {Map<string, any>} */
	const combinedStatusMap = new Map();
	/** @type {Set<string>} */
	const combinedActiveOps = new Set();
	let combinedCollapsed = /** @type {boolean | undefined} */ (undefined);
	let combinedPickContext = /** @type {{ commands: Array<{name:string;group:string}>; uploads: Array<{key:string;name:string;group:string}>; servers: string[]; presetAvailability: { sound: boolean; notification: boolean; open: boolean; installHint: string } }} */ ({ commands: [], uploads: [], servers: [], presetAvailability: { sound: true, notification: true, open: true, installHint: '' } });
	// Claude Hooks state
	let lastClaudeHooks = /** @type {any[]} */ ([]);
	let hooksCollapsed = /** @type {boolean | undefined} */ (undefined);
	let hooksShowGlobal = false;
	let hooksContext = /** @type {{ filePaths: { project: string; local: string; user: string }; events: string[]; matcherEvents: string[]; commands: Array<{ name: string; command: string; group: string }>; presetTemplates: any; presetAvailability: { sound: boolean; notification: boolean; open: boolean; installHint: string } }} */ ({
		filePaths: { project: '', local: '', user: '' },
		events: [],
		matcherEvents: [],
		commands: [],
		presetTemplates: {},
		presetAvailability: { sound: true, notification: true, open: true, installHint: '' },
	});

	// Short blurb shown under each event header to remind the user when the
	// hook actually fires. Pulled from Claude Code's hook docs.
	const HOOK_EVENT_DESCRIPTIONS = {
		Stop: 'Fires when Claude finishes responding to your prompt.',
		SubagentStop: 'Fires when a subagent finishes its task.',
		UserPromptSubmit: 'Fires every time you submit a new prompt.',
		PreToolUse: 'Fires before Claude runs a tool (use `matcher` to scope by tool name).',
		PostToolUse: 'Fires after a tool finishes (matcher scopes by tool name).',
		Notification: 'Fires when Claude needs your attention (permission request, idle warning).',
		SessionStart: 'Fires once at the start of a new session.',
		SessionEnd: 'Fires when the session ends.',
		PreCompact: 'Fires before context compaction.',
	};

	function saveCollapsedGroups() {
		vscode.postMessage({ type: 'saveCollapsedGroups', collapsedGroups: Array.from(collapsedGroups) });
	}

	if (collapseBtn) {
		collapseBtn.addEventListener('click', () => {
			if (!container) return;
			const commands = container.querySelectorAll('.group-commands');
			const chevrons = container.querySelectorAll('.group-chevron');
			groupsCollapsed = !groupsCollapsed;
			if (groupsCollapsed) {
				// Collect all group names into collapsedGroups
				container.querySelectorAll('.command-group').forEach(el => {
					const nameEl = el.querySelector('.group-name');
					if (nameEl) {
						const name = nameEl.textContent || '';
						collapsedGroups.add(name.startsWith('\u2605') ? '__favorites__' : name);
					}
				});
			} else {
				collapsedGroups.clear();
			}
			commands.forEach(el => {
				if (groupsCollapsed) {
					el.classList.add('collapsed');
				} else {
					el.classList.remove('collapsed');
				}
			});
			chevrons.forEach(el => {
				if (groupsCollapsed) {
					el.classList.add('collapsed');
				} else {
					el.classList.remove('collapsed');
				}
			});
			saveCollapsedGroups();
		});
	}

	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'clearTerminals' });
		});
	}

	if (refreshBtn) {
		refreshBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh' });
		});
	}

	const searchClearBtn = document.getElementById('searchClearBtn');

	if (searchInput) {
		searchInput.addEventListener('input', () => {
			filterCommands(searchInput.value.trim().toLowerCase());
			if (searchClearBtn) {
				searchClearBtn.classList.toggle('visible', searchInput.value.length > 0);
			}
		});
	}

	if (searchClearBtn && searchInput) {
		searchClearBtn.addEventListener('click', () => {
			searchInput.value = '';
			searchClearBtn.classList.remove('visible');
			filterCommands('');
			searchInput.focus();
		});
	}

	function filterCommands(query) {
		if (!container) return;
		const groups = container.querySelectorAll('.command-group');
		for (const group of groups) {
			const nameEl = group.querySelector('.group-name');
			const groupName = (nameEl ? nameEl.textContent || '' : '').toLowerCase();
			const groupMatches = query && groupName.includes(query);

			const items = group.querySelectorAll('.cmd-item');
			let visibleCount = 0;
			for (const item of items) {
				if (item instanceof HTMLElement) {
					const name = (item.dataset.name || '').toLowerCase();
					const subtitle = (item.querySelector('.cmd-subtitle') || {}).textContent || '';
					if (!query || groupMatches || name.includes(query) || subtitle.toLowerCase().includes(query)) {
						item.style.display = '';
						visibleCount++;
					} else {
						item.style.display = 'none';
					}
				}
			}
			if (group instanceof HTMLElement) {
				group.style.display = visibleCount === 0 && query ? 'none' : '';
			}
			// Expand groups while searching so results are visible
			const cmdsEl = group.querySelector('.group-commands');
			const chevron = group.querySelector('.group-chevron');
			if (query) {
				if (cmdsEl) cmdsEl.classList.remove('collapsed');
				if (chevron) chevron.classList.remove('collapsed');
			} else {
				// Restore collapsed state from the saved set
				const gName = group.classList.contains('favorites-group') ? '__favorites__' : (nameEl ? nameEl.textContent || '' : '');
				if (collapsedGroups.has(gName)) {
					if (cmdsEl) cmdsEl.classList.add('collapsed');
					if (chevron) chevron.classList.add('collapsed');
				}
			}
		}
	}

	const groupSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('cmdGroupSelect'));
	const groupInput = /** @type {HTMLInputElement|null} */ (document.getElementById('cmdGroupInput'));

	if (groupSelect && groupInput) {
		groupSelect.addEventListener('change', () => {
			if (groupSelect.value === '__new__') {
				groupInput.style.display = 'block';
				groupInput.focus();
			} else {
				groupInput.style.display = 'none';
				groupInput.value = '';
			}
		});
	}

	if (addBtn && addForm) {
		addBtn.addEventListener('click', () => {
			addForm.classList.toggle('visible');
			if (addForm.classList.contains('visible')) {
				// Populate group select with existing custom groups
				if (groupSelect) {
					const customGroups = currentGroups.filter(function(g) { return g.source === 'commands-list.json'; });
					groupSelect.innerHTML = '';
					// Default option
					const defaultOpt = document.createElement('option');
					defaultOpt.value = '';
					defaultOpt.textContent = 'General';
					groupSelect.appendChild(defaultOpt);
					// Existing custom groups
					for (const g of customGroups) {
						if (g.name === 'General') continue;
						const opt = document.createElement('option');
						opt.value = g.name;
						opt.textContent = g.name;
						groupSelect.appendChild(opt);
					}
					// New group option
					const newOpt = document.createElement('option');
					newOpt.value = '__new__';
					newOpt.textContent = '+ New group...';
					groupSelect.appendChild(newOpt);
					// Reset
					groupSelect.value = '';
					if (groupInput) {
						groupInput.style.display = 'none';
						groupInput.value = '';
					}
				}
				const firstInput = addForm.querySelector('input');
				if (firstInput) firstInput.focus();
			}
		});
	}

	// Add command form handling
	const saveBtn = document.getElementById('saveCommandBtn');
	const cancelBtn = document.getElementById('cancelCommandBtn');

	if (saveBtn) {
		saveBtn.addEventListener('click', () => {
			const nameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('cmdNameInput'));
			const commandInput = /** @type {HTMLInputElement|null} */ (document.getElementById('cmdCommandInput'));
			const typeSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('cmdTypeSelect'));
			const grpSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('cmdGroupSelect'));
			const grpInput = /** @type {HTMLInputElement|null} */ (document.getElementById('cmdGroupInput'));

			if (!nameInput || !commandInput || !typeSelect) return;

			const name = nameInput.value.trim();
			const command = commandInput.value.trim();
			if (!name || !command) return;

			// Determine group: from new input if "__new__", else from select
			let group = '';
			if (grpSelect && grpSelect.value === '__new__' && grpInput) {
				group = grpInput.value.trim();
			} else if (grpSelect) {
				group = grpSelect.value;
			}

			vscode.postMessage({
				type: 'addCommand',
				name: name,
				command: command,
				cmdType: typeSelect.value,
				group: group,
			});

			// Reset form
			nameInput.value = '';
			commandInput.value = '';
			typeSelect.value = 'terminal';
			if (grpSelect) grpSelect.value = '';
			if (grpInput) { grpInput.value = ''; grpInput.style.display = 'none'; }
			if (addForm) addForm.classList.remove('visible');
		});
	}

	if (cancelBtn && addForm) {
		cancelBtn.addEventListener('click', () => {
			addForm.classList.remove('visible');
		});
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'updateActiveTerminals':
				activeTerminals = message.activeTerminals || [];
				updateTerminalIndicators();
				break;
			case 'updateConfirmCommands':
				confirmCommands = message.confirmCommands || [];
				updateConfirmIndicators();
				break;
			case 'updateCommands':
				currentFavorites = message.favorites || [];
				currentGroups = (message.groups || []).map(function(g) { return { name: g.name, source: g.source }; });
				activeTerminals = message.activeTerminals || [];
				confirmCommands = message.confirmCommands || [];
				if (!collapsedGroupsInitialized && message.collapsedGroups) {
					for (const name of message.collapsedGroups) {
						collapsedGroups.add(name);
					}
					collapsedGroupsInitialized = true;
				}
				renderGroups(message.groups);
				break;
			case 'commandStarted':
				markCommandStarted(message.name);
				break;
			case 'updateMarketplace':
				renderMarketplace(message.templates);
				break;
			case 'updateUploads':
				lastUploadGroups = message.groups || [];
				if (Array.isArray(message.statuses)) {
					uploadStatusMap.clear();
					for (const s of message.statuses) {
						if (s && s.uploadKey) uploadStatusMap.set(s.uploadKey, s);
					}
				}
				if (Array.isArray(message.activeKeys)) {
					uploadActiveKeys.clear();
					for (const k of message.activeKeys) uploadActiveKeys.add(k);
				}
				if (message.stalenessMap && typeof message.stalenessMap === 'object') {
					for (const [k, v] of Object.entries(message.stalenessMap)) {
						uploadStalenessMap.set(k, /** @type {any} */ (v));
					}
				}
				renderUploads();
				break;
			case 'uploadStaleness':
				if (message.uploadKey) {
					uploadStalenessMap.set(message.uploadKey, {
						staleness: message.staleness,
						staleCount: message.staleCount || 0,
						staleFiles: message.staleFiles || [],
						trackedCount: message.trackedCount || 0,
					});
					updateUploadCardStatus(message.uploadKey);
					updateAutoUploads();
				}
				break;
			case 'updateSectionCollapse':
				marketplaceCollapsed = message.marketplaceCollapsed;
				uploadsCollapsed = message.uploadsCollapsed;
				applyMarketplaceCollapseState();
				applyUploadsCollapseState();
				break;
			case 'uploadProgress': {
				const p = message.progress;
				if (!p || !p.uploadKey) break;
				uploadStatusMap.set(p.uploadKey, p);
				if (p.status === 'connecting' || p.status === 'running') {
					uploadActiveKeys.add(p.uploadKey);
				} else {
					uploadActiveKeys.delete(p.uploadKey);
				}
				updateUploadCardStatus(p.uploadKey);
				// Combined op cards that are running an upload step echo this
				// upload's progress — refresh those cards too.
				for (const op of lastCombinedOps) {
					const st = combinedStatusMap.get(op.name);
					if (st && st.currentUploadKey === p.uploadKey) {
						updateCombinedCardStatus(op.name);
					}
				}
				break;
			}
			case 'updateCombined':
				lastCombinedOps = message.ops || [];
				if (Array.isArray(message.statuses)) {
					combinedStatusMap.clear();
					for (const s of message.statuses) {
						if (s && s.opName) combinedStatusMap.set(s.opName, s);
					}
				}
				if (Array.isArray(message.activeOps)) {
					combinedActiveOps.clear();
					for (const n of message.activeOps) combinedActiveOps.add(n);
				}
				if (message.combinedCollapsed !== undefined) {
					combinedCollapsed = message.combinedCollapsed;
				}
				if (message.pickContext) combinedPickContext = message.pickContext;
				renderCombined();
				break;
			case 'combinedOpProgress': {
				const p = message.progress;
				if (!p || !p.opName) break;
				combinedStatusMap.set(p.opName, p);
				if (p.status === 'running') {
					combinedActiveOps.add(p.opName);
				} else {
					combinedActiveOps.delete(p.opName);
				}
				updateCombinedCardStatus(p.opName);
				break;
			}
			case 'updateClaudeHooks':
				lastClaudeHooks = message.hooks || [];
				hooksContext = {
					filePaths: message.filePaths || hooksContext.filePaths,
					events: message.events || hooksContext.events,
					matcherEvents: message.matcherEvents || hooksContext.matcherEvents,
					commands: message.commands || hooksContext.commands,
					presetTemplates: message.presetTemplates || hooksContext.presetTemplates,
					presetAvailability: message.presetAvailability || hooksContext.presetAvailability,
				};
				if (message.hooksCollapsed !== undefined) hooksCollapsed = message.hooksCollapsed;
				if (message.hooksShowGlobal !== undefined) hooksShowGlobal = !!message.hooksShowGlobal;
				renderHooks();
				break;
			case 'openHookEditorFromPaste':
				if (message.hook) openHookEditor(null, message.hook);
				break;
			case 'vscodeCommandPicked':
				if (pendingVscodeCmdCallback) {
					const cb = pendingVscodeCmdCallback;
					pendingVscodeCmdCallback = null;
					cb(message.commandId || null);
				}
				break;
			case 'rpcResult': {
				const cb2 = pendingRpc.get(message._reqId);
				if (cb2) {
					pendingRpc.delete(message._reqId);
					cb2(message.result);
				}
				break;
			}
		}
	});

	/** @type {HTMLElement|null} */
	let activeContextMenu = null;

	function closeContextMenu() {
		if (activeContextMenu) {
			activeContextMenu.remove();
			activeContextMenu = null;
		}
	}

	// Auto-close on outside-click. Skip when the click happened INSIDE any
	// context menu — the item handler may have opened a sub-menu, and we'd
	// nuke it here on the bubbling click. `.closest()` still works on a
	// just-removed menu because the detached subtree keeps its parent links.
	document.addEventListener('click', (e) => {
		const t = e.target;
		if (t instanceof Element && t.closest('.context-menu')) return;
		closeContextMenu();
	});
	document.addEventListener('contextmenu', closeContextMenu);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') closeContextMenu();
	});

	/**
	 * @param {{ name: string; command: string; type: string; group: string; cwd?: string; detail?: string }} cmd
	 * @param {string} groupName
	 * @param {boolean} isFavorited
	 * @param {string} [groupSource]
	 * @returns {HTMLElement}
	 */
	function createCommandItem(cmd, groupName, isFavorited, groupSource) {
		const item = document.createElement('div');
		item.className = 'cmd-item';
		item.dataset.name = cmd.name;
		item.dataset.commandKey = groupName + ':' + cmd.name;

		// Play icon
		const icon = document.createElement('span');
		icon.className = 'cmd-icon';
		icon.textContent = '\u25B6';
		item.appendChild(icon);

		// Confirm indicator (SVG key icon)
		const commandKey = groupName + ':' + cmd.name;
		const confirmSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		confirmSvg.setAttribute('class', 'cmd-confirm-icon');
		confirmSvg.setAttribute('width', '7');
		confirmSvg.setAttribute('height', '7');
		confirmSvg.setAttribute('viewBox', '0 0 16 16');
		confirmSvg.setAttribute('fill', 'currentColor');
		const confirmPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		confirmPath.setAttribute('d', 'M8 1C6.34 1 5 2.34 5 4v2H3v8h10V6h-2V4c0-1.66-1.34-3-3-3zm0 1.5c.83 0 1.5.67 1.5 1.5v2h-3V4c0-.83.67-1.5 1.5-1.5zM8 9a1 1 0 0 1 .5 1.87V12h-1v-1.13A1 1 0 0 1 8 9z');
		confirmSvg.appendChild(confirmPath);
		icon.appendChild(confirmSvg);
		if (confirmCommands.includes(commandKey)) {
			item.classList.add('has-confirm');
		}

		// Info block: name + subtitle
		const info = document.createElement('div');
		info.className = 'cmd-info';

		const nameSpan = document.createElement('span');
		nameSpan.className = 'cmd-name';
		nameSpan.textContent = cmd.name;
		info.appendChild(nameSpan);

		const subtitle = document.createElement('span');
		subtitle.className = 'cmd-subtitle';
		subtitle.textContent = cmd.command;
		info.appendChild(subtitle);

		item.appendChild(info);

		// Tooltip: detail for npm scripts, command text for others
		const tooltipText = cmd.detail || cmd.command;
		const hasDetail = !!cmd.detail;

		const cmdTooltip = document.createElement('div');
		cmdTooltip.className = 'cmd-tooltip';
		cmdTooltip.textContent = tooltipText;
		item.appendChild(cmdTooltip);

		let cmdTooltipTimer = /** @type {number|undefined} */ (undefined);
		item.addEventListener('mouseenter', () => {
			const isTruncated = subtitle.scrollWidth > subtitle.clientWidth;
			if (!isTruncated && !hasDetail) return;
			cmdTooltipTimer = /** @type {any} */ (setTimeout(() => {
				cmdTooltip.classList.add('visible');
				positionTooltip(cmdTooltip);
			}, 400));
		});
		item.addEventListener('mouseleave', () => {
			clearTimeout(cmdTooltipTimer);
			cmdTooltip.classList.remove('visible');
		});

		// Type badge (only for non-terminal types)
		if (cmd.type !== 'terminal') {
			const badge = document.createElement('span');
			badge.className = 'cmd-badge';
			badge.textContent = cmd.type;
			item.appendChild(badge);
		}

		// Star (favorite) button
		const starBtn = document.createElement('button');
		starBtn.className = 'cmd-fav-btn';
		if (isFavorited) {
			starBtn.classList.add('favorited');
			starBtn.innerHTML = '&#x2605;'; // filled star
			starBtn.title = 'Remove from favorites';
		} else {
			starBtn.innerHTML = '&#x2606;'; // empty star
			starBtn.title = 'Add to favorites';
		}
		starBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'toggleFavorite', commandKey: groupName + ':' + cmd.name });
		});
		// Close terminal button (visible only when terminal is active)
		const closeBtn = document.createElement('button');
		closeBtn.className = 'cmd-close-btn';
		closeBtn.innerHTML = '&#x2715;';
		closeBtn.title = 'Close terminal';
		closeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'closeTerminal', name: cmd.name });
		});
		item.appendChild(closeBtn);

		item.appendChild(starBtn);

		// Apply active terminal indicator if terminal is open
		if (activeTerminals.includes(cmd.name)) {
			item.classList.add('has-terminal');
		}

		// Click to run command (with optional confirmation)
		item.addEventListener('click', () => {
			const commandKey = groupName + ':' + cmd.name;
			const msgType = confirmCommands.includes(commandKey) ? 'confirmRun' : 'runCommand';
			vscode.postMessage({
				type: msgType,
				name: cmd.name,
				command: cmd.command,
				shellType: cmd.type,
				cwd: cmd.cwd,
			});
		});

		// Context menu for all commands
		item.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			closeContextMenu();

			const commandKey = groupName + ':' + cmd.name;
			const menu = document.createElement('div');
			menu.className = 'context-menu';

			// Toggle favorite
			const isFav = currentFavorites.includes(commandKey);
			const favItem = document.createElement('div');
			favItem.className = 'context-menu-item';
			favItem.textContent = isFav ? 'Remove from favorites' : 'Add to favorites';
			favItem.addEventListener('click', (ev) => {
				ev.stopPropagation();
				vscode.postMessage({ type: 'toggleFavorite', commandKey: commandKey });
				closeContextMenu();
			});
			menu.appendChild(favItem);

			// Toggle confirmation
			const hasConfirm = confirmCommands.includes(commandKey);
			const confirmItem = document.createElement('div');
			confirmItem.className = 'context-menu-item';
			confirmItem.textContent = hasConfirm ? 'Disable confirmation' : 'Enable confirmation';
			confirmItem.addEventListener('click', (ev) => {
				ev.stopPropagation();
				vscode.postMessage({ type: 'toggleConfirm', commandKey: commandKey });
				closeContextMenu();
			});
			menu.appendChild(confirmItem);

			// Stop terminal (only if active)
			if (activeTerminals.includes(cmd.name)) {
				const stopItem = document.createElement('div');
				stopItem.className = 'context-menu-item';
				stopItem.textContent = 'Stop terminal';
				stopItem.addEventListener('click', (ev) => {
					ev.stopPropagation();
					vscode.postMessage({ type: 'closeTerminal', name: cmd.name });
					closeContextMenu();
				});
				menu.appendChild(stopItem);
			}

			// Custom command actions (Move to + Delete)
			if (groupSource === 'commands-list.json') {
				const otherGroups = currentGroups.filter(function(g) {
					return g.source === 'commands-list.json' && g.name !== groupName;
				});

				const sep1 = document.createElement('div');
				sep1.className = 'context-menu-separator';
				menu.appendChild(sep1);

				if (otherGroups.length > 0) {
					const header = document.createElement('div');
					header.className = 'context-menu-header';
					header.textContent = 'Move to';
					menu.appendChild(header);

					for (const g of otherGroups) {
						const menuItem = document.createElement('div');
						menuItem.className = 'context-menu-item';
						menuItem.textContent = g.name;
						menuItem.addEventListener('click', (ev) => {
							ev.stopPropagation();
							vscode.postMessage({
								type: 'moveCommand',
								commandName: cmd.name,
								sourceGroup: groupName,
								targetGroup: g.name,
							});
							closeContextMenu();
						});
						menu.appendChild(menuItem);
					}
				}

				const deleteItem = document.createElement('div');
				deleteItem.className = 'context-menu-item context-menu-item-danger';
				deleteItem.textContent = 'Delete';
				deleteItem.addEventListener('click', (ev) => {
					ev.stopPropagation();
					vscode.postMessage({
						type: 'deleteCommand',
						commandName: cmd.name,
						sourceGroup: groupName,
					});
					closeContextMenu();
				});
				menu.appendChild(deleteItem);
			}

			document.body.appendChild(menu);
			activeContextMenu = menu;

			// Position the menu
			const menuRect = menu.getBoundingClientRect();
			let top = e.clientY;
			let left = e.clientX;
			if (top + menuRect.height > window.innerHeight) {
				top = window.innerHeight - menuRect.height - 4;
			}
			if (left + menuRect.width > window.innerWidth) {
				left = window.innerWidth - menuRect.width - 4;
			}
			menu.style.top = top + 'px';
			menu.style.left = left + 'px';
		});

		return item;
	}

	/**
	 * @param {{ name: string; source?: string; commands: { name: string; command: string; type: string; group: string; cwd?: string; detail?: string }[] }[]} groups
	 */
	function renderGroups(groups) {
		if (!container) return;

		if (!groups || groups.length === 0) {
			container.innerHTML = '<p class="empty-message">No commands found. Create a commands-list.json in your workspace root or add scripts to package.json.</p>';
			return;
		}

		// Save current collapsed state from DOM before wiping
		container.querySelectorAll('.command-group').forEach(el => {
			const nameEl = el.querySelector('.group-name');
			const cmdsEl = el.querySelector('.group-commands');
			if (nameEl && cmdsEl) {
				const name = el.classList.contains('favorites-group') ? '__favorites__' : (nameEl.textContent || '');
				if (cmdsEl.classList.contains('collapsed')) {
					collapsedGroups.add(name);
				} else {
					collapsedGroups.delete(name);
				}
			}
		});

		container.innerHTML = '';

		// Build and render Favorites group at the top
		if (currentFavorites.length > 0) {
			const favCommands = [];
			for (const group of groups) {
				for (const cmd of group.commands) {
					const key = group.name + ':' + cmd.name;
					if (currentFavorites.includes(key)) {
						favCommands.push({ cmd, groupName: group.name, groupSource: group.source });
					}
				}
			}
			if (favCommands.length > 0) {
				const favGroupEl = document.createElement('div');
				favGroupEl.className = 'command-group favorites-group';

				const favHeader = document.createElement('div');
				favHeader.className = 'group-header';
				favHeader.innerHTML = '<span class="group-chevron">&#x25BC;</span><span class="group-name favorites-star-icon">&#x2605; Favorites</span><span class="group-count">' + favCommands.length + '</span>';

				const favCommandsEl = document.createElement('div');
				favCommandsEl.className = 'group-commands';

				favHeader.addEventListener('click', () => {
					const chevron = favHeader.querySelector('.group-chevron');
					if (chevron) chevron.classList.toggle('collapsed');
					favCommandsEl.classList.toggle('collapsed');
					if (favCommandsEl.classList.contains('collapsed')) {
						collapsedGroups.add('__favorites__');
					} else {
						collapsedGroups.delete('__favorites__');
					}
					saveCollapsedGroups();
				});

				// Restore collapsed state for favorites
				if (collapsedGroups.has('__favorites__') || groupsCollapsed) {
					const favChevron = favHeader.querySelector('.group-chevron');
					if (favChevron) favChevron.classList.add('collapsed');
					favCommandsEl.classList.add('collapsed');
				}

				for (const { cmd, groupName, groupSource } of favCommands) {
					const item = createCommandItem(cmd, groupName, true, groupSource);
					favCommandsEl.appendChild(item);
				}

				favGroupEl.appendChild(favHeader);
				favGroupEl.appendChild(favCommandsEl);
				container.appendChild(favGroupEl);
			}
		}

		// Render regular groups
		for (const group of groups) {
			const groupEl = document.createElement('div');
			groupEl.className = 'command-group';

			const color = groupColor(group.name);
			const header = document.createElement('div');
			header.className = 'group-header';

			const chevron = document.createElement('span');
			chevron.className = 'group-chevron';
			chevron.innerHTML = '&#x25BC;';
			chevron.style.color = color;
			header.appendChild(chevron);

			const nameEl = document.createElement('span');
			nameEl.className = 'group-name';
			nameEl.textContent = group.name;
			header.appendChild(nameEl);

			const countBadge = document.createElement('span');
			countBadge.className = 'group-count';
			countBadge.textContent = String(group.commands.length);
			header.appendChild(countBadge);

			// Delete button for custom groups (from commands-list.json)
			if (group.source === 'commands-list.json') {
				const deleteBtn = document.createElement('button');
				deleteBtn.className = 'group-delete-btn';
				deleteBtn.innerHTML = '&#x2715;';
				deleteBtn.title = 'Delete group "' + group.name + '"';
				deleteBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'deleteGroup', group: group.name });
				});
				header.appendChild(deleteBtn);
			}

			const commandsEl = document.createElement('div');
			commandsEl.className = 'group-commands';

			header.addEventListener('click', () => {
				const chevron = header.querySelector('.group-chevron');
				if (chevron) {
					chevron.classList.toggle('collapsed');
				}
				commandsEl.classList.toggle('collapsed');
				if (commandsEl.classList.contains('collapsed')) {
					collapsedGroups.add(group.name);
				} else {
					collapsedGroups.delete(group.name);
				}
				saveCollapsedGroups();
			});

			// Restore collapsed state
			if (collapsedGroups.has(group.name) || groupsCollapsed) {
				chevron.classList.add('collapsed');
				commandsEl.classList.add('collapsed');
			}

			for (const cmd of group.commands) {
				const key = group.name + ':' + cmd.name;
				const isFav = currentFavorites.includes(key);
				const item = createCommandItem(cmd, group.name, isFav, group.source);
				commandsEl.appendChild(item);
			}

			groupEl.appendChild(header);
			groupEl.appendChild(commandsEl);
			container.appendChild(groupEl);
		}

		// Re-apply search filter after re-render
		if (searchInput && searchInput.value.trim()) {
			filterCommands(searchInput.value.trim().toLowerCase());
		}
	}

	/**
	 * @param {string} name
	 */
	function updateConfirmIndicators() {
		if (!container) return;
		const items = container.querySelectorAll('.cmd-item');
		for (const item of items) {
			if (item instanceof HTMLElement) {
				const key = item.dataset.commandKey || '';
				if (confirmCommands.includes(key)) {
					item.classList.add('has-confirm');
				} else {
					item.classList.remove('has-confirm');
				}
			}
		}
	}

	function updateTerminalIndicators() {
		if (!container) return;
		const items = container.querySelectorAll('.cmd-item');
		for (const item of items) {
			if (item instanceof HTMLElement) {
				if (activeTerminals.includes(item.dataset.name || '')) {
					item.classList.add('has-terminal');
				} else {
					item.classList.remove('has-terminal');
				}
			}
		}
	}

	function markCommandStarted(name) {
		if (!container) return;
		const items = container.querySelectorAll('.cmd-item');
		for (const item of items) {
			if (item instanceof HTMLElement && item.dataset.name === name) {
				item.classList.add('running');
				setTimeout(() => item.classList.remove('running'), 2000);
			}
		}
	}

	/**
	 * Position a fixed tooltip below (or above) its parent element.
	 * @param {HTMLElement} tooltip
	 */
	function positionTooltip(tooltip) {
		var parent = tooltip.parentElement;
		if (!parent) return;
		var parentRect = parent.getBoundingClientRect();
		var tooltipRect = tooltip.getBoundingClientRect();
		var top = parentRect.bottom;
		var left = parentRect.left;
		if (top + tooltipRect.height > window.innerHeight) {
			top = parentRect.top - tooltipRect.height;
		}
		tooltip.style.top = top + 'px';
		tooltip.style.left = left + 'px';
	}

	/**
	 * @param {string} str
	 * @returns {string}
	 */
	function groupColor(str) {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = str.charCodeAt(i) + ((hash << 5) - hash);
		}
		const h = ((hash % 360) + 360) % 360;
		return 'hsl(' + h + ', 45%, 65%)';
	}

	/**
	 * @param {string} text
	 * @returns {string}
	 */
	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	/**
	 * @param {{ id: string; name: string; description: string; icon: string; commands: { name: string; command: string; type: string; group: string }[] }[]} templates
	 */
	function renderMarketplace(templates) {
		const wrapper = document.getElementById('marketplace-wrapper');
		if (!wrapper) return;

		// Clear wrapper content
		wrapper.innerHTML = '';

		if (!templates || templates.length === 0) return;

		// Resize handle
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'marketplace-resize-handle';
		wrapper.appendChild(resizeHandle);

		let isResizing = false;
		let startY = 0;
		let startHeight = 0;

		resizeHandle.addEventListener('mousedown', (e) => {
			isResizing = true;
			startY = e.clientY;
			startHeight = wrapper.offsetHeight;
			resizeHandle.classList.add('active');
			document.body.style.cursor = 'ns-resize';
			document.body.style.userSelect = 'none';
			e.preventDefault();
		});

		document.addEventListener('mousemove', (e) => {
			if (!isResizing) return;
			const delta = startY - e.clientY;
			const newHeight = Math.max(36, Math.min(window.innerHeight * 0.8, startHeight + delta));
			wrapper.style.height = newHeight + 'px';
		});

		document.addEventListener('mouseup', () => {
			if (!isResizing) return;
			isResizing = false;
			resizeHandle.classList.remove('active');
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
		});

		const section = document.createElement('div');
		section.className = 'marketplace-section';

		// Marketplace header (collapsible)
		const header = document.createElement('div');
		header.className = 'marketplace-header';
		header.innerHTML = '<span class="marketplace-chevron">&#x25BC;</span><span class="marketplace-title">Recommended</span>';

		const body = document.createElement('div');
		body.className = 'marketplace-body';

		// Add subtle hint badge so users notice the section even when collapsed
		const hint = document.createElement('span');
		hint.className = 'marketplace-hint';
		hint.title = 'Browse ready-made command templates';
		hint.textContent = 'templates';
		header.appendChild(hint);

		let savedHeight = '';
		header.addEventListener('click', () => {
			const chevron = header.querySelector('.marketplace-chevron');
			if (chevron) chevron.classList.toggle('collapsed');
			body.classList.toggle('collapsed');
			const isCollapsing = !wrapper.classList.contains('collapsed');
			if (isCollapsing) {
				savedHeight = wrapper.style.height;
				wrapper.style.height = '';
			} else {
				wrapper.style.height = savedHeight;
			}
			wrapper.classList.toggle('collapsed');
			vscode.postMessage({ type: 'setMarketplaceCollapsed', value: wrapper.classList.contains('collapsed') });
		});

		for (const tpl of templates) {
			const groupEl = document.createElement('div');
			groupEl.className = 'tpl-group';

			// Group header row
			const groupHeader = document.createElement('div');
			groupHeader.className = 'tpl-group-header';

			const icon = document.createElement('span');
			icon.className = 'tpl-group-icon';
			icon.textContent = tpl.icon;
			groupHeader.appendChild(icon);

			const info = document.createElement('div');
			info.className = 'tpl-group-info';

			const nameSpan = document.createElement('span');
			nameSpan.className = 'tpl-group-name';
			nameSpan.textContent = tpl.name;
			info.appendChild(nameSpan);

			const descSpan = document.createElement('span');
			descSpan.className = 'tpl-group-desc';
			descSpan.textContent = tpl.description;
			info.appendChild(descSpan);

			groupHeader.appendChild(info);

			// Add all button (left of badge)
			const addAllBtn = document.createElement('button');
			addAllBtn.className = 'tpl-group-add';
			addAllBtn.textContent = '+';
			addAllBtn.title = 'Add all ' + tpl.name + ' commands';
			addAllBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'addTemplateGroup', groupId: tpl.id });
			});
			groupHeader.appendChild(addAllBtn);

			// Badge with command count (right of button, hover-only)
			const badge = document.createElement('span');
			badge.className = 'tpl-group-badge';
			badge.textContent = String(tpl.commands.length);
			groupHeader.appendChild(badge);

			// Hover tooltip with delay
			let tooltipTimer = /** @type {number|undefined} */ (undefined);
			const tooltip = document.createElement('div');
			tooltip.className = 'tpl-tooltip';
			for (const cmd of tpl.commands) {
				const row = document.createElement('div');
				row.className = 'tpl-tooltip-row';
				row.innerHTML = '<span class="tpl-tooltip-name">' + escapeHtml(cmd.name) + '</span><span class="tpl-tooltip-cmd">' + escapeHtml(cmd.command) + '</span>';
				tooltip.appendChild(row);
			}
			groupHeader.appendChild(tooltip);

			groupHeader.addEventListener('mouseenter', () => {
				tooltipTimer = /** @type {any} */ (setTimeout(() => {
					tooltip.classList.add('visible');
					positionTooltip(tooltip);
				}, 400));
			});
			groupHeader.addEventListener('mouseleave', () => {
				clearTimeout(tooltipTimer);
				tooltip.classList.remove('visible');
			});

			// Expandable command list
			const cmdList = document.createElement('div');
			cmdList.className = 'tpl-group-commands';

			groupHeader.addEventListener('click', () => {
				const wasExpanded = cmdList.classList.contains('expanded');
				// Close all other expanded groups (accordion)
				body.querySelectorAll('.tpl-group-commands.expanded').forEach(el => {
					el.classList.remove('expanded');
				});
				// Toggle current
				if (!wasExpanded) {
					cmdList.classList.add('expanded');
				}
				// Hide tooltip on click
				clearTimeout(tooltipTimer);
				tooltip.classList.remove('visible');
			});

			for (const cmd of tpl.commands) {
				const cmdItem = document.createElement('div');
				cmdItem.className = 'tpl-cmd-item';

				const cmdName = document.createElement('span');
				cmdName.className = 'tpl-cmd-name';
				cmdName.textContent = cmd.name;
				cmdItem.appendChild(cmdName);

				const cmdCommand = document.createElement('span');
				cmdCommand.className = 'tpl-cmd-command';
				cmdCommand.textContent = cmd.command;
				cmdItem.appendChild(cmdCommand);

				const cmdAdd = document.createElement('button');
				cmdAdd.className = 'tpl-cmd-add';
				cmdAdd.textContent = '+';
				cmdAdd.title = 'Add "' + cmd.name + '"';
				cmdAdd.addEventListener('click', (e) => {
					e.stopPropagation();
					vscode.postMessage({
						type: 'addTemplateCommand',
						groupId: tpl.id,
						commandName: cmd.name,
					});
				});
				cmdItem.appendChild(cmdAdd);

				cmdList.appendChild(cmdItem);
			}

			groupEl.appendChild(groupHeader);
			groupEl.appendChild(cmdList);
			body.appendChild(groupEl);
		}

		section.appendChild(header);
		section.appendChild(body);

		wrapper.appendChild(section);

		applyMarketplaceCollapseState();
	}

	// Hide all tooltips on scroll
	document.querySelectorAll('#main-content, #uploads-wrapper, #marketplace-wrapper').forEach(function(el) {
		el.addEventListener('scroll', function() {
			document.querySelectorAll('.cmd-tooltip.visible, .tpl-tooltip.visible').forEach(function(t) {
				t.classList.remove('visible');
			});
		});
	});

	// ── Server Uploads ────────────────────────────────────────────────────

	function uploadKeyOf(group, name) {
		return (group || 'Uploads') + ':' + name;
	}

	function formatBytesShort(n) {
		if (!n && n !== 0) return '';
		if (n < 1024) return n + ' B';
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
		if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
		return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
	}

	function applyMarketplaceCollapseState() {
		const wrapper = document.getElementById('marketplace-wrapper');
		if (!wrapper) return;
		const body = wrapper.querySelector('.marketplace-body');
		const chevron = wrapper.querySelector('.marketplace-chevron');
		const shouldCollapse = marketplaceCollapsed === undefined ? true : marketplaceCollapsed;
		if (!body || !chevron) return;
		if (shouldCollapse) {
			body.classList.add('collapsed');
			chevron.classList.add('collapsed');
			wrapper.classList.add('collapsed');
		} else {
			body.classList.remove('collapsed');
			chevron.classList.remove('collapsed');
			wrapper.classList.remove('collapsed');
		}
	}

	function applyUploadsCollapseState() {
		const wrapper = document.getElementById('uploads-wrapper');
		if (!wrapper) return;
		const body = wrapper.querySelector('.uploads-body');
		const chevron = wrapper.querySelector('.uploads-chevron');
		if (!body || !chevron) return;
		const hasUploads = lastUploadGroups && lastUploadGroups.length > 0;
		const shouldCollapse = uploadsCollapsed === undefined ? !hasUploads : uploadsCollapsed;
		if (shouldCollapse) {
			body.classList.add('collapsed');
			chevron.classList.add('collapsed');
			wrapper.classList.add('collapsed');
		} else {
			body.classList.remove('collapsed');
			chevron.classList.remove('collapsed');
			wrapper.classList.remove('collapsed');
		}
	}

	function renderUploads() {
		const wrapper = document.getElementById('uploads-wrapper');
		if (!wrapper) return;
		wrapper.innerHTML = '';

		// Resize handle (drag to resize panel height)
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'uploads-resize-handle';
		wrapper.appendChild(resizeHandle);

		let isResizing = false;
		let startY = 0;
		let startHeight = 0;
		resizeHandle.addEventListener('mousedown', (e) => {
			isResizing = true;
			startY = e.clientY;
			startHeight = wrapper.offsetHeight;
			resizeHandle.classList.add('active');
			document.body.style.cursor = 'ns-resize';
			document.body.style.userSelect = 'none';
			e.preventDefault();
		});
		document.addEventListener('mousemove', (e) => {
			if (!isResizing) return;
			const delta = startY - e.clientY;
			const newHeight = Math.max(36, Math.min(window.innerHeight * 0.8, startHeight + delta));
			wrapper.style.height = newHeight + 'px';
		});
		document.addEventListener('mouseup', () => {
			if (!isResizing) return;
			isResizing = false;
			resizeHandle.classList.remove('active');
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
		});

		const wrap = document.createElement('div');
		wrap.className = 'uploads-section';

		const header = document.createElement('div');
		header.className = 'uploads-header';

		const chevron = document.createElement('span');
		chevron.className = 'uploads-chevron';
		chevron.innerHTML = '&#x25BC;';
		header.appendChild(chevron);

		const title = document.createElement('span');
		title.className = 'uploads-title';
		title.textContent = 'Server Uploads';
		header.appendChild(title);

		const totalCount = lastUploadGroups.reduce((s, g) => s + (g.uploads ? g.uploads.length : 0), 0);

		const editBtn = document.createElement('button');
		editBtn.className = 'uploads-edit-btn';
		editBtn.title = totalCount === 0 ? 'Create config file' : 'Edit config file';
		editBtn.innerHTML = totalCount === 0
			? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3 2.5h6.5L13 6v7a.5.5 0 0 1-.5.5h-9.5a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5z"/><path d="M9.2 2.5V6h3.5M5.5 10h5M8 7.5v5"/></svg>'
			: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-9 9-3.3.5.5-3.3z"/><path d="M10 3.2l2.8 2.8"/></svg>';
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'editUploadsFile' });
		});
		header.appendChild(editBtn);

		if (totalCount > 0) {
			const badge = document.createElement('span');
			badge.className = 'uploads-count';
			badge.textContent = String(totalCount);
			header.appendChild(badge);
		}

		const body = document.createElement('div');
		body.className = 'uploads-body';

		let savedUploadsHeight = '';
		header.addEventListener('click', () => {
			const isCollapsing = !wrapper.classList.contains('collapsed');
			body.classList.toggle('collapsed');
			chevron.classList.toggle('collapsed');
			if (isCollapsing) {
				savedUploadsHeight = wrapper.style.height;
				wrapper.style.height = '';
			} else {
				wrapper.style.height = savedUploadsHeight;
			}
			wrapper.classList.toggle('collapsed');
			vscode.postMessage({ type: 'setUploadsCollapsed', value: wrapper.classList.contains('collapsed') });
		});

		if (totalCount === 0) {
			const empty = document.createElement('div');
			empty.className = 'uploads-empty';
			empty.innerHTML = 'No uploads configured. Click <span class="uploads-empty-icon">+</span> to create <code>server-uploads.local.json</code>.';
			body.appendChild(empty);
		} else {
			const nonEmptyGroups = lastUploadGroups.filter((g) => g.uploads && g.uploads.length > 0);
			const showGroupHeads = nonEmptyGroups.length > 1;
			for (const group of nonEmptyGroups) {
				if (showGroupHeads && group.name && group.name !== 'Uploads') {
					const subhead = document.createElement('div');
					subhead.className = 'uploads-group-name';
					subhead.textContent = group.name;
					body.appendChild(subhead);
				}
				for (const u of group.uploads) {
					body.appendChild(createUploadCard(u, group.name));
				}
			}
		}

		wrap.appendChild(header);
		wrap.appendChild(body);
		buildAutoUploads(body);
		wrapper.appendChild(wrap);

		applyUploadsCollapseState();
	}

	function computeAutoUploadCmds() {
		/** @type {Map<string, {display: string, candidates: Array<{key: string, staleFiles: Set<string>}>}>} */
		const serverMap = new Map();
		for (const group of lastUploadGroups) {
			for (const u of group.uploads || []) {
				const key = uploadKeyOf(group.name, u.name);
				const info = uploadStalenessMap.get(key);
				if (!info || info.staleness !== 'stale' || !info.staleCount) continue;
				const serverKey = (u.protocol || '') + '://' + (u.user || '') + '@' + (u.host || '') + ':' + (u.port || '');
				const entry = serverMap.get(serverKey) || {
					display: (u.user || '') + '@' + (u.host || ''),
					candidates: [],
				};
				entry.candidates.push({ key, staleFiles: new Set(info.staleFiles || []), trackedCount: info.trackedCount || 0 });
				serverMap.set(serverKey, entry);
			}
		}

		const result = [];
		for (const entry of serverMap.values()) {
			// Collect all unique stale files for this server
			const allStale = new Set();
			for (const c of entry.candidates) for (const f of c.staleFiles) allStale.add(f);

			// Greedy set cover: pick fewest uploads that cover all stale files
			// Sort by coverage size desc so we pick the most useful upload first
			// Primary: more coverage first. Tiebreaker: fewer total tracked files (more targeted upload).
			const candidates = entry.candidates.slice().sort((a, b) =>
				(b.staleFiles.size - a.staleFiles.size) || (a.trackedCount - b.trackedCount)
			);
			const remaining = new Set(allStale);
			const chosen = [];
			for (const c of candidates) {
				if (!remaining.size) break;
				let covers = false;
				for (const f of c.staleFiles) if (remaining.has(f)) { covers = true; break; }
				if (!covers) continue;
				chosen.push(c);
				for (const f of c.staleFiles) remaining.delete(f);
			}
			if (!chosen.length) continue;

			const staleFiles = new Set();
			for (const c of chosen) for (const f of c.staleFiles) staleFiles.add(f);
			result.push({ display: entry.display, uploadKeys: chosen.map(c => c.key), staleFiles });
		}
		return result;
	}

	function getAutoUploadKeys() {
		const keys = new Set();
		for (const cmd of computeAutoUploadCmds()) {
			for (const k of cmd.uploadKeys) keys.add(k);
		}
		return keys;
	}

	function buildAutoUploads(body) {
		var existing = body.querySelector('.uploads-auto-section');
		if (existing) existing.remove();
		const cmds = computeAutoUploadCmds();
		if (!cmds.length) return;
		const section = document.createElement('div');
		section.className = 'uploads-auto-section';
		for (const cmd of cmds) {
			section.appendChild(createAutoUploadCard(cmd));
		}
		body.appendChild(section);
	}

	function updateAutoUploads() {
		const wrapper = document.getElementById('uploads-wrapper');
		if (!wrapper) return;
		const body = wrapper.querySelector('.uploads-body');
		if (body) buildAutoUploads(body);
	}

	function createAutoUploadCard(cmd) {
		const card = document.createElement('div');
		card.className = 'upload-auto-item';
		const fileList = Array.from(cmd.staleFiles).map(function(p) {
			var parts = p.replace(/\\/g, '/').split('/');
			return parts.length >= 2 ? parts.slice(-2).join('/') : p;
		});
		card.title = fileList.length
			? 'Upload only modified files to ' + cmd.display + ':\n' + fileList.join('\n')
			: 'Upload only modified files to ' + cmd.display;

		const icon = document.createElement('span');
		icon.className = 'upload-auto-icon';
		icon.textContent = '⚠';
		card.appendChild(icon);

		const info = document.createElement('div');
		info.className = 'upload-info';

		const top = document.createElement('div');
		top.className = 'upload-top';
		const nameSpan = document.createElement('span');
		nameSpan.className = 'upload-name';
		nameSpan.textContent = 'Upload ' + cmd.staleFiles.size + ' modified file' + (cmd.staleFiles.size !== 1 ? 's' : '');
		top.appendChild(nameSpan);
		info.appendChild(top);

		const sub = document.createElement('span');
		sub.className = 'upload-subtitle';
		sub.textContent = cmd.display;
		info.appendChild(sub);

		card.appendChild(info);

		card.addEventListener('click', function() {
			vscode.postMessage({ type: 'runAutoUpload', uploadKeys: cmd.uploadKeys });
		});

		return card;
	}

	function createUploadCard(upload, groupName) {
		const key = uploadKeyOf(groupName, upload.name);
		const card = document.createElement('div');
		card.className = 'upload-item';
		card.dataset.uploadKey = key;
		card.dataset.uploadName = upload.name;
		card.dataset.uploadGroup = groupName || 'Uploads';

		const icon = document.createElement('span');
		icon.className = 'upload-icon';
		icon.innerHTML = '&#x25B6;';
		card.appendChild(icon);

		const info = document.createElement('div');
		info.className = 'upload-info';

		const top = document.createElement('div');
		top.className = 'upload-top';
		const nameSpan = document.createElement('span');
		nameSpan.className = 'upload-name';
		nameSpan.textContent = upload.name;
		top.appendChild(nameSpan);

		if (upload.protocol) {
			const proto = document.createElement('span');
			proto.className = 'upload-proto';
			proto.textContent = upload.protocol;
			top.appendChild(proto);
		}

		info.appendChild(top);

		const sub = document.createElement('span');
		sub.className = 'upload-subtitle';
		const account = (upload.user && upload.host)
			? upload.user + '@' + upload.host
			: (upload.server ? '→ server "' + upload.server + '" (not found)' : 'no server config');
		// Prefix the server name before the account so it's clear which server
		// this upload targets (only when the upload references a named server).
		const where = (upload.server && upload.user && upload.host)
			? upload.server + ' · ' + account
			: account;
		sub.textContent = where + ' · ' + upload.remoteDir;
		if (upload._unresolved) {
			sub.classList.add('upload-unresolved');
		}
		info.appendChild(sub);

		const status = document.createElement('div');
		status.className = 'upload-status';
		info.appendChild(status);

		card.appendChild(info);

		const folderPath = '<path d="M2 5.2v7.3a1.2 1.2 0 0 0 1.2 1.2h9.6a1.2 1.2 0 0 0 1.2-1.2V6a1.2 1.2 0 0 0-1.2-1.2H7.6L6.2 3.4a.8.8 0 0 0-.6-.2H3.2A1.2 1.2 0 0 0 2 4.4z"/>';
		const folderSvgAttrs = 'width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"';

		const btnGroup = document.createElement('div');
		btnGroup.className = 'upload-btn-group';

		const addBtn = document.createElement('button');
		addBtn.className = 'upload-add-btn';
		addBtn.title = 'Pick files / folders to upload';
		addBtn.innerHTML = '<svg ' + folderSvgAttrs + '>' + folderPath + '<path d="M6 9.5h4M8 7.5v4"/></svg>';
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({
				type: 'pickUploadItems',
				uploadName: upload.name,
				uploadGroup: groupName || 'Uploads',
			});
		});
		btnGroup.appendChild(addBtn);

		const excludeBtn = document.createElement('button');
		excludeBtn.className = 'upload-exclude-btn';
		excludeBtn.title = 'Pick files / folders to exclude from upload';
		excludeBtn.innerHTML = '<svg ' + folderSvgAttrs + '>' + folderPath + '<path d="M6 9.5h4"/></svg>';
		excludeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({
				type: 'pickUploadExcludes',
				uploadName: upload.name,
				uploadGroup: groupName || 'Uploads',
			});
		});
		btnGroup.appendChild(excludeBtn);

		card.appendChild(btnGroup);

		const itemCount = document.createElement('span');
		itemCount.className = 'upload-items-badge';
		itemCount.textContent = String((upload.items || []).length);
		const tipParts = [];
		if (upload.items && upload.items.length) {
			tipParts.push('Items:\n' + upload.items.join('\n'));
		}
		if (upload.exclude && upload.exclude.length) {
			tipParts.push('Excluded:\n' + upload.exclude.join('\n'));
		}
		itemCount.title = tipParts.join('\n\n');
		card.appendChild(itemCount);

		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'upload-cancel-btn';
		cancelBtn.innerHTML = '&#x2715;';
		cancelBtn.title = 'Cancel upload';
		cancelBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({
				type: 'cancelUpload',
				uploadName: upload.name,
				uploadGroup: groupName || 'Uploads',
			});
		});
		card.appendChild(cancelBtn);

		card.addEventListener('click', () => {
			if (uploadActiveKeys.has(key)) return;
			vscode.postMessage({
				type: 'runUpload',
				uploadName: upload.name,
				uploadGroup: groupName || 'Uploads',
			});
		});

		card.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			closeContextMenu();
			const menu = document.createElement('div');
			menu.className = 'context-menu';

			const editItem = document.createElement('div');
			editItem.className = 'context-menu-item';
			editItem.textContent = 'Edit config file';
			editItem.addEventListener('click', () => {
				vscode.postMessage({ type: 'editUploadsFile' });
				closeContextMenu();
			});
			menu.appendChild(editItem);

			const addItem = document.createElement('div');
			addItem.className = 'context-menu-item';
			addItem.textContent = 'Add files / folders…';
			addItem.addEventListener('click', () => {
				vscode.postMessage({
					type: 'pickUploadItems',
					uploadName: upload.name,
					uploadGroup: groupName || 'Uploads',
				});
				closeContextMenu();
			});
			menu.appendChild(addItem);

			const excludeItem = document.createElement('div');
			excludeItem.className = 'context-menu-item';
			excludeItem.textContent = 'Exclude files / folders…';
			excludeItem.addEventListener('click', () => {
				vscode.postMessage({
					type: 'pickUploadExcludes',
					uploadName: upload.name,
					uploadGroup: groupName || 'Uploads',
				});
				closeContextMenu();
			});
			menu.appendChild(excludeItem);

			const uploadKey = uploadKeyOf(groupName, upload.name);
			const currentStaleness = uploadStalenessMap.get(uploadKey);
			if (currentStaleness && currentStaleness.staleness === 'stale') {
				const sep = document.createElement('div');
				sep.className = 'context-menu-separator';
				menu.appendChild(sep);

				const syncedItem = document.createElement('div');
				syncedItem.className = 'context-menu-item';
				syncedItem.textContent = 'Mark as synced';
				syncedItem.addEventListener('click', () => {
					vscode.postMessage({ type: 'markUploadSynced', uploadKey });
					closeContextMenu();
				});
				menu.appendChild(syncedItem);
			}

			document.body.appendChild(menu);
			activeContextMenu = menu;
			const menuRect = menu.getBoundingClientRect();
			let top = e.clientY;
			let left = e.clientX;
			if (top + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 4;
			if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 4;
			menu.style.top = top + 'px';
			menu.style.left = left + 'px';
		});

		applyUploadStatusToCard(card, uploadStatusMap.get(key), uploadActiveKeys.has(key));
		return card;
	}

	function updateUploadCardStatus(key) {
		const wrapper = document.getElementById('uploads-wrapper');
		if (!wrapper) return;
		const card = wrapper.querySelector('.upload-item[data-upload-key="' + cssEscape(key) + '"]');
		if (!(card instanceof HTMLElement)) return;
		applyUploadStatusToCard(card, uploadStatusMap.get(key), uploadActiveKeys.has(key));
	}

	function cssEscape(s) {
		return String(s).replace(/(["\\])/g, '\\$1');
	}

	function applyUploadStatusToCard(card, status, isActive) {
		card.classList.remove('upload-running', 'upload-done', 'upload-error', 'upload-cancelled', 'upload-stale');
		const statusEl = card.querySelector('.upload-status');
		if (!statusEl) return;
		statusEl.innerHTML = '';

		const key = card.dataset.uploadKey;
		const stalenessInfo = key ? uploadStalenessMap.get(key) : undefined;
		const staleness = stalenessInfo ? stalenessInfo.staleness : undefined;

		if (isActive) {
			card.classList.add('upload-running');
			const bar = document.createElement('div');
			bar.className = 'upload-progress';
			const fill = document.createElement('div');
			fill.className = 'upload-progress-fill';
			const pct = status && typeof status.percent === 'number' ? status.percent : 0;
			fill.style.width = pct.toFixed(1) + '%';
			bar.appendChild(fill);
			statusEl.appendChild(bar);

			const text = document.createElement('div');
			text.className = 'upload-progress-text';
			const parts = [];
			if (status && typeof status.percent === 'number') parts.push(status.percent.toFixed(0) + '%');
			if (status && status.currentFile) parts.push(truncate(status.currentFile, 40));
			if (status && typeof status.speedBps === 'number' && status.speedBps > 0) {
				parts.push(formatBytesShort(status.speedBps) + '/s');
			}
			if (status && status.filesTotal) parts.push(status.filesDone + '/' + status.filesTotal);
			if (status && status.status === 'connecting') parts.push(status.message || 'Connecting…');
			text.textContent = parts.join(' · ');
			statusEl.appendChild(text);
		} else if (staleness === 'stale' && key && getAutoUploadKeys().has(key)) {
			card.classList.add('upload-stale');
			const text = document.createElement('div');
			text.className = 'upload-last upload-last-stale';
			const n = stalenessInfo ? stalenessInfo.staleCount : 0;
			text.textContent = '⚠ ' + n + ' file' + (n !== 1 ? 's' : '') + ' modified';
			if (stalenessInfo && stalenessInfo.staleFiles.length > 0) {
				text.title = stalenessInfo.staleFiles.map(function(p) {
					var parts = p.replace(/\\/g, '/').split('/');
					return parts.length >= 2 ? parts.slice(-2).join('/') : p;
				}).join('\n');
			}
			statusEl.appendChild(text);
		} else if (status) {
			if (status.status === 'done') {
				card.classList.add('upload-done');
				const text = document.createElement('div');
				text.className = 'upload-last';
				text.textContent = '✓ ' + (status.message || 'Uploaded');
				statusEl.appendChild(text);
			} else if (status.status === 'error') {
				card.classList.add('upload-error');
				const text = document.createElement('div');
				text.className = 'upload-last upload-last-error';
				text.textContent = '✗ ' + (status.message || 'Failed');
				text.title = status.message || '';
				statusEl.appendChild(text);
			} else if (status.status === 'cancelled') {
				card.classList.add('upload-cancelled');
				const text = document.createElement('div');
				text.className = 'upload-last';
				text.textContent = status.message || 'Cancelled';
				statusEl.appendChild(text);
			}
		}
	}

	function truncate(s, n) {
		if (!s || s.length <= n) return s;
		return '…' + s.substring(s.length - n + 1);
	}

	// ─── Combined Operations ─────────────────────────────────────────────

	function stepIcon(step) {
		switch (step.type) {
			case 'command': return '▶';
			case 'upload': return '⬆';
			case 'auto-upload': return '⚡';
			case 'wait': return '⏱';
			case 'open': return '↗';
			case 'sound': return '🔊';
			case 'notification': return '🔔';
			case 'vscode-cmd': return '⚙';
			default: return '?';
		}
	}

	function stepLabel(step) {
		switch (step.type) {
			case 'command': return step.name;
			case 'upload': {
				const parts = String(step.uploadKey || '').split(':');
				return parts.length > 1 ? parts.slice(1).join(':') : step.uploadKey;
			}
			case 'auto-upload': return 'Auto → ' + step.server;
			case 'wait': return 'Wait ' + step.seconds + 's';
			case 'open': return 'Open ' + (step.kind || 'url') + ': ' + step.target;
			case 'sound': return 'Sound: ' + (step.clip || 'complete');
			case 'notification': return 'Notify: ' + step.message;
			case 'vscode-cmd': return 'VS Code: ' + (step.title || step.commandId);
			default: return JSON.stringify(step);
		}
	}

	/**
	 * Pending callback for the native quickPick — the picker lives in the
	 * extension host and replies via a 'vscodeCommandPicked' message, so we
	 * stash the resolution function here and call it when the message lands.
	 */
	let pendingVscodeCmdCallback = null;

	// Generic request/response RPC to the extension host. Used to drive
	// native inputBox / quickPick popups (window.prompt doesn't work inside
	// VS Code webviews).
	const pendingRpc = new Map();
	let nextRpcId = 0;
	function rpc(type, params) {
		const id = ++nextRpcId;
		return new Promise(function(resolve) {
			pendingRpc.set(id, resolve);
			vscode.postMessage(Object.assign({ type: type, _reqId: id }, params || {}));
		});
	}
	function rpcInput(title, defaultValue, placeholder) {
		return rpc('rpcInputBox', { title: title, defaultValue: defaultValue, placeholder: placeholder });
	}
	function rpcPick(title, items, placeholder) {
		return rpc('rpcQuickPick', { title: title, items: items, placeholder: placeholder });
	}

	function renderCombined() {
		const wrapper = document.getElementById('combined-wrapper');
		if (!wrapper) return;
		wrapper.innerHTML = '';

		const wrap = document.createElement('div');
		wrap.className = 'combined-section';

		const header = document.createElement('div');
		header.className = 'combined-header';

		const chevron = document.createElement('span');
		chevron.className = 'combined-chevron';
		chevron.innerHTML = '&#x25BC;';
		header.appendChild(chevron);

		const title = document.createElement('span');
		title.className = 'combined-title';
		title.textContent = 'Combined Operations';
		header.appendChild(title);

		const addBtn = document.createElement('button');
		addBtn.className = 'combined-add-btn';
		addBtn.title = 'Add combined operation';
		addBtn.textContent = '+';
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			openCombinedEditor(null);
		});
		header.appendChild(addBtn);

		if (lastCombinedOps.length > 0) {
			const badge = document.createElement('span');
			badge.className = 'combined-count';
			badge.textContent = String(lastCombinedOps.length);
			header.appendChild(badge);
		}

		const body = document.createElement('div');
		body.className = 'combined-body';

		header.addEventListener('click', () => {
			body.classList.toggle('collapsed');
			chevron.classList.toggle('collapsed');
			wrap.classList.toggle('collapsed');
			vscode.postMessage({ type: 'setCombinedCollapsed', value: wrap.classList.contains('collapsed') });
		});

		if (lastCombinedOps.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'combined-empty';
			empty.innerHTML = 'No combined operations. Click <span class="combined-empty-icon">+</span> to create one.';
			body.appendChild(empty);
		} else {
			for (const op of lastCombinedOps) {
				body.appendChild(createCombinedOpCard(op));
			}
		}

		wrap.appendChild(header);
		wrap.appendChild(body);
		wrapper.appendChild(wrap);

		// Apply collapsed state — default expanded when there are ops.
		const shouldCollapse = combinedCollapsed === undefined ? lastCombinedOps.length === 0 : combinedCollapsed;
		if (shouldCollapse) {
			body.classList.add('collapsed');
			chevron.classList.add('collapsed');
			wrap.classList.add('collapsed');
		}
	}

	function createCombinedOpCard(op) {
		const card = document.createElement('div');
		card.className = 'combined-item';
		card.dataset.opName = op.name;

		const icon = document.createElement('span');
		icon.className = 'combined-icon';
		icon.innerHTML = '&#x25B6;';
		card.appendChild(icon);

		const info = document.createElement('div');
		info.className = 'combined-info';

		const top = document.createElement('div');
		top.className = 'combined-top';
		const nameSpan = document.createElement('span');
		nameSpan.className = 'combined-name';
		nameSpan.textContent = op.name;
		top.appendChild(nameSpan);

		const stepBadge = document.createElement('span');
		stepBadge.className = 'combined-step-count';
		stepBadge.textContent = op.steps.length + ' step' + (op.steps.length === 1 ? '' : 's');
		top.appendChild(stepBadge);

		info.appendChild(top);

		// Per-step list with checkboxes. Lets the user quickly skip individual
		// steps without opening the editor. Click on the checkbox alone — the
		// rest of the row stays a no-op so the parent card click (Run) wins.
		const stepsList = document.createElement('div');
		stepsList.className = 'combined-steps-list';
		op.steps.forEach(function(step, idx) {
			const row = document.createElement('div');
			row.className = 'combined-step-mini';
			if (step.enabled === false) row.classList.add('combined-step-mini-off');
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.className = 'combined-step-mini-cb';
			cb.checked = step.enabled !== false;
			cb.title = cb.checked ? 'Click to skip this step' : 'Click to include this step';
			cb.addEventListener('click', function(e) {
				e.stopPropagation();
				// Optimistic update — the file rewrite + watcher refresh land
				// shortly after but the user sees instant feedback.
				step.enabled = cb.checked;
				row.classList.toggle('combined-step-mini-off', !cb.checked);
				vscode.postMessage({
					type: 'saveCombinedOp',
					op: { name: op.name, steps: op.steps, stopOnError: op.stopOnError !== false },
					originalName: op.name,
				});
			});
			row.appendChild(cb);
			const ic = document.createElement('span');
			ic.className = 'combined-step-mini-icon';
			ic.textContent = stepIcon(step);
			row.appendChild(ic);
			const lbl = document.createElement('span');
			lbl.className = 'combined-step-mini-label';
			lbl.textContent = stepLabel(step);
			lbl.title = stepLabel(step);
			row.appendChild(lbl);
			stepsList.appendChild(row);
		});
		info.appendChild(stepsList);

		const statusEl = document.createElement('div');
		statusEl.className = 'combined-status';
		info.appendChild(statusEl);

		card.appendChild(info);

		card.addEventListener('click', () => {
			if (combinedActiveOps.has(op.name)) {
				vscode.postMessage({ type: 'cancelCombinedOp', opName: op.name });
			} else {
				vscode.postMessage({ type: 'runCombinedOp', opName: op.name });
			}
		});

		card.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			closeContextMenu();
			const menu = document.createElement('div');
			menu.className = 'context-menu';

			const runItem = document.createElement('div');
			runItem.className = 'context-menu-item';
			runItem.textContent = combinedActiveOps.has(op.name) ? 'Cancel' : 'Run';
			runItem.addEventListener('click', () => {
				closeContextMenu();
				if (combinedActiveOps.has(op.name)) {
					vscode.postMessage({ type: 'cancelCombinedOp', opName: op.name });
				} else {
					vscode.postMessage({ type: 'runCombinedOp', opName: op.name });
				}
			});
			menu.appendChild(runItem);

			const editItem = document.createElement('div');
			editItem.className = 'context-menu-item';
			editItem.textContent = 'Edit…';
			editItem.addEventListener('click', () => {
				closeContextMenu();
				openCombinedEditor(op);
			});
			menu.appendChild(editItem);

			const sep = document.createElement('div');
			sep.className = 'context-menu-separator';
			menu.appendChild(sep);

			const delItem = document.createElement('div');
			delItem.className = 'context-menu-item context-menu-item-danger';
			delItem.textContent = 'Delete';
			delItem.addEventListener('click', () => {
				closeContextMenu();
				vscode.postMessage({ type: 'deleteCombinedOp', opName: op.name });
			});
			menu.appendChild(delItem);

			document.body.appendChild(menu);
			activeContextMenu = menu;
			const r = menu.getBoundingClientRect();
			let top = e.clientY;
			let left = e.clientX;
			if (top + r.height > window.innerHeight) top = window.innerHeight - r.height - 4;
			if (left + r.width > window.innerWidth) left = window.innerWidth - r.width - 4;
			menu.style.top = top + 'px';
			menu.style.left = left + 'px';
		});

		applyCombinedStatusToCard(card, op);
		return card;
	}

	function updateCombinedCardStatus(opName) {
		const wrapper = document.getElementById('combined-wrapper');
		if (!wrapper) return;
		const card = wrapper.querySelector('.combined-item[data-op-name="' + cssEscape(opName) + '"]');
		if (!(card instanceof HTMLElement)) return;
		const op = lastCombinedOps.find((o) => o.name === opName);
		if (!op) return;
		applyCombinedStatusToCard(card, op);
	}

	function applyCombinedStatusToCard(card, op) {
		card.classList.remove('combined-running', 'combined-done', 'combined-error', 'combined-cancelled');
		const statusEl = card.querySelector('.combined-status');
		if (!(statusEl instanceof HTMLElement)) return;
		statusEl.innerHTML = '';

		const st = combinedStatusMap.get(op.name);
		const isActive = combinedActiveOps.has(op.name);

		if (isActive && st) {
			card.classList.add('combined-running');
			const line = document.createElement('div');
			line.className = 'combined-progress-line';
			line.textContent = 'Running ' + st.step + '/' + st.total + ': ' + (st.currentLabel || '');
			statusEl.appendChild(line);

			if (st.message) {
				const sub = document.createElement('div');
				sub.className = 'combined-progress-sub';
				sub.textContent = st.message;
				statusEl.appendChild(sub);
			}

			// If the current step is an upload, embed its progress bar inline.
			if (st.currentUploadKey) {
				const upStatus = uploadStatusMap.get(st.currentUploadKey);
				if (upStatus) {
					const bar = document.createElement('div');
					bar.className = 'upload-progress';
					const fill = document.createElement('div');
					fill.className = 'upload-progress-fill';
					const pct = typeof upStatus.percent === 'number' ? upStatus.percent : 0;
					fill.style.width = pct.toFixed(1) + '%';
					bar.appendChild(fill);
					statusEl.appendChild(bar);

					const text = document.createElement('div');
					text.className = 'upload-progress-text';
					const parts = [];
					if (typeof upStatus.percent === 'number') parts.push(upStatus.percent.toFixed(0) + '%');
					if (upStatus.currentFile) parts.push(truncate(upStatus.currentFile, 40));
					if (typeof upStatus.speedBps === 'number' && upStatus.speedBps > 0) {
						parts.push(formatBytesShort(upStatus.speedBps) + '/s');
					}
					if (upStatus.filesTotal) parts.push(upStatus.filesDone + '/' + upStatus.filesTotal);
					text.textContent = parts.join(' · ');
					statusEl.appendChild(text);
				}
			}
		} else if (st && st.status === 'done') {
			card.classList.add('combined-done');
			const text = document.createElement('div');
			text.className = 'combined-last';
			text.textContent = '✓ done (' + st.total + '/' + st.total + ')';
			statusEl.appendChild(text);
		} else if (st && st.status === 'error') {
			card.classList.add('combined-error');
			const text = document.createElement('div');
			text.className = 'combined-last combined-last-error';
			text.textContent = '✗ failed at step ' + st.step + ': ' + (st.message || '');
			text.title = st.message || '';
			statusEl.appendChild(text);
		} else if (st && st.status === 'cancelled') {
			card.classList.add('combined-cancelled');
			const text = document.createElement('div');
			text.className = 'combined-last';
			text.textContent = 'cancelled at step ' + st.step;
			statusEl.appendChild(text);
		}
	}

	// ── Editor modal ────────────────────────────────────────────────────

	function openCombinedEditor(existingOp) {
		// Close any open menu.
		closeContextMenu();
		// Remove any prior editor (inline form lives inside the wrapper).
		const prior = document.querySelector('.combined-modal-backdrop');
		if (prior) prior.remove();
		// Expand the combined section if collapsed so the editor is visible.
		const cWrapper = document.getElementById('combined-wrapper');
		const cBody = cWrapper ? cWrapper.querySelector('.combined-body') : null;
		const cChevron = cWrapper ? cWrapper.querySelector('.combined-chevron') : null;
		const cWrap = cWrapper ? cWrapper.querySelector('.combined-section') : null;
		if (cBody && cBody.classList.contains('collapsed')) {
			cBody.classList.remove('collapsed');
			if (cChevron) cChevron.classList.remove('collapsed');
			if (cWrap) cWrap.classList.remove('collapsed');
		}

		const isEdit = !!existingOp;
		const originalName = existingOp ? existingOp.name : undefined;
		/** @type {{ name: string; steps: any[]; stopOnError: boolean }} */
		const draft = existingOp
			? { name: existingOp.name, steps: JSON.parse(JSON.stringify(existingOp.steps || [])), stopOnError: existingOp.stopOnError !== false }
			: { name: '', steps: [], stopOnError: true };

		const backdrop = document.createElement('div');
		backdrop.className = 'combined-modal-backdrop';
		backdrop.addEventListener('click', (e) => {
			if (e.target === backdrop) closeModal();
		});

		const modal = document.createElement('div');
		modal.className = 'combined-modal';
		modal.addEventListener('click', (e) => e.stopPropagation());

		// Header
		const headerRow = document.createElement('div');
		headerRow.className = 'combined-modal-header';
		const titleEl = document.createElement('span');
		titleEl.className = 'combined-modal-title';
		titleEl.textContent = isEdit ? 'Edit Combined Operation' : 'New Combined Operation';
		headerRow.appendChild(titleEl);
		const closeBtn = document.createElement('button');
		closeBtn.className = 'combined-modal-close';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', closeModal);
		headerRow.appendChild(closeBtn);
		modal.appendChild(headerRow);

		// Name input
		const nameGroup = document.createElement('div');
		nameGroup.className = 'combined-modal-field';
		const nameLabel = document.createElement('label');
		nameLabel.textContent = 'Name';
		const nameInput = document.createElement('input');
		nameInput.type = 'text';
		nameInput.value = draft.name;
		nameInput.placeholder = 'Build & Deploy';
		nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
		nameGroup.appendChild(nameLabel);
		nameGroup.appendChild(nameInput);
		modal.appendChild(nameGroup);

		// Steps list with drag-and-drop reorder
		const stepsLabel = document.createElement('label');
		stepsLabel.className = 'combined-modal-field-label';
		stepsLabel.textContent = 'Steps (drag to reorder):';
		modal.appendChild(stepsLabel);

		const stepsList = document.createElement('div');
		stepsList.className = 'combined-modal-steps';
		modal.appendChild(stepsList);

		function renderSteps() {
			stepsList.innerHTML = '';
			draft.steps.forEach((step, idx) => {
				const row = document.createElement('div');
				row.className = 'combined-step-row';
				if (step.enabled === false) row.classList.add('combined-step-row-off');
				row.draggable = true;
				row.dataset.stepIndex = String(idx);

				const drag = document.createElement('span');
				drag.className = 'combined-step-drag';
				drag.textContent = '⋮⋮';
				row.appendChild(drag);

				const enabledCb = document.createElement('input');
				enabledCb.type = 'checkbox';
				enabledCb.checked = step.enabled !== false;
				enabledCb.title = enabledCb.checked ? 'Step is included' : 'Step is skipped';
				enabledCb.addEventListener('click', function(e) {
					e.stopPropagation();
					step.enabled = enabledCb.checked;
					row.classList.toggle('combined-step-row-off', !enabledCb.checked);
				});
				row.appendChild(enabledCb);

				const stepIconEl = document.createElement('span');
				stepIconEl.className = 'combined-step-icon';
				stepIconEl.textContent = stepIcon(step);
				row.appendChild(stepIconEl);

				const label = document.createElement('span');
				label.className = 'combined-step-label';
				label.textContent = stepLabel(step);
				row.appendChild(label);

				const del = document.createElement('button');
				del.className = 'combined-step-del';
				del.textContent = '✕';
				del.title = 'Remove step';
				del.addEventListener('click', (e) => {
					e.stopPropagation();
					draft.steps.splice(idx, 1);
					renderSteps();
				});
				row.appendChild(del);

				row.addEventListener('dragstart', (e) => {
					e.dataTransfer?.setData('text/plain', String(idx));
					row.classList.add('dragging');
				});
				row.addEventListener('dragend', () => row.classList.remove('dragging'));
				row.addEventListener('dragover', (e) => {
					e.preventDefault();
					row.classList.add('drag-over');
				});
				row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
				row.addEventListener('drop', (e) => {
					e.preventDefault();
					row.classList.remove('drag-over');
					const fromIdx = parseInt(e.dataTransfer?.getData('text/plain') || '-1', 10);
					if (isNaN(fromIdx) || fromIdx === idx) return;
					const [moved] = draft.steps.splice(fromIdx, 1);
					draft.steps.splice(idx, 0, moved);
					renderSteps();
				});

				stepsList.appendChild(row);
			});
			if (draft.steps.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'combined-step-empty';
				empty.textContent = 'No steps yet. Click "Add step ▾" below.';
				stepsList.appendChild(empty);
			}
		}
		renderSteps();

		// Add-step dropdown
		const addRow = document.createElement('div');
		addRow.className = 'combined-modal-add-row';
		const addStepBtn = document.createElement('button');
		addStepBtn.className = 'btn-primary';
		addStepBtn.textContent = '+ Add step ▾';
		addRow.appendChild(addStepBtn);
		modal.appendChild(addRow);

		addStepBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			showAddStepMenu(addStepBtn, (newStep) => {
				if (newStep) {
					draft.steps.push(newStep);
					renderSteps();
				}
			});
		});

		// Stop-on-error checkbox — single label wraps the checkbox + text so they
		// line up on one row (the standard .combined-modal-field is a vertical
		// flex which made the label drop below the box).
		const optsRow = document.createElement('label');
		optsRow.className = 'combined-modal-checkbox';
		const stopCb = document.createElement('input');
		stopCb.type = 'checkbox';
		stopCb.checked = draft.stopOnError;
		stopCb.addEventListener('change', () => { draft.stopOnError = stopCb.checked; });
		optsRow.appendChild(stopCb);
		optsRow.appendChild(document.createTextNode('Stop on error'));
		modal.appendChild(optsRow);

		// Footer
		const footer = document.createElement('div');
		footer.className = 'combined-modal-footer';
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'btn-secondary';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', closeModal);
		const saveBtn = document.createElement('button');
		saveBtn.className = 'btn-primary';
		saveBtn.textContent = 'Save';
		saveBtn.addEventListener('click', () => {
			if (!draft.name.trim()) {
				nameInput.focus();
				return;
			}
			if (draft.steps.length === 0) {
				return;
			}
			vscode.postMessage({
				type: 'saveCombinedOp',
				op: { name: draft.name.trim(), steps: draft.steps, stopOnError: draft.stopOnError },
				originalName: originalName,
			});
			closeModal();
		});
		footer.appendChild(cancelBtn);
		footer.appendChild(saveBtn);
		modal.appendChild(footer);

		backdrop.appendChild(modal);
		// Inline inside the section's body so the editor is sidebar-friendly,
		// rather than a full-page modal overlay.
		const targetBody = document.querySelector('#combined-wrapper .combined-body');
		(targetBody || document.body).insertBefore(backdrop, targetBody ? targetBody.firstChild : null);
		nameInput.focus();
		backdrop.scrollIntoView({ block: 'nearest' });

		function closeModal() {
			backdrop.remove();
		}
	}

	function showAddStepMenu(anchor, onPick) {
		closeContextMenu();
		const menu = document.createElement('div');
		menu.className = 'context-menu combined-add-menu';

		const presetAvail = combinedPickContext.presetAvailability || { sound: true, notification: true, open: true, installHint: '' };

		const types = [
			{ label: '▶ Command', kind: 'command-pick' },
			{ label: '⬆ Upload', kind: 'upload-pick' },
			{ label: '⚡ Auto-upload server', kind: 'auto-upload-pick' },
			{ label: '⚙ VS Code command…', kind: 'vscode-cmd-pick' },
			{ label: '⏱ Wait…', kind: 'wait-prompt' },
			{ label: (presetAvail.open ? '' : '⚠ ') + '↗ Open…', kind: 'open-prompt' },
			{ label: (presetAvail.sound ? '' : '⚠ ') + '🔊 Play sound…', kind: 'sound-prompt' },
			{ label: (presetAvail.notification ? '' : '⚠ ') + '🔔 Notification…', kind: 'notification-prompt' },
		];

		for (const t of types) {
			const item = document.createElement('div');
			item.className = 'context-menu-item';
			item.textContent = t.label;
			if (t.kind === 'sound-prompt' && !presetAvail.sound) item.title = presetAvail.installHint || 'Sound utility not detected on this system';
			if (t.kind === 'notification-prompt' && !presetAvail.notification) item.title = presetAvail.installHint || 'Notification utility not detected on this system';
			if (t.kind === 'open-prompt' && !presetAvail.open) item.title = presetAvail.installHint || 'Open utility (xdg-open) not detected on this system';
			item.addEventListener('click', () => {
				closeContextMenu();
				handleAddStepPick(t.kind, anchor, onPick);
			});
			menu.appendChild(item);
		}

		document.body.appendChild(menu);
		activeContextMenu = menu;
		const r = anchor.getBoundingClientRect();
		const mr = menu.getBoundingClientRect();
		let top = r.bottom + 4;
		let left = r.left;
		if (top + mr.height > window.innerHeight) top = r.top - mr.height - 4;
		if (left + mr.width > window.innerWidth) left = window.innerWidth - mr.width - 4;
		menu.style.top = top + 'px';
		menu.style.left = left + 'px';
	}

	function handleAddStepPick(kind, anchor, onPick) {
		if (kind === 'command-pick') {
			showSubPicker(anchor, combinedPickContext.commands.map((c) => ({
				label: c.name,
				detail: c.group,
				onPick: () => onPick({ type: 'command', name: c.name }),
			})), 'No commands available');
		} else if (kind === 'upload-pick') {
			showSubPicker(anchor, combinedPickContext.uploads.map((u) => ({
				label: u.name,
				detail: u.group,
				onPick: () => onPick({ type: 'upload', uploadKey: u.key }),
			})), 'No uploads configured');
		} else if (kind === 'auto-upload-pick') {
			showSubPicker(anchor, combinedPickContext.servers.map((s) => ({
				label: s,
				detail: 'auto-upload set-cover',
				onPick: () => onPick({ type: 'auto-upload', server: s }),
			})), 'No upload servers configured');
		} else if (kind === 'vscode-cmd-pick') {
			// Defer to the native quickPick in the extension host — too many
			// commands (1000+) to ship to the webview, and VS Code's fuzzy
			// search is what users already know.
			pendingVscodeCmdCallback = (commandId) => {
				if (!commandId) return;
				onPick({ type: 'vscode-cmd', commandId: commandId, title: commandId });
			};
			vscode.postMessage({ type: 'pickVscodeCommand' });
		} else if (kind === 'wait-prompt') {
			// window.prompt() doesn't work in VS Code webviews — defer to the
			// native input box via RPC.
			rpcInput('Wait how many seconds?', '5', 'e.g. 5').then(function(val) {
				const n = parseFloat(val || '');
				if (n > 0) onPick({ type: 'wait', seconds: n });
			});
		} else if (kind === 'open-prompt') {
			rpcPick('Open — target kind', ['url', 'file', 'app']).then(function(k) {
				if (!k) return;
				const defaultV = k === 'url' ? 'https://example.com' : k === 'app' ? 'firefox' : '${workspaceFolder}/README.md';
				return rpcInput('Open — target', defaultV, k === 'url' ? 'https://…' : k === 'app' ? 'app name' : 'file path').then(function(target) {
					if (!target) return;
					onPick({ type: 'open', target: target, kind: k });
				});
			});
		} else if (kind === 'sound-prompt') {
			rpcPick('Sound clip', ['complete', 'alert', 'error']).then(function(c) {
				if (!c) return;
				onPick({ type: 'sound', clip: c });
			});
		} else if (kind === 'notification-prompt') {
			rpcInput('Notification message', 'Done', 'supports {opName}, {step}, {total}').then(function(msg) {
				if (!msg) return;
				return rpcPick('Level', ['info', 'warn', 'error']).then(function(l) {
					onPick({ type: 'notification', message: msg, level: l || 'info' });
				});
			});
		}
	}

	function showSubPicker(anchor, items, emptyText) {
		closeContextMenu();
		const menu = document.createElement('div');
		menu.className = 'context-menu combined-add-menu';

		if (items.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'context-menu-item context-menu-item-disabled';
			empty.textContent = emptyText;
			menu.appendChild(empty);
		} else {
			for (const it of items) {
				const row = document.createElement('div');
				row.className = 'context-menu-item';
				const label = document.createElement('span');
				label.textContent = it.label;
				row.appendChild(label);
				if (it.detail) {
					const det = document.createElement('span');
					det.className = 'context-menu-item-detail';
					det.textContent = it.detail;
					row.appendChild(det);
				}
				row.addEventListener('click', () => {
					closeContextMenu();
					it.onPick();
				});
				menu.appendChild(row);
			}
		}

		document.body.appendChild(menu);
		activeContextMenu = menu;
		const r = anchor.getBoundingClientRect();
		const mr = menu.getBoundingClientRect();
		let top = r.bottom + 4;
		let left = r.left;
		if (top + mr.height > window.innerHeight) top = r.top - mr.height - 4;
		if (left + mr.width > window.innerWidth) left = window.innerWidth - mr.width - 4;
		menu.style.top = top + 'px';
		menu.style.left = left + 'px';
	}

	// ─── Claude Hooks Manager ───────────────────────────────────────────

	function targetIcon(t) { return t === 'project' ? '📁' : t === 'local' ? '🔒' : '🌍'; }
	function targetLabel(t) { return t === 'project' ? 'project' : t === 'local' ? 'local' : 'user-global'; }

	function renderHooks() {
		const wrapper = document.getElementById('hooks-wrapper');
		if (!wrapper) return;
		wrapper.innerHTML = '';

		const wrap = document.createElement('div');
		wrap.className = 'hooks-section';

		const header = document.createElement('div');
		header.className = 'hooks-header';

		const chevron = document.createElement('span');
		chevron.className = 'hooks-chevron';
		chevron.innerHTML = '&#x25BC;';
		header.appendChild(chevron);

		const title = document.createElement('span');
		title.className = 'hooks-title';
		title.textContent = 'Claude Hooks';
		header.appendChild(title);

		const addBtn = document.createElement('button');
		addBtn.className = 'hooks-add-btn';
		addBtn.title = 'Add hook';
		addBtn.textContent = '+';
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			openHookEditor(null);
		});
		header.appendChild(addBtn);

		const pasteBtn = document.createElement('button');
		pasteBtn.className = 'hooks-add-btn';
		pasteBtn.title = 'Paste hook from clipboard';
		pasteBtn.textContent = '📋';
		pasteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'pasteClaudeHook' });
		});
		header.appendChild(pasteBtn);

		// Globals filter — by default the section shows only project + local
		// hooks (the ones actually scoped to this workspace). User-global hooks
		// live in ~/.claude/settings.json and clutter the list across every
		// project they're shared with — opt in with this button.
		const globalsBtn = document.createElement('button');
		globalsBtn.className = 'hooks-add-btn hooks-globals-toggle' + (hooksShowGlobal ? ' on' : '');
		globalsBtn.title = hooksShowGlobal
			? 'Showing user-global hooks too — click to hide'
			: 'Showing only project + local hooks — click to also show user-global';
		globalsBtn.textContent = '🌍';
		globalsBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			hooksShowGlobal = !hooksShowGlobal;
			vscode.postMessage({ type: 'setHooksShowGlobal', value: hooksShowGlobal });
			renderHooks();
		});
		header.appendChild(globalsBtn);

		// Quick access to the underlying settings.json files — same handler
		// the per-card badge uses, but you don't need a hook to view them.
		const settingsBtn = document.createElement('button');
		settingsBtn.className = 'hooks-add-btn';
		settingsBtn.title = 'Open settings.json file…';
		settingsBtn.textContent = '📂';
		settingsBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			closeContextMenu();
			const menu = document.createElement('div');
			menu.className = 'context-menu';
			const files = [
				{ target: 'project', label: '📁 project — .claude/settings.json', detail: hooksContext.filePaths.project },
				{ target: 'local', label: '🔒 local — .claude/settings.local.json', detail: hooksContext.filePaths.local },
				{ target: 'user', label: '🌍 user-global — ~/.claude/settings.json', detail: hooksContext.filePaths.user },
			];
			for (const f of files) {
				const item = document.createElement('div');
				item.className = 'context-menu-item';
				const lbl = document.createElement('span');
				lbl.textContent = f.label;
				item.appendChild(lbl);
				if (f.detail) {
					const det = document.createElement('span');
					det.className = 'context-menu-item-detail';
					det.textContent = f.detail;
					item.appendChild(det);
				}
				item.addEventListener('click', () => {
					closeContextMenu();
					vscode.postMessage({ type: 'openClaudeHookFile', target: f.target });
				});
				menu.appendChild(item);
			}
			document.body.appendChild(menu);
			activeContextMenu = menu;
			const r = settingsBtn.getBoundingClientRect();
			const mr = menu.getBoundingClientRect();
			let top = r.bottom + 4;
			let left = r.right - mr.width;
			if (top + mr.height > window.innerHeight) top = r.top - mr.height - 4;
			if (left < 4) left = 4;
			menu.style.top = top + 'px';
			menu.style.left = left + 'px';
		});
		header.appendChild(settingsBtn);

		const visibleHooks = hooksShowGlobal
			? lastClaudeHooks
			: lastClaudeHooks.filter((h) => h.targetFile !== 'user');
		const hiddenGlobalCount = lastClaudeHooks.length - visibleHooks.length;

		if (lastClaudeHooks.length > 0) {
			const badge = document.createElement('span');
			badge.className = 'hooks-count';
			badge.textContent = hiddenGlobalCount > 0
				? visibleHooks.length + '/' + lastClaudeHooks.length
				: String(lastClaudeHooks.length);
			if (hiddenGlobalCount > 0) badge.title = hiddenGlobalCount + ' user-global hook(s) hidden — click 🌍 to show';
			header.appendChild(badge);
		}

		const body = document.createElement('div');
		body.className = 'hooks-body';

		header.addEventListener('click', () => {
			body.classList.toggle('collapsed');
			chevron.classList.toggle('collapsed');
			wrap.classList.toggle('collapsed');
			vscode.postMessage({ type: 'setHooksCollapsed', value: wrap.classList.contains('collapsed') });
		});

		// Brief intro so users understand what hooks are without leaving the panel.
		const intro = document.createElement('div');
		intro.className = 'hooks-intro';
		intro.textContent = 'Shell commands Claude Code runs automatically on session events (Stop, PreToolUse, etc.). Stored in .claude/settings.json files.';
		body.appendChild(intro);

		if (visibleHooks.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'hooks-empty';
			if (hiddenGlobalCount > 0) {
				empty.innerHTML = 'No project/local hooks. ' + hiddenGlobalCount + ' user-global hidden — click <span class="hooks-empty-icon">🌍</span> to show.';
			} else {
				empty.innerHTML = 'No Claude hooks. Click <span class="hooks-empty-icon">+</span> to add one.';
			}
			body.appendChild(empty);
		} else {
			// Group by event. Sort events by ALL_HOOK_EVENTS-style canonical
			// order, and inside each event sort by id (stable hash over command
			// + matcher + timeout). Toggling a hook off→on does NOT change its
			// id, so its slot in the list is preserved across toggles.
			const eventOrder = hooksContext.events || [];
			const byEvent = new Map();
			for (const h of visibleHooks) {
				if (!byEvent.has(h.event)) byEvent.set(h.event, []);
				byEvent.get(h.event).push(h);
			}
			const orderedEvents = Array.from(byEvent.keys()).sort((a, b) => {
				const ia = eventOrder.indexOf(a);
				const ib = eventOrder.indexOf(b);
				if (ia >= 0 && ib >= 0) return ia - ib;
				if (ia >= 0) return -1;
				if (ib >= 0) return 1;
				return a.localeCompare(b);
			});
			for (const event of orderedEvents) {
				const hooks = byEvent.get(event).slice().sort((x, y) => {
					return String(x.id).localeCompare(String(y.id));
				});
				const subhead = document.createElement('div');
				subhead.className = 'hooks-group-name';
				subhead.textContent = event;
				body.appendChild(subhead);
				const desc = HOOK_EVENT_DESCRIPTIONS[event];
				if (desc) {
					const descEl = document.createElement('div');
					descEl.className = 'hooks-group-desc';
					descEl.textContent = desc;
					body.appendChild(descEl);
				}
				for (const h of hooks) body.appendChild(createHookCard(h));
			}
		}

		wrap.appendChild(header);
		wrap.appendChild(body);
		wrapper.appendChild(wrap);

		const shouldCollapse = hooksCollapsed === undefined ? true : hooksCollapsed;
		if (shouldCollapse) {
			body.classList.add('collapsed');
			chevron.classList.add('collapsed');
			wrap.classList.add('collapsed');
		}
	}

	function createHookCard(hook) {
		const card = document.createElement('div');
		card.className = 'hook-item';
		card.dataset.hookId = hook.id;
		if (!hook.enabled) card.classList.add('hook-disabled');

		// Toggle — proper slider so it's obvious what it does. Title spells out
		// "Enabled — click to disable" so first-time users get it without docs.
		const toggle = document.createElement('button');
		toggle.className = 'hook-toggle' + (hook.enabled ? ' hook-toggle-on' : '');
		toggle.title = hook.enabled
			? 'Enabled — click to disable. The hook is removed from settings.json and kept in workspace state.'
			: 'Disabled — click to re-enable. The hook is restored to its original settings.json.';
		const knob = document.createElement('span');
		knob.className = 'hook-toggle-knob';
		toggle.appendChild(knob);
		toggle.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'toggleClaudeHook', id: hook.id, enabled: !hook.enabled });
		});
		card.appendChild(toggle);

		const info = document.createElement('div');
		info.className = 'hook-info';

		const top = document.createElement('div');
		top.className = 'hook-top';

		// Command/label row (kept as the primary line; clickable if it points
		// to a script file we can open).
		const cmdLine = document.createElement('div');
		cmdLine.className = 'hook-cmd';
		const scriptPath = extractScriptPath(hook.command);
		if (scriptPath) {
			cmdLine.classList.add('hook-cmd-clickable');
			cmdLine.title = 'Click to open ' + scriptPath;
			cmdLine.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'openHookScript', path: scriptPath });
			});
		} else {
			cmdLine.title = hook.command;
		}
		cmdLine.textContent = hook.command;
		top.appendChild(cmdLine);

		// Badge for target file — pill, clickable, colored per-target.
		const targetSpan = document.createElement('span');
		targetSpan.className = 'hook-badge hook-badge-' + hook.targetFile;
		targetSpan.textContent = targetLabel(hook.targetFile);
		targetSpan.title = 'Open ' + targetLabel(hook.targetFile) + ' settings.json';
		targetSpan.addEventListener('click', (e) => {
			e.stopPropagation();
			vscode.postMessage({ type: 'openClaudeHookFile', target: hook.targetFile });
		});
		top.appendChild(targetSpan);
		info.appendChild(top);

		// Meta row — matcher / timeout. Event is shown in the group header.
		const meta = [];
		if (hook.matcher) meta.push('matcher: ' + hook.matcher);
		if (hook.timeout) meta.push(hook.timeout + 's timeout');
		if (meta.length) {
			const sub = document.createElement('div');
			sub.className = 'hook-sub';
			sub.textContent = meta.join(' · ');
			info.appendChild(sub);
		}

		card.appendChild(info);

		card.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			closeContextMenu();
			const menu = document.createElement('div');
			menu.className = 'context-menu';

			const editItem = document.createElement('div');
			editItem.className = 'context-menu-item';
			editItem.textContent = 'Edit…';
			editItem.addEventListener('click', () => { closeContextMenu(); openHookEditor(hook); });
			menu.appendChild(editItem);

			const copyItem = document.createElement('div');
			copyItem.className = 'context-menu-item';
			copyItem.textContent = 'Copy to clipboard';
			copyItem.addEventListener('click', () => {
				closeContextMenu();
				vscode.postMessage({ type: 'copyClaudeHook', hook });
			});
			menu.appendChild(copyItem);

			const sep = document.createElement('div');
			sep.className = 'context-menu-separator';
			menu.appendChild(sep);

			const delItem = document.createElement('div');
			delItem.className = 'context-menu-item context-menu-item-danger';
			delItem.textContent = 'Delete';
			delItem.addEventListener('click', () => {
				closeContextMenu();
				vscode.postMessage({ type: 'deleteClaudeHook', id: hook.id });
			});
			menu.appendChild(delItem);

			document.body.appendChild(menu);
			activeContextMenu = menu;
			const r = menu.getBoundingClientRect();
			let top = e.clientY;
			let left = e.clientX;
			if (top + r.height > window.innerHeight) top = window.innerHeight - r.height - 4;
			if (left + r.width > window.innerWidth) left = window.innerWidth - r.width - 4;
			menu.style.top = top + 'px';
			menu.style.left = left + 'px';
		});

		return card;
	}

	/**
	 * If a hook command looks like a wrapper around a script file (.sh, .py,
	 * .js, etc.) — possibly with $CLAUDE_PROJECT_DIR or ~/ prefixes — pull out
	 * the path so we can make the command row open it in the editor.
	 *
	 * Captures the FULL whitespace-delimited token ending in a script
	 * extension. That way shell quirks like `"$CLAUDE_PROJECT_DIR"/.path.sh`
	 * (quote ends mid-token) come through intact; the backend strips quotes
	 * and expands env vars / ~.
	 */
	function extractScriptPath(cmd) {
		if (!cmd) return null;
		const re = /(?:^|\s)(\S+\.(?:sh|py|js|ts|mjs|cjs|rb|pl|bash|zsh|fish))(?=\s|$|;|&|\||\))/;
		const m = cmd.match(re);
		if (!m) return null;
		return m[1];
	}

	function hookDisplayName(hook) {
		if (hook.source && hook.source.kind === 'preset' && hook.source.presetKey) {
			return '🎯 ' + hook.source.presetKey;
		}
		if (hook.source && hook.source.kind === 'command-ref' && hook.source.commandRef) {
			return '▶ ' + hook.source.commandRef;
		}
		// Truncate raw command
		const c = hook.command || '';
		if (c.length > 60) return c.substring(0, 57) + '…';
		return c;
	}

	function openHookEditor(existingHook, prefill) {
		closeContextMenu();
		const prior = document.querySelector('.combined-modal-backdrop[data-modal="hook"]');
		if (prior) prior.remove();
		// Expand the hooks section if collapsed so the editor is visible.
		const hWrapper = document.getElementById('hooks-wrapper');
		const hBody = hWrapper ? hWrapper.querySelector('.hooks-body') : null;
		const hChevron = hWrapper ? hWrapper.querySelector('.hooks-chevron') : null;
		const hWrap = hWrapper ? hWrapper.querySelector('.hooks-section') : null;
		if (hBody && hBody.classList.contains('collapsed')) {
			hBody.classList.remove('collapsed');
			if (hChevron) hChevron.classList.remove('collapsed');
			if (hWrap) hWrap.classList.remove('collapsed');
		}

		const isEdit = !!existingHook;
		const originalId = existingHook ? existingHook.id : undefined;
		/** @type {any} */
		const draft = existingHook
			? JSON.parse(JSON.stringify(existingHook))
			: (prefill
				? {
					event: prefill.event || 'Stop',
					matcher: prefill.matcher || '',
					command: prefill.command || '',
					timeout: prefill.timeout,
					targetFile: 'project',
					enabled: true,
				}
				: { event: 'Stop', matcher: '', command: '', timeout: undefined, targetFile: 'project', enabled: true });
		let actionMode = 'custom'; // preset | command | custom
		let currentPresetKey = '';
		if (draft.source) {
			actionMode = draft.source.kind === 'preset' ? 'preset' : draft.source.kind === 'command-ref' ? 'command' : 'custom';
			currentPresetKey = draft.source.presetKey || '';
		}

		const backdrop = document.createElement('div');
		backdrop.className = 'combined-modal-backdrop';
		backdrop.dataset.modal = 'hook';
		backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

		const modal = document.createElement('div');
		modal.className = 'combined-modal hook-modal';
		modal.addEventListener('click', (e) => e.stopPropagation());

		// Header
		const headerRow = document.createElement('div');
		headerRow.className = 'combined-modal-header';
		const titleEl = document.createElement('span');
		titleEl.className = 'combined-modal-title';
		titleEl.textContent = isEdit ? 'Edit Claude Hook' : 'New Claude Hook';
		headerRow.appendChild(titleEl);
		const closeBtn = document.createElement('button');
		closeBtn.className = 'combined-modal-close';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', close);
		headerRow.appendChild(closeBtn);
		modal.appendChild(headerRow);

		// Event dropdown
		const evGroup = document.createElement('div');
		evGroup.className = 'combined-modal-field';
		const evLabel = document.createElement('label');
		evLabel.textContent = 'Event';
		const evSelect = document.createElement('select');
		for (const ev of (hooksContext.events.length ? hooksContext.events : ['Stop'])) {
			const opt = document.createElement('option');
			opt.value = ev; opt.textContent = ev;
			if (draft.event === ev) opt.selected = true;
			evSelect.appendChild(opt);
		}
		evSelect.addEventListener('change', () => { draft.event = evSelect.value; renderMatcher(); });
		evGroup.appendChild(evLabel); evGroup.appendChild(evSelect);
		modal.appendChild(evGroup);

		// Matcher (conditional)
		const matcherGroup = document.createElement('div');
		matcherGroup.className = 'combined-modal-field';
		const matcherLabel = document.createElement('label');
		matcherLabel.textContent = 'Matcher (optional regex)';
		const matcherInput = document.createElement('input');
		matcherInput.type = 'text';
		matcherInput.value = draft.matcher || '';
		matcherInput.placeholder = 'e.g. ^Bash$ for PreToolUse';
		matcherInput.addEventListener('input', () => { draft.matcher = matcherInput.value; });
		matcherGroup.appendChild(matcherLabel); matcherGroup.appendChild(matcherInput);
		modal.appendChild(matcherGroup);
		function renderMatcher() {
			matcherGroup.style.display = hooksContext.matcherEvents.indexOf(draft.event) >= 0 ? '' : 'none';
		}
		renderMatcher();

		// Target file
		const tgtGroup = document.createElement('div');
		tgtGroup.className = 'combined-modal-field';
		const tgtLabel = document.createElement('label');
		tgtLabel.textContent = 'Target file';
		const tgtSelect = document.createElement('select');
		for (const t of [
			{ v: 'project', label: '📁 project — .claude/settings.json (committed)' },
			{ v: 'local', label: '🔒 local — .claude/settings.local.json (gitignored)' },
			{ v: 'user', label: '🌍 user-global — ~/.claude/settings.json' },
		]) {
			const opt = document.createElement('option');
			opt.value = t.v; opt.textContent = t.label;
			if (draft.targetFile === t.v) opt.selected = true;
			tgtSelect.appendChild(opt);
		}
		tgtSelect.addEventListener('change', () => { draft.targetFile = tgtSelect.value; });
		tgtGroup.appendChild(tgtLabel); tgtGroup.appendChild(tgtSelect);
		modal.appendChild(tgtGroup);

		// Action mode
		const actGroup = document.createElement('div');
		actGroup.className = 'combined-modal-field';
		const actLabel = document.createElement('label');
		actLabel.textContent = 'Action';
		actGroup.appendChild(actLabel);

		const modeWrap = document.createElement('div');
		modeWrap.className = 'hook-mode-wrap';
		const modes = [
			{ v: 'preset', label: 'Preset' },
			{ v: 'command', label: 'Existing command' },
			{ v: 'custom', label: 'Custom shell' },
		];
		for (const m of modes) {
			const rl = document.createElement('label');
			rl.className = 'hook-mode-radio';
			const r = document.createElement('input');
			r.type = 'radio'; r.name = 'hook-mode'; r.value = m.v;
			if (actionMode === m.v) r.checked = true;
			r.addEventListener('change', () => { actionMode = m.v; renderAction(); });
			rl.appendChild(r);
			rl.appendChild(document.createTextNode(' ' + m.label));
			modeWrap.appendChild(rl);
		}
		actGroup.appendChild(modeWrap);

		const actionExtra = document.createElement('div');
		actionExtra.className = 'hook-action-extra';
		actGroup.appendChild(actionExtra);
		modal.appendChild(actGroup);

		function renderAction() {
			actionExtra.innerHTML = '';
			if (actionMode === 'preset') {
				const presetSelect = document.createElement('select');
				const presets = [
					{ k: 'play-sound', label: '🔊 Play sound' + (hooksContext.presetAvailability.sound ? '' : ' ⚠'), cmd: hooksContext.presetTemplates.sound },
					{ k: 'notification', label: '🔔 Desktop notification' + (hooksContext.presetAvailability.notification ? '' : ' ⚠'), cmd: hooksContext.presetTemplates.notification },
					{ k: 'append-timestamp', label: '📝 Append timestamp', cmd: hooksContext.presetTemplates.appendTimestamp },
					{ k: 'wait-seconds', label: '⏱ Wait N seconds', cmd: '' /* user fills in */ },
					{ k: 'open-url', label: '↗ Open URL / file / app' + (hooksContext.presetAvailability.open ? '' : ' ⚠'), cmd: hooksContext.presetTemplates.open },
				];
				const defaultOpt = document.createElement('option');
				defaultOpt.value = ''; defaultOpt.textContent = '— choose preset —';
				presetSelect.appendChild(defaultOpt);
				for (const p of presets) {
					const opt = document.createElement('option');
					opt.value = p.k; opt.textContent = p.label;
					if (currentPresetKey === p.k) opt.selected = true;
					presetSelect.appendChild(opt);
				}
				presetSelect.addEventListener('change', () => {
					const sel = presets.find((p) => p.k === presetSelect.value);
					if (!sel) return;
					currentPresetKey = sel.k;
					if (sel.k === 'wait-seconds') {
						const n = parseFloat(prompt('How many seconds?', '5') || '');
						draft.command = (navigator.platform.indexOf('Win') !== -1 ? 'timeout /t ' + n + ' /nobreak >nul' : 'sleep ' + n);
					} else {
						draft.command = sel.cmd || '';
					}
					draft.source = { kind: 'preset', presetKey: sel.k };
					cmdInput.value = draft.command;
				});
				actionExtra.appendChild(presetSelect);
				if (hooksContext.presetAvailability.installHint) {
					const hint = document.createElement('div');
					hint.className = 'hook-install-hint';
					hint.textContent = hooksContext.presetAvailability.installHint;
					actionExtra.appendChild(hint);
				}
			} else if (actionMode === 'command') {
				const cmdSelect = document.createElement('select');
				const defOpt = document.createElement('option');
				defOpt.value = ''; defOpt.textContent = '— choose command —';
				cmdSelect.appendChild(defOpt);
				for (const cmd of hooksContext.commands) {
					const opt = document.createElement('option');
					opt.value = cmd.name;
					opt.textContent = cmd.name + (cmd.group ? '  (' + cmd.group + ')' : '');
					if (draft.source && draft.source.commandRef === cmd.name) opt.selected = true;
					cmdSelect.appendChild(opt);
				}
				cmdSelect.addEventListener('change', () => {
					if (!cmdSelect.value) return;
					const picked = hooksContext.commands.find(function(c) { return c.name === cmdSelect.value; });
					if (!picked) return;
					draft.source = { kind: 'command-ref', commandRef: picked.name };
					// IMPORTANT: store the actual shell script, not the command name —
					// otherwise the hook tries to execute the human-readable name.
					draft.command = picked.command;
					cmdInput.value = draft.command;
				});
				actionExtra.appendChild(cmdSelect);
				const hint = document.createElement('div');
				hint.className = 'hook-install-hint';
				hint.textContent = 'The script below is editable — tweak it for this hook without touching the original command.';
				actionExtra.appendChild(hint);
			} else {
				draft.source = { kind: 'custom' };
			}
		}

		// Command field — textarea so long shell scripts wrap and stay editable.
		const cmdGroup = document.createElement('div');
		cmdGroup.className = 'combined-modal-field';
		const cmdLabel = document.createElement('label');
		cmdLabel.textContent = 'Shell script (this is what runs)';
		const cmdInput = document.createElement('textarea');
		cmdInput.className = 'hook-cmd-input';
		cmdInput.rows = 3;
		cmdInput.value = draft.command || '';
		cmdInput.placeholder = 'shell command — e.g. echo hi >> /tmp/log';
		cmdInput.addEventListener('input', () => { draft.command = cmdInput.value; });
		cmdGroup.appendChild(cmdLabel); cmdGroup.appendChild(cmdInput);
		modal.appendChild(cmdGroup);

		renderAction();

		// Timeout
		const tmGroup = document.createElement('div');
		tmGroup.className = 'combined-modal-field';
		const tmLabel = document.createElement('label');
		tmLabel.textContent = 'Timeout (seconds, optional)';
		const tmInput = document.createElement('input');
		tmInput.type = 'text';
		tmInput.value = draft.timeout != null ? String(draft.timeout) : '';
		tmInput.placeholder = '10';
		tmInput.addEventListener('input', () => {
			const v = parseFloat(tmInput.value);
			draft.timeout = isNaN(v) ? undefined : v;
		});
		tmGroup.appendChild(tmLabel); tmGroup.appendChild(tmInput);
		modal.appendChild(tmGroup);

		// Footer
		const footer = document.createElement('div');
		footer.className = 'combined-modal-footer';
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'btn-secondary';
		cancelBtn.textContent = 'Cancel';
		cancelBtn.addEventListener('click', close);
		const saveBtn = document.createElement('button');
		saveBtn.className = 'btn-primary';
		saveBtn.textContent = 'Save';
		saveBtn.addEventListener('click', () => {
			if (!draft.command || !draft.command.trim()) { cmdInput.focus(); return; }
			vscode.postMessage({
				type: 'saveClaudeHook',
				hook: {
					event: draft.event,
					matcher: draft.matcher || undefined,
					command: draft.command,
					timeout: draft.timeout,
					targetFile: draft.targetFile,
					enabled: true,
					source: draft.source,
				},
				originalId: originalId,
			});
			close();
		});
		footer.appendChild(cancelBtn); footer.appendChild(saveBtn);
		modal.appendChild(footer);

		backdrop.appendChild(modal);
		const hookBody = document.querySelector('#hooks-wrapper .hooks-body');
		(hookBody || document.body).insertBefore(backdrop, hookBody ? hookBody.firstChild : null);
		backdrop.scrollIntoView({ block: 'nearest' });

		function close() { backdrop.remove(); }
	}

	// Signal to extension that webview JS is ready to receive messages
	vscode.postMessage({ type: 'ready' });
})();
