import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button, Card, Col, Descriptions, Row, Space, Typography, message,
} from "antd";
import { StopOutlined, DownloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Artifacts, Job, Metrics } from "../types";
import JobStatusTag from "../components/JobStatusTag";
import MetricsChart from "../components/MetricsChart";

export default function JobView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [metrics, setMetrics] = useState<Metrics>({});
  const [artifacts, setArtifacts] = useState<Artifacts>({ checkpoints: [], onnx: [] });
  const [error, setError] = useState("");
  const logBoxRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [j, l, m, a] = await Promise.all([
        api.getJob(id),
        api.getJobLog(id, 300),
        api.getJobMetrics(id),
        api.getJobArtifacts(id),
      ]);
      setJob(j); setLog(l.log); setMetrics(m); setArtifacts(a);
    } catch (e: any) {
      setError(String(e.message));
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  // 运行中每 2 秒轮询；结束后降低频率继续刷新指标（writer 落盘有延迟）
  const isRunning = job?.status === "running" || job?.status === "stopping";
  useEffect(() => {
    const interval = isRunning ? 2000 : 8000;
    const t = setInterval(refresh, interval);
    return () => clearInterval(t);
  }, [isRunning, refresh]);

  // 日志自动滚动到底部
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [log]);

  const stop = async () => {
    if (!id) return;
    try {
      await api.stopJob(id);
      message.success("已发送停止信号");
      refresh();
    } catch (e: any) {
      message.error(`停止失败: ${e.message}`);
    }
  };

  if (error) return <Typography.Text type="danger">加载失败: {error}</Typography.Text>;
  if (!job) return <Typography.Text>加载中…</Typography.Text>;

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Title level={4} style={{ color: "#eee", margin: 0 }}>
        训练任务 {job.id} <JobStatusTag status={job.status} />
      </Typography.Title>

      <Card>
        <Row justify="space-between" align="top">
          <Descriptions size="small" column={3} style={{ flex: 1, minWidth: 0, marginRight: 24 }}>
            <Descriptions.Item label="项目">{job.project}</Descriptions.Item>
            <Descriptions.Item label="环境">{job.env}</Descriptions.Item>
            <Descriptions.Item label="任务">{job.task}</Descriptions.Item>
            <Descriptions.Item label="步数">{job.num_timesteps.toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="开始时间">{job.started_at ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="结束时间">{job.finished_at ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="退出码">{job.exit_code ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="输出目录" span={2}>
              <Typography.Text code>{job.output_dir}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="命令" span={3}>
              <Typography.Text code style={{ fontSize: 12 }}>{job.command}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          <Space size={8} style={{ alignSelf: "flex-start" }}>
            <Button
              danger
              icon={<StopOutlined />}
              disabled={!isRunning}
              onClick={stop}
            >
              停止训练
            </Button>
            <Button onClick={() => navigate(`/projects/${job.project}`)}>返回项目</Button>
          </Space>
        </Row>
      </Card>

      <Card title="训练指标" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>每 2 秒自动刷新</Typography.Text>}>
        <MetricsChart metrics={metrics} />
      </Card>

      <Card title="训练日志（尾部 300 行）">
        <div className="log-view" ref={logBoxRef}>{log || "（暂无输出）"}</div>
      </Card>

      <Card title="产物">
        <Row gutter={16}>
          <Col span={12}>
            <Typography.Text strong>Checkpoints</Typography.Text>
            {artifacts.checkpoints.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                暂无（训练过程中自动保存）
              </Typography.Paragraph>
            ) : (
              <ul style={{ marginTop: 8, paddingLeft: 18, color: "#ccc" }}>
                {artifacts.checkpoints.map((c) => (
                  <li key={c.name}>
                    <Typography.Text style={{ color: "#ccc" }}>{c.name}</Typography.Text>
                    <Typography.Text type="secondary">（{c.n_files} 个文件）</Typography.Text>
                  </li>
                ))}
              </ul>
            )}
          </Col>
          <Col span={12}>
            <Typography.Text strong>ONNX 模型</Typography.Text>
            {artifacts.onnx.length === 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                暂无（随 checkpoint 一起导出）
              </Typography.Paragraph>
            ) : (
              <ul style={{ marginTop: 8, paddingLeft: 18 }}>
                {artifacts.onnx.map((o) => (
                  <li key={o.name}>
                    <a href={`/api/jobs/${job.id}/download/${o.name}`} download>
                      <DownloadOutlined /> {o.name}
                    </a>
                    <Typography.Text type="secondary">（{(o.size / 1024).toFixed(0)} KB）</Typography.Text>
                  </li>
                ))}
              </ul>
            )}
          </Col>
        </Row>
      </Card>
    </Space>
  );
}
