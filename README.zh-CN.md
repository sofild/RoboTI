# RoboTI

**RoboTI** = Robot + **T**raining & **I**nference（训推一体）—— 一个开源的 Web 平台，把**机器人强化学习的训练与推理**统一到一处：3D 浏览 MJCF 模型、提交并监控 RL 训练、**在浏览器里直接运行**训练好的 ONNX 策略，并用 LLM Copilot 生成新的训练环境。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![React](https://img.shields.io/badge/React-18-61dafb)
![MuJoCo](https://img.shields.io/badge/MuJoCo-WASM-orange)
![ONNX](https://img.shields.io/badge/ONNX%20Runtime-Web-purple)

[English](README.md)

> 首个接入机器人：**Open Duck Mini V2**（双足鸭子，MuJoCo MJX + PPO）。

---

## ✨ 演示 — 交互实验室

加载模型、挂上训练好的 ONNX 策略，看鸭子走起来——物理仿真与策略推理全部在浏览器本地完成（MuJoCo WASM 跑物理 + ONNX Runtime Web 跑策略），支持键盘 / 手柄控制。

**[▶️ 观看演示视频](docs/imgs/lab-demo.mp4)**

![交互实验室](docs/imgs/lab.png)

<!-- 提示：仓库公开后，可把 lab-demo.mp4 上传到 GitHub Release，用 Release 资源链接
     替换上面的链接即可在 README 内直接播放：
     ![demo](https://github.com/<user>/RoboTI/releases/download/v0.1.0/lab-demo.mp4) -->

## 📸 截图

### 机器人项目 — 模型在线查看、推理、训练一站式

![项目页](docs/imgs/project-overview.png)

<details>
<summary>更多视图</summary>

MJCF 结构查看：

![MJCF 查看器](docs/imgs/project-mjcf.png)

加载训练好的策略进行推理回放：

![推理回放](docs/imgs/project-infer-train.png)

</details>

### 训练 — 提交任务，实时监控指标

![训练监控](docs/imgs/training-monitor-1.png)

<details>
<summary>更多视图</summary>

![训练监控 2](docs/imgs/training-monitor-2.png)

</details>

### 环境工坊 — 用 LLM 生成自定义训练环境

用自然语言描述想要的行为（如"站立同时摇头，head_yaw 跟踪 0.5Hz 正弦目标"），Copilot 自动生成环境代码，经三阶段静态检查后展示 diff 供人工审查，通过后可一键发起沙箱试跑或完整训练。

![环境工坊](docs/imgs/workshop.png)

### 模型广场 — 管理所有训练与上传的模型

![模型广场](docs/imgs/model-hub.png)

### 学习中心 — RL 训练知识库

![学习中心](docs/imgs/learn.png)

## 🧩 功能特性

- **浏览器端 MJCF 查看与仿真** — MuJoCo WASM + Three.js，模型渲染与物理仿真完全在浏览器完成，无需服务端渲染。
- **浏览器端策略推理** — 训练好的 ONNX 策略经 ONNX Runtime Web 直接运行；交互实验室支持键盘 / 手柄实时控制。
- **RL 训练管理** — 提交 / 监控 / 停止任务；自研 TensorBoard 事件解析（无 TensorFlow 依赖），指标实时推送前端；checkpoint 与 ONNX 产物按任务隔离存放。
- **训练进程独立于后端** — 任务经 `systemd-run --user` 在 WSL 内托管，后端重启不影响训练，重启后自动重新挂载监控。
- **LLM Copilot（模板约束生成）** — LLM 只生成"新环境文件"（reward / 配置 / 命令逻辑），严格遵循骨架约定；三阶段静态检查（语法 → 导入 → 环境实例化）；运行前强制 diff 审查。
- **无侵入机器人适配器** — 新增一个 YAML 即可接入新机器人子项目（训练命令模板 + MJCF 目录 + 环境/任务清单），不修改子项目代码。
- **模型广场** — 上传外部 ONNX 或选择任意训练产物，一键跳转交互实验室试跑。

## 🏗️ 架构

```
浏览器
 ├─ React + Ant Design（Vite, TypeScript）
 ├─ MuJoCo WASM — 浏览器内物理仿真
 └─ Three.js — MJCF 渲染
        │ /api/*（JSON / zip / 文件下载）
        ▼
FastAPI 后端
 ├─ adapters/*.yaml — 机器人子项目描述（无侵入）
 ├─ 训练任务 — WSL 内 systemd-run --user 托管
 ├─ 指标 — 自研 TensorBoard 事件解析（无 TensorFlow）
 ├─ LLM Copilot — 模板约束环境生成 + 三阶段检查
 └─ 任务/日志/产物 API + 前端静态托管
        │ wsl.exe
        ▼
WSL Ubuntu（uv + JAX/MJX 训练环境）
 └─ uv run playground/<project>/runner.py --env … --task … --output_dir checkpoints/<job_id>
```

## 🚀 快速开始

### 环境要求

- **Windows 10/11 + WSL2**（推荐 Ubuntu-22.04，启用 systemd）—— 训练在 WSL 内运行
- [uv](https://docs.astral.sh/uv/) — Python 包管理器（Windows 与 WSL 侧都需要）
- **Node.js ≥ 18** — 前端构建
- 一个待训练的机器人子项目 —— 见 [Open_Duck_Playground](https://github.com/apirrone/Open_Duck_Playground)（首个接入项目）

### 目录布局

平台通过适配器访问同级目录下的子项目：

```
parent/
├── RoboTI/                  # 本仓库
└── Open_Duck_Playground/    # 机器人子项目（克隆到 RoboTI 旁边）
```

### 1. 后端

```bash
cd RoboTI/backend
uv sync
# 复制示例配置并按需修改
cp ../platform.example.yaml ../platform.yaml
uv run uvicorn app.main:app --reload --port 8000
```

> 后端在 `http://127.0.0.1:8000` 提供 API；生产模式下（前端 `npm run build` 后）同时托管前端静态页面。

### 2. 前端

```bash
cd RoboTI/frontend
npm install
npm run dev        # http://localhost:5173，/api 自动代理到后端
```

MuJoCo / ONNX Runtime 的 wasm 文件会在 dev/build 时自动复制到 `public/`。

### 3. 训练环境（WSL）

在 WSL 内按子项目要求部署训练环境（Open_Duck_Playground 需要 `uv` + JAX/MJX）。训练任务经 `wsl.exe` 启动，由 systemd user unit 托管。

### 4.（可选）启用 LLM Copilot

编辑 `platform.yaml` —— 任意 OpenAI 兼容接口均可（智谱 GLM / DeepSeek / Kimi 等）：

```yaml
llm:
  base_url: "https://open.bigmodel.cn/api/paas/v4"
  api_key: "<你的 API Key>"
  model: "glm-4.6"
```

重启后端生效。未配置 LLM 时，其余功能均正常可用。

## 🤖 接入新机器人

在 `adapters/` 下新增一个 YAML 即可：

```yaml
name: my_robot
display_name: My Robot
repo_root: ".."                                   # 子项目位置，相对 RoboTI 目录
xmls_dir: playground/my_robot/xmls                # MJCF 资源
reference_motion: playground/my_robot/data/xx.pkl # 可选，模仿奖励用
train_command: >-                                 # 平台自动填充占位符
  uv run playground/my_robot/runner.py --env {env} --task {task}
  --num_timesteps {num_timesteps} --output_dir {output_dir}
envs:
  joystick: [flat_terrain]
```

无需修改机器人子项目代码——平台启动时自动扫描适配器目录。

## 🗺️ 路线图

- [x] 浏览器 MJCF 查看器 + MuJoCo WASM 仿真
- [x] RL 训练管理与实时指标
- [x] 浏览器端 ONNX 推理与交互实验室
- [x] LLM Copilot 环境生成
- [x] 模型广场与学习中心
- [ ] 服务端 rollout 视频流回放（大模型/弱终端保底方案）
- [ ] Docker / 一键部署、多用户支持
- [ ] 开箱即用的更多机器人（第二个适配器）

## 🙏 致谢

- [Open_Duck_Playground](https://github.com/apirrone/Open_Duck_Playground) — 首个接入的机器人子项目（也是很棒的机器人 RL 游乐场）
- [mujoco_playground](https://github.com/kscalelabs/mujoco_playground) — 灵感来源
- [MuJoCo](https://mujoco.org/) / [MJX](https://github.com/google-deepmind/mujoco), [ONNX Runtime Web](https://onnxruntime.ai/), [Three.js](https://threejs.org/), [FastAPI](https://fastapi.tiangolo.com/)

## 许可证

[MIT](LICENSE)
