import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest, addResultChange, applyProtestDecision, publishStandings,
  saveArrival, setRaceStatus, type ActionResult, type AppDispatch, type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import { buildStandings, formatDuration, hasUnpublishedDrift } from './ranking';
import { ChangeLogCard, StandingsTable, VersionHistoryCard } from './components';
import type { ChangeCategory, Protest, ProtestAction, RaceEntry, StandingRow } from './types';

const { Header, Content, Sider } = Layout;

const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

const arrivalSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive('到线用时必须大于 0'),
  note: z.string().max(120)
});

const changeSchema = z.object({
  entryId: z.string().min(1, '请选择参赛船'),
  category: z.enum(['time_correction', 'penalty', 'resail', 'withdrawal']),
  penaltySeconds: z.number().min(0),
  correctedElapsed: z.number().min(0),
  reason: z.string().min(2, '请填写变更原因')
});

type ChangeFormValues = z.infer<typeof changeSchema>;
function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function showActionResult(result: ActionResult, msgApi: ReturnType<typeof message.useMessage>[0]) {
  if (result.ok) {
    if (result.idempotent) msgApi.info(result.message);
    else msgApi.success(result.message);
  } else {
    msgApi.error(result.message);
  }
}

function useRegatta() {
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const versions = useSelector((state: RootState) => state.regatta.standingsVersions);
  const changeSeq = useSelector((state: RootState) => state.regatta.changeSeq);
  const locked = !!race?.lockedAt;
  // 比赛状态或裁决项一更新，这里立即重算；未发布名次永远是工作副本
  const standings = useMemo(
    () => buildStandings(entries, changes, { provisional: !locked }),
    [entries, changes, locked]
  );
  const drift = useMemo(() => hasUnpublishedDrift(versions, standings), [versions, standings]);
  return { race, locked, entries, changes, protests, timeline, versions, changeSeq, standings, drift };
}

type ManualCategory = Exclude<ChangeCategory, 'lock'>;

const changeCategoryOptions: Array<{ value: ManualCategory; label: string }> = [
  { value: 'time_correction', label: '到线更正（修正原始到线时间）' },
  { value: 'penalty', label: '加罚（增加净用时）' },
  { value: 'resail', label: '裁决重赛' },
  { value: 'withdrawal', label: '弃权（退赛）' }
];

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const { race, locked, entries, changes, changeSeq, standings } = useRegatta();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const boatOf = (entryId: string) => entries.find((entry) => entry.id === entryId)?.boat ?? entryId;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : race.status === 'finished' ? 'success' : 'default'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="到线成绩">
                {locked
                  ? <Tag color="blue">已于 {new Date(race.lockedAt!).toLocaleTimeString()} 锁定（记录版本 v{changeSeq}）</Tag>
                  : <Tag color="orange">未锁定，加罚 / 重赛 / 弃权需先结束比赛</Tag>}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} disabled={locked} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button type="primary" danger disabled={locked} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛并锁定到线成绩</Button>
              <Button disabled={locked} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
              {locked && <Tag color="default">成绩已锁定，如需调整请到成绩页登记变更项</Tag>}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <StandingsTable rows={standings} title={`${t('control')} · 当前名次`} locked={locked} />
        </Col>
      </Row>
      <Row gutter={[18, 18]}>
        <Col xs={24}>
          <ChangeLogCard changes={changes} boatOf={boatOf} compact />
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const [msgApi, contextHolder] = message.useMessage();
  const { race, locked, entries, changes, versions, changeSeq, standings, drift } = useRegatta();

  const arrivalForm = useForm<z.infer<typeof arrivalSchema>>({
    resolver: zodResolver(arrivalSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, note: '' }
  });

  const changeForm = useForm<ChangeFormValues>({
    resolver: zodResolver(changeSchema),
    defaultValues: { entryId: entries[0]?.id, category: 'penalty', penaltySeconds: 30, correctedElapsed: 3200, reason: '' }
  });
  const category = changeForm.watch('category');

  const boatOf = (entryId: string) => entries.find((entry) => entry.id === entryId)?.boat ?? entryId;

  const onArrival = (values: z.infer<typeof arrivalSchema>) => {
    dispatch(saveArrival(values));
    msgApi.success('到线成绩已录入（结束比赛时统一锁定）');
    arrivalForm.reset({ id: values.id, elapsedSeconds: values.elapsedSeconds, note: '' });
  };

  const onChange = (values: ChangeFormValues) => {
    const result = dispatch(addResultChange({
      entryId: values.entryId,
      category: values.category,
      penaltySeconds: values.penaltySeconds,
      correctedElapsed: values.correctedElapsed,
      reason: values.reason
    }));
    showActionResult(result, msgApi);
    if (result.ok) changeForm.reset({ ...values, reason: '' });
  };

  const [publishNote, setPublishNote] = useState('');
  const onPublish = () => {
    const result = dispatch(publishStandings(publishNote));
    showActionResult(result, msgApi);
    if (result.ok) setPublishNote('');
  };
  const latestVersion = versions[versions.length - 1];

  return (
    <>
      {contextHolder}
      {!locked && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }}
          message="比赛尚未结束"
          description="到线成绩尚未锁定：现在录入的是原始到线时间；结束比赛后自动锁定，之后的加罚、重赛、弃权必须作为新的变更项登记，不能直接覆盖。" />
      )}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={8}>
          <Card title="到线成绩录入（锁定前）" extra={<Tag color={locked ? 'default' : 'orange'}>{locked ? '已锁定' : '可录入'}</Tag>}>
            {locked ? (
              <Empty description="到线成绩已锁定，不能直接修改；如需更正请在中间卡片登记“到线更正”变更项" />
            ) : (
              <Form layout="vertical" onFinish={arrivalForm.handleSubmit(onArrival)}>
                <Form.Item label="参赛船" validateStatus={arrivalForm.formState.errors.id ? 'error' : undefined} help={arrivalForm.formState.errors.id?.message}>
                  <select {...arrivalForm.register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
                </Form.Item>
                <Form.Item label="到线用时（秒）" validateStatus={arrivalForm.formState.errors.elapsedSeconds ? 'error' : undefined} help={arrivalForm.formState.errors.elapsedSeconds?.message}>
                  <Input type="number" {...arrivalForm.register('elapsedSeconds', { valueAsNumber: true })} />
                </Form.Item>
                <Form.Item label="备注"><Input.TextArea rows={2} {...arrivalForm.register('note')} /></Form.Item>
                <Button htmlType="submit" type="primary">录入到线</Button>
              </Form>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="赛后变更项（参与名次计算）" extra={<Tag color={locked ? 'blue' : 'default'}>记录版本 v{changeSeq}</Tag>}>
            <Form layout="vertical" onFinish={changeForm.handleSubmit(onChange)}>
              <Form.Item label="参赛船" validateStatus={changeForm.formState.errors.entryId ? 'error' : undefined} help={changeForm.formState.errors.entryId?.message}>
                <select {...changeForm.register('entryId')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="变更类型">
                <Select
                  value={category}
                  onChange={(value) => changeForm.setValue('category', value as ManualCategory)}
                  options={changeCategoryOptions}
                />
              </Form.Item>
              {category === 'penalty' && (
                <Form.Item label="加罚秒数">
                  <Input type="number" {...changeForm.register('penaltySeconds', { valueAsNumber: true })} />
                </Form.Item>
              )}
              {category === 'time_correction' && (
                <Form.Item label="更正后的到线用时（秒）">
                  <Input type="number" {...changeForm.register('correctedElapsed', { valueAsNumber: true })} />
                </Form.Item>
              )}
              <Form.Item label="变更原因" validateStatus={changeForm.formState.errors.reason ? 'error' : undefined} help={changeForm.formState.errors.reason?.message}>
                <Input.TextArea rows={3} {...changeForm.register('reason')} />
              </Form.Item>
              <Button htmlType="submit" type="primary" icon={<PlusOutlined />} disabled={!locked}>登记变更项</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="发布正式名次" extra={<Badge status={drift ? 'processing' : 'success'} text={drift ? '待发布' : '已同步'} />}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                发布时对当前名次做不可变快照；首次为正式版，此后如有变化则另开更正版，旧版本保留查证。
              </Typography.Text>
              <Input.TextArea rows={2} placeholder="发布说明（可选）" value={publishNote} onChange={(event) => setPublishNote(event.target.value)} />
              <Button type="primary" block disabled={!locked || !drift} onClick={onPublish}>
                {versions.length === 0 ? '发布正式名次' : `发布更正版（v${versions.length} → v${versions.length + 1}）`}
              </Button>
              {!drift && latestVersion && <Tag color="green">当前名次与 v{latestVersion.versionNo} 一致</Tag>}
            </Space>
          </Card>
        </Col>
      </Row>
      <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
        <Col xs={24}>
          <StandingsTable
            rows={standings}
            locked={locked}
            drift={drift}
            title={`工作名次（按生效变更项实时重算）${race.lockedAt ? ` · 锁定于 ${new Date(race.lockedAt).toLocaleTimeString()}` : ''}`}
          />
        </Col>
      </Row>
      <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
        <Col xs={24} lg={12}>
          <ChangeLogCard changes={changes} boatOf={boatOf} />
        </Col>
        <Col xs={24} lg={12}>
          <VersionHistoryCard versions={versions} />
        </Col>
      </Row>
    </>
  );
}

/* ---------------- 并发裁决：两位裁判席 ---------------- */

interface JuryBenchProps {
  protest: Protest;
  judgeName: string;
  judgeRole: string;
  seatColor: string;
  boatOf: (entryId: string) => string;
  entries: RaceEntry[];
}

function JuryBench({ protest, judgeName, judgeRole, seatColor, boatOf, entries }: JuryBenchProps) {
  const dispatch = useDispatch<AppDispatch>();
  const changeSeq = useSelector((state: RootState) => state.regatta.changeSeq);
  const changes = useSelector((state: RootState) => state.regatta.changes);
  const [msgApi, contextHolder] = message.useMessage();

  // 打开面板时读到的版本号：另一方先裁决后，这里会落后于全局 changeSeq
  const [baseVersion, setBaseVersion] = useState(changeSeq);
  const [penalty, setPenalty] = useState(30);
  const [conflict, setConflict] = useState<ActionResult['conflict'] | null>(null);

  const sync = () => {
    setBaseVersion(changeSeq);
    setConflict(null);
    msgApi.info(`已刷新到当前版本 v${changeSeq}`);
  };

  // 裁决动作：先到的一方与当前版本一致 → 生效；后到的一方收到版本冲突与当前名次
  const submit = (action: ProtestAction, overrideVersion?: number) => {
    const version = overrideVersion ?? baseVersion;
    const result = dispatch(applyProtestDecision({
      id: protest.id,
      action,
      penaltySeconds: penalty,
      decision: '',
      baseVersion: version
    }));
    if (result.ok) {
      showActionResult(result, msgApi);
      setConflict(null);
      // 用哪个版本提交，生效后就推进到其后；继续处理时若仍落后，角标会标红
      setBaseVersion(version + 1);
    } else if (result.conflict) {
      setConflict(result.conflict);
      msgApi.error('版本冲突：对方裁决先生效，请查看当前名次后重试');
    } else {
      msgApi.error(result.message);
    }
  };

  const conflictRows: StandingRow[] = conflict?.currentStandings ?? buildStandings(entries, changes);
  const stale = baseVersion !== changeSeq;

  return (
    <Card
      type="inner"
      title={<Tag color={seatColor}>{judgeName} · {judgeRole}</Tag>}
      extra={<Space size={4}>
        <Tag color={stale ? 'red' : 'green'}>持有 v{baseVersion}{stale ? ` / 当前 v${changeSeq}` : ''}</Tag>
        <Button size="small" onClick={sync}>刷新版本</Button>
      </Space>}
    >
      {contextHolder}
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Typography.Text type="secondary">
          处理 {boatOf(protest.entryId)} 的 {protest.rule} 抗议。两人同时点裁决时，先到的生效。
        </Typography.Text>
        <Space wrap>
          <Input type="number" value={penalty} onChange={(event) => setPenalty(Number(event.target.value) || 0)} style={{ width: 90 }} addonAfter="秒" />
          <Button size="small" type="primary" onClick={() => submit('penalty')}>支持并加罚</Button>
          <Button size="small" style={{ color: '#ad6800', borderColor: '#d48806' }} onClick={() => submit('resail')}>改判重赛</Button>
          <Button size="small" onClick={() => submit('withdrawal')}>裁决弃权</Button>
          <Button size="small" danger onClick={() => submit('reject')}>驳回维持原判</Button>
        </Space>
        {conflict && (
          <Alert
            type="error"
            showIcon
            message={`版本冲突：你持有 v${conflict.expected}，记录已经是 v${conflict.actual}`}
            description={
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <span>对方的裁决已先生效，以下是按最新变更项重算后的当前名次；可带着新版本重试，已生效变更保留，同一处罚不会计两遍。</span>
                <Table
                  rowKey="entryId"
                  size="small"
                  pagination={false}
                  dataSource={conflictRows}
                  columns={[
                    { title: '名次', dataIndex: 'rank', width: 56, render: (rank: number | null) => rank ?? '—' },
                    { title: '船', dataIndex: 'boat' },
                    { title: '加罚', dataIndex: 'penaltySeconds', width: 72, render: (secs: number) => secs > 0 ? `+${secs}s` : '—' },
                    { title: '净用时', render: (_v, r: StandingRow) => r.netSeconds === null ? '—' : formatDuration(r.netSeconds) }
                  ]}
                />
                <Space>
                  <Button size="small" type="primary" onClick={() => submit('penalty', conflict.actual)}>以 v{conflict.actual} 重试加罚</Button>
                  <Button size="small" onClick={sync}>放弃并刷新到最新版本</Button>
                </Space>
              </Space>
            }
          />
        )}
      </Space>
    </Card>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const { protests, timeline, entries, changes, changeSeq, locked } = useRegatta();
  const [msgApi, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({
    resolver: zodResolver(protestSchema),
    defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' }
  });
  const submitProtest = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    msgApi.success('抗议已登记，等待复核');
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
  const boatOf = (entryId: string) => entries.find((entry) => entry.id === entryId)?.boat ?? entryId;

  // 常规队列：始终以最新版本号提交；失败时已生效的变更保留，可重试
  const decide = (item: Protest, action: ProtestAction) => {
    const result = dispatch(applyProtestDecision({
      id: item.id, action, penaltySeconds: 30, decision: '', baseVersion: changeSeq
    }));
    showActionResult(result, msgApi);
  };

  const activeProtest = protests.find((item) => item.status === 'reviewing' || item.status === 'submitted') ?? protests[0];

  return (
    <>
      {contextHolder}
      {!locked && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="到线成绩尚未锁定：抗议可登记与复核；加罚 / 重赛 / 弃权类裁决需在结束比赛后生效。" />}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={9}>
          <Card title="提交抗议">
            <Form layout="vertical" onFinish={handleSubmit(submitProtest)}>
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
          <Card title="冲突复核队列" extra={<Tag>记录 v{changeSeq}</Tag>}>
            {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
              <List.Item>
                <List.Item.Meta
                  title={<Space wrap>
                    <Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'success' : 'default'}>{item.status}</Tag>
                    {item.rule}
                    {item.appliedAction && <Tag color="purple">已裁决：{item.appliedAction}</Tag>}
                  </Space>}
                  description={
                    <Space direction="vertical" size={0}>
                      <div>{item.reason}</div>
                      <small>{boatOf(item.entryId)} · 提交于 {new Date(item.createdAt).toLocaleString()}</small>
                      {item.decision && <div style={{ color: '#7a4b00' }}>结论：{item.decision}</div>}
                    </Space>
                  }
                />
                <Space direction="vertical">
                  <Button size="small" disabled={item.status === 'reviewing'} onClick={() => decide(item, 'reviewing')}>进入复核</Button>
                  <Button size="small" type="primary" disabled={item.status === 'resolved' || !locked} onClick={() => decide(item, 'penalty')}>接受并加罚30秒</Button>
                  <Button size="small" danger disabled={item.status === 'rejected'} onClick={() => decide(item, 'reject')}>驳回</Button>
                </Space>
              </List.Item>
            )} />}
          </Card>
        </Col>
        <Col xs={24} lg={6}>
          <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : event.type === 'result' ? 'green' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
        </Col>
      </Row>
      <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
        <Col span={24}>
          <Card
            title={<Space><SafetyCertificateOutlined />两人同时处理同一抗议（乐观锁演示）</Space>}
            extra={activeProtest ? <Tag color="blue">{boatOf(activeProtest.entryId)} · {activeProtest.rule} · {activeProtest.status}</Tag> : undefined}
          >
            {activeProtest ? (
              <Row gutter={18}>
                <Col xs={24} lg={12}>
                  <JuryBench protest={activeProtest} judgeName="宋宁" judgeRole="仲裁主席（裁判席 A）" seatColor="blue" boatOf={boatOf} entries={entries} />
                </Col>
                <Col xs={24} lg={12}>
                  <JuryBench protest={activeProtest} judgeName="陈港" judgeRole="竞赛官（裁判席 B）" seatColor="purple" boatOf={boatOf} entries={entries} />
                </Col>
              </Row>
            ) : <Empty description="暂无可处理的抗议" />}
          </Card>
        </Col>
      </Row>
      <Row gutter={[18, 18]} style={{ marginTop: 18 }}>
        <Col span={24}>
          <ChangeLogCard changes={changes} boatOf={boatOf} />
        </Col>
      </Row>
    </>
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
