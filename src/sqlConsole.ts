import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { spawn } from 'child_process';
import { ServerDefinition, ServerSqlConfig } from './uploadsTypes';

/**
 * SQL console: a Webview panel that runs queries against a remote MySQL
 * database over SSH, using the developer's own SSH key. Nothing is executed
 * locally and no database password is stored in the workspace — credentials
 * are read on the server from a PHP config file, or provided in the server's
 * `sql` block.
 */

const MARK = '__CE_SET__';

export interface SqlTarget {
  serverName: string;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  config: ServerSqlConfig;
}

export function getSqlTarget(server: ServerDefinition): SqlTarget | null {
  const cfg = server.sql;
  // No button unless the database is fully configured.
  if (!cfg?.database || !cfg.dbUser || !cfg.dbPassword) return null;
  const sshHost = cfg.sshHost || server.host;
  const sshUser = cfg.sshUser || server.user;
  if (!sshHost || !sshUser) return null;
  return {
    serverName: server.name,
    sshHost,
    sshUser,
    sshPort: cfg.sshPort ?? 22,
    config: cfg,
  };
}

/** Shell-quotes a value for safe interpolation into the remote script. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Splits a script into statements, ignoring semicolons inside strings,
 * identifiers and comments. Each statement is run separately so result sets
 * stay distinct and an error points at the statement that caused it.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];

    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`') { cur += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === `'` || c === '"' || c === '`') { quote = c; cur += c; i++; continue; }
    if ((c === '-' && n === '-') || c === '#') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? sql.length : e + 2;
      cur += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Without `--raw`, the mysql client escapes newlines and tabs inside values,
 * so one database row always stays on one output line. This turns those
 * escapes back into real characters.
 */
function unescapeCell(v: string): string | null {
  if (v === '\\N') return null;
  return v.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case '\\': return '\\';
      default: return c;
    }
  });
}

export interface ResultSet {
  columns: string[];
  rows: (string | null)[][];
}

function parseBatchOutput(raw: string): ResultSet[] {
  // The separator arrives as its own little result set (header line plus value),
  // so drop those two lines along with the split.
  return raw
    .split(new RegExp(`^${MARK}\\n${MARK}\\n?`, 'm'))
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.length > 0 && l !== MARK);
      if (!lines.length) return null;
      const rows = lines.map((l) => l.split('\t').map(unescapeCell));
      return {
        columns: (rows[0] as string[]).map((c) => c ?? ''),
        rows: rows.slice(1),
      };
    })
    .filter((s): s is ResultSet => s !== null);
}

/**
 * Builds the script executed on the server.
 *
 * The whole batch goes through a single mysql session: session state — user
 * variables, PREPARE/EXECUTE, temporary tables, transactions — must survive
 * from one statement to the next, which running each statement in its own
 * connection would silently break. Result sets are told apart by a marker
 * selected between statements.
 */
function buildRemoteScript(target: SqlTarget, statements: string[]): string {
  const cfg = target.config;
  const credentials = [
    `DB=${sq(cfg.database)}`,
    `USER=${sq(cfg.dbUser)}`,
    `PW=${sq(cfg.dbPassword)}`,
    `HOST=${sq(cfg.dbHost ?? 'localhost')}`,
  ].join('\n');

  const script = statements
    .map((stmt, i) => (i > 0 ? `SELECT '${MARK}' AS \`${MARK}\`;\n${stmt};` : `${stmt};`))
    .join('\n');

  return `set -uo pipefail
${credentials}
MYSQL_PWD="$PW" mysql -h "$HOST" -u "$USER" --default-character-set=utf8mb4 \\
  --batch --show-warnings "$DB" <<'CE_SQL_EOF'
${script}
CE_SQL_EOF
`;
}

export interface QueryOutcome {
  ok: boolean;
  sets?: ResultSet[];
  warnings?: string | null;
  error?: string;
  ms: number;
}

const SSH_NOISE =
  /post-quantum|store now, decrypt later|may need to be upgraded|^\*\*|Welcome to|Using a password|^Warning: Permanently added/;

export function runQuery(target: SqlTarget, sql: string): Promise<QueryOutcome> {
  const statements = splitStatements(sql);
  if (!statements.length) {
    return Promise.resolve({ ok: false, error: 'Empty query.', ms: 0 });
  }

  const script = buildRemoteScript(target, statements);
  const args = [
    '-p', String(target.sshPort),
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-T',
    `${target.sshUser}@${target.sshHost}`,
    'bash -s',
  ];

  return new Promise((resolve) => {
    const started = Date.now();
    const ssh = spawn('ssh', args);
    let out = '';
    let err = '';

    ssh.stdout.on('data', (d) => { out += d.toString(); });
    ssh.stderr.on('data', (d) => { err += d.toString(); });

    ssh.on('error', (e) =>
      resolve({ ok: false, error: `Could not start ssh: ${e.message}`, ms: Date.now() - started })
    );

    ssh.on('close', (code) => {
      const ms = Date.now() - started;
      const message = err
        .split('\n')
        .filter((l) => l.trim() && !SSH_NOISE.test(l))
        .join('\n');

      if (code !== 0) {
        resolve({
          ok: false,
          error: message || `Query failed (exit code ${code}).`,
          ms,
        });
        return;
      }
      resolve({ ok: true, sets: parseBatchOutput(out), warnings: message || null, ms });
    });

    ssh.stdin.write(script);
    ssh.stdin.end();
  });
}

/** Verifies the SSH connection and reports which database would be used. */
export function probeConnection(target: SqlTarget): Promise<QueryOutcome> {
  return runQuery(target, 'SELECT DATABASE() AS `database`, VERSION() AS `version`');
}

export type ExportMode = 'full' | 'schema' | 'data';

export interface ExportProgress {
  stage: string;
  bytes?: number;
  seconds?: number;
}

export interface ExportResult {
  ok: boolean;
  file?: string;
  bytes?: number;
  seconds?: number;
  tables?: number;
  primaryKeys?: number;
  warning?: string;
  error?: string;
}

/**
 * Dumps the database over SSH. mysqldump and gzip both run on the server, so
 * only compressed bytes travel over the network — the whole reason this is not
 * done with a local client.
 */
export function runExport(
  target: SqlTarget,
  mode: ExportMode,
  destination: string,
  onProgress: (p: ExportProgress) => void
): Promise<ExportResult> {
  const cfg = target.config;
  const flags = [
    '--single-transaction',
    '--quick',
    '--default-character-set=utf8mb4',
    '--routines',
    '--events',
    '--triggers',
    // Shared hosting accounts lack the PROCESS privilege this would need.
    '--no-tablespaces',
  ];
  if (mode === 'schema') flags.push('--no-data');
  if (mode === 'data') flags.push('--no-create-info');

  const script = `set -uo pipefail
MYSQL_PWD=${sq(cfg.dbPassword)} mysqldump -h ${sq(cfg.dbHost ?? 'localhost')} -u ${sq(cfg.dbUser)} \\
  ${flags.join(' ')} ${sq(cfg.database)} | gzip -1
`;

  const args = [
    '-p', String(target.sshPort),
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', 'BatchMode=yes',
    '-o', 'LogLevel=ERROR',
    '-T',
    `${target.sshUser}@${target.sshHost}`,
    'bash -s',
  ];

  return new Promise((resolve) => {
    const started = Date.now();
    const out = fs.createWriteStream(destination);
    const ssh = spawn('ssh', args);
    let bytes = 0;
    let err = '';
    let lastReport = 0;

    onProgress({ stage: 'Connecting' });

    ssh.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      const now = Date.now();
      if (now - lastReport > 400) {
        lastReport = now;
        onProgress({
          stage: 'Downloading',
          bytes,
          seconds: Math.round((now - started) / 1000),
        });
      }
    });

    ssh.stdout.pipe(out);
    ssh.stderr.on('data', (d) => { err += d.toString(); });

    ssh.on('error', (e) => {
      out.destroy();
      resolve({ ok: false, error: `Could not start ssh: ${e.message}` });
    });

    ssh.on('close', (code) => {
      out.end(async () => {
        const seconds = Math.round((Date.now() - started) / 1000);
        const message = err
          .split('\n')
          .filter((l) => l.trim() && !SSH_NOISE.test(l))
          .join('\n');

        if (code !== 0 || bytes === 0) {
          fs.promises.unlink(destination).catch(() => undefined);
          resolve({ ok: false, error: message || `Dump failed (exit code ${code}).` });
          return;
        }

        onProgress({ stage: 'Verifying', bytes, seconds });
        try {
          const check = await verifyDump(destination, mode);
          resolve({ ok: true, file: destination, bytes, seconds, ...check });
        } catch (e) {
          resolve({
            ok: true,
            file: destination,
            bytes,
            seconds,
            tables: 0,
            warning: `Could not verify the dump: ${e instanceof Error ? e.message : e}`,
          });
        }
      });
    });

    ssh.stdin.write(script);
    ssh.stdin.end();
  });
}

/**
 * Reads the gzipped dump back to confirm it is complete. A dump that is missing
 * mysqldump's trailing marker was truncated, and one without primary keys
 * restores into a database that silently loses them.
 */
async function verifyDump(
  file: string,
  mode: ExportMode
): Promise<{ tables: number; primaryKeys?: number; warning?: string }> {
  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(file).pipe(gunzip);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let tables = 0;
  let primaryKeys = 0;
  let inTable = false;
  let tableHasPk = false;
  let completed = false;

  for await (const line of rl) {
    if (line.startsWith('CREATE TABLE')) {
      tables++;
      inTable = true;
      tableHasPk = false;
      continue;
    }
    if (inTable) {
      if (line.includes('PRIMARY KEY')) tableHasPk = true;
      if (line.startsWith(') ENGINE') || line.startsWith(');')) {
        if (tableHasPk) primaryKeys++;
        inTable = false;
      }
    }
    if (line.includes('Dump completed')) completed = true;
  }

  if (!completed) {
    return { tables, primaryKeys, warning: 'The dump has no completion marker — it may be truncated.' };
  }
  if (mode === 'data') {
    return { tables };
  }
  if (tables > 0 && primaryKeys < tables) {
    return {
      tables,
      primaryKeys,
      warning: `${tables - primaryKeys} of ${tables} tables have no PRIMARY KEY. Restoring this dump reproduces that.`,
    };
  }
  return { tables, primaryKeys };
}

let openPanel: vscode.WebviewPanel | undefined;

/**
 * Opens the SQL console. All servers that declare an `sql` block are passed in;
 * when there is more than one the panel shows a server switcher.
 */
export function openSqlConsole(
  targets: SqlTarget[],
  context: vscode.ExtensionContext,
  initialSql?: string
): void {
  if (!targets.length) return;

  if (openPanel) {
    openPanel.reveal(vscode.ViewColumn.Active);
    // The panel is already up: hand it the new script instead of a stale one.
    if (initialSql !== undefined) {
      openPanel.webview.postMessage({ type: 'setQuery', sql: initialSql });
    }
    return;
  }

  const extensionUri = context.extensionUri;

  const panel = vscode.window.createWebviewPanel(
    'commandsExtension.sqlConsole',
    'SQL Console',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] }
  );

  openPanel = panel;
  panel.onDidDispose(() => { openPanel = undefined; });

  const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sql.js'));
  const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sql.css'));
  panel.webview.html = renderHtml(panel.webview, scriptUri, styleUri, targets, initialSql);

  panel.webview.onDidReceiveMessage(async (msg) => {
    const target = targets.find((t) => t.serverName === msg?.server) ?? targets[0];

    if (msg?.type === 'query') {
      const result = await runQuery(target, String(msg.sql ?? ''));
      panel.webview.postMessage({ type: 'result', requestId: msg.requestId, ...result });
      return;
    }

    if (msg?.type === 'pickExportDir') {
      const dir = await promptForExportDir(context);
      if (dir) panel.webview.postMessage({ type: 'exportDir', dir });
      return;
    }

    if (msg?.type === 'export') {
      const mode: ExportMode =
        msg.mode === 'schema' || msg.mode === 'data' ? msg.mode : 'full';

      // The folder is asked for once and remembered; dumps land there by name.
      let dir = getExportDir(context);
      if (!dir) {
        dir = await promptForExportDir(context);
        if (!dir) {
          panel.webview.postMessage({ type: 'exportDone', ok: false, error: 'Export cancelled.' });
          return;
        }
        panel.webview.postMessage({ type: 'exportDir', dir });
      }

      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const destination = path.join(dir, `${target.config.database}-${mode}-${stamp}.sql.gz`);

      try {
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (e) {
        panel.webview.postMessage({
          type: 'exportDone',
          ok: false,
          error: `Cannot write to ${dir}: ${e instanceof Error ? e.message : e}`,
        });
        return;
      }

      const result = await runExport(target, mode, destination, (p) =>
        panel.webview.postMessage({ type: 'exportProgress', ...p })
      );
      panel.webview.postMessage({ type: 'exportDone', ...result });
    }
  });

  panel.webview.postMessage({ type: 'exportDir', dir: getExportDir(context) });
}

const EXPORT_DIR_KEY = 'commandsExtension.sqlExportDir';

function getExportDir(context: vscode.ExtensionContext): string | undefined {
  return context.workspaceState.get<string>(EXPORT_DIR_KEY);
}

/** Asks for the folder dumps are written to and remembers it per workspace. */
async function promptForExportDir(context: vscode.ExtensionContext): Promise<string | undefined> {
  const current = getExportDir(context);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const start = current ?? root;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: start ? vscode.Uri.file(start) : undefined,
    openLabel: 'Save dumps here',
    title: 'Folder for database dumps',
  });
  const dir = picked?.[0]?.fsPath;
  if (dir) await context.workspaceState.update(EXPORT_DIR_KEY, dir);
  return dir;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderHtml(
  webview: vscode.Webview,
  scriptUri: vscode.Uri,
  styleUri: vscode.Uri,
  targets: SqlTarget[],
  initialSql?: string
): string {
  const n = nonce();

  // A single server needs no switcher — just show what it is.
  const picker = targets.length > 1
    ? `<select id="sql-server" title="Server">${targets
        .map(
          (t) =>
            `<option value="${escapeHtml(t.serverName)}">${escapeHtml(t.serverName)} — ${escapeHtml(
              t.config.database
            )}</option>`
        )
        .join('')}</select>`
    : `<span class="sql-target">${escapeHtml(targets[0].serverName)}</span>
    <span class="sql-source">${escapeHtml(targets[0].config.database)} &middot; ${escapeHtml(
        targets[0].sshUser
      )}@${escapeHtml(targets[0].sshHost)}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>SQL Console</title>
</head>
<body>
  <header id="sql-head">
    <span class="sql-title">SQL Console</span>
    ${picker}
  </header>

  <nav id="sql-tabs">
    <button class="sql-tab active" data-tab="query">Query</button>
    <button class="sql-tab" data-tab="export">Export</button>
  </nav>

  <div class="sql-pane" data-pane="query">
    <div class="sql-editor-wrap">
      <div id="sql-editor">
        <pre id="sql-highlight" aria-hidden="true"></pre>
        <textarea id="sql-input" spellcheck="false" placeholder="SELECT * FROM wp_options LIMIT 10;"${
          initialSql !== undefined ? ' data-preset="1"' : ''
        }>${initialSql !== undefined ? escapeHtml(initialSql) : ''}</textarea>
      </div>
      <div class="sql-bar">
        <button id="sql-run">Run</button>
        <button id="sql-clear" class="sql-secondary">Clear</button>
        <span class="sql-hint">Ctrl+Enter to run &middot; click a cell to expand, double-click to select it &middot; Ctrl+C copies</span>
      </div>
    </div>
    <div id="sql-output"><div class="sql-empty">Enter a query and press Run.</div></div>
  </div>

  <div class="sql-pane" data-pane="export" hidden>
    <div class="sql-editor-wrap">
      <div class="sql-bar">
        <div class="sql-toggles" role="group" aria-label="What to include in the dump">
          <button type="button" class="sql-toggle active" id="sql-toggle-schema" aria-pressed="true">Schema</button>
          <button type="button" class="sql-toggle active" id="sql-toggle-data" aria-pressed="true">Data</button>
        </div>
        <button id="sql-export-run">Export</button>
        <span class="sql-hint">Dump runs on the server and arrives gzipped</span>
      </div>
      <div id="sql-dest-row">
        <span id="sql-dest-label">Save to</span>
        <span id="sql-dest-path" class="sql-dest-empty" title="Folder where dumps are written">Not set &mdash; you'll be asked once</span>
        <button id="sql-dest-pick" class="sql-secondary">Change…</button>
      </div>
    </div>
    <div id="sql-export-output"><div class="sql-empty">Choose what to export and press Export.</div></div>
  </div>

  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
