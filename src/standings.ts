import type { ComputedStanding, Publication, Race, RaceEntry, ResultChange, ResultStatus } from './types';

/**
 * 计算实时名次（未发布）。
 * 到线成绩锁定后以 finishSeconds 为基准，加上所有生效变更项的 deltaSeconds；
 * 弃权变更的船只排在所有完赛船之后。
 */
export function computeStandings(entries: RaceEntry[], changes: ResultChange[], race?: Race): ComputedStanding[] {
  const raceId = race?.id;
  const list: ComputedStanding[] = entries.map((entry) => {
    const entryChanges = changes.filter(
      (c) => c.entryId === entry.id && c.status === 'active' && (raceId ? c.raceId === raceId : true)
    );
    const deltaSeconds = entryChanges.reduce((sum, c) => sum + c.deltaSeconds, 0);
    const finishSeconds = entry.finishSeconds ?? entry.elapsedSeconds;
    const waived = entryChanges.some((c) => c.type === 'waiver');
    return {
      rank: 0,
      entryId: entry.id,
      boat: entry.boat,
      sailNo: entry.sailNo,
      finishSeconds,
      deltaSeconds,
      totalSeconds: finishSeconds + deltaSeconds,
      waived,
      changes: entryChanges
    };
  });
  list.sort((a, b) => {
    if (a.waived !== b.waived) return a.waived ? 1 : -1;
    return a.totalSeconds - b.totalSeconds;
  });
  list.forEach((item, i) => { item.rank = i + 1; });
  return list;
}

/** 实时名次与已发布版本是否一致（用于判断是否有未发布更正） */
export function findChangedSince(live: ComputedStanding[], publication?: Publication): ComputedStanding[] {
  if (!publication) return [];
  const changed: ComputedStanding[] = [];
  for (const s of live) {
    const published = publication.standings.find((p) => p.entryId === s.entryId);
    if (!published || published.totalSeconds !== s.totalSeconds || published.waived !== s.waived || published.rank !== s.rank) {
      changed.push(s);
    }
  }
  return changed;
}

/** 条目在当前发布版本下的状态 */
export function entryResultStatus(
  entry: RaceEntry,
  live: ComputedStanding[],
  race: Race | undefined,
  latestPublication?: Publication
): ResultStatus {
  if (race?.status !== 'finished') return 'provisional';
  if (!latestPublication) return 'provisional';
  const liveS = live.find((s) => s.entryId === entry.id);
  const published = latestPublication.standings.find((p) => p.entryId === entry.id);
  if (!liveS || !published) return 'provisional';
  if (published.totalSeconds !== liveS.totalSeconds || published.waived !== liveS.waived) return 'corrected';
  return 'official';
}

/** 变更项类型的中文标签 */
export const CHANGE_TYPE_LABEL: Record<ResultChange['type'], string> = {
  penalty: '加罚',
  rerun: '重赛',
  waiver: '弃权',
  redress: '补偿',
  correction: '更正'
};
