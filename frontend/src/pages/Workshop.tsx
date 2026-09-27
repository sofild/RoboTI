/**
 * 环境工坊：把"一句话生成"升级为结构化表单。
 * 勾选行为模板 + 填参数 → 自动拼装 requirement → 走现有 copilot/generate 管线。
 * 同时集中管理已生成环境（查看代码 / 沙箱试跑 / 删除）。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Card, Checkbox, Col, Empty, Input, InputNumber, Popconfirm, Row, Select, Space,
  Spin, Tabs, Tag, Typography, message,
} from "antd";
import {
  CaretRightOutlined, CopyOutlined, DeleteOutlined, ExperimentOutlined, RocketOutlined, ToolOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { GenerateResult, GeneratedEnv, Project } from "../types";
import { DiffView } from "../components/CopilotModal";

/** 行为模板：勾选后按参数拼装进 requirement */
interface BehaviorTpl {
  id: string;
  label: string;
  desc: string;
  params?: { key: string; label: string; def: number; min: number; max: number; step: number; unit: string }[];
  build: (p: Record<string, number>) => string;
}

const BEHAVIORS: BehaviorTpl[] = [
  {
    id: "stand",
    label: "站立稳定",
    desc: "保持躯干直立、高度稳定，无位移",
    build: () => "机器人保持站立稳定：躯干直立不倾倒，重心高度基本不变，不产生移动",
  },
  {
    id: "walk",
    label: "行走前进",
    desc: "按目标速度行走，可调 vx",
    params: [{ key: "vx", label: "前进速度", def: 0.1, min: 0.01, max: 0.15, step: 0.01, unit: "m/s" }],
    build: (p) => `机器人以约 ${p.vx} m/s 的速度稳定向前行走，速度跟踪偏差要小`,
  },
  {
    id: "head_swing",
    label: "头部左右摇头",
    desc: "head_yaw 跟踪正弦目标",
    params: [
      { key: "amp", label: "幅度", def: 1.0, min: 0.2, max: 2.7, step: 0.1, unit: "rad" },
      { key: "freq", label: "频率", def: 0.5, min: 0.1, max: 2, step: 0.1, unit: "Hz" },
    ],
    build: (p) => `头部 head_yaw 关节跟踪频率 ${p.freq}Hz、幅度 ±${p.amp}rad 的正弦目标（摇头动作）`,
  },
  {
    id: "head_nod",
    label: "头部俯仰点头",
    desc: "head_pitch 跟踪正弦目标",
    params: [
      { key: "amp", label: "幅度", def: 0.4, min: 0.1, max: 0.78, step: 0.05, unit: "rad" },
      { key: "freq", label: "频率", def: 0.5, min: 0.1, max: 2, step: 0.1, unit: "Hz" },
    ],
    build: (p) => `头部 head_pitch 关节跟踪频率 ${p.freq}Hz、幅度 ±${p.amp}rad 的正弦目标（点头动作）`,
  },
  {
    id: "push_recovery",
    label: "抗推扰恢复",
    desc: "训练时施加随机推力，学会恢复平衡",
    build: () => "训练过程中对躯干施加随机方向的推力扰动，机器人被推后应能快速恢复平衡",
  },
];

export default function Workshop() {
  const navigate = useNavigate();
  // 项目选择
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");

  // 行为表单
  const [selected, setSelected] = useState<Record<string, boolean>>({ stand: true });
  const [params, setParams] = useState<Record<string, number>>({});
  const [extra, setExtra] = useState("");
  const [envHint, setEnvHint] = useState("");

  // 生成
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);

  // 已生成环境管理
  const [existing, setExisting] = useState<GeneratedEnv[]>([]);
  const [viewCode, setViewCode] = useState<{ env: string; code: string } | null>(null);
  const [sandboxing, setSandboxing] = useState("");

  useEffect(() => {
    api.listProjects().then((ps) => {
      setProjects(ps);
      if (ps.length) setProject((prev) => prev || ps[0].name);
    }).catch((e) => message.error(String(e.message)));
  }, []);

  const refreshList = useCallback(() => {
    if (!project) return;
    api.copilotList(project).then(setExisting).catch(() => setExisting([]));
  }, [project]);

  useEffect(() => { refreshList(); }, [refreshList]);

  // 参数默认值填充
  const paramOf = (tpl: BehaviorTpl, key: string) => {
    const k = `${tpl.id}.${key}`;
    const def = tpl.params?.find((p) => p.key === key)?.def ?? 0;
    return params[k] ?? def;
  };

  const requirement = (() => {
    const parts: string[] = [];
    for (const tpl of BEHAVIORS) {
      if (!selected[tpl.id]) continue;
      const p = Object.fromEntries((tpl.params ?? []).map((pp) => [pp.key, paramOf(tpl, pp.key)]));
      parts.push(tpl.build(p));
    }
    if (extra.trim()) parts.push(extra.trim());
    return parts.join("；") + (parts.length ? "。" : "");
  })();

  const generate = async () => {
    if (!requirement.trim()) return;
    setGenerating(true);
    setResult(null);
    try {
      const r = await api.copilotGenerate(project, {
        requirement,
        env_name_hint: envHint.trim() || undefined,
      });
      setResult(r);
      refreshList();
      message[r.registered ? "success" : "warning"](
        r.registered ? `环境 ${r.env_name} 生成并通过检查，已注册` : `环境 ${r.env_name} 已生成但未通过检查`,
      );
    } catch (e: any) {
      message.error(`生成失败: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const sandboxRun = async (envName: string) => {
    setSandboxing(envName);
    try {
      const job = await api.startTraining(project, { env: envName, task: "flat_terrain", num_timesteps: 3_000_000 });
      message.success(`沙箱试跑已提交（任务 ${job.id}）`);
      navigate(`/jobs/${job.id}`);
    } catch (e: any) {
      message.error(`试跑提交失败: ${e.message}`);
    } finally {
      setSandboxing("");
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
    } catch (e: any) {
      message.error(e.message);
    }
  };

  return (
    <>
      <Typography.Title level={4} style={{ color: "#eee", marginTop: 0 }}>环境工坊</Typography.Title>

      <Row gutter={[16, 16]}>
        {/* 左列：行为表单 + 生成 */}
        <Col xs={24} lg={13}>
          <Card
            title="1 · 选择项目"
            size="small"
            extra={
              <Select size="small" style={{ minWidth: 180 }} value={project || undefined}
                onChange={(v) => { setProject(v); setResult(null); setViewCode(null); }}
                options={projects.map((p) => ({ label: p.display_name, value: p.name }))}
              />
            }
          >
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              生成器只新增训练环境文件（reward / 配置 / 命令逻辑），不改动现有代码；生成后需沙箱试跑验证再正式训练。
            </Typography.Text>
          </Card>

          <Card title="2 · 勾选目标行为（可组合）" size="small" style={{ marginTop: 16 }}>
            {BEHAVIORS.map((tpl) => (
              <div key={tpl.id} style={{ marginBottom: 10 }}>
                <Checkbox
                  checked={!!selected[tpl.id]}
                  onChange={(e) => setSelected((s) => ({ ...s, [tpl.id]: e.target.checked }))}
                >
                  <span style={{ color: "#eee" }}>{tpl.label}</span>
                  <span style={{ color: "#888", marginLeft: 8, fontSize: 12 }}>{tpl.desc}</span>
                </Checkbox>
                {selected[tpl.id] && tpl.params && (
                  <Row gutter={12} style={{ marginTop: 6, paddingLeft: 24 }}>
                    {tpl.params.map((pp) => (
                      <Col key={pp.key} span={12}>
                        <Space size={4}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{pp.label}</Typography.Text>
                          <InputNumber
                            size="small" style={{ width: 80 }}
                            min={pp.min} max={pp.max} step={pp.step}
                            value={paramOf(tpl, pp.key)}
                            onChange={(v) => v != null && setParams((s) => ({ ...s, [`${tpl.id}.${pp.key}`]: v }))}
                          />
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{pp.unit}</Typography.Text>
                        </Space>
                      </Col>
                    ))}
                  </Row>
                )}
              </div>
            ))}
            <div style={{ marginTop: 14 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>补充要求（可选）</Typography.Text>
              <Input.TextArea
                rows={2} style={{ marginTop: 4 }} value={extra}
                placeholder="例：整体能耗要低，动作要平滑，避免关节抖动"
                onChange={(e) => setExtra(e.target.value)}
              />
            </div>
          </Card>

          <Card
            title="3 · 需求预览 → 生成"
            size="small" style={{ marginTop: 16 }}
            extra={
              <Input
                size="small" style={{ width: 200 }} value={envHint}
                placeholder="环境名（可选，如 head_swing）"
                onChange={(e) => setEnvHint(e.target.value)}
              />
            }
          >
            <Alert
              type="info"
              message={requirement || "请至少勾选一个行为，或填写补充要求"}
              style={{ marginBottom: 12, whiteSpace: "normal" }}
            />
            <Button
              type="primary" icon={<ToolOutlined />} loading={generating}
              disabled={!requirement.trim()} onClick={generate}
            >
              {generating ? "生成中（约 1-5 分钟，含静态检查）…" : "生成训练环境"}
            </Button>

            {result && (
              <div style={{ marginTop: 16 }}>
                <Space wrap style={{ marginBottom: 8 }}>
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
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
                  文件: {result.file}
                </Typography.Paragraph>
                <Tabs
                  items={[
                    { key: "diff", label: "与骨架 Diff", children: <DiffView diff={result.diff} /> },
                    {
                      key: "code", label: "生成代码",
                      children: (
                        <pre style={{
                          margin: 0, padding: 12, maxHeight: 380, overflow: "auto", fontSize: 12,
                          lineHeight: 1.5, background: "#0d1117", color: "#c9d1d9", borderRadius: 6,
                        }}>
                          {result.code}
                        </pre>
                      ),
                    },
                  ]}
                />
                {result.check_ok && (
                  <Space style={{ marginTop: 8 }}>
                    <Button
                      icon={<ExperimentOutlined />} loading={sandboxing === result.env_name}
                      onClick={() => sandboxRun(result.env_name)}
                    >
                      沙箱试跑（300 万步）
                    </Button>
                    <Button icon={<RocketOutlined />} onClick={() => navigate(`/projects/${project}`)}>
                      去项目页发起完整训练
                    </Button>
                  </Space>
                )}
              </div>
            )}
          </Card>
        </Col>

        {/* 右列：已生成环境管理 */}
        <Col xs={24} lg={11}>
          <Card title="已生成环境" size="small">
            {existing.length === 0 ? (
              <Empty description="暂无生成记录" imageStyle={{ height: 60 }} />
            ) : (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                {existing.map((g) => (
                  <div key={g.env_name} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 10px", background: "#1a1f22", borderRadius: 6,
                  }}>
                    <a onClick={() => viewExisting(g.env_name)} style={{ color: "#5edede" }}>{g.env_name}</a>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {(g.size / 1024).toFixed(1)} KB
                    </Typography.Text>
                    <Space size={4}>
                      <Button size="small" icon={<CaretRightOutlined />} loading={sandboxing === g.env_name}
                        onClick={() => sandboxRun(g.env_name)}>
                        试跑
                      </Button>
                      <Popconfirm title={`删除环境 ${g.env_name}？`} onConfirm={() => removeEnv(g.env_name)}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </Space>
            )}
            {viewCode && (
              <pre style={{
                marginTop: 12, padding: 12, maxHeight: 420, overflow: "auto", fontSize: 12,
                background: "#0d1117", color: "#c9d1d9", borderRadius: 6,
              }}>
                {viewCode.code}
              </pre>
            )}
          </Card>
          {generating && (
            <Card size="small" style={{ marginTop: 16 }}>
              <Space>
                <Spin size="small" />
                <Typography.Text type="secondary">
                  LLM 正在基于骨架与 reward 库生成代码，完成后自动做静态检查并注册…
                </Typography.Text>
              </Space>
            </Card>
          )}
        </Col>
      </Row>
    </>
  );
}
