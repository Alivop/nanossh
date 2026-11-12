/** NanoSSH 前端数据契约：字段名与 Rust 侧 serde 序列化保持一致（camelCase） */

export interface Profile {
  id: string;
  title: string;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  rememberPassword?: boolean;
  /** 连接分组：旧数据缺字段时归一化成「未分组」 */
  group: string;
}

export interface SshConfig {
  title: string;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
}

export type TabKind = "ssh" | "local";
/** restored = 应用重启后恢复的页签：未连接，切换到此页签（或按 Enter）时自动连接 */
export type TabStatus = "connecting" | "connected" | "need-password" | "failed" | "restored";

export interface Tab {
  id: string;
  title: string;
  config: SshConfig;
  profileId: string | null;
  kind: TabKind;
  sessionId: string | null;
  status: TabStatus;
  cwd: string | null;
  /** 克隆来源，仅用于页签 hover 提示 */
  cloneFrom: string | null;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime?: number;
}

export interface DirListing {
  path: string;
  home: string;
  entries: FsEntry[];
}

export type TransferState =
  | "running" | "paused" | "done" | "error" | "canceled" | "interrupted";

export interface Transfer {
  job: string;
  kind: "upload" | "download";
  label: string;
  count: number;
  index: number;
  file: string;
  percent: number;
  sent: number;
  total: number;
  state: TransferState;
  ok: number;
  failed: number;
  error: string;
  targetDir: string;
  sessionId: string | null;
  outcomes: TransferOutcome[];
  at: number;
}

export interface TransferOutcome {
  path: string;
  ok: boolean;
  error?: string;
}

export interface ProgressPayload {
  job: string;
  index: number;
  file: string;
  sent: number;
  total: number;
  percent: number;
}

export interface DonePayload {
  job: string;
  ok: number;
  failed: number;
  canceled: boolean;
  error?: string;
  outcomes?: TransferOutcome[];
}
