# Commands Extension — Documentation

Detailed reference for the bigger features. The main [README](../README.md)
covers the overview, quick start, `commands-list.json` format, and configuration.

- **[Server Uploads](server-uploads.md)** — FTP / FTPS / SFTP upload targets:
  `servers` / `uploads` config, mirror deploys, parallel transfers,
  `skipUnchanged`, snapshot-based "Modified" uploads, Quick Upload, and the
  upload-spec format for agents.
- **[SQL Console](sql-console.md)** — query and export a remote database over
  SSH from a panel: the `sql` server block, the Query and Export tabs, and how
  dumps are verified.
- **[Combined Operations](combined-operations.md)** — bundle commands, uploads,
  and helpers into one ordered, cancellable sequence.
- **[Claude Hooks Manager](claude-hooks.md)** — manage Claude Code hooks from the
  panel across project / local / user-global `settings.json`.
- **[Roadmap](roadmap.md)** — ideas considered but left out of the MVP.
