/**
 * 交互实验室：键盘/手柄遥操作 + 实时观测可视化。
 *
 * 键盘/手柄通过 Lab 页持有的 commandsRef 写入指令（与 RobotView 滑条同一机制），
 * MjcfViewer 通过 onObs 回调按 10Hz 外发最新观测向量，按布局分块渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Card, Col, Row, Segmented, Select, Slider, Space, Switch, Tag, Typography, message,
} from "antd";
import {
  CaretRightOutlined, PauseOutlined, ReloadOutlined, RocketOutlined, StopOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { PolicyRun, Project, ProjectDetail } from "../types";
import MjcfViewer from "../components/MjcfViewer";
import type { MjcfViewerHandle } from "../components/MjcfViewer";

type Layout = "joystick" | "standing";

/** 指令轴定义：commandsRef 下标、范围与键盘绑定 */
const AXES: { idx: number; name: string; min: number; max: number; inc: string; dec: string; step: number }[] = [
  { idx: 0, name: "vx 前后", min: -0.15, max: 0.15, inc: "KeyW", dec: "KeyS", step: 0.012 },
  { idx: 1, name: "vy 左右", min: -0.2, max: 0.2, inc: "KeyA", dec: "KeyD", step: 0.014 },
  { idx: 2, name: "ω 转向", min: -1, max: 1, inc: "KeyQ", dec: "KeyE", step: 0.07 },
  { idx: 3, name: "neck 脖子", min: -0.34, max: 1.1, inc: "KeyR", dec: "KeyF", step: 0.07 },
  { idx: 4, name: "headP 俯仰", min: -0.78, max: 0.78, inc: "ArrowUp", dec: "ArrowDown", step: 0.05 },
  { idx: 5, name: "headY 偏航", min: -2.7, max: 2.7, inc: "ArrowLeft", dec: "ArrowRight", step: 0.15 },
  { idx: 6, name: "headR 翻滚", min: -0.5, max: 0.5, inc: "KeyT", dec: "KeyG", step: 0.035 },
];

const KEY_LABEL: Record<string, string> = {
  KeyW: "W", KeyS: "S", KeyA: "A", KeyD: "D", KeyQ: "Q", KeyE: "E",
  KeyR: "R", KeyF: "F", KeyT: "T", KeyG: "G",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

/** 观测分块定义（与 MjcfViewer 构建顺序严格一致）。 */
function obsGroups(layout: Layout, nu: number): { name: string; from: number; to: number }[] {
  const head = [
    { name: "陀螺仪", from: 0, to: 3 },
    { name: "加速度计", from: 3, to: 6 },
    { name: "指令", from: 6, to: 13 },
  ];
  const blocks = [
    { name: "关节位置", off: 0 },
    { name: "关节速度", off: 1 },
    { name: "动作 t-1", off: 2 },
    { name: "动作 t-2", off: 3 },
    { name: "动作 t-3", off: 4 },
  ];
  const mid = blocks.map((b) => ({ name: b.name, from: 13 + b.off * nu, to: 13 + (b.off + 1) * nu }));
  if (layout === "joystick") {
    return [
      ...head, ...mid,
      { name: "motor_targets", from: 13 + 5 * nu, to: 13 + 6 * nu },
      { name: "足端接触", from: 13 + 6 * nu, to: 15 + 6 * nu },
      { name: "步态相位", from: 15 + 6 * nu, to: 17 + 6 * nu },
    ];
  }
  return [...head, ...mid, { name: "足端接触", from: 13 + 5 * nu, to: 15 + 5 * nu }];
}

const guessLayout = (r: PolicyRun | undefined): Layout =>
  !r || !r.env || r.env === "joystick" ? "joystick" : "standing";

export default function Lab() {
  const viewerRef = useRef<MjcfViewerHandle | null>(null);
  const commandsRef = useRef<number[]>([0, 0, 0, 0, 0, 0, 0]);

  // ---- 项目/场景 ----
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [entry, setEntry] = useState("");
  const [viewerKey, setViewerKey] = useState(0);
  const [running, setRunning] = useState(false);

  // ---- 策略 ----
  const [policyRuns, setPolicyRuns] = useState<PolicyRun[]>([]);
  const [policyRun, setPolicyRun] = useState("");
  const [policyFile, setPolicyFile] = useState("");
  const [policyMode, setPolicyMode] = useState("walking");
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyLoaded, setPolicyLoaded] = useState<string | null>(null);
  const [phasePeriod, setPhasePeriod] = useState(0);
  const [layout, setLayout] = useState<Layout>("joystick");

  // ---- 操控台 ----
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [gamepadOn, setGamepadOn] = useState(false);
  const [cmdView, setCmdView] = useState<number[]>([0, 0, 0, 0, 0, 0, 0]);
  const keysDown = useRef<Set<string>>(new Set());
  const gamepadOk = useRef(false);

  // ---- 观测可视化 ----
  const [obs, setObs] = useState<number[] | null>(null);
  const [obsLayout, setObsLayout] = useState<Layout>("joystick");
  const [selGroup, setSelGroup] = useState(3); // 默认看关节位置
  const obsHistRef = useRef<Float32Array[]>([]); // 观测历史环形缓冲（时序曲线用）
  const selGroupRef = useRef(3);
  selGroupRef.current = selGroup;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 初始化：项目列表 → 详情 → 场景
  useEffect(() => {
    api.listProjects().then((ps) => {
      setProjects(ps);
      if (ps.length) setProject((prev) => prev || ps[0].name);
    }).catch((e) => message.error(String(e.message)));
  }, []);

  useEffect(() => {
    if (!project) return;
    api.getProject(project).then((d) => {
      setDetail(d);
      setEntry(d.entry_xmls[0] || d.xmls[0] || "");
    }).catch((e) => message.error(String(e.message)));
    api.listPolicyRuns(project).then((runs) => {
      setPolicyRuns(runs);
      const preferred = runs.find((r) => r.env === "joystick") ?? runs[0];
      setPolicyRun((prev) => prev || preferred?.run || "");
      setLayout(guessLayout(preferred));
      const files = preferred?.files ?? [];
      setPolicyFile((prev) => prev || (files.length ? files[files.length - 1].name : ""));
    }).catch(() => setPolicyRuns([]));
    api.getPhasePeriod(project).then((p) => setPhasePeriod(p.nb_steps_in_period)).catch(() => setPhasePeriod(0));
  }, [project]);

  // ---- 策略加载 ----
  const loadPolicy = async () => {
    if (!project || !policyRun || !policyFile) return;
    setPolicyLoading(true);
    try {
      const buf = await fetch(api.policyOnnxUrl(project, policyRun, policyFile)).then((r) => {
        if (!r.ok) throw new Error(`下载失败 (${r.status})`);
        return r.arrayBuffer();
      });
      const actual = await viewerRef.current?.setPolicy?.({
        data: new Uint8Array(buf),
        standing: policyMode === "standing",
        nbStepsInPeriod: phasePeriod,
        commandsRef,
      });
      if (actual) setLayout(actual);
      viewerRef.current?.setRunning(false);
      setRunning(false);
      obsHistRef.current = [];
      setPolicyLoaded(`${policyRun}/${policyFile}`);
      message.success(`策略已加载（${actual === "standing" ? "站立" : "行走"}布局）`);
      setTimeout(() => { viewerRef.current?.setRunning(true); setRunning(true); }, 1200);
    } catch (e: any) {
      message.error(`策略加载失败: ${e.message}`);
    } finally {
      setPolicyLoading(false);
    }
  };

  const unloadPolicy = async () => {
    await viewerRef.current?.setPolicy?.(null);
    setPolicyLoaded(null);
    setObs(null);
    obsHistRef.current = [];
  };

  // ---- 观测外发回调（MjcfViewer 10Hz 调用）----
  const handleObs = useCallback((o: number[], l: Layout) => {
    setObs(o);
    setObsLayout(l);
    const hist = obsHistRef.current;
    hist.push(Float32Array.from(o));
    if (hist.length > 150) hist.shift();
  }, []);

  // nu 由观测长度反推：joystick=(len-17)/6，standing=(len-15)/5
  const nu = useMemo(() => {
    if (!obs) return 14;
    return obsLayout === "joystick" ? (obs.length - 17) / 6 : (obs.length - 15) / 5;
  }, [obs, obsLayout]);

  const groups = useMemo(() => obsGroups(obsLayout, nu), [obsLayout, nu]);

  // ---- 时序曲线绘制循环 ----
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = canvasRef.current;
      if (!cv) return;
      const g = obsGroups(obsLayout, nu)[selGroupRef.current];
      const ctx = cv.getContext("2d");
      if (!g || !ctx) return;
      const w = cv.width, h = cv.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "#333";
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      const hist = obsHistRef.current;
      if (hist.length < 2) return;
      const n = g.to - g.from;
      const colors = ["#13c2c2", "#f5a623", "#b37feb", "#ff7a45", "#5cdbd3", "#ff85c0", "#a0d911", "#69b1ff"];
      let vMin = Infinity, vMax = -Infinity;
      for (const row of hist) for (let k = g.from; k < g.to; k++) {
        if (row[k] < vMin) vMin = row[k];
        if (row[k] > vMax) vMax = row[k];
      }
      if (vMax - vMin < 1e-6) { vMax = vMin + 1; }
      const span = vMax - vMin;
      const pad = span * 0.1;
      vMin -= pad; vMax += pad;
      for (let c = 0; c < n; c++) {
        ctx.strokeStyle = colors[c % colors.length];
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < hist.length; i++) {
          const v = hist[i][g.from + c];
          const x = (i / (hist.length - 1)) * (w - 2) + 1;
          const y = h - 4 - ((v - vMin) / (vMax - vMin)) * (h - 8);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [obsLayout, nu]);

  const setCmd = (idx: number, v: number) => { commandsRef.current[idx] = v; setCmdView([...commandsRef.current]); };
  const clearCmds = () => { for (let i = 0; i < 7; i++) commandsRef.current[i] = 0; setCmdView([0, 0, 0, 0, 0, 0, 0]); };

  // ---- 键盘控制 ----
  useEffect(() => {
    if (!keyboardOn) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) e.preventDefault();
      if (e.code === "KeyX") {
        for (let i = 0; i < 7; i++) commandsRef.current[i] = 0;
        return;
      }
      if (KEY_LABEL[e.code]) {
        keysDown.current.add(e.code);
        if (e.code.startsWith("Arrow")) e.preventDefault(); // 防止方向键滚动页面
      }
    };
    const up = (e: KeyboardEvent) => keysDown.current.delete(e.code);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      keysDown.current.clear();
    };
  }, [keyboardOn]);

  // ---- 操控台主循环：键盘斜坡 + 手柄绝对值，50ms 一拍 ----
  useEffect(() => {
    if (!keyboardOn && !gamepadOn) return;
    const timer = setInterval(() => {
      const cmds = commandsRef.current;
      for (const ax of AXES) {
        const dir = (keysDown.current.has(ax.inc) ? 1 : 0) - (keysDown.current.has(ax.dec) ? 1 : 0);
        if (dir !== 0) {
          cmds[ax.idx] = Math.max(ax.min, Math.min(ax.max, cmds[ax.idx] + dir * ax.step));
        }
      }
      // 手柄：左摇杆 = vx/ω，右摇杆 = headY/headP
      if (gamepadOn) {
        const pad = navigator.getGamepads?.()[0];
        gamepadOk.current = !!pad;
        if (pad) {
          const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
          cmds[2] = -dz(pad.axes[0] ?? 0);
          cmds[0] = -dz(pad.axes[1] ?? 0) * 0.15;
          cmds[5] = dz(pad.axes[2] ?? 0) * 2.7;
          cmds[4] = -dz(pad.axes[3] ?? 0) * 0.78;
        }
      }
      setCmdView([...cmds]);
    }, 50);
    return () => clearInterval(timer);
  }, [keyboardOn, gamepadOn]);

  const runFiles = policyRuns.find((r) => r.run === policyRun)?.files ?? [];
  const hasPolicy = !!policyLoaded;

  return (
    <>
      <Typography.Title level={4} style={{ color: "#eee", marginTop: 0 }}>
        交互实验室
        <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 14 }}>
          加载策略后用键盘或手柄驾驶机器人，并实时观察它"眼中"的观测数据
        </Typography.Text>
      </Typography.Title>

      <Row gutter={[16, 16]}>
        {/* 左列：查看器 + 策略加载 */}
        <Col xs={24} xl={15}>
          <Card
            title={
              <Space>
                <span>MuJoCo 仿真</span>
                <Select
                  size="small" style={{ minWidth: 160 }} value={project}
                  onChange={(v) => { setProject(v); setPolicyRun(""); setPolicyFile(""); setPolicyLoaded(null); }}
                  options={projects.map((p) => ({ label: p.display_name, value: p.name }))}
                />
                <Segmented
                  size="small" value={entry} onChange={(v) => setEntry(v as string)}
                  options={(detail?.entry_xmls ?? []).map((x) => ({
                    label: x.replace("scene_", "").replace(".xml", ""), value: x,
                  }))}
                />
              </Space>
            }
            extra={
              <Space>
                <Button
                  size="small" icon={running ? <PauseOutlined /> : <CaretRightOutlined />}
                  onClick={() => { const v = !running; setRunning(v); viewerRef.current?.setRunning(v); }}
                >
                  {running ? "暂停" : "运行"}
                </Button>
                <Button
                  size="small" icon={<ReloadOutlined />}
                  onClick={() => { setViewerKey((k) => k + 1); setRunning(false); setPolicyLoaded(null); setObs(null); }}
                >
                  重置
                </Button>
              </Space>
            }
          >
            <MjcfViewer
              key={`${project}-${entry}-${viewerKey}`}
              ref={viewerRef}
              project={project}
              entryXml={entry}
              onObs={handleObs}
            />
          </Card>

          <Card title="策略加载（ONNX）" size="small" style={{ marginTop: 16 }}
            extra={policyLoaded && <Tag color="green" style={{ marginInlineEnd: 0 }}>{policyLoaded}</Tag>}
          >
            <Space size={8} wrap>
              <Select placeholder="训练 run" style={{ width: 220 }} value={policyRun || undefined}
                onChange={(v) => {
                  setPolicyRun(v);
                  const r = policyRuns.find((x) => x.run === v);
                  setLayout(guessLayout(r));
                  const files = r?.files ?? [];
                  setPolicyFile(files.length ? files[files.length - 1].name : "");
                }}
                options={policyRuns.map((r) => ({ label: `${r.run}${r.env ? ` · ${r.env}` : ""}`, value: r.run }))}
              />
              <Select placeholder="onnx 文件" style={{ width: 240 }} value={policyFile || undefined}
                onChange={setPolicyFile}
                options={runFiles.map((f) => ({ label: f.name, value: f.name }))}
              />
              <Segmented
                value={policyMode} onChange={(v) => setPolicyMode(v as string)}
                options={[{ label: "行走", value: "walking" }, { label: "站立", value: "standing" }]}
              />
              <Button type="primary" loading={policyLoading} onClick={loadPolicy} disabled={!policyRun || !policyFile}>
                加载策略并运行
              </Button>
              {hasPolicy && <Button icon={<StopOutlined />} onClick={unloadPolicy}>卸载</Button>}
              <Tag color="cyan">{layout === "standing" ? "站立布局 85 维" : "行走布局 101 维"}</Tag>
            </Space>
          </Card>
        </Col>

        {/* 右列：操控台 + 观测可视化 */}
        <Col xs={24} xl={9}>
          <Card
            title="指令操控台"
            size="small"
            extra={
              <Space size={12}>
                <span style={{ fontSize: 12 }}>
                  <Switch size="small" checked={keyboardOn} onChange={setKeyboardOn} /> 键盘
                </span>
                <span style={{ fontSize: 12 }}>
                  <Switch size="small" checked={gamepadOn} onChange={setGamepadOn} /> 手柄
                </span>
                <Button size="small" icon={<StopOutlined />} onClick={clearCmds}>回中</Button>
              </Space>
            }
          >
            {keyboardOn && (
              <Alert
                type="info" showIcon style={{ marginBottom: 10 }}
                message="W/S 前后 · A/D 左右 · Q/E 转向 · R/F 脖子 · ↑↓ 俯仰 · ←→ 偏航 · T/G 翻滚 · X 急停"
              />
            )}
            {gamepadOn && !gamepadOk.current && (
              <Alert type="warning" showIcon style={{ marginBottom: 10 }}
                message="未检测到手柄，请连接后按任意手柄键" />
            )}
            <Row gutter={[8, 0]}>
              {AXES.map((ax) => (
                <Col key={ax.idx} span={12}>
                  <div style={{ fontSize: 12, color: "#999" }}>
                    {ax.name}
                    <span style={{ color: "#5edede", marginLeft: 6 }}>{cmdView[ax.idx]?.toFixed(2)}</span>
                  </div>
                  <Slider
                    min={ax.min} max={ax.max} step={(ax.max - ax.min) / 100} value={cmdView[ax.idx] ?? 0}
                    onChange={(v) => setCmd(ax.idx, v as number)} tooltip={{ open: false }}
                  />
                </Col>
              ))}
            </Row>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <RocketOutlined /> 指令写入策略观测的第 6–12 维；键盘按住为斜坡增减，手柄摇杆为绝对值控制。
            </Typography.Text>
          </Card>

          <Card
            title={<>观测可视化 <Tag style={{ marginInlineStart: 8 }} color="cyan">{obsLayout === "standing" ? "85 维" : "101 维"}</Tag></>}
            size="small" style={{ marginTop: 16 }}
          >
            {!hasPolicy && !obs && (
              <Typography.Text type="secondary">加载策略后，这里会实时显示策略网络的输入向量。</Typography.Text>
            )}
            {obs && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                  {groups.map((g, gi) => (
                    <Tag
                      key={g.name}
                      color={gi === selGroup ? "cyan" : "default"}
                      style={{ cursor: "pointer", marginInlineEnd: 0 }}
                      onClick={() => setSelGroup(gi)}
                    >
                      {g.name} <span style={{ opacity: 0.6 }}>[{g.from}-{g.to})</span>
                    </Tag>
                  ))}
                </div>
                {/* 分块条形图 */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {groups.map((g, gi) => {
                    const n = g.to - g.from;
                    const vals = obs.slice(g.from, g.to);
                    const m = Math.max(1e-6, ...vals.map((v) => Math.abs(v)));
                    return (
                      <div key={g.name} style={{ width: n <= 4 ? 90 : "100%" }}>
                        <div style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>
                          {g.name}{gi === selGroup ? " ▼" : ""}
                        </div>
                        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: n <= 4 ? 36 : 44 }}>
                          {vals.map((v, i) => (
                            <div
                              key={i}
                              title={`[${g.from + i}] ${v.toFixed(4)}`}
                              style={{
                                flex: n <= 4 ? undefined : 1,
                                width: n <= 4 ? 14 : undefined,
                                height: `${Math.max(3, (Math.abs(v) / m) * 100)}%`,
                                minWidth: 3,
                                background: v >= 0 ? "#13c2c2" : "#ff7a45",
                                borderRadius: 1,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* 选中分块的时序曲线 */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>
                    时序（近 15 秒 · {groups[selGroup]?.name}）
                  </div>
                  <canvas ref={canvasRef} width={640} height={120} style={{ width: "100%", background: "#141414", borderRadius: 4 }} />
                </div>
              </>
            )}
          </Card>
        </Col>
      </Row>
    </>
  );
}
