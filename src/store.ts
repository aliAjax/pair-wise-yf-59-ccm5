import { configureStore, createSlice, type AnyAction, type PayloadAction, type ThunkAction } from '@reduxjs/toolkit';
import { raceApi } from './api';
import { buildStandings } from './ranking';
import type {
  AppState, ChangeCategory, Protest, ProtestAction, ProtestStatus, Race,
  RaceEntry, ResultChange, StandingRow, StandingsVersion
} from './types';

const STORAGE_KEY = 'regatta-control-v1';
const SCHEMA_VERSION = 2;

type AppThunk<ReturnType> = ThunkAction<ReturnType, { regatta: AppState }, unknown, AnyAction>;

const nowIso = () => new Date().toISOString();

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, lockedElapsedSeconds: null, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, lockedElapsedSeconds: null, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, lockedElapsedSeconds: null, resultStatus: 'official', note: '' }
];

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialState: AppState = {
  schemaVersion: SCHEMA_VERSION,
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled', lockedAt: null }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString(), baseVersion: 0, appliedAction: null, appliedChangeId: null, resolvedAt: null }],
  changes: [],
  standingsVersions: [],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  changeSeq: 0
};

/* ---------------- 旧数据迁移：v1（无变更记录）→ v2 ---------------- */

export function migrate(raw: Partial<AppState> & Record<string, unknown>): AppState {
  if (raw.schemaVersion === SCHEMA_VERSION) return raw as AppState;

  const races: Race[] = (raw.races as Race[] | undefined) ?? [];
  const legacyEntries = (raw.entries as Array<Partial<RaceEntry>> | undefined) ?? [];
  const locked = races.some((race) => race.status === 'finished');
  const lockedAt = locked ? nowIso() : null;

  const changes: ResultChange[] = [];
  const entries: RaceEntry[] = legacyEntries.map((entry) => ({
    id: entry.id!,
    boat: entry.boat ?? '',
    sailNo: entry.sailNo ?? '',
    skipper: entry.skipper ?? '',
    elapsedSeconds: entry.elapsedSeconds ?? 0,
    penaltySeconds: entry.penaltySeconds ?? 0,
    lockedElapsedSeconds: locked ? (entry.elapsedSeconds ?? 0) : null,
    resultStatus: entry.resultStatus,
    note: entry.note ?? ''
  }));

  races.forEach((race) => { race.lockedAt = lockedAt; });

  if (locked) {
    // 旧数据没有锁定记录，迁移时补登锁定项与遗留加罚，保证名次与旧版一致
    for (const entry of entries) {
      changes.push({
        id: crypto.randomUUID(), raceId: races[0]?.id ?? 'race-1', entryId: entry.id,
        category: 'lock', source: 'migration', penaltySeconds: 0,
        reason: '数据升级：补登结束时锁定的到线成绩', state: 'active', createdAt: lockedAt!
      });
      if ((entry.penaltySeconds ?? 0) > 0) {
        changes.push({
          id: crypto.randomUUID(), raceId: races[0]?.id ?? 'race-1', entryId: entry.id,
          category: 'penalty', source: 'migration', penaltySeconds: entry.penaltySeconds!,
          reason: `数据升级：保留原有 ${entry.penaltySeconds} 秒处罚`, state: 'active', createdAt: lockedAt!
        });
      }
    }
  }

  const protests: Protest[] = ((raw.protests as Protest[] | undefined) ?? []).map((protest) => ({
    ...protest,
    baseVersion: 0,
    appliedAction: null,
    appliedChangeId: null,
    resolvedAt: protest.status === 'resolved' || protest.status === 'rejected' ? protest.createdAt : null
  }));

  let standingsVersions: StandingsVersion[] = [];
  if (locked && entries.some((entry) => entry.resultStatus === 'official')) {
    standingsVersions = [{
      id: crypto.randomUUID(),
      versionNo: 1,
      kind: 'official',
      publishedAt: lockedAt!,
      note: '数据升级：补登已发布正式成绩',
      rows: buildStandings(entries, changes),
      superseded: false
    }];
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    races,
    entries,
    protests,
    changes,
    standingsVersions,
    timeline: (raw.timeline as AppState['timeline']) ?? [],
    changeSeq: changes.length
  };
}

function loadState(): AppState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return initialState;
    return migrate(JSON.parse(stored) as Partial<AppState> & Record<string, unknown>);
  } catch {
    return initialState;
  }
}

/* ---------------- Slice：只做原子提交，冲突/幂等在 thunk 判定 ---------------- */

interface CommitFinishPayload { id: string }
interface CommitDecisionPayload {
  protestId: string;
  status: ProtestStatus;
  action: ProtestAction;
  decision: string;
  change: { category: ChangeCategory; penaltySeconds: number; reason: string } | null;
  revertChangeId: string | null;
}
interface CommitManualChangePayload {
  raceId: string;
  entryId: string;
  category: ChangeCategory;
  penaltySeconds: number;
  correctedElapsed: number | null;
  reason: string;
  source: ResultChange['source'];
}
interface CommitPublishPayload { version: StandingsVersion; drift: boolean }

const slice = createSlice({
  name: 'regatta',
  initialState: loadState,
  reducers: {
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = {
        id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '',
        createdAt: nowIso(), baseVersion: state.changeSeq, appliedAction: null, appliedChangeId: null, resolvedAt: null
      };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },
    /** 锁定前的到线录入：直接改原始成绩，不产生变更项 */
    saveArrival(state, action: PayloadAction<{ id: string; elapsedSeconds: number; note: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.note = action.payload.note;
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'result', message: `${entry.boat} 到线成绩录入为 ${action.payload.elapsedSeconds} 秒` });
    },
    commitRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status']; withLock: CommitFinishPayload | null }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (!race) return;
      race.status = action.payload.status;
      if (action.payload.withLock) {
        const lockedAt = nowIso();
        race.lockedAt = lockedAt;
        // 比赛一结束，先锁定全部到线成绩：每条船一个 lock 变更项
        for (const entry of state.entries) {
          entry.lockedElapsedSeconds = entry.elapsedSeconds;
          state.changes.unshift({
            id: crypto.randomUUID(), raceId: race.id, entryId: entry.id, category: 'lock',
            source: 'race_control', penaltySeconds: 0, reason: '比赛结束，锁定到线成绩', state: 'active', createdAt: lockedAt
          });
        }
        state.changeSeq += 1;
        state.timeline.unshift({ id: crypto.randomUUID(), time: lockedAt, type: 'race', message: `${race.name} 结束，${state.entries.length} 条到线成绩已锁定，后续加罚/重赛/弃权均以变更项记录` });
      } else {
        state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    commitDecision(state, action: PayloadAction<CommitDecisionPayload>) {
      const data = action.payload;
      const protest = state.protests.find((item) => item.id === data.protestId);
      if (!protest) return;

      if (data.revertChangeId) {
        const previous = state.changes.find((change) => change.id === data.revertChangeId);
        if (previous) previous.state = 'reverted';
      }

      let newChangeId: string | null = null;
      if (data.change) {
        const change: ResultChange = {
          id: crypto.randomUUID(), raceId: protest.raceId, entryId: protest.entryId,
          category: data.change.category, source: 'protest',
          penaltySeconds: data.change.penaltySeconds, reason: data.change.reason,
          protestId: protest.id, state: 'active', createdAt: nowIso()
        };
        state.changes.unshift(change);
        newChangeId = change.id;
      }

      protest.status = data.status;
      protest.decision = data.decision;
      protest.appliedAction = data.action;
      protest.appliedChangeId = newChangeId;
      protest.resolvedAt = data.status === 'resolved' || data.status === 'rejected' ? nowIso() : null;
      state.changeSeq += 1;
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 裁决：${data.decision}${data.revertChangeId ? '（原处罚已撤销，未重复计罚）' : ''}` });
    },
    commitManualChange(state, action: PayloadAction<CommitManualChangePayload>) {
      const data = action.payload;
      const entry = state.entries.find((item) => item.id === data.entryId);
      const change: ResultChange = {
        id: crypto.randomUUID(), raceId: data.raceId, entryId: data.entryId,
        category: data.category, source: data.source,
        penaltySeconds: data.penaltySeconds,
        reason: data.correctedElapsed !== null ? `到线更正为 ${data.correctedElapsed} 秒：${data.reason}` : data.reason,
        refId: data.correctedElapsed !== null ? String(data.correctedElapsed) : undefined,
        state: 'active', createdAt: nowIso()
      };
      state.changes.unshift(change);
      state.changeSeq += 1;
      state.timeline.unshift({
        id: crypto.randomUUID(), time: change.createdAt, type: 'result',
        message: entry ? `${entry.boat} 新增变更项：${data.category}${data.penaltySeconds ? ` +${data.penaltySeconds}秒` : ''}` : `新增 ${data.category} 变更项`
      });
    },
    commitPublish(state, action: PayloadAction<CommitPublishPayload>) {
      const { version } = action.payload;
      const latest = [...state.standingsVersions].sort((a, b) => b.versionNo - a.versionNo)[0];
      if (latest) latest.superseded = true;
      state.standingsVersions.push(version);
      state.changeSeq += 1;
      state.timeline.unshift({ id: crypto.randomUUID(), time: version.publishedAt, type: 'result', message: `名次 v${version.versionNo}（${version.kind === 'official' ? '正式发布' : '更正版'}）已对外发布，旧版本冻结留查` });
    }
  }
});

export const { addProtest, saveArrival, commitRaceStatus, commitDecision, commitManualChange, commitPublish } = slice.actions;

/* ---------------- Thunks：版本冲突、幂等、发布快照 ---------------- */

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 乐观锁冲突：后提交一方拿到对方版本与当前名次 */
  conflict?: { expected: number; actual: number; currentStandings: StandingRow[] };
  /** 重试命中已生效裁决：不重复计罚 */
  idempotent?: boolean;
  versionNo?: number;
}

const terminalActions: ProtestAction[] = ['penalty', 'reject', 'resail', 'withdrawal'];

function changeForAction(action: Exclude<ProtestAction, 'reviewing' | 'reject'>, penaltySeconds: number, reason: string): CommitDecisionPayload['change'] {
  if (action === 'penalty') return { category: 'penalty', penaltySeconds, reason };
  return { category: action, penaltySeconds: 0, reason };
}

/**
 * 提交抗议裁决（进入复核 / 支持加罚 / 驳回 / 改判重赛 / 弃权）。
 * baseVersion 为打开裁决面板时读到的 changeSeq：先到的一方生效，
 * 后到的一方收到版本冲突与当前名次，可带着新版本重试。
 */
export function applyProtestDecision(payload: {
  id: string;
  action: ProtestAction;
  decision: string;
  penaltySeconds?: number;
  baseVersion: number;
}): AppThunk<ActionResult> {
  return (dispatch, getState) => {
    const state = getState().regatta;
    const protest = state.protests.find((item) => item.id === payload.id);
    if (!protest) return { ok: false, message: '抗议不存在' };

    // 乐观锁：版本不一致说明另一方的裁决先生效
    if (payload.baseVersion !== state.changeSeq) {
      return {
        ok: false,
        message: `版本冲突：记录已从 v${payload.baseVersion} 更新到 v${state.changeSeq}，对方裁决先生效，请查看当前名次后重试`,
        conflict: { expected: payload.baseVersion, actual: state.changeSeq, currentStandings: buildStandings(state.entries, state.changes) }
      };
    }

    const race = state.races.find((item) => item.id === protest.raceId);
    const locked = !!race?.lockedAt;
    const terminal = terminalActions.includes(payload.action);

    if (!locked && terminal && payload.action !== 'reject') {
      return { ok: false, message: '比赛尚未结束、到线成绩未锁定，不能裁决加罚 / 重赛 / 弃权' };
    }

    const isTerminalStatus = protest.status === 'resolved' || protest.status === 'rejected';

    // 终局后的提交：要么是同一裁决重试（幂等），要么是改判（撤销原变更后追加新变更）
    if (isTerminalStatus) {
      if (payload.action === 'reviewing') {
        return { ok: false, message: '抗议已有终局裁决，不能回到复核；如需调整请直接改判' };
      }
      if (protest.appliedAction === payload.action) {
        if (payload.action === 'penalty') {
          const activePenalty = state.changes.find(
            (change) => change.protestId === protest.id && change.category === 'penalty' && change.state === 'active'
          );
          const requested = Math.max(0, Math.trunc(payload.penaltySeconds ?? 0));
          // 同动作且同秒数才是重试：保留生效变更，不再追加
          if (activePenalty && activePenalty.penaltySeconds === requested) {
            return { ok: true, idempotent: true, message: `该 ${requested} 秒处罚此前已生效，本次重试未重复计罚` };
          }
          if (requested <= 0) return { ok: false, message: '加罚秒数必须大于 0；如需取消处罚请改判驳回/重赛' };
          // 秒数不同 → 落入改判流程：旧罚撤销，新罚生效
        } else {
          const category = payload.action;
          const already = state.changes.some((change) => change.protestId === protest.id && change.category === category && change.state === 'active');
          if (already) return { ok: true, idempotent: true, message: '该裁决此前已生效，本次重试未重复记录' };
        }
      }
    }

    if (payload.action === 'reviewing') {
      if (protest.status === 'reviewing') return { ok: true, idempotent: true, message: '抗议已在复核中' };
      dispatch(commitDecision({ protestId: protest.id, status: 'reviewing', action: 'reviewing', decision: payload.decision || protest.decision, change: null, revertChangeId: null }));
      return { ok: true, message: '抗议已进入复核' };
    }

    if (payload.action === 'reject') {
      dispatch(commitDecision({
        protestId: protest.id, status: 'rejected', action: 'reject',
        decision: payload.decision || '证据不足，维持原成绩',
        change: null,
        // 改判为驳回：撤销此前该抗议产生的变更
        revertChangeId: isTerminalStatus && protest.appliedChangeId ? protest.appliedChangeId : null
      }));
      return { ok: true, message: '抗议已驳回，维持原成绩' };
    }

    const penalty = Math.max(0, Math.trunc(payload.penaltySeconds ?? 0));
    if (payload.action === 'penalty' && penalty <= 0) {
      return { ok: false, message: '加罚秒数必须大于 0' };
    }
    const reason = payload.decision || (payload.action === 'penalty' ? `支持抗议，加罚 ${penalty} 秒` : payload.action === 'resail' ? '支持抗议，裁决重赛' : '裁决弃权');
    dispatch(commitDecision({
      protestId: protest.id,
      status: 'resolved',
      action: payload.action,
      decision: reason,
      change: changeForAction(payload.action, penalty, reason),
      // 改判：原裁决变更先撤销，新裁决才参与名次，保证同一处罚不重叠
      revertChangeId: isTerminalStatus && protest.appliedChangeId ? protest.appliedChangeId : null
    }));
    return { ok: true, message: payload.action === 'penalty' ? `裁决已生效：加罚 ${penalty} 秒，名次已重算` : '裁决已生效，名次已重算' };
  };
}

/** 结束比赛：锁定全部到线成绩；重复结束不会二次锁定 */
export function setRaceStatus(payload: { id: string; status: Race['status'] }): AppThunk<void> {
  return (dispatch, getState) => {
    const race = getState().regatta.races.find((item) => item.id === payload.id);
    if (!race) return;
    const needsLock = payload.status === 'finished' && !race.lockedAt;
    dispatch(commitRaceStatus({ id: payload.id, status: payload.status, withLock: needsLock ? { id: payload.id } : null }));
  };
}

/** 成绩页手动追加变更项（到线更正 / 加罚 / 重赛 / 弃权），锁定后一律走变更记录 */
export function addResultChange(payload: {
  entryId: string;
  category: Exclude<ChangeCategory, 'lock'>;
  penaltySeconds?: number;
  correctedElapsed?: number | null;
  reason: string;
}): AppThunk<ActionResult> {
  return (dispatch, getState) => {
    const state = getState().regatta;
    const race = state.races[0];
    if (!race?.lockedAt) return { ok: false, message: '比赛尚未结束：请在结束比赛、锁定到线成绩后再登记变更项' };
    if (payload.category === 'penalty' && !(payload.penaltySeconds && payload.penaltySeconds > 0)) {
      return { ok: false, message: '加罚秒数必须大于 0' };
    }
    if (payload.category === 'time_correction' && !(payload.correctedElapsed && payload.correctedElapsed > 0)) {
      return { ok: false, message: '更正后的到线用时必须大于 0' };
    }
    if (!payload.reason.trim()) return { ok: false, message: '请填写变更原因' };
    dispatch(commitManualChange({
      raceId: race.id,
      entryId: payload.entryId,
      category: payload.category,
      penaltySeconds: payload.category === 'penalty' ? Math.trunc(payload.penaltySeconds ?? 0) : 0,
      correctedElapsed: payload.category === 'time_correction' ? Math.trunc(payload.correctedElapsed ?? 0) : null,
      reason: payload.reason.trim(),
      source: 'results'
    }));
    return { ok: true, message: '变更项已记录，未发布名次已立即重算' };
  };
}

/** 发布名次：首次为正式版，之后名次有变化则另开更正版；已发布版本不可变 */
export function publishStandings(note: string): AppThunk<ActionResult> {
  return (dispatch, getState) => {
    const state = getState().regatta;
    const race = state.races[0];
    if (!race?.lockedAt) return { ok: false, message: '比赛尚未结束，到线成绩锁定后才能发布名次' };
    const current = buildStandings(state.entries, state.changes);
    const latest = [...state.standingsVersions].sort((a, b) => b.versionNo - a.versionNo)[0];
    if (latest) {
      const sameRankings = latest.rows.length === current.length
        && latest.rows.every((row, index) => {
          const other = current[index];
          return !!other && row.rank === other.rank && row.entryId === other.entryId && row.outcome === other.outcome && row.netSeconds === other.netSeconds;
        });
      if (sameRankings) return { ok: true, idempotent: true, message: `当前名次与 v${latest.versionNo} 完全一致，无需重复发布` };
    }
    const versionNo = (latest?.versionNo ?? 0) + 1;
    dispatch(commitPublish({
      version: {
        id: crypto.randomUUID(),
        versionNo,
        kind: versionNo === 1 ? 'official' : 'correction',
        publishedAt: nowIso(),
        note: note.trim() || (versionNo === 1 ? '正式发布' : '名次更正发布'),
        rows: current,
        superseded: false
      },
      drift: true
    }));
    return { ok: true, versionNo, message: `名次 v${versionNo}（${versionNo === 1 ? '正式版' : '更正版'}）已发布，旧版本已冻结留查` };
  };
}

/* ---------------- Store 装配与持久化 ---------------- */

const preloadedState = loadState();

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware),
  preloadedState: { regatta: preloadedState }
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
