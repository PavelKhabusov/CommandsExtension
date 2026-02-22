// @ts-check

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	const container = document.getElementById('commands-container');
	const refreshBtn = document.getElementById('refresh-btn');

	if (refreshBtn) {
		refreshBtn.addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh' });
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
				const btn = document.createElement('button');
				btn.className = 'cmd-btn';
				btn.dataset.name = cmd.name;
				btn.title = cmd.command;

				const nameSpan = document.createElement('span');
				nameSpan.textContent = cmd.name;
				btn.appendChild(nameSpan);

				if (cmd.type !== 'terminal') {
					const badge = document.createElement('span');
					badge.className = 'badge';
					badge.textContent = cmd.type;
					btn.appendChild(badge);
				}

				btn.addEventListener('click', () => {
					vscode.postMessage({
						type: 'runCommand',
						name: cmd.name,
						command: cmd.command,
						shellType: cmd.type,
						cwd: cmd.cwd,
					});
				});
				commandsEl.appendChild(btn);
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
		const buttons = container.querySelectorAll('.cmd-btn');
		for (const btn of buttons) {
			if (btn instanceof HTMLElement && btn.dataset.name === name) {
				btn.classList.add('running');
				setTimeout(() => btn.classList.remove('running'), 2000);
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

	// Request initial data
	vscode.postMessage({ type: 'refresh' });
})();
