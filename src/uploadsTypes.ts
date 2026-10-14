export type UploadProtocol = 'ftp' | 'ftps' | 'sftp' | 'ssh';

/**
 * Uploads over SSH with the system rsync, authenticated by the developer's own
 * key (ssh-agent / ~/.ssh) — no password in the config. Used when the server's
 * protocol is "ssh", or when an FTP server sets uploadVia: "ssh".
 */
export interface ServerSshConfig {
  /** SSH host; defaults to sql.sshHost, then the server's `host`. */
  host?: string;
  /** SSH user; defaults to sql.sshUser, then the server's `user`. */
  user?: string;
  /** SSH port; defaults to sql.sshPort, then 22 (or `port` for protocol "ssh"). */
  port?: number;
  /**
   * Where the config's remote paths (remoteDir, spec paths) start over SSH.
   * Default for uploadVia "ssh": "~" — the SSH home, which on shared hosting
   * is usually the FTP root. Default for protocol "ssh": "/" (paths are absolute).
   */
  root?: string;
  /** Uploads to this server running at once (default 3). */
  maxParallel?: number;
  /** When SSH cannot connect, upload over the server's FTP/SFTP instead of failing. */
  fallbackToFtp?: boolean;
}

export interface SshTarget {
  host: string;
  user: string;
  port: number;
  root: string;
  maxParallel: number;
  fallbackToFtp: boolean;
}

/**
 * Optional SQL console settings for a server. When present, the server header
 * shows a database button that opens an SQL console running queries over SSH.
 */
export interface ServerSqlConfig {
  /** Database name. */
  database: string;
  /** Database user. */
  dbUser: string;
  /** Database password. */
  dbPassword: string;
  /** Database host as seen from the server itself. Defaults to localhost. */
  dbHost?: string;
  /** SSH host; defaults to the server's `host`. */
  sshHost?: string;
  /** SSH user; defaults to the server's `user`. */
  sshUser?: string;
  /** SSH port; defaults to 22. */
  sshPort?: number;
}

export interface ServerDefinition {
  name: string;
  protocol: UploadProtocol;
  host: string;
  port?: number;
  user: string;
  password?: string;
  /** Enables the SQL console button for this server. */
  sql?: ServerSqlConfig;
  /** SSH settings for rsync uploads (protocol "ssh" or uploadVia "ssh"). */
  ssh?: ServerSshConfig;
  /** "ssh" — an FTP/SFTP server uploads through rsync over SSH. */
  uploadVia?: 'ssh';
}

export interface UploadDefinition {
  name: string;
  group?: string;
  server?: string;
  protocol?: UploadProtocol;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  remoteDir: string;
  items: string[];
  exclude?: string[];
  onExists?: 'overwrite' | 'skip';
  /**
   * 'mirror' — after uploading, delete remote files under remoteDir that do
   * not exist locally (stale hashed builds, removed pages). Directories left
   * empty are pruned too. Default 'upload' (never deletes anything).
   */
  mode?: 'upload' | 'mirror';
  /**
   * Glob patterns (relative to remoteDir, posix) that mirror-mode must never
   * delete — server-side files living inside the deploy dir ('.htaccess',
   * 'api/**', …). '.htaccess' is always protected implicitly.
   */
  protectRemote?: string[];
  /**
   * Glob patterns: a file matching one of these whose remote size equals the
   * local size is considered unchanged and skipped. Safe for content-hashed
   * paths ('_next/static/**', 'assets/*.<hash>.js') — repeat deploys upload
   * only what actually changed.
   */
  skipUnchanged?: string[];
  /**
   * Glob patterns: skip a file whose sha1 matches the one recorded after the
   * previous successful full upload (manifest in .vscode/upload-hashes/).
   * Use for non-hashed build output (html, txt) that rebuilds byte-identical.
   */
  skipSameHash?: string[];
  /** Parallel connections for the transfer (1–8, default 4 for ftp/ftps, 2 for sftp). */
  connections?: number;
}

export interface ResolvedUpload {
  name: string;
  group: string;
  protocol: UploadProtocol;
  host: string;
  port: number;
  user: string;
  password?: string;
  remoteDir: string;
  items: string[];
  exclude: string[];
  onExists?: 'overwrite' | 'skip';
  mode?: 'upload' | 'mirror';
  protectRemote?: string[];
  skipUnchanged?: string[];
  skipSameHash?: string[];
  connections?: number;
  /** Set when this upload goes through rsync over SSH. */
  ssh?: SshTarget;
}

export interface UploadGroup {
  name: string;
  uploads: UploadDefinition[];
}

export type UploadStatus = 'idle' | 'connecting' | 'running' | 'done' | 'error' | 'cancelled';

export interface UploadProgress {
  uploadKey: string;
  status: UploadStatus;
  /** Workspace root this upload runs from — surfaced to the hub so it can
   *  apply per-project rules (e.g. keep VPN on for some projects). */
  workspacePath?: string;
  message?: string;
  currentFile?: string;
  bytes?: number;
  bytesTotal?: number;
  filesDone?: number;
  filesTotal?: number;
  percent?: number;
  speedBps?: number;
  finishedAt?: number;
}
