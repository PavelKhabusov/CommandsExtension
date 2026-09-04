# SQL Console

Run queries and export a remote database from inside VS Code. A server carrying
an `sql` block in `server-uploads.local.json` puts a **database button** in the
Server Uploads section header; servers without one are untouched and show no
button.

- **Query tab** — a phpMyAdmin-style box with SQL syntax highlighting: `Run` or
  `Ctrl+Enter`, one result table per statement, full MySQL errors with code and
  line
- **Copy results** — per-table and whole-batch copy buttons emit markdown
  tables, ready to paste into a chat or an issue
- **Browse tab** — pick a table and page through it, with server-side search,
  click-to-sort headers and a 25/50/100/250/500 page size
- **Export tab** — dump the database as full, schema only or data only, with
  live progress and a summary
- **Runs on the server over SSH** — `mysqldump` and `gzip` included, so only
  compressed bytes cross the network
- **Verified dumps** — a truncated transfer or missing primary keys are reported
- **Server switcher** — appears when more than one server configures `sql`
- **No database port exposed** — nothing has to listen on 3306 publicly

## Why it runs server-side

A database reached over the internet answers every client round-trip at network
latency. `mysqldump` alone issues several queries per table before it fetches a
single row, so against a 300 ms link a few hundred tables cost minutes of pure
waiting — and then the rows themselves travel uncompressed. Running the same
work through SSH moves both problems to the server, where the database is a
local socket away, and sends back a gzipped stream. This is the same reason a
hosting panel's own export feels instant while a local client crawls.

## Requirements

1. SSH access enabled for the hosting account — on most shared hosts this is a
   switch in the control panel.
2. Your public key installed on the server, so no password is asked:

   ```bash
   ssh-copy-id user@example.com
   ```

   Connections use `BatchMode`: if the key is missing, the console reports the
   error instead of hanging on an invisible password prompt — and prints the
   `ssh-copy-id` line for that exact login so it can be pasted into a terminal.
   The same applies to an unresolvable host, a refused connection, a changed
   host key (`ssh-keygen -R …`) and rejected database credentials, which are
   called out as database rather than SSH credentials.
3. The `mysql` and `mysqldump` clients on the server — present on virtually
   every LAMP host.

## Configuration

```json
{
  "servers": [
    {
      "name": "staging",
      "protocol": "sftp",
      "host": "staging.example.com",
      "user": "deploy",
      "password": "upload-password",

      "sql": {
        "database": "myapp",
        "dbUser": "myapp_user",
        "dbPassword": "db-password"
      }
    }
  ]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `database` | — | **Required.** Database name |
| `dbUser` | — | **Required.** Database user |
| `dbPassword` | — | **Required.** Database password |
| `dbHost` | `localhost` | Database host *as seen from the server itself* |
| `sshHost` | server's `host` | SSH host |
| `sshUser` | server's `user` | SSH user |
| `sshPort` | `22` | SSH port |

All three required fields must be present — otherwise no database button is
shown for that server. `dbHost` stays `localhost` in the usual case: the query
runs on the server, so "localhost" means the server's own MySQL.

`server-uploads.local.json` already holds upload passwords and its `.local.json`
name matches common gitignore patterns, so credentials stay out of git.

The SSH password is never stored: authentication is by key. The database
password is sent to the server through the SSH channel and passed to the client
via `MYSQL_PWD`, so it does not appear in the server's process list.

## Query tab

- **Run** or `Ctrl+Enter` executes the box.
- Selecting a fragment runs only that fragment — handy in a long script.
- Statements separated by `;` each get their own result table.
- The batch runs in **one session**, so user variables, `PREPARE`/`EXECUTE`,
  temporary tables and transactions carry from one statement to the next — a
  migration guarded by `SET @ddl := …; PREPARE …; EXECUTE …` works as written.
- Execution stops at the first failing statement and shows its MySQL error
  (`ERROR 1064 (42000) at line 1: …`).
- Semicolons inside strings, backticks and comments do not split statements.
- `NULL` is rendered distinctly from an empty string. Long values stay on one
  line — **click a cell** to expand it, click again to collapse.
- **Double-click** a cell to select its whole value (not just the word under the
  cursor), and **Ctrl/Cmd+C** copies the selection — or, with nothing selected,
  the cell under the pointer.

### Opening a .sql file

Right-clicking a `.sql` file — in the explorer, the editor, or its tab — offers
**Run SQL File in Console**: the console opens on the Query tab with the file's
contents loaded, ready to review. Nothing is executed until you press **Run**.
Unsaved editor changes are used in preference to what is on disk, so a script
you are still editing is the one that lands in the box.

The entry appears only for `.sql` files and only when a server configures `sql`.

### Copying results

Every result table carries a **Copy** button, and a batch that produced several
tables gets a **Copy all results** button above them. Both emit markdown:

```
Result 1 — 2 row(s)
| id | name |
| --- | --- |
| 1 | alpha |
| 2 | NULL |
```

`NULL` is written literally rather than as an empty cell, embedded newlines are
flattened and `|` is escaped, so a pasted table renders correctly. Failed
queries offer **Copy error**, and a finished export offers **Copy summary**.

## Browse tab

Pick a table from the dropdown (each shows its approximate row count) and page
through its rows.

- **Search** filters **on the server across every column**, so it covers the
  whole table rather than the rows currently on screen — a match on page 40 of
  a 20 000-row table is found.
- **Click a column header** to sort by it; click again to flip direction. Only a
  real column name ever reaches `ORDER BY`.
- **Page size** is 25 by default, up to 500. The first/previous/next/last
  buttons and the page number box move between pages.
- **Copy page** emits the visible rows as a markdown table, like the Query tab.
- Cells behave as they do in query results: click to expand, double-click to
  select the whole value.

The table and page size are remembered, so reopening the console returns you to
what you were looking at.

## Export tab

Two toggles decide what goes into the dump:

| Schema | Data | Result |
|--------|------|--------|
| on | on | Full — schema and rows |
| on | off | `CREATE TABLE` statements, no rows |
| off | on | Rows only, no `CREATE TABLE` |

They can never both be off — switching off the only active one turns the other
on, so there is no way to ask for an empty dump.

**Save to** shows the folder dumps are written to. It is asked for once (on the
first export, or via **Change…**) and remembered per workspace, so exporting
afterwards is a single click; files are named
`<database>-<mode>-<timestamp>.sql.gz`.

Progress is reported live (`Connecting` → `Downloading 13.5 MB · 10s` →
`Verifying`), followed by a summary of file, size, duration and table count.

Dumps include routines, events and triggers, and use `--single-transaction` so
the export does not lock the site out of its own database. `--no-tablespaces` is
always passed: shared hosting accounts lack the `PROCESS` privilege it would
otherwise require.

### Verification

A finished dump is read back before it is reported as good:

- **No completion marker** — the transfer was truncated; the file is incomplete
  even though its size looks plausible.
- **Tables without a `PRIMARY KEY`** — reported as a warning with a count.
  Restoring such a dump reproduces the missing keys, which is easy to miss until
  something silently breaks much later.

Neither check rewrites the dump; both surface what it actually contains.
