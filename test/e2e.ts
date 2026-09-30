import './setup';
import { store, addProtest, applyProtestDecision, setRaceStatus, addResultChange, publishStandings, saveArrival } from '../src/store';
import { buildStandings } from '../src/ranking';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function regatta() { return store.getState().regatta; }
function findChange(raceId: string, category: string) {
  return regatta().changes.find((c) => c.entryId === raceId && c.category === category && c.state === 'active');
}

console.log('\n[1] 初始状态（v2 空库）');
{
  const s = regatta();
  check('schemaVersion = 2', s.schemaVersion === 2);
  check('比赛未锁定', s.races[0].lockedAt === null);
  check('无变更项', s.changes.length === 0);
  check('changeSeq = 0', s.changeSeq === 0);
  const standings = buildStandings(s.entries, s.changes, { provisional: true });
  check('未锁定时可显示临时名次', standings[0].rank === 1 && standings[0].entryId === 'entry-1');
}

console.log('\n[2] 锁定前不允许终局裁决');
{
  store.dispatch(addProtest({ raceId: 'race-1', entryId: 'entry-1', reason: '绕标争议需要测试一下', rule: 'RRS 18' }));
  const protest = regatta().protests[0];
  const r = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 30, decision: '', baseVersion: regatta().changeSeq }));
  check('加罚被拒绝', !r.ok && /尚未结束/.test(r.message));
  check('未产生处罚变更项', !findChange('entry-1', 'penalty'));
  // 进入复核仍然允许
  const rv = store.dispatch(applyProtestDecision({ id: protest.id, action: 'reviewing', decision: '', baseVersion: regatta().changeSeq }));
  check('进入复核允许', rv.ok);
}

console.log('\n[3] 结束比赛：每条船锁定一个 lock 项');
{
  const seqBefore = regatta().changeSeq;
  store.dispatch(setRaceStatus({ id: 'race-1', status: 'finished' }));
  const s = regatta();
  check('已锁定', s.races[0].lockedAt !== null);
  const locks = s.changes.filter((c) => c.category === 'lock');
  check('3 条船 3 个锁定项', locks.length === 3);
  check('到线成绩已写入 lockedElapsedSeconds', s.entries.every((e) => e.lockedElapsedSeconds !== null));
  check('changeSeq 推进', s.changeSeq === seqBefore + 1, `before=${seqBefore} after=${s.changeSeq}`);
  const standings = buildStandings(s.entries, s.changes);
  check('按净用时排名 entry-1 第一', standings[0].entryId === 'entry-1' && standings[0].netSeconds === 3168);

  // 重复结束不会二次锁定
  store.dispatch(setRaceStatus({ id: 'race-1', status: 'finished' }));
  check('重复结束不产生新锁定项', regatta().changes.filter((c) => c.category === 'lock').length === 3);
}

console.log('\n[4] 抗议加罚：名次立即重算，同一裁决重试幂等');
{
  const protest = regatta().protests.find((p) => p.rule === 'RRS 18')!;
  const seq = regatta().changeSeq;
  const r1 = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 30, decision: '', baseVersion: seq }));
  check('裁决生效', r1.ok);
  const change = findChange('entry-1', 'penalty');
  check('产生 +30 加罚项', !!change && change.penaltySeconds === 30 && change.protestId === protest.id);
  let standings = buildStandings(regatta().entries, regatta().changes);
  const row1 = standings.find((r) => r.entryId === 'entry-1')!;
  check('entry-1 净用时 3198', row1.netSeconds === 3198);
  check('entry-1 因加罚掉到第2', row1.rank === 2);
  const protest2 = regatta().protests.find((p) => p.id === protest.id)!;
  check('protest 记录 appliedAction=penalty', protest2.appliedAction === 'penalty');

  // 同一动作、同版本重试 → 幂等，不能计两遍
  const r2 = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 30, decision: '', baseVersion: seq + 1 }));
  check('同动作重试返回幂等', r2.ok && !!r2.idempotent);
  const penalties = regatta().changes.filter((c) => c.category === 'penalty' && c.entryId === 'entry-1' && c.state === 'active');
  check('生效加罚仍然只有 1 条、合计 30 秒', penalties.length === 1 && penalties[0].penaltySeconds === 30);
}

console.log('\n[5] 乐观锁：两人同时提交，后到的冲突并看到当前名次');
{
  store.dispatch(addProtest({ raceId: 'race-1', entryId: 'entry-3', reason: '终点线抢航需要复核确认', rule: 'RRS 10' }));
  const protest = regatta().protests[0];
  const base = regatta().changeSeq;
  const a = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 10, decision: '', baseVersion: base }));
  check('裁判席 A 先提交生效', a.ok);
  const b = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 60, decision: '', baseVersion: base }));
  check('裁判席 B 拿到冲突', !b.ok && !!b.conflict);
  check('冲突给出期望/实际版本', b.conflict!.expected === base && b.conflict!.actual === base + 1);
  check('冲突快照附带当前名次', b.conflict!.currentStandings.some((r) => r.entryId === 'entry-3' && r.penaltySeconds === 10));
  check('B 的 60 秒没有写入', !regatta().changes.some((c) => c.entryId === 'entry-3' && c.penaltySeconds === 60 && c.state === 'active'));

  // B 刷新到新版本后重试：罚秒不同 → 撤销旧变更，追加新变更，不重叠
  const retry = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 60, decision: '', baseVersion: base + 1 }));
  check('刷新后重试生效（改判 60 秒）', retry.ok);
  const activeFor3 = regatta().changes.filter((c) => c.entryId === 'entry-3' && c.category === 'penalty');
  check('旧 10 秒被撤销', activeFor3.find((c) => c.penaltySeconds === 10)?.state === 'reverted');
  check('新 60 秒生效', activeFor3.find((c) => c.penaltySeconds === 60)?.state === 'active');
  const standings = buildStandings(regatta().entries, regatta().changes);
  check('名次合计只有 60 秒', standings.find((r) => r.entryId === 'entry-3')!.penaltySeconds === 60);

  // 再重试一次 60 → 幂等
  const again = store.dispatch(applyProtestDecision({ id: protest.id, action: 'penalty', penaltySeconds: 60, decision: '', baseVersion: base + 2 }));
  check('再次重试幂等不累计', again.ok && !!again.idempotent
    && buildStandings(regatta().entries, regatta().changes).find((r) => r.entryId === 'entry-3')!.penaltySeconds === 60);
}

console.log('\n[6] 改判重赛 / 驳回：原处罚撤销，参与形态变化');
{
  const protest = regatta().protests.find((p) => p.rule === 'RRS 18')!;
  const seq = regatta().changeSeq;
  store.dispatch(applyProtestDecision({ id: protest.id, action: 'resail', decision: '', baseVersion: seq }));
  let standings = buildStandings(regatta().entries, regatta().changes);
  const row = standings.find((r) => r.entryId === 'entry-1')!;
  check('entry-1 变为待重赛', row.outcome === 'resail' && row.rank === null && row.netSeconds === null);
  const oldPenalty = regatta().changes.find((c) => c.protestId === protest.id && c.category === 'penalty')!;
  check('原 30 秒处罚被撤销', oldPenalty.state === 'reverted');

  // 再改判驳回（维持原成绩）
  const rj = store.dispatch(applyProtestDecision({ id: protest.id, action: 'reject', decision: '', baseVersion: seq + 1 }));
  check('改判驳回成功', rj.ok);
  standings = buildStandings(regatta().entries, regatta().changes);
  const row2 = standings.find((r) => r.entryId === 'entry-1')!;
  check('恢复完赛且无加罚', row2.outcome === 'finished' && row2.netSeconds === 3168);
  check('恢复后重新拿到第1', row2.rank === 1);
  check('protest 状态 rejected', regatta().protests.find((p) => p.id === protest.id)!.status === 'rejected');
}

console.log('\n[7] 成绩页手动变更：加罚、弃权、到线更正');
{
  const lockOnly = regatta().changes.filter((c) => c.entryId === 'entry-2' && c.category === 'penalty').length;
  const r = store.dispatch(addResultChange({ entryId: 'entry-2', category: 'penalty', penaltySeconds: 15, reason: '计时员补记 OCS 处罚' }));
  check('手动加罚生效', r.ok);
  check('净用时增加 15 秒', buildStandings(regatta().entries, regatta().changes).find((x) => x.entryId === 'entry-2')!.netSeconds === 3194 + 15);
  void lockOnly;

  const wd = store.dispatch(addResultChange({ entryId: 'entry-2', category: 'withdrawal', reason: '船队赛前申请退赛' }));
  check('弃权生效', wd.ok);
  const row = buildStandings(regatta().entries, regatta().changes).find((x) => x.entryId === 'entry-2')!;
  check('弃权船无名次无净用时', row.outcome === 'withdrawal' && row.rank === null && row.netSeconds === null);

  const tc = store.dispatch(addResultChange({ entryId: 'entry-3', category: 'time_correction', correctedElapsed: 3100, reason: '终点计时修正' }));
  check('到线更正生效', tc.ok);
  const row3 = buildStandings(regatta().entries, regatta().changes).find((x) => x.entryId === 'entry-3')!;
  check('原始到线改为 3100，净用时 3160（含60秒罚）', row3.lockedElapsedSeconds === 3100 && row3.netSeconds === 3160);

  // 直接改到线录入在锁定后无效（saveArrival 不改 locked 值）
  store.dispatch(saveArrival({ id: 'entry-3', elapsedSeconds: 9999, note: '试图覆盖' }));
  check('锁定后录入不影响锁定值', regatta().entries.find((e) => e.id === 'entry-3')!.lockedElapsedSeconds === 3210);
}

console.log('\n[8] 发布：正式版冻结，之后另开更正版，旧版可查，重复发布幂等');
{
  const p1 = store.dispatch(publishStandings('第一轮正式成绩'));
  check('v1 正式版发布', p1.ok && p1.versionNo === 1);
  const v1 = regatta().standingsVersions.find((v) => v.versionNo === 1)!;
  check('v1 为正式版且未取代', v1.kind === 'official' && !v1.superseded);
  const snapshotRank = v1.rows.find((r) => r.entryId === 'entry-3')!.rank;

  // 无变化重复发布
  const dup = store.dispatch(publishStandings('再发一次'));
  check('无变化时拒绝重复发布', dup.ok && !!dup.idempotent);
  check('仍然只有一个版本', regatta().standingsVersions.length === 1);

  // 新变更 → 名次漂移 → 发更正版
  store.dispatch(addResultChange({ entryId: 'entry-3', category: 'penalty', penaltySeconds: 200, reason: '仲裁追加罚' }));
  const p2 = store.dispatch(publishStandings('根据追加处罚更正'));
  check('v2 更正版发布', p2.ok && p2.versionNo === 2);
  const versions = regatta().standingsVersions;
  check('v1 仍保留且标记被取代', versions.some((v) => v.versionNo === 1 && v.superseded));
  const v1b = versions.find((v) => v.versionNo === 1)!;
  check('v1 快照名次未被篡改', v1b.rows.find((r) => r.entryId === 'entry-3')!.rank === snapshotRank);
  const v2 = versions.find((v) => v.versionNo === 2)!;
  check('v2 为更正版', v2.kind === 'correction' && !v2.superseded);
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed > 0) process.exit(1);
