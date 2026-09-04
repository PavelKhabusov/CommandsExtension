// @ts-check
(function () {
	const vscode = acquireVsCodeApi();

	const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('sql-input'));
	const highlightLayer = /** @type {HTMLElement} */ (document.getElementById('sql-highlight'));
	const output = /** @type {HTMLElement} */ (document.getElementById('sql-output'));
	const runBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-run'));
	const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-clear'));
	const serverSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('sql-server'));

	const exportBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-export-run'));
	const exportOut = /** @type {HTMLElement} */ (document.getElementById('sql-export-output'));
	const toggleSchema = /** @type {HTMLButtonElement} */ (document.getElementById('sql-toggle-schema'));
	const toggleData = /** @type {HTMLButtonElement} */ (document.getElementById('sql-toggle-data'));
	const destPath = /** @type {HTMLElement} */ (document.getElementById('sql-dest-path'));
	const destPick = /** @type {HTMLButtonElement} */ (document.getElementById('sql-dest-pick'));

	const tableSel = /** @type {HTMLSelectElement} */ (document.getElementById('sql-table'));
	const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('sql-search'));
	const searchBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-search-run'));
	const browseOut = /** @type {HTMLElement} */ (document.getElementById('sql-browse-output'));
	const pager = /** @type {HTMLElement} */ (document.getElementById('sql-pager'));
	const pagerInfo = /** @type {HTMLElement} */ (document.getElementById('sql-pager-info'));
	const prevBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-prev'));
	const nextBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-next'));
	const firstBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-first'));
	const lastBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sql-last'));
	const pageInput = /** @type {HTMLInputElement} */ (document.getElementById('sql-page'));
	const pagesLabel = /** @type {HTMLElement} */ (document.getElementById('sql-pages'));
	const limitSel = /** @type {HTMLSelectElement} */ (document.getElementById('sql-limit'));

	let requestId = 0;
	let pending = 0;
	let exporting = false;

	const saved = vscode.getState() || {};
	// A query preset into the markup (Run SQL File) wins over the saved one.
	const hasPreset = input.hasAttribute('data-preset');
	if (!hasPreset && typeof saved.sql === 'string') input.value = saved.sql;
	if (saved.server && serverSel) serverSel.value = saved.server;
	if (saved.tab) selectTab(saved.tab);
	if (saved.limit) limitSel.value = saved.limit;
	// At least one of the two must stay on, so an empty pair means "both".
	if (saved.includeSchema === false || saved.includeData === false) {
		setToggle(toggleSchema, saved.includeSchema !== false);
		setToggle(toggleData, saved.includeData !== false);
	}

	function persist() {
		vscode.setState({
			sql: input.value,
			server: serverSel ? serverSel.value : undefined,
			includeSchema: isOn(toggleSchema),
			includeData: isOn(toggleData),
			table: tableSel.value,
			limit: limitSel.value,
			tab: currentTab(),
		});
	}

	function currentServer() {
		return serverSel ? serverSel.value : undefined;
	}

	function escapeHtml(value) {
		return String(value).replace(/[&<>"]/g, (c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
		);
	}

	/** Sub-second timings stay in ms; anything longer reads better in seconds. */
	function formatDuration(ms) {
		if (ms < 1000) return ms + ' ms';
		if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
		const m = Math.floor(ms / 60000);
		return m + 'm ' + Math.round((ms % 60000) / 1000) + 's';
	}

	// ---- syntax highlight ---------------------------------------------------

	// A textarea cannot render styled text, so a <pre> underneath it holds the
	// coloured copy and the textarea itself is transparent. Typing, selection,
	// undo and IME all stay native.

	const KEYWORDS = ('SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TRUNCATE|TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|PROCEDURE|FUNCTION|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|USING|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|ASC|DESC|CASE|WHEN|THEN|ELSE|END|IF|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DEFAULT|AUTO_INCREMENT|ENGINE|CHARSET|COLLATE|CONSTRAINT|MODIFY|CHANGE|RENAME|TO|REPLACE|IGNORE|DUPLICATE|SHOW|DESCRIBE|EXPLAIN|USE|START|BEGIN|COMMIT|ROLLBACK|TRANSACTION|LOCK|UNLOCK|GRANT|REVOKE|WITH|RECURSIVE|OVER|PARTITION|WINDOW').split('|');

	const FUNCS = ('COUNT|SUM|AVG|MIN|MAX|CONCAT|CONCAT_WS|SUBSTRING|SUBSTR|LENGTH|CHAR_LENGTH|UPPER|LOWER|TRIM|LTRIM|RTRIM|REPLACE|COALESCE|IFNULL|NULLIF|CAST|CONVERT|DATE|NOW|CURDATE|CURTIME|UNIX_TIMESTAMP|FROM_UNIXTIME|DATE_FORMAT|DATE_ADD|DATE_SUB|DATEDIFF|YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|ROUND|FLOOR|CEIL|CEILING|ABS|MOD|RAND|GROUP_CONCAT|JSON_EXTRACT|JSON_UNQUOTE|ROW_NUMBER|RANK|DENSE_RANK').split('|');

	const TYPES = ('INT|INTEGER|TINYINT|SMALLINT|MEDIUMINT|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|BIT|BOOL|BOOLEAN|CHAR|VARCHAR|BINARY|VARBINARY|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|ENUM|DATETIME|TIMESTAMP|TIME|JSON|UNSIGNED|SIGNED|ZEROFILL').split('|');

	const KEYWORD_RE = new RegExp('^(?:' + KEYWORDS.join('|') + ')$', 'i');
	const FUNC_RE = new RegExp('^(?:' + FUNCS.join('|') + ')$', 'i');
	const TYPE_RE = new RegExp('^(?:' + TYPES.join('|') + ')$', 'i');

	// Order matters: comments and strings win over everything inside them.
	const TOKEN_RE = new RegExp([
		'(--[^\\n]*|#[^\\n]*|/\\*[\\s\\S]*?\\*/)',        // 1 comment
		"('(?:\\\\.|[^'\\\\])*'|\"(?:\\\\.|[^\"\\\\])*\")", // 2 string
		'(`[^`]*`)',                                      // 3 identifier
		'(\\b\\d+(?:\\.\\d+)?\\b)',                        // 4 number
		'([A-Za-z_][A-Za-z0-9_$]*)',                      // 5 word
		'([(),;=<>!+\\-*/%|&]+)',                          // 6 operator
	].join('|'), 'g');

	function highlight(text) {
		let out = '';
		let last = 0;
		TOKEN_RE.lastIndex = 0;
		let m;
		while ((m = TOKEN_RE.exec(text)) !== null) {
			out += escapeHtml(text.slice(last, m.index));
			last = TOKEN_RE.lastIndex;
			const raw = m[0];
			let cls = '';
			if (m[1]) cls = 'tok-comment';
			else if (m[2]) cls = 'tok-string';
			else if (m[3]) cls = 'tok-ident';
			else if (m[4]) cls = 'tok-number';
			else if (m[5]) {
				if (KEYWORD_RE.test(raw)) cls = 'tok-keyword';
				else if (FUNC_RE.test(raw)) cls = 'tok-func';
				else if (TYPE_RE.test(raw)) cls = 'tok-type';
			} else if (m[6]) cls = 'tok-op';
			out += cls ? '<span class="' + cls + '">' + escapeHtml(raw) + '</span>' : escapeHtml(raw);
		}
		out += escapeHtml(text.slice(last));
		return out;
	}

	function paintHighlight() {
		// The trailing newline keeps the last line visible while scrolling.
		highlightLayer.innerHTML = highlight(input.value) + '\n';
		highlightLayer.scrollTop = input.scrollTop;
		highlightLayer.scrollLeft = input.scrollLeft;
	}

	input.addEventListener('input', paintHighlight);
	input.addEventListener('scroll', () => {
		highlightLayer.scrollTop = input.scrollTop;
		highlightLayer.scrollLeft = input.scrollLeft;
	});

	// ---- tabs ---------------------------------------------------------------

	function currentTab() {
		const active = document.querySelector('.sql-tab.active');
		return active ? active.getAttribute('data-tab') : 'query';
	}

	function selectTab(name) {
		document.querySelectorAll('.sql-tab').forEach((el) => {
			el.classList.toggle('active', el.getAttribute('data-tab') === name);
		});
		document.querySelectorAll('.sql-pane').forEach((el) => {
			const match = el.getAttribute('data-pane') === name;
			/** @type {HTMLElement} */ (el).hidden = !match;
		});
	}

	document.querySelectorAll('.sql-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			selectTab(tab.getAttribute('data-tab'));
			persist();
		});
	});

	// ---- query --------------------------------------------------------------

	function run() {
		// Running a selection mirrors phpMyAdmin: highlight a fragment to run it alone.
		const selection = input.value.slice(input.selectionStart, input.selectionEnd).trim();
		const sql = selection || input.value.trim();
		if (!sql) return;

		persist();
		pending = ++requestId;
		runBtn.disabled = true;
		output.innerHTML = '<div class="sql-meta">Running…</div>';
		vscode.postMessage({ type: 'query', sql, server: currentServer(), requestId: pending });
	}

	// Result sets of the last run, kept so the copy buttons can rebuild text
	// without scraping the DOM.
	let lastSets = [];
	let lastError = null;

	/**
	 * Renders one result set as a markdown table — the shape that pastes
	 * usefully into a chat or an issue.
	 */
	function setToText(set) {
		const head = '| ' + set.columns.join(' | ') + ' |';
		const rule = '| ' + set.columns.map(() => '---').join(' | ') + ' |';
		const body = set.rows.map((row) =>
			'| ' + row.map((c) => (c === null ? 'NULL' : String(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))).join(' | ') + ' |'
		);
		return [head, rule].concat(body).join('\n');
	}

	function allResultsToText() {
		if (lastError) return 'Error: ' + lastError;
		if (!lastSets.length) return 'Statement executed, no rows returned.';
		return lastSets
			.map((set, i) =>
				(lastSets.length > 1 ? 'Result ' + (i + 1) + ' — ' + set.rows.length + ' row(s)\n' : '') + setToText(set)
			)
			.join('\n\n');
	}

	function copyText(text, button) {
		const done = () => {
			if (!button) return;
			const original = button.textContent;
			button.textContent = 'Copied';
			button.classList.add('copied');
			setTimeout(() => {
				button.textContent = original;
				button.classList.remove('copied');
			}, 1200);
		};
		// The webview clipboard API needs focus; fall back to a hidden textarea.
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
		} else {
			fallbackCopy(text, done);
		}
	}

	function fallbackCopy(text, done) {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand('copy'); done(); } catch (e) { /* nothing else to try */ }
		document.body.removeChild(ta);
	}

	function makeCopyBtn(label, title, getText) {
		const btn = document.createElement('button');
		btn.className = 'sql-copy';
		btn.textContent = label;
		btn.title = title;
		btn.addEventListener('click', () => copyText(getText(), btn));
		return btn;
	}

	function renderResult(msg) {
		lastSets = [];
		lastError = null;
		output.innerHTML = '';

		if (!msg.ok) {
			lastError = msg.error || 'Query failed.';
			const box = document.createElement('div');
			box.className = 'sql-msg sql-error';
			box.textContent = lastError;
			const bar = document.createElement('div');
			bar.className = 'sql-actions';
			bar.appendChild(makeCopyBtn('Copy error', 'Copy the error message', () => lastError));
			output.appendChild(box);
			output.appendChild(bar);
			return;
		}

		if (msg.warnings) {
			const warn = document.createElement('div');
			warn.className = 'sql-msg sql-warn';
			warn.textContent = msg.warnings;
			output.appendChild(warn);
		}

		const sets = (msg.sets || []).filter((s) => s.columns && s.columns.length);
		lastSets = sets;

		if (!sets.length) {
			const ok = document.createElement('div');
			ok.className = 'sql-msg sql-ok';
			ok.textContent = 'Statement executed, no rows returned. ' + formatDuration(msg.ms);
			output.appendChild(ok);
			return;
		}

		// One "copy everything" action when a batch produced several tables.
		if (sets.length > 1) {
			const bar = document.createElement('div');
			bar.className = 'sql-actions';
			bar.appendChild(
				makeCopyBtn('Copy all results', 'Copy every result table as markdown', allResultsToText)
			);
			output.appendChild(bar);
		}

		sets.forEach((set, i) => {
			const meta = document.createElement('div');
			meta.className = 'sql-meta sql-set-head';

			const label = document.createElement('span');
			label.textContent =
				(sets.length > 1 ? 'Result ' + (i + 1) + ' · ' : '') + set.rows.length + ' row(s) · ' + formatDuration(msg.ms);
			meta.appendChild(label);

			meta.appendChild(makeCopyBtn('Copy', 'Copy this table as markdown', () => setToText(set)));
			output.appendChild(meta);

			const wrap = document.createElement('div');
			wrap.className = 'sql-table-wrap';
			const html = ['<table><thead><tr>'];
			set.columns.forEach((c) => html.push('<th>' + escapeHtml(c) + '</th>'));
			html.push('</tr></thead><tbody>');
			set.rows.forEach((row) => {
				html.push('<tr>');
				row.forEach((cell) => {
					html.push(cell === null
						? '<td class="sql-null">NULL</td>'
						: '<td>' + escapeHtml(cell) + '</td>');
				});
				html.push('</tr>');
			});
			html.push('</tbody></table>');
			wrap.innerHTML = html.join('');
			output.appendChild(wrap);
		});
	}

	runBtn.addEventListener('click', run);

	clearBtn.addEventListener('click', () => {
		input.value = '';
		paintHighlight();
		persist();
		output.innerHTML = '<div class="sql-empty">Enter a query and press Run.</div>';
		input.focus();
	});

	input.addEventListener('input', persist);
	if (serverSel) serverSel.addEventListener('change', persist);

	input.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			run();
			return;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			const start = input.selectionStart;
			input.value = input.value.slice(0, start) + '  ' + input.value.slice(input.selectionEnd);
			input.selectionStart = input.selectionEnd = start + 2;
			paintHighlight();
			persist();
		}
	});

	// ---- browse -------------------------------------------------------------

	let browseOffset = 0;
	let browseTotal = 0;
	let browseReq = 0;
	let browseSort = null; // {column, direction}

	function pageSize() {
		return parseInt(limitSel.value, 10) || 25;
	}

	function loadTables() {
		vscode.postMessage({ type: 'listTables' });
	}

	function requestPage(offset) {
		const table = tableSel.value;
		if (!table) return;
		browseOffset = Math.max(0, offset);
		browseReq++;
		browseOut.innerHTML = '<div class="sql-meta">Loading…</div>';
		vscode.postMessage({
			type: 'browse',
			table,
			offset: browseOffset,
			limit: pageSize(),
			search: searchInput.value.trim(),
			sort: browseSort,
			server: currentServer(),
			requestId: browseReq,
		});
	}

	function renderBrowse(msg) {
		if (msg.requestId !== browseReq) return;

		if (!msg.ok) {
			browseOut.innerHTML = '';
			const box = document.createElement('div');
			box.className = 'sql-msg sql-error';
			box.textContent = msg.error || 'Could not read the table.';
			browseOut.appendChild(box);
			pager.hidden = true;
			return;
		}

		browseTotal = msg.total || 0;
		browseOut.innerHTML = '';

		if (!msg.rows.length) {
			const empty = document.createElement('div');
			empty.className = 'sql-empty';
			empty.textContent = searchInput.value.trim()
				? 'Nothing matches that search.'
				: 'This table is empty.';
			browseOut.appendChild(empty);
			pager.hidden = true;
			return;
		}

		const head = document.createElement('div');
		head.className = 'sql-meta sql-set-head';
		const label = document.createElement('span');
		label.textContent = browseTotal + ' row(s)' + (searchInput.value.trim() ? ' matching' : ' in table');
		head.appendChild(label);
		head.appendChild(makeCopyBtn('Copy page', 'Copy this page as markdown', () =>
			setToText({ columns: msg.columns, rows: msg.rows })
		));
		browseOut.appendChild(head);

		const wrap = document.createElement('div');
		wrap.className = 'sql-table-wrap';
		const html = ['<table><thead><tr>'];
		msg.columns.forEach((c) => {
			// Clicking a header sorts by it; clicking the sorted one flips direction.
			const active = browseSort && browseSort.column === c;
			const arrow = active ? (browseSort.direction === 'asc' ? ' ▲' : ' ▼') : '';
			html.push(
				'<th class="sql-sortable' + (active ? ' sorted' : '') + '" data-col="' + escapeHtml(c) + '">' +
				escapeHtml(c) + '<span class="sql-arrow">' + arrow + '</span></th>'
			);
		});
		html.push('</tr></thead><tbody>');
		msg.rows.forEach((row) => {
			html.push('<tr>');
			row.forEach((cell) => {
				html.push(cell === null
					? '<td class="sql-null">NULL</td>'
					: '<td>' + escapeHtml(cell) + '</td>');
			});
			html.push('</tr>');
		});
		html.push('</tbody></table>');
		wrap.innerHTML = html.join('');
		browseOut.appendChild(wrap);

		wrap.querySelectorAll('th.sql-sortable').forEach((th) => {
			th.addEventListener('click', () => {
				const col = th.getAttribute('data-col');
				browseSort = browseSort && browseSort.column === col
					? { column: col, direction: browseSort.direction === 'asc' ? 'desc' : 'asc' }
					: { column: col, direction: 'asc' };
				requestPage(0);
			});
		});

		updatePager(msg.rows.length);
	}

	function updatePager(rowsOnPage) {
		const size = pageSize();
		const pages = Math.max(1, Math.ceil(browseTotal / size));
		const current = Math.floor(browseOffset / size) + 1;
		const from = browseOffset + 1;
		const to = Math.min(browseOffset + rowsOnPage, browseTotal);

		pageInput.value = String(current);
		pageInput.max = String(pages);
		pagesLabel.textContent = String(pages);
		pagerInfo.textContent = from + '–' + to + ' of ' + browseTotal;

		firstBtn.disabled = prevBtn.disabled = current <= 1;
		nextBtn.disabled = lastBtn.disabled = current >= pages;
		pager.hidden = false;
	}

	function gotoPage(n) {
		const size = pageSize();
		const pages = Math.max(1, Math.ceil(browseTotal / size));
		const clamped = Math.min(Math.max(1, n), pages);
		requestPage((clamped - 1) * size);
	}

	tableSel.addEventListener('change', () => {
		searchInput.value = '';
		browseSort = null; // a new table has different columns
		requestPage(0);
		persist();
	});

	searchBtn.addEventListener('click', () => requestPage(0));
	searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); requestPage(0); }
	});

	limitSel.addEventListener('change', () => { requestPage(0); persist(); });

	firstBtn.addEventListener('click', () => gotoPage(1));
	prevBtn.addEventListener('click', () => requestPage(browseOffset - pageSize()));
	nextBtn.addEventListener('click', () => requestPage(browseOffset + pageSize()));
	lastBtn.addEventListener('click', () => gotoPage(Math.ceil(browseTotal / pageSize())));

	pageInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); gotoPage(parseInt(pageInput.value, 10) || 1); }
	});
	pageInput.addEventListener('change', () => gotoPage(parseInt(pageInput.value, 10) || 1));

	// ---- export -------------------------------------------------------------

	function isOn(btn) {
		return btn.classList.contains('active');
	}

	function setToggle(btn, on) {
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-pressed', String(on));
	}

	/** Schema + data = full; turning one off narrows the dump. */
	function currentMode() {
		if (isOn(toggleSchema) && isOn(toggleData)) return 'full';
		return isOn(toggleSchema) ? 'schema' : 'data';
	}

	// The pair is exclusive-or-both: switching one off forces the other on, so
	// there is never an empty dump to ask for.
	[[toggleSchema, toggleData], [toggleData, toggleSchema]].forEach(([btn, other]) => {
		btn.addEventListener('click', () => {
			if (isOn(btn) && !isOn(other)) {
				// Turning off the only active one would select nothing; swap instead.
				setToggle(btn, false);
				setToggle(other, true);
			} else {
				setToggle(btn, !isOn(btn));
			}
			persist();
		});
	});

	function setExportBusy(busy) {
		exporting = busy;
		exportBtn.disabled = busy;
		exportBtn.textContent = busy ? 'Exporting…' : 'Export';
	}

	destPick.addEventListener('click', () => {
		vscode.postMessage({ type: 'pickExportDir' });
	});

	exportBtn.addEventListener('click', () => {
		if (exporting) return;
		persist();
		setExportBusy(true);
		exportOut.innerHTML = '<div class="sql-meta">Connecting…</div>';
		vscode.postMessage({ type: 'export', mode: currentMode(), server: currentServer() });
	});

	function renderExportProgress(msg) {
		const parts = [];
		if (msg.stage) parts.push(escapeHtml(msg.stage));
		if (msg.bytes) parts.push(formatBytes(msg.bytes) + ' received');
		if (msg.seconds) parts.push(formatDuration(msg.seconds * 1000));
		exportOut.innerHTML = '<div class="sql-meta">' + parts.join(' &middot; ') + '</div>';
	}

	function renderExportDone(msg) {
		setExportBusy(false);
		exportOut.innerHTML = '';

		if (!msg.ok) {
			const box = document.createElement('div');
			box.className = 'sql-msg sql-error';
			box.textContent = msg.error || 'Export failed.';
			exportOut.appendChild(box);
			return;
		}

		const rows = [
			['File', msg.file],
			['Size', formatBytes(msg.bytes)],
			['Duration', formatDuration(msg.seconds * 1000)],
			['Tables', String(msg.tables)],
		];
		if (msg.primaryKeys !== undefined) {
			rows.push(['Tables with PRIMARY KEY', msg.primaryKeys + ' of ' + msg.tables]);
		}

		const ok = document.createElement('div');
		ok.className = 'sql-msg sql-ok';
		ok.textContent = 'Export finished.';
		exportOut.appendChild(ok);

		const bar = document.createElement('div');
		bar.className = 'sql-actions';
		bar.appendChild(makeCopyBtn('Copy summary', 'Copy the export summary', () =>
			rows.map(([k, v]) => k + ': ' + v).join('\n') + (msg.warning ? '\n\nWarning: ' + msg.warning : '')
		));
		exportOut.appendChild(bar);

		const wrap = document.createElement('div');
		wrap.className = 'sql-table-wrap';
		const html = ['<table><tbody>'];
		rows.forEach(([k, v]) => {
			html.push('<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>');
		});
		html.push('</tbody></table>');
		wrap.innerHTML = html.join('');
		exportOut.appendChild(wrap);

		if (msg.warning) {
			const warn = document.createElement('div');
			warn.className = 'sql-msg sql-warn';
			warn.textContent = msg.warning;
			exportOut.appendChild(warn);
		}
	}

	function formatBytes(n) {
		if (!n) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB'];
		let i = 0;
		let v = n;
		while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
		return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
	}

	function selectCellText(cell) {
		const range = document.createRange();
		range.selectNodeContents(cell);
		const sel = window.getSelection();
		if (!sel) return;
		sel.removeAllRanges();
		sel.addRange(range);
	}

	// Delegated once, so these cover every table rendered later.
	[output, exportOut].forEach((container) => {
		let clickTimer = null;

		// Single click expands a truncated value; clicking again collapses it.
		// Deferred, so a double click doesn't toggle before selecting.
		container.addEventListener('click', (e) => {
			const cell = /** @type {HTMLElement} */ (e.target).closest('td');
			if (!cell || !container.contains(cell)) return;
			// Don't fight a text selection the user is making.
			if (String(window.getSelection() || '').length) return;
			clearTimeout(clickTimer);
			clickTimer = setTimeout(() => cell.classList.toggle('expanded'), 180);
		});

		// Double click selects the whole value instead of the word under the
		// cursor, so a serialized blob can be grabbed in one go.
		container.addEventListener('dblclick', (e) => {
			const cell = /** @type {HTMLElement} */ (e.target).closest('td');
			if (!cell || !container.contains(cell)) return;
			clearTimeout(clickTimer);
			e.preventDefault();
			cell.classList.add('expanded');
			selectCellText(cell);
		});
	});

	// Ctrl/Cmd+C over a result table copies the selection — or, with nothing
	// selected, the cell under the pointer. The textarea keeps native handling.
	let hoveredCell = null;
	[output, exportOut].forEach((container) => {
		container.addEventListener('mouseover', (e) => {
			const cell = /** @type {HTMLElement} */ (e.target).closest('td');
			hoveredCell = cell && container.contains(cell) ? cell : null;
		});
		container.addEventListener('mouseleave', () => { hoveredCell = null; });
	});

	document.addEventListener('keydown', (e) => {
		if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
		if (document.activeElement === input) return;

		const selected = String(window.getSelection() || '');
		if (selected) {
			copyText(selected, null);
			e.preventDefault();
			return;
		}
		if (hoveredCell) {
			copyText(hoveredCell.textContent || '', null);
			e.preventDefault();
		}
	});

	// ---- messages -----------------------------------------------------------

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg) return;

		if (msg.type === 'result') {
			if (msg.requestId !== pending) return;
			runBtn.disabled = false;
			renderResult(msg);
			return;
		}
		if (msg.type === 'setQuery') {
			input.value = msg.sql || '';
			paintHighlight();
			selectTab('query');
			persist();
			input.focus();
			input.setSelectionRange(0, 0);
			output.innerHTML = '<div class="sql-empty">Press Run to execute.</div>';
			return;
		}
		if (msg.type === 'tables') {
			if (!msg.ok) {
				tableSel.innerHTML = '<option value="">Could not list tables</option>';
				return;
			}
			const wanted = saved.table || '';
			tableSel.innerHTML = '<option value="">Select a table…</option>' +
				msg.tables.map((t) =>
					'<option value="' + escapeHtml(t.name) + '">' +
					escapeHtml(t.name) + ' (~' + t.rows + ')</option>'
				).join('');
			if (wanted && msg.tables.some((t) => t.name === wanted)) {
				tableSel.value = wanted;
				requestPage(0);
			}
			return;
		}
		if (msg.type === 'browseResult') {
			renderBrowse(msg);
			return;
		}
		if (msg.type === 'exportDir') {
			destPath.textContent = msg.dir || "Not set — you'll be asked once";
			destPath.title = msg.dir || 'Folder where dumps are written';
			destPath.classList.toggle('sql-dest-empty', !msg.dir);
			return;
		}
		if (msg.type === 'exportProgress') {
			renderExportProgress(msg);
			return;
		}
		if (msg.type === 'exportDone') {
			renderExportDone(msg);
		}
	});

	paintHighlight();
	loadTables();
	input.focus();
})();
