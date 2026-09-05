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

/**
 * Turns a raw ssh failure into something actionable: the common ones are
 * fixable with a single command, so spell that command out instead of leaving
 * the developer with "Permission denied (publickey,password)".
 */
function explainSshFailure(target: SqlTarget, message: string): string | null {
  const login = `${target.sshUser}@${target.sshHost}`;
  const port = target.sshPort !== 22 ? ` -p ${target.sshPort}` : '';

  if (/Permission denied|Too many authentication failures|no mutual signature/i.test(message)) {
    return [
      `The server refused the key for ${login}.`,
      '',
      'Install your public key there (it asks for the account password once):',
      `  ssh-copy-id${port} ${login}`,
      '',
      'Then check that a plain login works:',
      `  ssh${port} ${login}`,
    ].join('\n');
  }

  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(message)) {
    return [
      `Cannot resolve ${target.sshHost}.`,
      '',
      'Check the host in the server\'s "sql" block (or its sshHost) in server-uploads.local.json.',
    ].join('\n');
  }

  if (/Connection refused|Connection timed out|Operation timed out|No route to host/i.test(message)) {
    return [
      `No SSH service answered on ${target.sshHost}:${target.sshPort}.`,
      '',
      'Enable SSH access for the hosting account, or set "sshPort" if it listens elsewhere.',
      'Verify with:',
      `  ssh${port} ${login}`,
    ].join('\n');
  }

  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) {
    return [
      `The host key for ${target.sshHost} does not match the one already trusted.`,
      '',
      'If the server was legitimately rebuilt, drop the stale entry and connect once to accept the new key:',
      `  ssh-keygen -R ${target.sshHost}`,
      `  ssh${port} ${login}`,
    ].join('\n');
  }

  if (/mysql: (command )?not found|mysqldump: (command )?not found/i.test(message)) {
    return [
      'The MySQL client is missing on the server.',
      '',
      `Check what is available there:  ssh${port} ${login} 'which mysql mysqldump'`,
    ].join('\n');
  }

  if (/Access denied for user/i.test(message)) {
    return [
      'MySQL rejected the database credentials.',
      '',
      'Check "database", "dbUser" and "dbPassword" in the server\'s "sql" block',
      'in server-uploads.local.json — these are the database\'s own credentials,',
      'not the SSH login.',
    ].join('\n');
  }

  return null;
}

/** Appends the actionable hint to a raw failure message, when there is one. */
function withSshHint(target: SqlTarget, message: string, fallback: string): string {
  const raw = message || fallback;
  const hint = explainSshFailure(target, raw);
  return hint ? `${raw}\n\n${hint}` : raw;
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
          error: withSshHint(target, message, `Query failed (exit code ${code}).`),
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

/** Quotes an identifier for SQL: `tbl` → \`tbl\`, backticks doubled. */
function qid(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** Quotes a string literal for SQL, escaping what MySQL treats specially. */
function qlit(value: string): string {
  return `'${String(value).replace(/[\\'"\0\n\r\x1a]/g, (c) => {
    switch (c) {
      case '\\': return '\\\\';
      case `'`: return `\\'`;
      case '"': return '\\"';
      case '\0': return '\\0';
      case '\n': return '\\n';
      case '\r': return '\\r';
      default: return '\\Z';
    }
  })}'`;
}

export interface TableInfo {
  name: string;
  rows: number;
}

/** Lists the database's tables with their approximate row counts. */
export async function listTables(target: SqlTarget): Promise<{ ok: boolean; tables?: TableInfo[]; error?: string }> {
  const r = await runQuery(
    target,
    `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`
  );
  if (!r.ok) return { ok: false, error: r.error };
  const set = r.sets?.[0];
  return {
    ok: true,
    tables: (set?.rows ?? []).map((row) => ({
      name: row[0] ?? '',
      rows: Number(row[1] ?? 0),
    })),
  };
}

export interface BrowsePage {
  ok: boolean;
  columns?: string[];
  rows?: (string | null)[][];
  total?: number;
  offset?: number;
  error?: string;
}

/**
 * Reads one page of a table. A search term filters on the server across every
 * column, so it covers the whole table rather than the rows already fetched.
 */
export async function browseTable(
  target: SqlTarget,
  table: string,
  offset: number,
  limit: number,
  search: string,
  sort?: { column: string; direction: 'asc' | 'desc' }
): Promise<BrowsePage> {
  const cols = await runQuery(
    target,
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${qlit(table)}
     ORDER BY ORDINAL_POSITION`
  );
  if (!cols.ok) return { ok: false, error: cols.error };

  const columns = (cols.sets?.[0]?.rows ?? []).map((r) => r[0] ?? '');
  if (!columns.length) return { ok: false, error: `Table ${table} not found.` };

  // CONVERT(... USING utf8mb4) keeps LIKE working over binary/blob columns.
  const where = search
    ? 'WHERE ' +
      columns
        .map((c) => `CONVERT(${qid(c)} USING utf8mb4) LIKE ${qlit('%' + search + '%')}`)
        .join(' OR ')
    : '';

  // Only a real column name can reach ORDER BY, so a crafted sort cannot
  // inject SQL.
  const orderBy =
    sort && columns.includes(sort.column)
      ? `ORDER BY ${qid(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`
      : '';

  const t = qid(table);
  const r = await runQuery(
    target,
    `SELECT COUNT(*) AS total FROM ${t} ${where};
     SELECT * FROM ${t} ${where} ${orderBy} LIMIT ${Math.max(1, Math.min(500, limit))} OFFSET ${Math.max(0, offset)}`
  );
  if (!r.ok) return { ok: false, error: r.error };

  const totalSet = r.sets?.[0];
  const dataSet = r.sets?.[1];
  return {
    ok: true,
    columns: dataSet?.columns ?? columns,
    rows: dataSet?.rows ?? [],
    total: Number(totalSet?.rows?.[0]?.[0] ?? 0),
    offset,
  };
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
          resolve({ ok: false, error: withSshHint(target, message, `Dump failed (exit code ${code}).`) });
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

    if (msg?.type === 'listTables') {
      const r = await listTables(target);
      panel.webview.postMessage({ type: 'tables', ...r });
      return;
    }

    if (msg?.type === 'browse') {
      const r = await browseTable(
        target,
        String(msg.table ?? ''),
        Number(msg.offset ?? 0),
        Number(msg.limit ?? 25),
        String(msg.search ?? ''),
        msg.sort?.column
          ? { column: String(msg.sort.column), direction: msg.sort.direction === 'desc' ? 'desc' : 'asc' }
          : undefined
      );
      panel.webview.postMessage({ type: 'browseResult', requestId: msg.requestId, table: msg.table, ...r });
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
    <button class="sql-tab" data-tab="browse">Browse</button>
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

  <div class="sql-pane" data-pane="browse" hidden>
    <div class="sql-editor-wrap">
      <div class="sql-bar">
        <select id="sql-table" title="Table to browse"><option value="">Loading tables…</option></select>
        <input type="search" id="sql-search" placeholder="Search all rows…" spellcheck="false">
        <button id="sql-search-run">Search</button>
      </div>
    </div>
    <div id="sql-browse-output"><div class="sql-empty">Pick a table to browse.</div></div>
    <div id="sql-pager" hidden>
      <button id="sql-first" title="First page">&laquo;</button>
      <button id="sql-prev" title="Previous page">&lsaquo;</button>
      <span class="sql-pager-page">Page
        <input type="number" id="sql-page" min="1" value="1"> of <span id="sql-pages">1</span>
      </span>
      <button id="sql-next" title="Next page">&rsaquo;</button>
      <button id="sql-last" title="Last page">&raquo;</button>
      <select id="sql-limit" title="Rows per page">
        <option value="25" selected>25</option>
        <option value="50">50</option>
        <option value="100">100</option>
        <option value="250">250</option>
        <option value="500">500</option>
      </select>
      <span id="sql-pager-info"></span>
    </div>
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
