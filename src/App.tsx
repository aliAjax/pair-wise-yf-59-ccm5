import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Modal, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addChange,
  addProtest,
  clearConflict,
  handleProtest,
  publishResults,
  saveResult,
  setRaceStatus,
  transitionProtest,
  voidChange,
  type AppDispatch,
  type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import { CHANGE_TYPE_LABEL, computeStandings, entryResultStatus, findChangedSince } from './standings';
import type { ChangeType, ProtestStatus, RaceEntry, ResultChange } from './types';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});
const changeTypes: ChangeType[] = ['penalty', 'rerun', 'waiver', 'redress', 'correction'];

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const live = useMemo(() => computeStandings(entries, changes, race), [entries, changes, race]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            {race.status === 'finished' && race.lockedAt && (
              <Alert style={{ marginTop: 12 }} type="info" showIcon message={`到线成绩已于 ${new Date(race.lockedAt).toLocaleString()} 锁定`} description="加罚、重赛、弃权作为变更项参与名次计算" />
            )}
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{live.length} 艘参赛船</Tag>}>
            <Table rowKey="entryId" pagination={false} dataSource={live} columns={[
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', render: (_v, r) => entries.find((e) => e.id === r.entryId)?.skipper },
              { title: '到线成绩', dataIndex: 'finishSeconds' },
              { title: '变更合计', render: (_v, r) => <span style={{ color: r.deltaSeconds > 0 ? '#cf1322' : r.deltaSeconds < 0 ? '#389e0d' : undefined }}>{r.deltaSeconds > 0 ? '+' : ''}{r.deltaSeconds}</span> },
              { title: '有效成绩', dataIndex: 'totalSeconds' },
              { title: '状态', render: (_v, r) => {
                const status = entryResultStatus(entries.find((e) => e.id === r.entryId) as RaceEntry, live, race);
                return <Space><Tag color={status === 'official' ? 'green' : status === 'corrected' ? 'orange' : 'default'}>{status}</Tag>{r.waived && <Tag color="red">弃权</Tag>}</Space>;
              } }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const publications = useSelector((state: RootState) => state.regatta.publications);
  const [api, contextHolder] = message.useMessage();
  const live = useMemo(() => computeStandings(entries, changes, race), [entries, changes, race]);
  const latestPublication = useMemo(
    () => publications.filter((p) => p.raceId === race.id).sort((a, b) => b.version - a.version)[0],
    [publications, race.id]
  );
  const unpublished = useMemo(() => findChangedSince(live, latestPublication), [live, latestPublication]);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const submit = (values: z.infer<typeof resultSchema>) => {
    dispatch(saveResult({ ...values, official: false }));
    api.success('成绩已更正并进入待发布状态');
    reset();
  };

  // 赛后变更项录入
  const [changeEntry, setChangeEntry] = useState(entries[0]?.id ?? '');
  const [changeType, setChangeType] = useState<ChangeType>('penalty');
  const [changeDelta, setChangeDelta] = useState(30);
  const [changeReason, setChangeReason] = useState('');
  const changeDeltaDefault = (type: ChangeType) => (type === 'penalty' ? 30 : type === 'redress' ? -30 : 0);
  const submitChange = () => {
    if (!changeEntry || changeReason.trim().length < 2) { api.error('请填写完整变更信息（原因至少2个字）'); return; }
    dispatch(addChange({ raceId: race.id, entryId: changeEntry, type: changeType, deltaSeconds: changeDelta, reason: changeReason.trim() }));
    api.success('变更项已录入，未发布名次已重算');
    setChangeReason('');
  };

  const [publishNote, setPublishNote] = useState('');
  const publish = () => {
    dispatch(publishResults({ raceId: race.id, note: publishNote.trim() || '发布正式成绩' }));
    api.success('正式名次已发布，旧版本保留供查证');
    setPublishNote('');
  };

  const raceChanges = changes.filter((c) => c.raceId === race.id);

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Row gutter={[18, 18]}>
          <Col xs={24} lg={10}>
            {race.status !== 'finished' ? (
              <Card title="成绩更正（比赛未结束）">
                <Alert style={{ marginBottom: 12 }} type="info" showIcon message="比赛结束后到线成绩将锁定" description="加罚、重赛、弃权将作为变更项参与名次计算，不再直接覆盖净用时" />
                <Form layout="vertical" onFinish={handleSubmit(submit)}>
                  <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                    <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
                  </Form.Item>
                  <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
                  <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
                  <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
                  <Button htmlType="submit" type="primary">保存更正</Button>
                </Form>
              </Card>
            ) : (
              <Card title="赛后变更项">
                <Alert style={{ marginBottom: 12 }} type="info" showIcon message="到线成绩已锁定" description="加罚、重赛、弃权、补偿、更正均作为新的变更项参与名次计算" />
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  <Select style={{ width: '100%' }} value={changeEntry} onChange={setChangeEntry} options={entries.map((e) => ({ value: e.id, label: `${e.boat} / ${e.sailNo}` }))} />
                  <Select style={{ width: '100%' }} value={changeType} onChange={(t) => { setChangeType(t); setChangeDelta(changeDeltaDefault(t)); }} options={changeTypes.map((t) => ({ value: t, label: CHANGE_TYPE_LABEL[t] }))} />
                  <Input addonBefore="变更秒数" type="number" value={changeDelta} onChange={(e) => setChangeDelta(Number(e.target.value))} />
                  <Input.TextArea rows={2} placeholder="变更原因（至少2个字）" value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />
                  <Button type="primary" icon={<PlusOutlined />} onClick={submitChange}>录入变更项</Button>
                </Space>
              </Card>
            )}
          </Col>
          <Col xs={24} lg={14}>
            <Card title="未发布名次" extra={unpublished.length > 0 ? <Tag color="orange">{unpublished.length} 条未发布更正</Tag> : <Tag color="green">与正式版本一致</Tag>}>
              <Table size="small" rowKey="entryId" pagination={false} dataSource={live} columns={[
                { title: '排名', render: (_v, _r, i) => i + 1, width: 56 },
                { title: '船名', dataIndex: 'boat' },
                { title: '到线成绩', dataIndex: 'finishSeconds' },
                { title: '变更合计', render: (_v, r) => <span style={{ color: r.deltaSeconds > 0 ? '#cf1322' : r.deltaSeconds < 0 ? '#389e0d' : undefined }}>{r.deltaSeconds > 0 ? '+' : ''}{r.deltaSeconds}</span> },
                { title: '有效成绩', dataIndex: 'totalSeconds' },
                { title: '状态', render: (_v, r) => {
                  const entry = entries.find((e) => e.id === r.entryId);
                  const status = entry ? entryResultStatus(entry, live, race, latestPublication) : 'provisional';
                  return <Tag color={status === 'official' ? 'green' : status === 'corrected' ? 'orange' : 'default'}>{status}</Tag>;
                } }
              ]} />
              {race.status === 'finished' && (
                <Space style={{ marginTop: 16 }}>
                  <Input style={{ width: 240 }} placeholder="发布说明（可选）" value={publishNote} onChange={(e) => setPublishNote(e.target.value)} />
                  <Button type="primary" onClick={publish}>发布正式成绩</Button>
                </Space>
              )}
            </Card>
          </Col>
        </Row>

        {race.status === 'finished' && (
          <Row gutter={[18, 18]}>
            <Col xs={24} lg={12}>
              <Card title="变更项记录">
                {raceChanges.length === 0 ? <Empty /> : (
                  <List dataSource={raceChanges} renderItem={(c: ResultChange) => {
                    const boat = entries.find((e) => e.id === c.entryId)?.boat;
                    return (
                      <List.Item actions={c.status === 'active' ? [<Button key="void" size="small" danger onClick={() => dispatch(voidChange({ id: c.id }))}>作废</Button>] : []}>
                        <List.Item.Meta
                          title={<Space><Tag color={c.status === 'active' ? 'blue' : 'default'}>{CHANGE_TYPE_LABEL[c.type]}</Tag>{c.legacy && <Tag>升级前</Tag>}<span>{boat}</span><span style={{ color: c.deltaSeconds > 0 ? '#cf1322' : '#389e0d' }}>{c.deltaSeconds > 0 ? '+' : ''}{c.deltaSeconds}s</span></Space>}
                          description={<><div>{c.reason}</div><small>{new Date(c.createdAt).toLocaleString()}</small></>}
                        />
                      </List.Item>
                    );
                  }} />
                )}
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card title="正式名次版本（旧版本留档查证）">
                {publications.filter((p) => p.raceId === race.id).length === 0 ? <Empty /> : (
                  <List dataSource={[...publications].filter((p) => p.raceId === race.id).sort((a, b) => b.version - a.version)} renderItem={(pub) => (
                    <List.Item>
                      <List.Item.Meta
                        title={<Space><Tag color={pub.trigger === 'correction' ? 'orange' : 'green'}>v{pub.version}</Tag>{pub.trigger === 'correction' && <Tag color="orange">更正版</Tag>}<small>{new Date(pub.publishedAt).toLocaleString()}</small></Space>}
                        description={<><div>{pub.note}</div><Table size="small" rowKey="entryId" pagination={false} dataSource={pub.standings} columns={[
                          { title: '排名', dataIndex: 'rank', width: 56 },
                          { title: '船名', dataIndex: 'boat' },
                          { title: '有效成绩', dataIndex: 'totalSeconds' },
                          { title: '变更', render: (_v, s) => <span>{s.deltaSeconds > 0 ? '+' : ''}{s.deltaSeconds}</span> }
                        ]} /></>}
                      />
                    </List.Item>
                  )} />
                )}
              </Card>
            </Col>
          </Row>
        )}
      </Space>
    </>
  );
}

type PendingAction =
  | { kind: 'handle'; id: string; status: 'resolved' | 'rejected'; decision: string; changeType?: ChangeType; deltaSeconds?: number }
  | { kind: 'transition'; id: string; status: ProtestStatus };

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const conflict = useSelector((state: RootState) => state.regatta.conflict);
  const [penaltyById, setPenaltyById] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<PendingAction | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };

  useEffect(() => { if (!conflict) setPending(null); }, [conflict]);

  const penaltyOf = (id: string) => penaltyById[id] ?? 30;
  const review = (item: { id: string; version: number }) => {
    setPending({ kind: 'transition', id: item.id, status: 'reviewing' });
    dispatch(transitionProtest({ id: item.id, expectedVersion: item.version, status: 'reviewing' }));
  };
  const decide = (item: { id: string; version: number }, status: 'resolved' | 'rejected', decision: string, changeType?: ChangeType, deltaSeconds?: number) => {
    setPending({ kind: 'handle', id: item.id, status, decision, changeType, deltaSeconds });
    dispatch(handleProtest({ id: item.id, expectedVersion: item.version, status, decision, changeType, deltaSeconds }));
  };
  const retry = () => {
    if (!conflict || !pending) return;
    if (pending.kind === 'handle') {
      dispatch(handleProtest({ id: pending.id, expectedVersion: conflict.currentVersion, status: pending.status, decision: pending.decision, changeType: pending.changeType, deltaSeconds: pending.deltaSeconds }));
    } else {
      dispatch(transitionProtest({ id: pending.id, expectedVersion: conflict.currentVersion, status: pending.status }));
    }
  };
  const closeConflict = () => { dispatch(clearConflict()); setPending(null); };

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'green' : item.status === 'rejected' ? 'red' : 'default'}>{item.status}</Tag><Tag>v{item.version}</Tag>{item.rule}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}{item.decision ? ` · ${item.decision}` : ''}</small></>}
              />
              <Space direction="vertical">
                <Button size="small" onClick={() => review(item)}>进入复核</Button>
                <Space>
                  <Input style={{ width: 90 }} size="small" type="number" value={penaltyOf(item.id)} onChange={(e) => setPenaltyById((m) => ({ ...m, [item.id]: Number(e.target.value) }))} />
                  <span>秒</span>
                </Space>
                <Button size="small" type="primary" onClick={() => decide(item, 'resolved', `接受抗议并处以 ${penaltyOf(item.id)} 秒处罚`, 'penalty', penaltyOf(item.id))}>接受并处罚</Button>
                <Button size="small" onClick={() => decide(item, 'resolved', '弃权处理', 'waiver', 0)}>弃权</Button>
                <Button size="small" danger onClick={() => decide(item, 'rejected', '证据不足，维持原成绩')}>驳回</Button>
              </Space>
            </List.Item>
          )} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
      <Modal
        open={!!conflict}
        title="版本冲突"
        onOk={retry}
        onCancel={closeConflict}
        okText="重试"
        cancelText="关闭"
        okButtonProps={{ disabled: !pending }}
      >
        {conflict && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert type="warning" showIcon message={conflict.message} />
            <div>当前版本：<Tag>v{conflict.currentVersion}</Tag>状态：{conflict.currentStatus}</div>
            <div>当前名次（生效变更已保留）：</div>
            <Table size="small" rowKey="entryId" pagination={false} dataSource={conflict.standings} columns={[
              { title: '排名', render: (_v, _r, i) => i + 1, width: 56 },
              { title: '船名', dataIndex: 'boat' },
              { title: '到线成绩', dataIndex: 'finishSeconds' },
              { title: '变更合计', render: (_v, s) => <span>{s.deltaSeconds > 0 ? '+' : ''}{s.deltaSeconds}</span> },
              { title: '有效成绩', dataIndex: 'totalSeconds' }
            ]} />
          </Space>
        )}
      </Modal>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space><Tag>{data.length} 名值班人员</Tag><Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button></Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/protests" element={<ProtestsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
