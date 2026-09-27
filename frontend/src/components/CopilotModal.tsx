import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Input, Modal, Popconfirm, Space, Spin, Tabs, Tag, Typography, message,
} from "antd";
import {
  CaretRightOutlined, DeleteOutlined, ExperimentOutlined, RocketOutlined, CopyOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { GenerateResult, GeneratedEnv } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  project: string;
  onEnvGenerated: (envName: string) => void; // 生成成功后刷新项目详情
}

/** unified diff 行渲染（环境工坊页复用） */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre
      style={{
        margin: 0, padding: 12, maxHeight: 420, overflow: "auto", fontSize: 12,
        lineHeight: 1.5, background: "#0d1117", borderRadius: 6,
      }}
    >
      {lines.map((l, i) => {
        let color = "#c9d1d9";
        let bg = "transparent";
        if (l.startsWith("+")) { color = "#3fb950"; bg = "rgba(46,160,67,0.15)"; }
        else if (l.startsWith("-")) { color = "#f85149"; bg = "rgba(248,81,73,0.15)"; }
        else if (l.startsWith("@@")) { color = "#58a6ff"; }
        return (
          <div key={i} style={{ color, background: bg, whiteSpace: "pre" }}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}

export default function CopilotModal({ open, onClose, project, onEnvGenerated }: Props) {
  const navigate = useNavigate();
  const [requirement, setRequirement] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [existing, setExisting] = useState<GeneratedEnv[]>([]);
  const [viewCode, setViewCode] = useState<{ env: string; code: string } | null>(null);
  const [sandboxing, setSandboxing] = useState(false);

  const refreshList = useCallback(() => {
    api.copilotList(project).then(setExisting).catch(() => setExisting([]));
  }, [project]);

  useEffect(() => {
    if (open) refreshList();
  }, [open, refreshList]);

  const generate = async () => {
    if (!requirement.trim()) return;
    setGenerating(true);
    setResult(null);
    try {
      const r = await api.copilotGenerate(project, { requirement });
      setResult(r);
      refreshList();
      if (r.registered) {
        message.success(`环境 ${r.env_name} 生成并通过检查，已注册`);
        onEnvGenerated(r.env_name);
      } else {
        message.warning(`环境 ${r.env_name} 已生成但未通过检查，请查看详情`);
      }
    } catch (e: any) {
      message.error(`生成失败: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const sandboxRun = async (envName: string) => {
    setSandboxing(true);
    try {
      const job = await api.startTraining(project, {
        env: envName, task: "flat_terrain", num_timesteps: 3_000_000,
      });
      message.success(`沙箱试跑已提交（任务 ${job.id}）`);
      onClose();
      navigate(`/jobs/${job.id}`);
    } catch (e: any) {
      message.error(`试跑提交失败: ${e.message}`);
    } finally {
      setSandboxing(false);
    }
  };

  const viewExisting = async (env: string) => {
    try {
      const r = await api.copilotRead(project, env);
      setViewCode({ env, code: r.code });
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const removeEnv = async (env: string) => {
    try {
      await api.copilotDelete(project, env);
      message.success(`已删除 ${env}`);
      setViewCode(null);
      refreshList();
      onEnvGenerated("");
    } catch (e: any) {
      message.error(e.message);
    }
  };

  return (
    <Modal
      title="AI 生成训练任务（Copilot）"
      open={open}
      onCancel={onClose}
      width={700}
      footer={null}
      destroyOnClose
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <div>
          <Typography.Text type="secondary">
            描述你想要的机器人行为，LLM 将基于现有骨架与 reward 库生成训练环境
            （仅生成 reward / 配置 / 命令逻辑，模板约束，不改动现有代码）
          </Typography.Text>
          <Input.TextArea
            style={{ marginTop: 8 }}
            rows={4}
            placeholder={"示例：让机器人在站立的同时做摇头动作——头部 head_yaw 关节跟踪一个频率 0.5Hz、幅度 ±1.0rad 的正弦目标，身体保持不动"}
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            disabled={generating}
          />
        </div>

        <Button type="primary" loading={generating} onClick={generate} disabled={!requirement.trim()}>
          {generating ? "生成中（约 1-5 分钟，含静态检查）…" : "生成训练环境"}
        </Button>

        {result && (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Space>
              <Typography.Text strong>环境名:</Typography.Text>
              <Tag color={result.check_ok ? "green" : "red"}>{result.env_name}</Tag>
              {result.check_ok
                ? <Tag color="green">静态检查通过 · 已注册</Tag>
                : <Tag color="red">静态检查未通过 · 未注册</Tag>}
              <Button
                size="small" icon={<CopyOutlined />}
                onClick={() => { navigator.clipboard.writeText(result.code); message.success("已复制"); }}
              >
                复制代码
              </Button>
            </Space>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
              文件: {result.file}
            </Typography.Paragraph>
            <pre
              style={{
                margin: 0, padding: 10, background: "#0d1117", color: result.check_ok ? "#3fb950" : "#f85149",
                borderRadius: 6, fontSize: 12, maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap",
              }}
            >
              {result.check_output}
            </pre>
            <Tabs
              items={[
                {
                  key: "diff",
                  label: "与骨架 Diff",
                  children: <DiffView diff={result.diff} />,
                },
                {
                  key: "code",
                  label: "生成代码",
                  children: (
                    <pre
                      style={{
                        margin: 0, padding: 12, maxHeight: 420, overflow: "auto", fontSize: 12,
                        lineHeight: 1.5, background: "#0d1117", color: "#c9d1d9", borderRadius: 6,
                      }}
                    >
                      {result.code}
                    </pre>
                  ),
                },
              ]}
            />
            {result.check_ok && (
              <Space>
                <Button
                  icon={<ExperimentOutlined />} loading={sandboxing}
                  onClick={() => sandboxRun(result.env_name)}
                >
                  沙箱试跑（300 万步）
                </Button>
                <Button icon={<RocketOutlined />} onClick={() => { onClose(); onEnvGenerated(result.env_name); }}>
                  去发起完整训练
                </Button>
              </Space>
            )}
          </Space>
        )}

        {existing.length > 0 && (
          <div>
            <Typography.Text strong>已生成环境</Typography.Text>
            <Space direction="vertical" size={6} style={{ marginTop: 8, width: "100%" }}>
              {existing.map((g) => (
                <Space key={g.env_name} style={{ justifyContent: "space-between", width: "100%" }}>
                  <a onClick={() => viewExisting(g.env_name)}>{g.env_name}</a>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{g.file}</Typography.Text>
                  <Space>
                    <Button size="small" icon={<CaretRightOutlined />} onClick={() => sandboxRun(g.env_name)}>
                      试跑
                    </Button>
                    <Popconfirm title={`删除环境 ${g.env_name}？`} onConfirm={() => removeEnv(g.env_name)}>
                      <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                  </Space>
                </Space>
              ))}
            </Space>
            {viewCode && (
              <pre
                style={{
                  marginTop: 10, padding: 12, maxHeight: 300, overflow: "auto", fontSize: 12,
                  background: "#0d1117", color: "#c9d1d9", borderRadius: 6,
                }}
              >
                {viewCode.code}
              </pre>
            )}
          </div>
        )}
      </Space>
    </Modal>
  );
}
