export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type ChangeType = 'penalty' | 'rerun' | 'waiver' | 'redress' | 'correction';
export type ChangeStatus = 'active' | 'void';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  /** 到线成绩锁定时间：比赛结束后写入，锁定后到线成绩不再直接修改 */
  lockedAt?: string;
}

export interface RaceEntry {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  /** 升级前的处罚秒数，仅用于兼容展示；升级后以变更项为准 */
  penaltySeconds: number;
  /** 锁定的到线成绩（净用时），比赛结束时从 elapsedSeconds 复制 */
  finishSeconds?: number;
  resultStatus: ResultStatus;
  note: string;
}

/** 赛后变更项：加罚、重赛、弃权、补偿、更正都作为独立条目参与名次计算 */
export interface ResultChange {
  id: string;
  raceId: string;
  entryId: string;
  type: ChangeType;
  /** 正为加罚，负为补偿 */
  deltaSeconds: number;
  reason: string;
  /** 关联的裁决项（抗议），用于幂等控制，同一抗议只能计一次罚 */
  protestId?: string;
  status: ChangeStatus;
  version: number;
  /** 升级前遗留的处罚记录 */
  legacy?: boolean;
  createdAt: string;
}

/** 发布时的名次快照 */
export interface PublishedStanding {
  rank: number;
  entryId: string;
  boat: string;
  sailNo: string;
  finishSeconds: number;
  deltaSeconds: number;
  totalSeconds: number;
  waived: boolean;
}

/** 正式名次发布版本：每次发布生成一个版本，旧版本保留供查证 */
export interface Publication {
  id: string;
  raceId: string;
  version: number;
  publishedAt: string;
  note: string;
  /** publish=首次发布，correction=对外发布后的更正版 */
  trigger: 'publish' | 'correction';
  standings: PublishedStanding[];
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  /** 乐观并发版本：每次处理 +1，提交时携带读到的版本号 */
  version: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

/** 实时名次（未发布） */
export interface ComputedStanding {
  rank: number;
  entryId: string;
  boat: string;
  sailNo: string;
  finishSeconds: number;
  deltaSeconds: number;
  totalSeconds: number;
  waived: boolean;
  changes: ResultChange[];
}

/** 版本冲突信息：后提交一方看到当前版本与当前名次 */
export interface ConflictInfo {
  protestId: string;
  currentVersion: number;
  currentStatus: ProtestStatus;
  message: string;
  alreadyHandled?: boolean;
  standings: ComputedStanding[];
}
