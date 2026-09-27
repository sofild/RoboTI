import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Alert, Button, Card, Col, InputNumber, Row, Segmented, Select, Slider, Space, Table, Tag, Typography, Upload, message,
} from "antd";
import {
  CaretRightOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, RobotOutlined, UploadOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { Job, ProjectDetail, JobStatus, PolicyRun } from "../types";
import MjcfViewer from "../components/MjcfViewer";
import type { MjcfViewerHandle } from "../components/MjcfViewer";
import JobStatusTag from "../components/JobStatusTag";
import CopilotModal from "../components/CopilotModal";

export default function RobotView() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState("");
  const [env, setEnv] = useState("");
  const [task, setTask] = useState("");
  const [timesteps, setTimesteps] = useState<number>(30_000_000);
  const [submitting, setSubmitting] = useState(false);
  const [viewerKey, setViewerKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const viewerRef = useRef<MjcfViewerHandle | null>(null);

  // ---- 策略推理状态 ----
  const [policyRuns, setPolicyRuns] = useState<PolicyRun[]>([]);
  const [policyRun, setPolicyRun] = useState<string>("");
  const [policyFile, setPolicyFile] = useState<string>("");
  const [policyMode, setPolicyMode] = useState<string>("walking");
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyLoaded, setPolicyLoaded] = useState<string | null>(null);
  const [phasePeriod, setPhasePeriod] = useState(0);
  const [cmdVx, setCmdVx] = useState(0);
  const [cmdVy, setCmdVy] = useState(0);
  const [cmdOmega, setCmdOmega] = useState(0);
  const [cmdNeck, setCmdNeck] = useState(0);
  const [cmdHeadP, setCmdHeadP] = useState(0);
  const [cmdHeadY, setCmdHeadY] = useState(0);
  const [cmdHeadR, setCmdHeadR] = useState(0);
  const [layout, setLayout] = useState<"joystick" | "standing">("joystick");
  const commandsRef = useRef<number[]>([0, 0, 0, 0, 0, 0, 0]); // vx,vy,ω,neck,headP,headY,headR

  // 由 run 的训练环境预估 obs 布局：joystick 系 =行走布局；standing 系 = 站立布局
  const guessLayout = (r: PolicyRun | undefined): "joystick" | "standing" =>
    !r || !r.env || r.env === "joystick" ? "joystick" : "standing";

  const refresh = useCallback(() => {
    if (!name) return;
    api.getProject(name).then((d) => {
      setDetail(d);
      setEntry((prev) => prev || d.entry_xmls[0] || d.xmls[0] || "");
      setEnv((prev) => prev || Object.keys(d.envs)[0] || "");
      setTimesteps((prev) => (prev === 30_000_000 ? d.default_timesteps : prev));
    }).catch((e) => setError(String(e.message)));
  }, [name]);

  useEffect(() => { refresh(); }, [refresh]);
  // 任务在跑时轮询刷新列表
  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // 策略 checkpoint 列表 + 步态相位周期（支持 URL ?run=&file= 指定，供模型广场跳转）
  useEffect(() => {
    if (!name) return;
    const urlRun = searchParams.get("run") ?? "";
    const urlFile = searchParams.get("file") ?? "";
    api.listPolicyRuns(name).then((runs) => {
      setPolicyRuns(runs);
      const target = (urlRun && runs.find((r) => r.run === urlRun)) || undefined;
      // 默认选 joystick 环境训练的 run（查看器 obs 布局与之匹配），否则选第一个
      const preferred = target ?? runs.find((r) => r.env === "joystick") ?? runs[0];
      setPolicyRun((prev) => prev || preferred?.run || "");
      setLayout((prev) => (prev === "standing" ? prev : guessLayout(preferred)));
      const files = preferred?.files ?? [];
      const pickFile = urlFile && files.some((f) => f.name === urlFile)
        ? urlFile
        : (files.length ? files[files.length - 1].name : "");
      setPolicyFile((prev) => prev || pickFile);
    }).catch(() => setPolicyRuns([]));
    api.getPhasePeriod(name).then((p) => setPhasePeriod(p.nb_steps_in_period)).catch(() => setPhasePeriod(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // URL 带 policy=1 时（模型广场"试跑"跳转），待 run/file 就绪后自动加载策略
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (autoLoadRef.current) return;
    if (searchParams.get("policy") !== "1") return;
    if (!policyRun || !policyFile || policyLoading) return;
    autoLoadRef.current = true;
    loadPolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyRun, policyFile, policyLoading]);

  useEffect(() => {
    if (detail && env && !task) setTask(detail.envs[env]?.[0] || "");
  }, [detail, env, task]);

  // env 切换时重置 task
  const onEnvChange = (v: string) => {
    setEnv(v);
    setTask(detail?.envs[v]?.[0] || "");
  };

  const submit = async () => {
    if (!name || !env || !task) return;
    setSubmitting(true);
    try {
      await api.startTraining(name, { env, task, num_timesteps: timesteps });
      message.success("训练任务已提交");
      refresh();
    } catch (e: any) {
      message.error(`提交失败: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // ---- 策略推理 ----
  const runFiles = policyRuns.find((r) => r.run === policyRun)?.files ?? [];

  const onPolicyRunChange = (v: string) => {
    setPolicyRun(v);
    const r = policyRuns.find((x) => x.run === v);
    setLayout(guessLayout(r));
    const files = r?.files ?? [];
    setPolicyFile(files.length ? files[files.length - 1].name : ""); // 默认选步数最大的
  };

  // 切换布局时把另一组指令清零，避免残留值影响观测
  const switchLayout = (l: "joystick" | "standing") => {
    setLayout(l);
    if (l === "standing") {
      commandsRef.current[0] = 0; commandsRef.current[1] = 0; commandsRef.current[2] = 0;
      setCmdVx(0); setCmdVy(0); setCmdOmega(0);
    } else {
      commandsRef.current[3] = 0; commandsRef.current[4] = 0; commandsRef.current[5] = 0; commandsRef.current[6] = 0;
      setCmdNeck(0); setCmdHeadP(0); setCmdHeadY(0); setCmdHeadR(0);
    }
  };

  const loadPolicy = async () => {
    if (!name || !policyRun || !policyFile) return;
    setPolicyLoading(true);
    try {
      const buf = await fetch(api.policyOnnxUrl(name, policyRun, policyFile)).then((r) => {
        if (!r.ok) throw new Error(`下载失败 (${r.status})`);
        return r.arrayBuffer();
      });
      const actualLayout = await viewerRef.current?.setPolicy?.({
        data: new Uint8Array(buf),
        standing: policyMode === "standing",
        nbStepsInPeriod: phasePeriod,
        commandsRef,
      });
      if (actualLayout) switchLayout(actualLayout);
      // 先暂停物理，等 ORT wasm 预热完成（首次推理 JIT 开销秒级）再启动，避免开局失控
      viewerRef.current?.setRunning(false);
      setRunning(false);
      setPolicyLoaded(`${policyRun}/${policyFile}`);
      message.success(`策略已加载（${actualLayout === "standing" ? "站立" : "行走"}布局）`);
      setTimeout(() => {
        viewerRef.current?.setRunning(true);
        setRunning(true);
      }, 1200);
    } catch (e: any) {
      message.error(`策略加载失败: ${e.message}`);
    } finally {
      setPolicyLoading(false);
    }
  };

  const unloadPolicy = async () => {
    await viewerRef.current?.setPolicy?.(null);
    setPolicyLoaded(null);
  };

  // 上传外部 ONNX：保存到平台 checkpoints/platform/uploaded/，刷新下拉列表后选中，用「加载策略并运行」即可
  const handleUpload = async (file: File) => {
    try {
      if (!name) throw new Error("缺少项目");
      await api.uploadPolicyOnnx(name, file);
      const runs = await api.listPolicyRuns(name);
      setPolicyRuns(runs);
      setPolicyRun("uploaded");
      const files = runs.find((r) => r.run === "uploaded")?.files ?? [];
      const f = files.find((x) => x.name === file.name) ?? files[files.length - 1];
      setPolicyFile(f?.name ?? "");
      message.success("上传成功，请点击「加载策略并运行」");
    } catch (e: any) {
      message.error(`上传失败: ${e.message}`);
    }
    return false;
  };

  const onnxLabel = (n: string) => {
    const m = n.match(/_(\d+)\.onnx$/);
    if (!m) return n;
    const timePart = n.replace(/^\d{4}_\d{2}_\d{2}_/, "").replace(/_\d+\.onnx$/, "");
    return `${Number(m[1]).toLocaleString()} 步 · ${timePart}`;
  };

  if (error) return <Alert type="error" message={error} />;
  if (!detail) return <Typography.Text>加载中…</Typography.Text>;

  const jobColumns = [
    {
      title: "任务 ID", dataIndex: "id", width: 200,
      render: (id: string) => <a onClick={(e) => { e.stopPropagation(); navigate(`/jobs/${id}`); }}>{id}</a>,
    },
    { title: "环境", dataIndex: "env", width: 100 },
    { title: "Task", dataIndex: "task", width: 180 },
    { title: "步数", dataIndex: "num_timesteps", width: 120, render: (v: number) => v.toLocaleString() },
    {
      title: "状态", dataIndex: "status", width: 100,
      render: (s: JobStatus) => <JobStatusTag status={s} />,
    },
    { title: "创建时间", dataIndex: "created_at", width: 170 },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Typography.Title level={4} style={{ color: "#eee", margin: 0 }}>
        {detail.display_name}
        <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 14 }}>
          {detail.description}
        </Typography.Text>
      </Typography.Title>

      <Card
        title="MJCF 查看器"
        extra={
          <Space>
            <Segmented
              value={entry}
              onChange={(v) => setEntry(v as string)}
              options={detail.entry_xmls.map((x) => ({ label: x.replace("scene_", "").replace(".xml", ""), value: x }))}
            />
            <Button
              icon={running ? <PauseOutlined /> : <CaretRightOutlined />}
              onClick={() => { const v = !running; setRunning(v); viewerRef.current?.setRunning(v); }}
            >
              {running ? "暂停物理" : "运行物理"}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => { setViewerKey((k) => k + 1); setRunning(false); setPolicyLoaded(null); }}>
              重置
            </Button>
          </Space>
        }
      >
        <MjcfViewer
          key={`${entry}-${viewerKey}`}
          ref={viewerRef}
          project={name!}
          entryXml={entry}
        />
      </Card>

      <Card
        title="策略推理（ONNX）"
        extra={policyLoaded && <Tag color="green" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>{policyLoaded}</Tag>}
      >
        <Space direction="vertical" size={10} style={{ width: "100%" }}>
          <Space size={8} wrap>
            <Select
              placeholder="训练 run"
              style={{ width: 230 }}
              value={policyRun || undefined}
              onChange={onPolicyRunChange}
              options={policyRuns.map((r) => ({
                label: r.run + (r.env && r.env !== "joystick" ? `（${r.env}）` : ""),
                value: r.run,
                title: r.env && r.env !== "joystick"
                  ? `${r.run}：由 ${r.env} 环境训练（站立系布局）`
                  : r.run,
              }))}
            />
            <Select
              placeholder="策略 ONNX"
              style={{ width: 210 }}
              value={policyFile || undefined}
              onChange={(v) => setPolicyFile(v)}
              options={runFiles.map((f) => ({ label: onnxLabel(f.name), value: f.name, title: f.name }))}
            />
            {layout === "joystick" && (
              <Segmented
                value={policyMode}
                onChange={(v) => setPolicyMode(v as string)}
                options={[{ label: "行走", value: "walking" }, { label: "站立", value: "standing" }]}
              />
            )}
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={policyLoading}
              onClick={loadPolicy}
              disabled={!policyRun || !policyFile}
            >
              加载策略并运行
            </Button>
            <Upload accept=".onnx" showUploadList={false} beforeUpload={handleUpload}>
              <Button icon={<UploadOutlined />}>上传外部 ONNX</Button>
            </Upload>
            {policyLoaded && (
              <Button icon={<PauseOutlined />} onClick={unloadPolicy}>
                卸载策略
              </Button>
            )}
          </Space>
          {layout === "joystick" ? (
            policyMode === "walking" && (
              <Row gutter={24}>
                <Col span={8}>
                  <Typography.Text type="secondary">前进 vx（m/s）</Typography.Text>
                  <Slider
                    min={-0.15} max={0.15} step={0.01} value={cmdVx}
                    onChange={(v) => { setCmdVx(v); commandsRef.current[0] = v; }}
                    marks={{ "-0.15": "-0.15", 0: "0", "0.15": "0.15" }}
                  />
                </Col>
                <Col span={8}>
                  <Typography.Text type="secondary">侧移 vy（m/s）</Typography.Text>
                  <Slider
                    min={-0.2} max={0.2} step={0.01} value={cmdVy}
                    onChange={(v) => { setCmdVy(v); commandsRef.current[1] = v; }}
                    marks={{ "-0.2": "-0.2", 0: "0", "0.2": "0.2" }}
                  />
                </Col>
                <Col span={8}>
                  <Typography.Text type="secondary">转向 ω（rad/s）</Typography.Text>
                  <Slider
                    min={-1} max={1} step={0.05} value={cmdOmega}
                    onChange={(v) => { setCmdOmega(v); commandsRef.current[2] = v; }}
                    marks={{ "-1": "-1", 0: "0", 1: "1" }}
                  />
                </Col>
              </Row>
            )
          ) : (
            <Row gutter={16}>
              <Col span={6}>
                <Typography.Text type="secondary">脖子俯仰 neck</Typography.Text>
                <Slider
                  min={-0.34} max={1.1} step={0.02} value={cmdNeck}
                  onChange={(v) => { setCmdNeck(v); commandsRef.current[3] = v; }}
                  marks={{ "-0.34": "-0.34", "1.1": "1.1" }}
                />
              </Col>
              <Col span={6}>
                <Typography.Text type="secondary">头部俯仰 headP</Typography.Text>
                <Slider
                  min={-0.78} max={0.78} step={0.02} value={cmdHeadP}
                  onChange={(v) => { setCmdHeadP(v); commandsRef.current[4] = v; }}
                  marks={{ "-0.78": "-0.78", "0.78": "0.78" }}
                />
              </Col>
              <Col span={6}>
                <Typography.Text type="secondary">头部偏航 headY</Typography.Text>
                <Slider
                  min={-2.7} max={2.7} step={0.05} value={cmdHeadY}
                  onChange={(v) => { setCmdHeadY(v); commandsRef.current[5] = v; }}
                  marks={{ "-2.7": "-2.7", "2.7": "2.7" }}
                />
              </Col>
              <Col span={6}>
                <Typography.Text type="secondary">头部翻滚 headR</Typography.Text>
                <Slider
                  min={-0.5} max={0.5} step={0.02} value={cmdHeadR}
                  onChange={(v) => { setCmdHeadR(v); commandsRef.current[6] = v; }}
                  marks={{ "-0.5": "-0.5", "0.5": "0.5" }}
                />
              </Col>
            </Row>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            在浏览器里用 onnxruntime-web 加载训练导出的 ONNX 策略，MuJoCo 物理仿真 + 实时推理。
            {layout === "standing"
              ? "站立系布局（85 维）：调整头部姿态指令，机器人站立并摆动头部。"
              : `行走布局（101 维）：行走模式按参考运动周期（${phasePeriod || "—"} 步/周期）生成步态相位，站立模式相位恒 0。`}
          </Typography.Text>
        </Space>
      </Card>

      <Card title="发起训练">
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div>
            <Button
              icon={<RobotOutlined />}
              onClick={() => setCopilotOpen(true)}
              style={{ width: "100%" }}
            >
              AI 生成训练任务（Copilot）
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
              描述需求 → LLM 生成 reward/命令/配置 → 静态检查 → 沙箱试跑 → 训练
            </Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary">环境</Typography.Text>
            <Segmented style={{ marginTop: 6 }} value={env} onChange={onEnvChange} options={Object.keys(detail.envs)} />
          </div>
          <div>
            <Typography.Text type="secondary">任务</Typography.Text>
            <Segmented
              style={{ marginTop: 6 }}
              value={task}
              onChange={(v) => setTask(v as string)}
              options={detail.envs[env] || []}
            />
          </div>
          <div>
            <Typography.Text type="secondary">训练步数</Typography.Text>
            <InputNumber
              style={{ width: "100%", marginTop: 6 }}
              min={1000}
              step={1_000_000}
              value={timesteps}
              onChange={(v) => v && setTimesteps(v)}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}
              parser={(t: string | undefined) => Number((t ?? "0").replace(/,/g, ""))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              完整训练约 150,000,000 步；预览训练趋势可用较小值（如 3,000,000）
            </Typography.Text>
          </div>
          <Button type="primary" loading={submitting} onClick={submit} disabled={!env || !task}>
            提交训练
          </Button>
        </Space>
      </Card>

      <Card title="训练任务">
        <Table<Job>
          rowKey="id"
          size="small"
          dataSource={detail.jobs}
          columns={jobColumns}
          pagination={{ pageSize: 10 }}
          onRow={(r) => ({ onClick: () => navigate(`/jobs/${r.id}`) })}
          style={{ cursor: "pointer" }}
        />
      </Card>

      <CopilotModal
        open={copilotOpen}
        onClose={() => setCopilotOpen(false)}
        project={name!}
        onEnvGenerated={(envName) => {
          refresh();
          if (envName) setEnv(envName);
        }}
      />
    </Space>
  );
}
