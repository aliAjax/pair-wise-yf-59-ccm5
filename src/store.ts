import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  ConflictInfo,
  Protest,
  ProtestStatus,
  Publication,
  Race,
  RaceEntry,
  ResultChange,
  TimelineEvent
} from './types';
import { computeStandings } from './standings';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  changes: ResultChange[];
  publications: Publication[];
  timeline: TimelineEvent[];
  /** 后提交一方遇到的版本冲突信息 */
  conflict: ConflictInfo | null;
}

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '' }
];

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialState: AppState = {
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled' }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', version: 1, createdAt: now.toISOString() }],
  changes: [],
  publications: [],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  conflict: null
};

const STORAGE_KEY = 'regatta-control-v1';

/** 升级迁移：补齐新字段，旧数据正常打开 */
function migrate(raw: Partial<AppState> | null): AppState {
  if (!raw) return initialState;
  const state: AppState = {
    races: raw.races ?? initialState.races,
    entries: raw.entries ?? initialState.entries,
    protests: raw.protests ?? initialState.protests,
    timeline: raw.timeline ?? initialState.timeline,
    changes: raw.changes ?? [],
    publications: raw.publications ?? [],
    conflict: null
  };
  state.races = state.races.map((race) => ({
    ...race,
    lockedAt: race.lockedAt ?? (race.status === 'finished' ? new Date(0).toISOString() : undefined)
  }));
  state.entries = state.entries.map((entry) => ({
    ...entry,
    finishSeconds: entry.finishSeconds ?? entry.elapsedSeconds
  }));
  state.protests = state.protests.map((protest) => ({ ...protest, version: protest.version ?? 1 }));
  // 升级前的处罚秒数迁移为遗留变更项，保证名次不丢罚
  for (const entry of state.entries) {
    if (entry.penaltySeconds > 0 && !state.changes.some((c) => c.entryId === entry.id && c.legacy && c.type === 'penalty')) {
      state.changes.push({
        id: crypto.randomUUID(),
        raceId: state.races[0]?.id ?? 'race-1',
        entryId: entry.id,
        type: 'penalty',
        deltaSeconds: entry.penaltySeconds,
        reason: '升级前处罚记录',
        status: 'active',
        version: 1,
        legacy: true,
        createdAt: new Date(0).toISOString()
      });
    }
  }
  return state;
}

function loadState(): AppState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return migrate(initialState);
    return migrate(JSON.parse(stored) as Partial<AppState>);
  } catch {
    return migrate(initialState);
  }
}

/** 比赛结束：锁定到线成绩，之后名次只随变更项变动 */
function lockFinishResults(state: AppState, race: Race) {
  race.lockedAt = new Date().toISOString();
  for (const entry of state.entries) {
    if (entry.finishSeconds == null) entry.finishSeconds = entry.elapsedSeconds;
  }
  state.timeline.unshift({
    id: crypto.randomUUID(),
    time: race.lockedAt,
    type: 'race',
    message: `${race.name} 已结束，到线成绩锁定，加罚/重赛/弃权作为变更项参与名次计算`
  });
}

/** 版本冲突时构造冲突信息（含当前名次） */
function buildConflict(state: AppState, protest: Protest, message: string, alreadyHandled = false): ConflictInfo {
  const race = state.races.find((r) => r.id === protest.raceId);
  return {
    protestId: protest.id,
    currentVersion: protest.version,
    currentStatus: protest.status,
    message,
    alreadyHandled,
    standings: computeStandings(state.entries, state.changes, race)
  };
}

const slice = createSlice({
  name: 'regatta',
  initialState: loadState(),
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (!race) return;
      const wasFinished = race.status === 'finished';
      race.status = action.payload.status;
      if (action.payload.status === 'finished' && !wasFinished) lockFinishResults(state, race);
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        type: 'race',
        message: `${race.name} 状态更新为 ${race.status}`
      });
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      // 同步升级前遗留的处罚变更项
      const legacy = state.changes.find((c) => c.entryId === entry.id && c.legacy && c.type === 'penalty');
      if (action.payload.penaltySeconds > 0) {
        if (legacy) legacy.deltaSeconds = action.payload.penaltySeconds;
        else state.changes.push({
          id: crypto.randomUUID(), raceId: state.races[0]?.id ?? 'race-1', entryId: entry.id,
          type: 'penalty', deltaSeconds: action.payload.penaltySeconds, reason: '升级前处罚记录',
          status: 'active', version: 1, legacy: true, createdAt: new Date().toISOString()
        });
      } else if (legacy) {
        legacy.status = 'void';
      }
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒` });
    },
    /** 新增赛后变更项（加罚/重赛/弃权/补偿/更正） */
    addChange(state, action: PayloadAction<{ raceId: string; entryId: string; type: ResultChange['type']; deltaSeconds: number; reason: string }>) {
      const entry = state.entries.find((item) => item.id === action.payload.entryId);
      if (!entry) return;
      const change: ResultChange = {
        id: crypto.randomUUID(),
        raceId: action.payload.raceId,
        entryId: action.payload.entryId,
        type: action.payload.type,
        deltaSeconds: action.payload.deltaSeconds,
        reason: action.payload.reason,
        status: 'active',
        version: 1,
        createdAt: new Date().toISOString()
      };
      state.changes.unshift(change);
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: change.createdAt,
        type: 'result',
        message: `${entry.boat} ${change.type === 'penalty' ? '加罚' : change.type === 'rerun' ? '重赛' : change.type === 'waiver' ? '弃权' : change.type === 'redress' ? '补偿' : '更正'} ${action.payload.deltaSeconds > 0 ? '+' : ''}${action.payload.deltaSeconds}s：${action.payload.reason}`
      });
    },
    /** 作废变更项（生效变更保留，可作废） */
    voidChange(state, action: PayloadAction<{ id: string }>) {
      const change = state.changes.find((c) => c.id === action.payload.id);
      if (!change) return;
      change.status = 'void';
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `变更项已作废：${change.reason}` });
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', version: 1, createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },
    /** 进入复核等状态流转（带乐观并发版本） */
    transitionProtest(state, action: PayloadAction<{ id: string; expectedVersion: number; status: ProtestStatus }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      if (protest.version !== action.payload.expectedVersion) {
        state.conflict = buildConflict(state, protest, '抗议状态已被他人更新，请确认当前名次后重试');
        return;
      }
      protest.version += 1;
      protest.status = action.payload.status;
      state.conflict = null;
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 更新为 ${action.payload.status}` });
    },
    /**
     * 裁决抗议（接受处罚/弃权/驳回）。
     * 乐观并发：expectedVersion 与当前版本不一致时不生效，返回版本冲突与当前名次；
     * 已处理的抗议不重复生成变更项，同一处罚不能计两遍。
     */
    handleProtest(state, action: PayloadAction<{
      id: string;
      expectedVersion: number;
      status: 'resolved' | 'rejected';
      decision: string;
      changeType?: ResultChange['type'];
      deltaSeconds?: number;
    }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      if (protest.version !== action.payload.expectedVersion) {
        state.conflict = buildConflict(state, protest, '抗议已被他人先处理，版本冲突；生效变更保留，可重试查看当前名次');
        return;
      }
      if (protest.status === 'resolved' || protest.status === 'rejected') {
        state.conflict = buildConflict(state, protest, '该抗议已被处理，生效变更保留', true);
        return;
      }
      protest.version += 1;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision;
      if (action.payload.status === 'resolved' && action.payload.changeType && action.payload.deltaSeconds) {
        // 幂等：同一抗议只生成一个生效变更项
        const exists = state.changes.some((c) => c.protestId === protest.id && c.status === 'active');
        if (!exists) {
          state.changes.unshift({
            id: crypto.randomUUID(),
            raceId: protest.raceId,
            entryId: protest.entryId,
            type: action.payload.changeType,
            deltaSeconds: action.payload.deltaSeconds,
            reason: action.payload.decision,
            protestId: protest.id,
            status: 'active',
            version: 1,
            createdAt: new Date().toISOString()
          });
        }
      }
      state.conflict = null;
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 裁决为 ${action.payload.status}` });
    },
    clearConflict(state) {
      state.conflict = null;
    },
    /** 发布正式名次：生成一个版本快照；已有发布则为更正版，旧版本保留供查证 */
    publishResults(state, action: PayloadAction<{ raceId: string; note: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race) return;
      const live = computeStandings(state.entries, state.changes, race);
      const previous = state.publications.filter((p) => p.raceId === action.payload.raceId);
      const version = previous.length ? Math.max(...previous.map((p) => p.version)) + 1 : 1;
      const publication: Publication = {
        id: crypto.randomUUID(),
        raceId: race.id,
        version,
        publishedAt: new Date().toISOString(),
        note: action.payload.note,
        trigger: version === 1 ? 'publish' : 'correction',
        standings: live.map((s) => ({
          rank: s.rank,
          entryId: s.entryId,
          boat: s.boat,
          sailNo: s.sailNo,
          finishSeconds: s.finishSeconds,
          deltaSeconds: s.deltaSeconds,
          totalSeconds: s.totalSeconds,
          waived: s.waived
        }))
      };
      state.publications.push(publication);
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: publication.publishedAt,
        type: 'result',
        message: version === 1
          ? `正式名次 v${version} 已发布`
          : `正式名次更正版 v${version} 已发布（旧版本保留供查证）`
      });
    }
  }
});

export const {
  setRaceStatus,
  saveResult,
  addChange,
  voidChange,
  addProtest,
  transitionProtest,
  handleProtest,
  clearConflict,
  publishResults
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
