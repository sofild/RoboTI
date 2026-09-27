import { useEffect, useMemo, useState } from "react";
import { Button, Card, Col, Empty, Modal, Row, Segmented, Space, Spin, Tag, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { CheckpointRun, Metrics } from "../types";
import MetricsChart from "../components/MetricsChart";

/** 训练曲线缩略图（取 reward 主指标最后 N 个点）。 */
function Sparkline({ metrics }: { metrics: Metrics }) {
  const points = useMemo(() => {
    const tags = Object.keys(metrics).filter((t) => /reward/.test(t) && !/std|clip|ratio/.test(t));
    if (!tags.length) return null;
    const tag = tags[0];
    const { steps, values } = metrics[tag];
    if (steps.length < 2) return null;
    const tail = 60;
    const xs = steps.slice(-tail);
    const ys = values.slice(-tail);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const span = yMax - yMin || 1;
    const w = 200;
    const h = 44;
    return {
      path: ys.map((v, i) => {
        const x = (i / (ys.length - 1)) * w;
        const y = h - 3 - ((v - yMin) / span) * (h - 6);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" "),
      last: ys[ys.length - 1],
    };
  }, [metrics]);

  if (!points) return <div style={{ height: 44, color: "#666", fontSize: 12 }}>暂无曲线数据</div>;
  return (
    <div style={{ height: 44 }}>
      <svg width="100%" height={44} viewBox="0 0 200 44" preserveAspectRatio="none">
        <path d={points.path} fill="none" stroke="#13c2c2" strokeWidth="1.6" />
      </svg>
      <span style={{ fontSize: 12, color: "#5edede" }}>reward ≈ {points.last.toFixed(1)}</span>
    </div>
  );
}

const fmtTime = (t: number) => new Date(t * 1000).toLocaleString("zh-CN", { hour12: false });

export default function ModelHub() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<CheckpointRun[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [detail, setDetail] = useState<CheckpointRun | null>(null);
  const [detailMetrics, setDetailMetrics] = useState<Metrics | null>(null);
  // 每个 run 的 reward 曲线缓存
  const [metricsMap, setMetricsMap] = useState<Record<string, Metrics | null>>({});

  useEffect(() => {
    api.listAllCheckpoints().then(async (rs) => {
      setRuns(rs);
      setLoading(false);
      // 并发拉取各 run 的训练指标（画缩略曲线）；uploaded 等无任务 run 会失败，忽略
      const results = await Promise.all(
        rs.map(async (r) => [r.run, await api.getJobMetrics(r.run).catch(() => null)] as const),
      );
      setMetricsMap(Object.fromEntries(results));
    }).catch((e) => { setError(String(e.message)); setLoading(false); });
  }, []);

  const openDetail = (r: CheckpointRun) => {
    setDetail(r);
    setDetailMetrics(metricsMap[r.run] ?? null);
  };

  const filtered = useMemo(() => {
    if (filter === "all") return runs;
    if (filter === "joystick") return runs.filter((r) => !r.env || r.env === "joystick");
    return runs.filter((r) => r.env && r.env !== "joystick");
  }, [runs, filter]);

  if (error) return <Typography.Text type="danger">加载失败: {error}</Typography.Text>;
  if (loading) return <Spin tip="加载模型列表…" style={{ display: "block", marginTop: 80 }} />;

  const latestFile = (r: CheckpointRun) => r.files[r.files.length - 1];

  return (
    <>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 4 }}>
        <Typography.Title level={4} style={{ color: "#eee", margin: 0 }}>模型广场</Typography.Title>
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as string)}
          options={[
            { label: "全部", value: "all" },
            { label: "行走（101 维）", value: "joystick" },
            { label: "站立（85 维）", value: "standing" },
          ]}
        />
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        平台产出的全部策略模型。点击卡片查看训练曲线与文件详情，可一键回到查看器试跑。
      </Typography.Paragraph>

      {filtered.length === 0 ? (
        <Empty description="暂无模型，先去机器人项目训练一个吧" />
      ) : (
        <Row gutter={[16, 16]}>
          {filtered.map((r) => {
            const f = latestFile(r);
            return (
              <Col key={`${r.project}/${r.run}`} xs={24} md={12} lg={8}>
                <Card
                  hoverable
                  onClick={() => openDetail(r)}
                  title={<span style={{ fontSize: 14 }}>{r.run}</span>}
                  extra={<Tag color="cyan">{r.env || "未知环境"}</Tag>}
                >
                  <p style={{ color: "#bbb", marginBottom: 8 }}>
                    {r.display_name} ·{" "}
                    {r.num_timesteps > 0 ? `计划 ${r.num_timesteps.toLocaleString()} 步` : "外部上传"}
                  </p>
                  <Sparkline metrics={metricsMap[r.run] ?? {}} />
                  <p style={{ color: "#888", fontSize: 12, margin: "8px 0 0" }}>
                    {f ? `${f.name} · ${(f.size / 1024).toFixed(0)} KB · ${fmtTime(f.mtime)}` : "—"}
                  </p>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}

      <Modal
        open={!!detail}
        onCancel={() => setDetail(null)}
        width={760}
        title={detail ? `${detail.run}（${detail.display_name}）` : ""}
        footer={
          detail && (
            <Space>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => navigate(`/projects/${detail.project}?run=${detail.run}&policy=1`)}
              >
                在查看器中试跑
              </Button>
              <Link to={`/jobs/${detail.run}`}><Button>查看训练任务</Button></Link>
            </Space>
          )
        }
      >
        {detail && (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color="cyan">{detail.env || "未知环境"}</Tag>
              <Tag>ONNX 文件 {detail.files.length} 个</Tag>
              {detail.num_timesteps > 0 && <Tag>计划步数 {detail.num_timesteps.toLocaleString()}</Tag>}
            </Space>
            {detailMetrics && Object.keys(detailMetrics).length > 0 ? (
              <MetricsChart metrics={detailMetrics} />
            ) : (
              <Typography.Text type="secondary">无训练指标数据（外部上传或指标已清理）</Typography.Text>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
