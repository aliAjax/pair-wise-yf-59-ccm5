import { migrate } from '../src/store';
import { buildStandings } from '../src/ranking';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n[M1] 旧 v1 完赛数据（含遗留加罚 + official 标记）迁移');
{
  const legacy = {
    races: [{ id: 'race-9', name: '旧版比赛', fleet: '统一级', course: 'W2', startsAt: '2026-01-01T00:00:00.000Z', status: 'finished' }],
    entries: [
      { id: 'a', boat: '甲船', sailNo: 'A1', skipper: '甲', elapsedSeconds: 3000, penaltySeconds: 30, resultStatus: 'official', note: '' },
      { id: 'b', boat: '乙船', sailNo: 'B2', skipper: '乙', elapsedSeconds: 3050, penaltySeconds: 0, resultStatus: 'corrected', note: '' }
    ],
    protests: [
      { id: 'p1', raceId: 'race-9', entryId: 'a', reason: '旧抗议', rule: 'RRS 14', status: 'resolved', decision: '加罚', createdAt: '2026-01-01T02:00:00.000Z' }
    ],
    timeline: []
  };

  const s = migrate(legacy as never as Parameters<typeof migrate>[0]);
  check('schemaVersion 置为 2', s.schemaVersion === 2);
  check('race 补 lockedAt', s.races[0].lockedAt !== null);
  check('entry 补 lockedElapsedSeconds=原到线', s.entries[0].lockedElapsedSeconds === 3000);
  check('每条船补 lock 变更项', s.changes.filter((c) => c.category === 'lock').length === 2);
  const migratedPenalty = s.changes.find((c) => c.category === 'penalty' && c.entryId === 'a');
  check('旧 30 秒处罚迁移为生效变更项', !!migratedPenalty && migratedPenalty.state === 'active' && migratedPenalty.penaltySeconds === 30);
  check('迁移处罚不挂抗议 id（避免被误认为同一抗议处罚）', !migratedPenalty!.protestId);
  check('protest 补齐 baseVersion / appliedAction', typeof s.protests[0].baseVersion === 'number' && s.protests[0].appliedAction === null);
  check('补登一个已发布正式版', s.standingsVersions.length === 1 && s.standingsVersions[0].kind === 'official');

  const standings = buildStandings(s.entries, s.changes);
  const a = standings.find((r) => r.entryId === 'a')!;
  const b = standings.find((r) => r.entryId === 'b')!;
  check('甲船净用时 3030', a.netSeconds === 3030);
  check('乙船净用时 3050', b.netSeconds === 3050);
  check('甲船第1、乙船第2（保留旧净用时语义）', a.rank === 1 && b.rank === 2);
  check('发布快照名次同样正确', s.standingsVersions[0].rows[0].entryId === 'a' && s.standingsVersions[0].rows[0].rank === 1);
}

console.log('\n[M2] 旧 v1 未开赛数据迁移');
{
  const legacy = {
    races: [{ id: 'race-1', name: '待赛', fleet: '', course: '', startsAt: '2026-01-01T00:00:00.000Z', status: 'scheduled' }],
    entries: [
      { id: 'a', boat: '甲', sailNo: 'A1', skipper: '', elapsedSeconds: 0, penaltySeconds: 0, resultStatus: 'provisional', note: '' }
    ],
    protests: [],
    timeline: []
  };
  const s = migrate(legacy as never as Parameters<typeof migrate>[0]);
  check('未开赛不补锁定时间', s.races[0].lockedAt === null);
  check('未开赛不生成 lock 项', s.changes.length === 0);
  check('lockedElapsedSeconds 为 null', s.entries[0].lockedElapsedSeconds === null);
  check('不生成发布版本', s.standingsVersions.length === 0);
  check('changeSeq 为 0', s.changeSeq === 0);
}

console.log('\n[M3] 已经是 v2 的数据原样打开');
{
  const v2 = {
    schemaVersion: 2,
    races: [], entries: [], protests: [], changes: [], standingsVersions: [], timeline: [], changeSeq: 0
  };
  const s = migrate(v2);
  check('原样返回', s === (v2 as unknown as typeof s));
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
