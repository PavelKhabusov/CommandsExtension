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

	document.addEventListener('click', closeContextMenu);
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
		const where = (upload.user && upload.host)
			? upload.user + '@' + upload.host
			: (upload.server ? '→ server "' + upload.server + '" (not found)' : 'no server config');
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

	// Signal to extension that webview JS is ready to receive messages
	vscode.postMessage({ type: 'ready' });
})();
