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

	let groupsCollapsed = false;
	let currentFavorites = /** @type {string[]} */ ([]);
	let currentGroups = /** @type {{ name: string; source?: string }[]} */ ([]);

	if (collapseBtn) {
		collapseBtn.addEventListener('click', () => {
			if (!container) return;
			const commands = container.querySelectorAll('.group-commands');
			const chevrons = container.querySelectorAll('.group-chevron');
			groupsCollapsed = !groupsCollapsed;
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
			case 'updateCommands':
				currentFavorites = message.favorites || [];
				currentGroups = (message.groups || []).map(function(g) { return { name: g.name, source: g.source }; });
				renderGroups(message.groups);
				break;
			case 'commandStarted':
				markCommandStarted(message.name);
				break;
			case 'updateMarketplace':
				renderMarketplace(message.templates);
				break;
		}
	});

	/**
	 * @param {{ name: string; command: string; type: string; group: string; cwd?: string; detail?: string }} cmd
	 * @param {string} groupName
	 * @param {boolean} isFavorited
	 * @returns {HTMLElement}
	 */
	function createCommandItem(cmd, groupName, isFavorited) {
		const item = document.createElement('div');
		item.className = 'cmd-item';
		item.dataset.name = cmd.name;

		// Play icon
		const icon = document.createElement('span');
		icon.className = 'cmd-icon';
		icon.textContent = '\u25B6';
		item.appendChild(icon);

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
		item.appendChild(starBtn);

		// Click to run command
		item.addEventListener('click', () => {
			vscode.postMessage({
				type: 'runCommand',
				name: cmd.name,
				command: cmd.command,
				shellType: cmd.type,
				cwd: cmd.cwd,
			});
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

		container.innerHTML = '';

		// Build and render Favorites group at the top
		if (currentFavorites.length > 0) {
			const favCommands = [];
			for (const group of groups) {
				for (const cmd of group.commands) {
					const key = group.name + ':' + cmd.name;
					if (currentFavorites.includes(key)) {
						favCommands.push({ cmd, groupName: group.name });
					}
				}
			}
			if (favCommands.length > 0) {
				const favGroupEl = document.createElement('div');
				favGroupEl.className = 'command-group favorites-group';

				const favHeader = document.createElement('div');
				favHeader.className = 'group-header';
				favHeader.innerHTML = '<span class="group-chevron">&#x25BC;</span><span class="group-name favorites-star-icon">&#x2605; Favorites</span>';

				const favCommandsEl = document.createElement('div');
				favCommandsEl.className = 'group-commands';

				favHeader.addEventListener('click', () => {
					const chevron = favHeader.querySelector('.group-chevron');
					if (chevron) chevron.classList.toggle('collapsed');
					favCommandsEl.classList.toggle('collapsed');
				});

				for (const { cmd, groupName } of favCommands) {
					const item = createCommandItem(cmd, groupName, true);
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
			});

			for (const cmd of group.commands) {
				const key = group.name + ':' + cmd.name;
				const isFav = currentFavorites.includes(key);
				const item = createCommandItem(cmd, group.name, isFav);
				commandsEl.appendChild(item);
			}

			groupEl.appendChild(header);
			groupEl.appendChild(commandsEl);
			container.appendChild(groupEl);
		}
	}

	/**
	 * @param {string} name
	 */
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

			// Badge with command count
			const badge = document.createElement('span');
			badge.className = 'tpl-group-badge';
			badge.textContent = String(tpl.commands.length);
			groupHeader.appendChild(badge);

			// Add all button
			const addAllBtn = document.createElement('button');
			addAllBtn.className = 'tpl-group-add';
			addAllBtn.textContent = '+';
			addAllBtn.title = 'Add all ' + tpl.name + ' commands';
			addAllBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'addTemplateGroup', groupId: tpl.id });
			});
			groupHeader.appendChild(addAllBtn);

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
	}

	// Hide all tooltips on scroll
	document.querySelectorAll('#main-content, #marketplace-wrapper').forEach(function(el) {
		el.addEventListener('scroll', function() {
			document.querySelectorAll('.cmd-tooltip.visible, .tpl-tooltip.visible').forEach(function(t) {
				t.classList.remove('visible');
			});
		});
	});

	// Signal to extension that webview JS is ready to receive messages
	vscode.postMessage({ type: 'ready' });
})();
