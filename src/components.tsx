import { Badge, Card, Empty, List, Space, Table, Tag, Typography } from 'antd';
import { ClockCircleOutlined, HistoryOutlined } from '@ant-design/icons';
import type { ResultChange, StandingRow, StandingsVersion } from './types';
import { categoryLabel, formatDuration, outcomeLabel } from './ranking';

const outcomeColor: Record<StandingRow['outcome'], string> = {
  finished: 'green',
  resail: 'gold',
  withdrawal: 'default'
};

interface StandingsTableProps {
  rows: StandingRow[];
  title?: string;
  extra?: React.ReactNode;
  locked: boolean;
  /** 相对最近发布版本是否有待发布变化 */
  drift?: boolean;
}

export function StandingsTable({ rows, title = '当前名次（未发布实时重算）', extra, locked, drift }: StandingsTableProps) {
  return (
    <Card
      title={title}
      extra={<Space>
        {locked && drift !== undefined && (
          <Badge status={drift ? 'processing' : 'success'} text={drift ? '有未发布变化' : '与发布版一致'} />
        )}
        {!locked && <Tag color="default">到线成绩尚未锁定（临时）</Tag>}
        {extra}
      </Space>}
    >
      <Table rowKey="entryId" pagination={false} dataSource={rows} size="middle" columns={[
        { title: '名次', dataIndex: 'rank', width: 72, render: (rank: number | null) => rank ?? '—' },
        { title: '船名', dataIndex: 'boat' },
        { title: '帆号', dataIndex: 'sailNo' },
        { title: '原始到线', render: (_v, r: StandingRow) => <span title={`${r.lockedElapsedSeconds ?? ''} 秒`}>{formatDuration(r.lockedElapsedSeconds)}</span> },
        { title: '生效加罚', dataIndex: 'penaltySeconds', width: 92, render: (secs: number) => secs > 0 ? <Tag color="volcano">+{secs}s</Tag> : '—' },
        {
          title: '净用时', render: (_v, r: StandingRow) => r.netSeconds === null
            ? '—'
            : <b title={`${r.netSeconds} 秒`}>{formatDuration(r.netSeconds)}</b>
        },
        {
          title: '形态', render: (_v, r: StandingRow) =>
            <Tag color={outcomeColor[r.outcome]}>{outcomeLabel[r.outcome]}</Tag>
        }
      ]} />
    </Card>
  );
}

const changeColor: Record<ResultChange['category'], string> = {
  lock: 'blue',
  time_correction: 'geekblue',
  penalty: 'volcano',
  resail: 'gold',
  withdrawal: 'default'
};

const sourceLabel: Record<ResultChange['source'], string> = {
  race_control: '竞赛控制',
  results: '成绩页',
  protest: '抗议裁决',
  migration: '数据迁移'
};

interface ChangeLogCardProps {
  changes: ResultChange[];
  boatOf: (entryId: string) => string;
  title?: string;
  compact?: boolean;
}

/** 赛后变更记录：三页共用同一份数据，按时间倒序展示，已撤销项灰显留痕 */
export function ChangeLogCard({ changes, boatOf, title = '赛后变更记录', compact }: ChangeLogCardProps) {
  return (
    <Card title={<Space><HistoryOutlined />{title}</Space>} extra={<Tag>{changes.length} 项</Tag>}>
      {changes.length === 0 ? <Empty description={compact ? '锁定后在此生成变更项' : '比赛结束并锁定到线成绩后，加罚、重赛、弃权都会在此登记'} /> : (
        <List
          size={compact ? 'small' : 'default'}
          dataSource={changes}
          renderItem={(change) => (
            <List.Item style={{ opacity: change.state === 'reverted' ? 0.45 : 1 }}>
              <List.Item.Meta
                title={
                  <Space wrap>
                    <Tag color={changeColor[change.category]}>{categoryLabel[change.category]}</Tag>
                    <b>{boatOf(change.entryId)}</b>
                    {change.category === 'penalty' && <Tag color="volcano">+{change.penaltySeconds}s</Tag>}
                    <Tag>{sourceLabel[change.source]}</Tag>
                    {change.state === 'reverted' && <Tag color="default">已撤销（被改判回滚）</Tag>}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={0}>
                    <span>{change.reason}</span>
                    <small>{new Date(change.createdAt).toLocaleString()}</small>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

interface VersionHistoryCardProps {
  versions: StandingsVersion[];
}

/** 已发布名次版本：正式版/更正版均为不可变快照，旧版本留作查证 */
export function VersionHistoryCard({ versions }: VersionHistoryCardProps) {
  const sorted = [...versions].sort((a, b) => b.versionNo - a.versionNo);
  return (
    <Card title={<Space><ClockCircleOutlined />已发布名次版本（旧版冻结留查）</Space>}>
      {sorted.length === 0 ? <Empty description="尚未发布名次" /> : (
        <List
          dataSource={sorted}
          renderItem={(version) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <Space wrap>
                    <Typography.Text strong>v{version.versionNo}</Typography.Text>
                    <Tag color={version.kind === 'official' ? 'green' : 'orange'}>{version.kind === 'official' ? '正式版' : '更正版'}</Tag>
                    {version.superseded && <Tag>已被后续版本取代</Tag>}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <span>{version.note}</span>
                    <small>发布时间：{new Date(version.publishedAt).toLocaleString()}</small>
                    <Table
                      rowKey="entryId"
                      size="small"
                      pagination={false}
                      dataSource={version.rows}
                      columns={[
                        { title: '名次', dataIndex: 'rank', width: 60, render: (rank: number | null) => rank ?? '—' },
                        { title: '船名', dataIndex: 'boat' },
                        { title: '帆号', dataIndex: 'sailNo' },
                        { title: '净用时', render: (_v, r: StandingRow) => r.netSeconds === null ? outcomeLabel[r.outcome] : `${formatDuration(r.netSeconds)}（${r.netSeconds}s）` }
                      ]}
                    />
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}
