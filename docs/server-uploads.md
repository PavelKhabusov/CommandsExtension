# Server Uploads

Define per-project FTP / FTPS / SFTP upload targets in `server-uploads.local.json` and run them with one click — no FileZilla CLI required, works on Linux, macOS, and Windows.

- **Live progress** — percentage, current file, transfer speed, files done / total
- **Cancel mid-flight** — stop button on running uploads
- **Files, folders, globs** — single files, recursive folder uploads, or glob patterns
- **Per-upload `exclude`** — skip files inside an uploaded folder (e.g. `**/node_modules/**`)
- **Parallel transfers** — `"connections": N` opens a pool of FTP/SFTP connections (default 4 / sftp 2); directory creation is cached per deploy
- **Mirror deploys** — `"mode": "mirror"` deletes remote files that no longer exist locally (full uploads only); `protectRemote` globs and `.htaccess` are never touched
- **`skipUnchanged` globs** — matching files whose remote size equals the local size are skipped (content-hashed builds re-deploy only new chunks)
- **Modified tracking** — cards show `⚠ N files modified` since the last upload; a per-server "Upload only N modified" action sends just those, and a header ✓ button marks everything synced
- **Shared `servers`** — define a server once, reference it from many uploads
- **Interactive picker** — folder-with-plus button opens a native file/folder dialog and appends selections to the config
- **`.local.json` by default** — the default filename is excluded by common gitignore patterns so credentials stay out of git

```json
{
  "servers": [
    {
      "name": "main",
      "protocol": "ftp",
      "host": "example.com",
      "port": 21,
      "user": "username",
      "password": "your-password"
    }
  ],
  "uploads": [
    {
      "name": "Theme → prod",
      "server": "main",
      "remoteDir": "/public_html/wp-content/themes/mytheme/",
      "items": ["./wp-content/themes/mytheme/"],
      "exclude": ["**/node_modules/**", "**/*.log"],
      "onExists": "overwrite"
    },
    {
      "name": "Single file → prod",
      "server": "main",
      "remoteDir": "/public_html/",
      "items": ["./bundle/app.js"]
    }
  ]
}
```

## `servers` entry

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Reference name used by uploads |
| `protocol` | `"ftp"` \| `"ftps"` \| `"sftp"` | yes | Connection protocol |
| `host` | string | yes | Server hostname or IP |
| `port` | number | no | Defaults: 21 (FTP/FTPS), 22 (SFTP) |
| `user` | string | yes | Username |
| `password` | string | no | Password. If omitted, you'll be prompted at upload time (not saved) |

## `uploads` entry

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Display name in the UI |
| `group` | string | no | Group name (default: `"Uploads"`) |
| `server` | string | conditional | Reference to a `servers` entry. Required unless inline `host`/`user`/`protocol` are set |
| `protocol` / `host` / `port` / `user` / `password` | — | conditional | Inline server fields (override or replace `server`) |
| `remoteDir` | string | yes | Remote directory (absolute path) |
| `items` | string[] | yes | Files, folders, or globs (relative to workspace root) |
| `exclude` | string[] | no | Glob patterns to skip during folder/glob expansion |
| `onExists` | `"overwrite"` \| `"skip"` | no | Behavior on file collision (default: `"overwrite"`) |
| `mode` | `"mirror"` | no | After a full upload, delete remote files missing locally and prune empty dirs (partial uploads never delete) |
| `protectRemote` | string[] | no | Globs (relative to `remoteDir`) the mirror must never delete; `.htaccess` is always protected |
| `connections` | number 1–8 | no | Parallel connection pool (default 4 for ftp/ftps, 2 for sftp) |
| `skipUnchanged` | string[] | no | Globs whose files are skipped when remote size equals local size |

Folder items follow rsync trailing-slash semantics: `"folder/"` uploads the folder's *contents* into `remoteDir`, `"folder"` keeps the folder name on the server.

Right-click an upload for context menu actions: edit config, add files.

> **Passwords are stored in plain text inside `server-uploads.local.json`.** The default filename is `.local.json` so most gitignore presets exclude it. If you use a different filename, add it to `.gitignore` yourself.

> **Proxy / VPN note:** uploads use raw TCP sockets; HTTP proxy settings (system or VS Code) are not applied. System-level VPN tunnels are honored transparently by the OS — bypassing them requires VPN-level split tunneling.

## Modified uploads = exactly what the badge shows

The "Modified" action uploads precisely the files listed in the staleness badge —
no hidden re-scans, no surprises. Badges are fed by file-watcher events, a re-check
of tracked files on activation, and a scope rescan when the uploads config changes.
Snapshots keep a sha1 of each uploaded file, so an mtime bump with identical content
(typically `git checkout` / branch switching) heals itself instead of flagging the
tree as Modified. `mirror` deletions and `skipUnchanged` sizing apply to full
uploads only.

## Quick Upload (untracked files → any server path)

For one-off uploads of files that are **not** part of any configured upload (logos,
icons, assets) into an **arbitrary** server directory — without editing
`server-uploads.local.json`.

**Header buttons** (Server Uploads section, appear on hover):

- **⬆ Quick upload** — pick files (multi-select) **or** a whole folder → pick a
  server (auto if only one) → browse the server's directories (FileZilla-style:
  enter folders, `..` up, "Upload here", create new folder) or type the path
  manually → uploaded. Folders keep their structure; single files land as
  `remoteDir/<basename>`.
- **✓ Mark all as synced** — mark every tracked upload as synced (clears
  changed/new badges) without actually uploading anything.

**Servers** are read from `server-uploads.local.json` (`servers[]` — same list
used by regular uploads).

### Upload spec format (for humans and agents)

There is a non-interactive command **`Commands Extension: Quick Upload from Spec`**
that accepts a spec string, so an agent can generate a ready-to-run line and the
user just pastes it. One pair per line:

```
<local file or folder>  =>  <serverName>:<remoteDir>
```

- **left** — absolute local path to a file or a folder (folder = recursive, keeps structure).
- **`serverName`** — must match a `name` in `servers[]` of `server-uploads.local.json`.
- **right of `:`** — target directory on the server.
- **Downloading** — a line of the form `<serverName>:<remote path> => <local dir>` pulls from the
  server instead of uploading (the server is on the *left* of the arrow). A file lands as
  `<local dir>/<basename>`; a folder is fetched recursively, keeping its structure. The local dir
  is created if missing and may be relative to the workspace root.
- **Deleting** — a line of the form `del <serverName>:<remote path>` removes that path on the
  server instead of uploading. Works on files and folders (folders are removed recursively) and
  can be mixed with upload pairs in the same spec. Before anything is removed the extension
  checks the server and shows a modal listing exactly what was found — each file, and each
  folder with how many files it contains — plus any paths that don't exist (skipped). Nothing is
  deleted until you confirm.
- Multiple pairs: separate by newline **or** `;` (the interactive input box is single-line, so use `;` when pasting several pairs there). Lines starting with `#` are ignored.
- Pairs are **grouped by server**: everything bound for one server uploads over a single
  connection in one run, even when remote dirs differ. The input box shows a live parse
  preview grouped by server; a spec pasted into the Quick-upload picker (or already on
  the clipboard) is recognised there too.

Example:

```
/home/pavel/DEV/propress.ru/wp-content/themes/pro/img/logo-09-08.webm => dev-propress:/wp-content/themes/pro/img
/home/pavel/Downloads/составные-части-иконки => dev-propress:/wp-content/themes/pro/img/constructor/parts
dev-propress:/wp-content/themes/pro/style.css => /home/pavel/backup
del dev-propress:/wp-content/themes/pro/img/logo-old.webm
```

Run via Command Palette → "Quick Upload from Spec" (or programmatically:
`commandsExtension.quickUploadFromSpec` with the spec string as the argument).

> **For agents:** to hand the user a paste-ready upload, output a fenced block in
> exactly the `local => serverName:/remote/dir` format above. Resolve `serverName`
> from the project's `server-uploads.local.json` `servers[]` (e.g. `dev-propress`,
> `propress`). Left side is a local file/folder path; right side is the server
> directory. Do not invent server names.
