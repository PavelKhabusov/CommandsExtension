// @ts-check

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	const container = document.getElementById('commands-container');
	const refreshBtn = document.getElementById('refreshBtn');
	const addBtn = document.getElementById('addBtn');
	const addForm = document.getElementById('add-command-form');

	const clearBtn = document.getElementById('clearBtn');

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

	if (addBtn && addForm) {
		addBtn.addEventListener('click', () => {
			addForm.classList.toggle('visible');
			if (addForm.classList.contains('visible')) {
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
			const groupInput = /** @type {HTMLInputElement|null} */ (document.getElementById('cmdGroupInput'));

			if (!nameInput || !commandInput || !typeSelect) return;

			const name = nameInput.value.trim();
			const command = commandInput.value.trim();
			if (!name || !command) return;

			vscode.postMessage({
				type: 'addCommand',
				name: name,
				command: command,
				cmdType: typeSelect.value,
				group: groupInput ? groupInput.value.trim() : '',
			});

			// Reset form
			nameInput.value = '';
			commandInput.value = '';
			typeSelect.value = 'terminal';
			if (groupInput) groupInput.value = '';
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
				renderGroups(message.groups);
				break;
			case 'commandStarted':
				markCommandStarted(message.name);
				break;
		}
	});

	/**
	 * @param {{ name: string; commands: { name: string; command: string; type: string; group: string; cwd?: string }[] }[]} groups
	 */
	function renderGroups(groups) {
		if (!container) return;

		if (!groups || groups.length === 0) {
			container.innerHTML = '<p class="empty-message">No commands found. Create a commands.json in your workspace root or add scripts to package.json.</p>';
			return;
		}

		container.innerHTML = '';

		for (const group of groups) {
			const groupEl = document.createElement('div');
			groupEl.className = 'command-group';

			const header = document.createElement('div');
			header.className = 'group-header';
			header.innerHTML = `<span class="group-chevron">&#x25BC;</span><span class="group-name">${escapeHtml(group.name)}</span>`;

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

				// Type badge (only for non-terminal types)
				if (cmd.type !== 'terminal') {
					const badge = document.createElement('span');
					badge.className = 'cmd-badge';
					badge.textContent = cmd.type;
					item.appendChild(badge);
				}

				item.addEventListener('click', () => {
					vscode.postMessage({
						type: 'runCommand',
						name: cmd.name,
						command: cmd.command,
						shellType: cmd.type,
						cwd: cmd.cwd,
					});
				});

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
	 * @param {string} text
	 * @returns {string}
	 */
	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	// Signal to extension that webview JS is ready to receive messages
	vscode.postMessage({ type: 'ready' });
})();
