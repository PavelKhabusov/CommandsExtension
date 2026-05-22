export type UploadProtocol = 'ftp' | 'ftps' | 'sftp';

export interface ServerDefinition {
  name: string;
  protocol: UploadProtocol;
  host: string;
  port?: number;
  user: string;
  password?: string;
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
