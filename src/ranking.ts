import type { RaceEntry, ResultChange, StandingOutcome, StandingRow, StandingsVersion } from './types';

/** 有效变更项：撤销的不再参与名次计算 */
export function activeChanges(changes: ResultChange[]): ResultChange[] {
  return changes.filter((change) => change.state === 'active');
}

/** 某条船当前的最终形态：重赛/弃权类一旦生效即为最终结果 */
export function currentOutcome(changes: ResultChange[], entryId: string): StandingOutcome {
  for (const change of activeChanges(changes)) {
    if (change.entryId !== entryId) continue;
    if (change.category === 'resail') return 'resail';
    if (change.category === 'withdrawal') return 'withdrawal';
  }
  return 'finished';
}

/** 锁定后的到线成绩：取锁定项，之后若有到线更正则取最近一条 */
export function lockedElapsedFor(changes: ResultChange[], entry: RaceEntry, provisional = false): number | null {
  let value = entry.lockedElapsedSeconds;
  if (value === null && provisional) value = entry.elapsedSeconds;
  if (value === null) return null;
  // changes 新的在前：最近一条生效的到线更正才是当前原始到线成绩
  for (const change of changes) {
    if (change.entryId === entry.id && change.state === 'active' && change.category === 'time_correction') {
      value = change.refId ? Number(change.refId) : value;
      break;
    }
  }
  return value;
}

/** 当前生效加罚合计 */
export function penaltyTotalFor(changes: ResultChange[], entryId: string): number {
  return activeChanges(changes)
    .filter((change) => change.entryId === entryId && change.category === 'penalty')
    .reduce((sum, change) => sum + change.penaltySeconds, 0);
}

export interface BuildOptions {
  /** true：比赛未锁定时也用 elapsedSeconds 生成临时名次；false：仅展示锁定后名次 */
  provisional?: boolean;
}

/**
 * 根据锁定成绩 + 生效变更项计算当前名次。
 * 比赛状态、裁决项一更新，调用方重新执行本函数即得到重算结果。
 */
export function buildStandings(entries: RaceEntry[], changes: ResultChange[], options: BuildOptions = {}): StandingRow[] {
  const rows: StandingRow[] = entries.map((entry) => {
    const outcome = currentOutcome(changes, entry.id);
    const corrected = lockedElapsedFor(changes, entry, options.provisional);
    const penalty = penaltyTotalFor(changes, entry.id);
    return {
      rank: null,
      entryId: entry.id,
      boat: entry.boat,
      sailNo: entry.sailNo,
      skipper: entry.skipper,
      outcome,
      lockedElapsedSeconds: corrected,
      penaltySeconds: penalty,
      netSeconds: outcome === 'finished' && corrected !== null ? corrected + penalty : null
    };
  });

  const finished = rows.filter((row) => row.netSeconds !== null).sort((a, b) => {
    const gap = (a.netSeconds ?? 0) - (b.netSeconds ?? 0);
    if (gap !== 0) return gap;
    // 净用时相同按帆号稳定排序，避免并列名次抖动
    return a.sailNo.localeCompare(b.sailNo);
  });
  finished.forEach((row, index) => { row.rank = index + 1; });

  const pendingResail = rows.filter((row) => row.outcome === 'resail');
  const withdrawals = rows.filter((row) => row.outcome === 'withdrawal');
  return [...finished, ...pendingResail, ...withdrawals];
}

/** 行级快照比较（含名次），用于判断未发布名次相对上一版是否发生变化 */
function rowsEqual(a: StandingRow[], b: StandingRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index];
    return !!other
      && row.rank === other.rank
      && row.entryId === other.entryId
      && row.outcome === other.outcome
      && row.netSeconds === other.netSeconds
      && row.lockedElapsedSeconds === other.lockedElapsedSeconds
      && row.penaltySeconds === other.penaltySeconds;
  });
}

/** 当前名次与最近发布版本是否一致（是否有待发布的变化） */
export function hasUnpublishedDrift(versions: StandingsVersion[], current: StandingRow[]): boolean {
  const latest = [...versions].sort((a, b) => b.versionNo - a.versionNo)[0];
  if (!latest) return true;
  return !rowsEqual(latest.rows, current);
}

/** 秒数格式化为 mm:ss，tooltip 同时保留原始秒数 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const outcomeLabel: Record<StandingOutcome, string> = {
  finished: '完赛',
  resail: '待重赛',
  withdrawal: '弃权'
};

export const categoryLabel: Record<ResultChange['category'], string> = {
  lock: '锁定到线',
  time_correction: '到线更正',
  penalty: '加罚',
  resail: '重赛',
  withdrawal: '弃权'
};
