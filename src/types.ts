export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  /** 比赛结束时锁定到线成绩的时间；未结束为 null */
  lockedAt: string | null;
}

export interface RaceEntry {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
  /** 到线用时：锁定前可改；锁定后只作为原始记录，正式名次使用 lockedElapsedSeconds + 变更项 */
  elapsedSeconds: number;
  /** @deprecated 旧版处罚秒数，v2 起由变更记录计算，仅为兼容旧数据保留 */
  penaltySeconds?: number;
  /** 结束瞬间锁定的到线成绩，之后任何更正都以变更项追加 */
  lockedElapsedSeconds: number | null;
  /** @deprecated 旧版单条结果状态，v2 起名次状态随发布版本推导，仅为兼容旧数据保留 */
  resultStatus?: ResultStatus;
  note: string;
}

/** 变更项类别：锁定 / 到线更正 / 加罚 / 重赛 / 弃权 / 抗议裁决 */
export type ChangeCategory = 'lock' | 'time_correction' | 'penalty' | 'resail' | 'withdrawal';
/** 变更来源：竞赛控制、计时员成绩页、裁判抗议裁决、数据迁移 */
export type ChangeSource = 'race_control' | 'results' | 'protest' | 'migration';
/** 变更项状态：生效 / 已撤销（被后续改判回滚） */
export type ChangeState = 'active' | 'reverted';

export interface ResultChange {
  id: string;
  raceId: string;
  entryId: string;
  category: ChangeCategory;
  source: ChangeSource;
  /** 加罚秒数（penalty 时有效） */
  penaltySeconds: number;
  reason: string;
  /** 由哪个抗议产生；抗议改判时据此找到原变更并撤销，保证同一处罚不重复计 */
  protestId?: string;
  /** 重赛裁决时为新生成的重赛抗议/事件 id（预留展示） */
  refId?: string;
  state: ChangeState;
  createdAt: string;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
  /** 裁决所基于的变更记录版本号；并发裁决时用于乐观锁冲突检测 */
  baseVersion: number;
  /** 已生效的裁决动作（幂等重试与改判依据） */
  appliedAction?: ProtestAction | null;
  /** 最近一次裁决产生的变更项 id */
  appliedChangeId?: string | null;
  resolvedAt?: string | null;
}

/** 抗议裁决动作：进入复核 / 支持并加罚 / 驳回（维持原判）/ 改判重赛 / 弃权 */
export type ProtestAction = 'reviewing' | 'penalty' | 'reject' | 'resail' | 'withdrawal';

export type StandingOutcome = 'finished' | 'resail' | 'withdrawal';

export interface StandingRow {
  rank: number | null;
  entryId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  outcome: StandingOutcome;
  /** 原始到线用时（锁定值），未完赛时为 null */
  lockedElapsedSeconds: number | null;
  /** 生效加罚合计 */
  penaltySeconds: number;
  /** 净用时 = 到线 + 加罚；重赛/弃权无净用时 */
  netSeconds: number | null;
}

export type StandingsVersionKind = 'official' | 'correction';

export interface StandingsVersion {
  id: string;
  versionNo: number;
  kind: StandingsVersionKind;
  publishedAt: string;
  note: string;
  /** 发布时的名次快照（不可变，旧版本留作查证） */
  rows: StandingRow[];
  /** 是否已被后续更正版取代 */
  superseded: boolean;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

export interface AppState {
  /** 数据结构版本，用于旧数据迁移 */
  schemaVersion: number;
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  /** 唯一的赛后变更记录，比赛状态页、抗议处理、成绩页共用 */
  changes: ResultChange[];
  /** 已发布名次版本，已发布即冻结，更正另开新版本 */
  standingsVersions: StandingsVersion[];
  timeline: TimelineEvent[];
  /** 变更记录的单调版本号，裁决乐观锁据此检测冲突 */
  changeSeq: number;
}
