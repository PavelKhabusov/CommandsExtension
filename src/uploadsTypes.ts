export type UploadProtocol = 'ftp' | 'ftps' | 'sftp';

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
  connections?: number;
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
