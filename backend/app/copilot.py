"""M2 LLM Copilot：模板约束的训练环境代码生成。

流程：构建上下文（MJCF 结构 + reward 库 + 骨架源码）→ 调 LLM 生成完整环境文件
→ 写入 generated/ 目录 → WSL 内静态检查（语法/导入/实例化）→ 注册为可用环境。
"""

import difflib
import json
import re
import subprocess
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from .adapters import Adapter
from .config import settings

RESERVED_ENVS = {"joystick", "standing"}
ENV_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

# ------------------------------------------------------------------ MJCF 摘要

_ACTUATOR_TAGS = {"position", "motor", "general", "velocity", "torque"}


def mjcf_summary(xmls_dir: Path, entry_rel: str) -> str:
    """递归解析 MJCF（含 include），输出关节/执行器/传感器结构摘要。"""
    seen: set[str] = set()
    joints: list[str] = []
    actuators: list[str] = []
    sensors: list[str] = []

    def parse(rel: str) -> None:
        if rel in seen:
            return
        seen.add(rel)
        try:
            root = ET.parse(xmls_dir / rel).getroot()
        except ET.ParseError:
            return
        parent = Path(rel).parent
        for inc in root.iter("include"):
            f = inc.get("file")
            if f:
                parse((parent / f).as_posix())
        for j in root.iter("joint"):
            jname = j.get("name")
            if not jname:
                continue  # default class 里的模板定义
            jtype = j.get("type", "hinge")
            if jtype in ("hinge", "slide"):
                rng = j.get("range", "")
                joints.append(f"- {jname} ({jtype}, range=[{rng}])")
        for a in root.iter():
            if a.tag in _ACTUATOR_TAGS and a.get("name"):
                parts = [f"{a.tag}"]
                if a.get("joint"):
                    parts.append(f"joint={a.get('joint')}")
                if a.get("gear"):
                    parts.append(f"gear={a.get('gear')}")
                actuators.append(f"- {a.get('name')} ({', '.join(parts)})")
        for sensor_block in root.iter("sensor"):
            for s in sensor_block:
                sensors.append(f"- {s.get('name')} ({s.tag})")

    parse(entry_rel)
    out = ["== MJCF 结构摘要 =="]
    out.append("关节（文档顺序，即 qpos 顺序）:")
    out.extend(joints or ["(无)"])
    out.append("\n执行器（文档顺序，即 ctrl 顺序）:")
    out.extend(actuators or ["(无)"])
    out.append("\n传感器:")
    out.extend(sensors or ["(无)"])
    return "\n".join(out)


# ------------------------------------------------------------------ 上下文构建

BASE_API_DOC = """== 基类 OpenDuckMiniV2Env 可用 API（base.py）==
self._mj_model / self.mjx_model      # mujoco 模型
self._init_q                          # home keyframe qpos
self._default_actuator                # home keyframe ctrl（14 维默认关节目标）
self.get_actuator_joints_qpos(data.qpos)      # 14 个实际关节角（不含浮动基座/虚隙）
self.get_actuator_joints_qvel(data.qvel)      # 14 个实际关节角速度
self.get_actuator_joint_qpos_from_name(data.qpos, "head_yaw")  # 按名取关节角
self.get_floating_base_qpos(data.qpos) / get_floating_base_qvel(data.qvel)
self.get_gravity(data) / get_gyro(data) / get_accelerometer(data)
self.get_local_linvel(data) / get_global_linvel(data) / get_global_angvel(data)
self.dt                                # ctrl_dt（默认 0.02s）
"""

KEY_FACTS = """== 关键事实（必须遵守）==
1. 实际关节共 14 个，qpos/qvel/actuator 顺序为：
   [0:5] 左腿: left_hip_yaw, left_hip_roll, left_hip_pitch, left_knee, left_ankle
   [5:9] 头颈: neck_pitch, head_pitch, head_yaw, head_roll
   [9:14] 右腿: right_hip_yaw, right_hip_roll, right_hip_pitch, right_knee, right_ankle
2. info["command"] 为 7 维: [lin_vel_x, lin_vel_y, ang_vel_yaw, neck_pitch, head_pitch, head_yaw, head_roll]
   obs（state）中已包含完整 7 维 command。
3. reward_config.scales 的键必须与 _get_reward() 返回字典的键完全一致（每个键都要有非零 scale，
   否则 metrics 缺失；reward 键用正值、cost 键用负值便于日志区分）。
4. 代码必须兼容 JAX jit：step/reset/_get_reward 内只用 jax 操作，禁止 python 分支依赖数组值。
5. episode_length=1000（约 20 秒 ctrl_dt=0.02）；step() 中 info["step"] 计数、done 或超 500 步重置。
6. 终止条件参考: self.get_gravity(data)[-1] < 0.0（摔倒）| qpos/qvel 出现 NaN。
"""

GENERATION_RULES = """== 输出格式（严格）==
第一行: ENV_NAME: <snake_case 环境名，不能用 joystick/standing>
随后: 一个 ```python 代码块，包含完整可运行的环境模块。不要输出其他内容。

== 代码约束（严格）==
1. 以提供的 standing.py 为骨架（整体结构保持一致），按需求修改 config、命令生成、reward。
2. 模块级必须定义:
   - default_config() -> config_dict.ConfigDict
   - 环境类（继承 open_duck_mini_v2_base.OpenDuckMiniV2Env，含 _post_init/reset/step/
     _get_termination/_get_obs/_get_reward/sample_command）
   - ENV_CLASS = <类名>   # runner 通过它加载环境
3. 导入限制（只能用这些）: jax, jax.numpy as jp, ml_collections.config_dict,
   mujoco.mjx, mujoco.mjx._src.math, numpy, mjx_env（mujoco_playground._src）,
   geoms_colliding（mujoco_playground._src.collision）, constants, base
   (as open_duck_mini_v2_base), playground.common.rewards 中的已有函数。
4. 重要：生成文件保存在 playground/open_duck_mini_v2/generated/ 子包内，
   禁止相对导入（from . import xxx）。constants 与 base 必须写完整路径:
   from playground.open_duck_mini_v2 import constants
   from playground.open_duck_mini_v2 import base as open_duck_mini_v2_base
5. reward 设计优先复用 playground/common/rewards.py 中的函数；需要新 reward 逻辑时
   在文件内定义独立函数（纯 jax）。
6. 命令生成逻辑：sample_command(rng) 签名固定；若命令需要随时间变化（如正弦目标），
   可在 step() 中基于 info 内的步计数器直接更新 info["command"]（参考骨架中
   jp.where(state.info["step"] > 500, ...) 的位置），并保证 reset 时初始化。
7. 禁止: 读写文件、print、python 循环依赖数组值、修改 self 状态（_post_init 除外）。
"""


def build_context(adapter: Adapter) -> str:
    """组装给 LLM 的完整上下文。"""
    repo = adapter.repo_root
    env_dir = repo / "playground" / "open_duck_mini_v2"
    skeleton = (env_dir / "standing.py").read_text(encoding="utf-8")
    rewards_src = (repo / "playground" / "common" / "rewards.py").read_text(encoding="utf-8")
    entry = adapter.entry_xmls()[0] if adapter.entry_xmls() else adapter.list_xmls()[0]
    summary = mjcf_summary(adapter.xmls_dir, entry)

    parts = [
        "你在为双足鸭子机器人 Open Duck Mini V2 生成 MuJoCo Playground 强化学习训练环境。",
        "",
        summary,
        "",
        BASE_API_DOC,
        "",
        KEY_FACTS,
        "",
        GENERATION_RULES,
        "",
        "== 参考骨架 standing.py（完整源码，生成物应保持相同结构）==",
        skeleton,
        "",
        "== 可复用的 reward 库 playground/common/rewards.py（完整源码）==",
        rewards_src,
    ]
    return "\n".join(parts)


# ------------------------------------------------------------------ LLM 调用


def call_llm(system: str, user: str) -> str:
    """OpenAI 兼容 chat/completions 调用（标准库实现）。"""
    if not settings.llm_configured:
        raise ValueError(
            "LLM 未配置：请在 robot-ti-platform/platform.yaml 的 llm 段填写 "
            "base_url / api_key / model 后重启后端"
        )
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": settings.llm_temperature,
        "max_tokens": settings.llm_max_tokens,
    }
    req = urllib.request.Request(
        f"{settings.llm_base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.llm_api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=settings.llm_timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise ValueError(f"LLM 接口错误 {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise ValueError(f"LLM 接口不可达: {e}") from e
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise ValueError(f"LLM 返回格式异常: {json.dumps(body)[:500]}") from e


# ------------------------------------------------------------------ 生成结果解析


def parse_response(text: str) -> tuple[str, str]:
    """从 LLM 输出解析 (env_name, code)。"""
    m = re.search(r"ENV_NAME:\s*([A-Za-z0-9_]+)", text)
    env_name = (m.group(1) if m else "").strip().lower()
    blocks = re.findall(r"```(?:python)?\s*\n(.*?)```", text, re.DOTALL)
    if not blocks:
        raise ValueError("LLM 输出中未找到 ```python 代码块")
    code = max(blocks, key=len).strip() + "\n"
    if not env_name:
        raise ValueError("LLM 输出中未找到 ENV_NAME 行")
    if not ENV_NAME_RE.match(env_name):
        raise ValueError(f"非法环境名: {env_name}（需为 snake_case 标识符）")
    if env_name in RESERVED_ENVS:
        raise ValueError(f"环境名 {env_name} 为保留名，请换一个")
    if "ENV_CLASS" not in code:
        raise ValueError("生成代码缺少模块级 ENV_CLASS 定义")
    return env_name, code


def slugify(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()
    return s or "custom_env"


# ------------------------------------------------------------------ 静态检查


def _wsl_run(adapter: Adapter, script: str, timeout: int = 180) -> tuple[int, str]:
    argv = [
        "wsl.exe", "--distribution", settings.wsl_distro,
        "--cd", adapter.wsl_repo_root,
        "--exec", "bash", "-lc", script,
    ]
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "检查超时"
    except OSError as e:
        return 125, str(e)
    out = (r.stdout + r.stderr).decode("utf-8", errors="replace").strip()
    return r.returncode, out


def static_check(adapter: Adapter, env_name: str) -> tuple[bool, str]:
    """WSL 内三阶段检查：语法编译 → 模块导入 → 环境实例化。"""
    mod = f"playground.open_duck_mini_v2.generated.{env_name}"
    lines = []
    # 阶段 1: 语法
    rc, out = _wsl_run(
        adapter, f"uv run python -m py_compile playground/open_duck_mini_v2/generated/{env_name}.py",
        timeout=60,
    )
    if rc != 0:
        return False, f"[py_compile 失败]\n{out}"
    lines.append("[1/3] py_compile 通过")
    # 阶段 2: 导入 + 约定检查
    rc, out = _wsl_run(
        adapter,
        f'uv run python -c "import {mod} as m; assert m.ENV_CLASS; assert callable(m.default_config); '
        f'print(m.ENV_CLASS.__name__)"',
        timeout=180,
    )
    if rc != 0:
        return False, "\n".join(lines) + f"\n[导入失败]\n{out}"
    lines.append(f"[2/3] 模块导入通过（ENV_CLASS={out.splitlines()[-1] if out else '?'}）")
    # 阶段 3: 实例化（加载 MJCF + jax，最严格）
    rc, out = _wsl_run(
        adapter,
        f'uv run python -c "from playground.open_duck_mini_v2.generated.{env_name} import ENV_CLASS; '
        f'e = ENV_CLASS(task=\'flat_terrain\'); '
        f'print(\'instance OK\', e.action_size)"',
        timeout=300,
    )
    if rc != 0:
        return False, "\n".join(lines) + f"\n[实例化失败]\n{out}"
    lines.append(f"[3/3] 环境实例化通过（{out.splitlines()[-1] if out else ''}）")
    return True, "\n".join(lines)


# ------------------------------------------------------------------ diff


def make_diff(adapter: Adapter, code: str) -> str:
    """与骨架 standing.py 的 unified diff。"""
    skeleton = (adapter.repo_root / "playground" / "open_duck_mini_v2" / "standing.py").read_text(
        encoding="utf-8", errors="replace"
    ).splitlines(keepends=True)
    diff = difflib.unified_diff(
        skeleton, code.splitlines(keepends=True),
        fromfile="standing.py（骨架）", tofile="generated（新环境）",
    )
    return "".join(diff)


# ------------------------------------------------------------------ 生成主流程


def generate(adapter: Adapter, requirement: str, env_name_hint: str | None = None) -> dict:
    """生成环境文件 + 静态检查 + 注册。返回给前端的结果字典。"""
    requirement = requirement.strip()
    if not requirement:
        raise ValueError("需求描述不能为空")

    gen_dir = adapter.generated_envs_dir
    if gen_dir is None:
        raise ValueError("该项目的 adapter 未配置 generated_envs")

    system = "你是机器人强化学习训练任务代码生成器，严格按用户提供的上下文与约束输出。"
    user = build_context(adapter) + f"\n\n== 用户需求 ==\n{requirement}\n"
    if env_name_hint:
        suggested = slugify(env_name_hint)
        if ENV_NAME_RE.match(suggested) and suggested not in RESERVED_ENVS:
            user += f"\n（建议环境名: {suggested}）\n"

    raw = call_llm(system, user)
    env_name, code = parse_response(raw)

    target = gen_dir / f"{env_name}.py"
    if target.exists():
        raise ValueError(f"环境 {env_name} 已存在，请先删除或换名")

    gen_dir.mkdir(parents=True, exist_ok=True)
    target.write_text(code, encoding="utf-8")

    ok, check_output = static_check(adapter, env_name)
    if not ok:
        # 检查失败：保留文件供查看，但不注册为可用环境
        return {
            "env_name": env_name, "code": code, "file": target.relative_to(adapter.repo_root).as_posix(),
            "check_ok": False, "check_output": check_output, "diff": make_diff(adapter, code),
            "registered": False,
        }

    registered = env_name in adapter.register_generated_envs()
    return {
        "env_name": env_name, "code": code, "file": target.relative_to(adapter.repo_root).as_posix(),
        "check_ok": True, "check_output": check_output, "diff": make_diff(adapter, code),
        "registered": registered,
    }


def list_generated(adapter: Adapter) -> list[dict]:
    gen_dir = adapter.generated_envs_dir
    if gen_dir is None or not gen_dir.is_dir():
        return []
    out = []
    for p in sorted(gen_dir.glob("*.py")):
        if p.stem.startswith("_") or p.stem == "__init__":
            continue
        out.append({
            "env_name": p.stem,
            "file": p.relative_to(adapter.repo_root).as_posix(),
            "mtime": p.stat().st_mtime,
            "size": p.stat().st_size,
        })
    return out


def read_generated(adapter: Adapter, env_name: str) -> str:
    if not ENV_NAME_RE.match(env_name) or env_name in RESERVED_ENVS:
        raise ValueError(f"非法环境名: {env_name}")
    p = gen_file(adapter, env_name)
    if not p.is_file():
        raise ValueError(f"环境 {env_name} 不存在")
    return p.read_text(encoding="utf-8")


def gen_file(adapter: Adapter, env_name: str) -> Path:
    gen_dir = adapter.generated_envs_dir
    if gen_dir is None:
        raise ValueError("该项目的 adapter 未配置 generated_envs")
    return gen_dir / f"{env_name}.py"


def delete_generated(adapter: Adapter, env_name: str) -> None:
    p = gen_file(adapter, env_name)
    if not ENV_NAME_RE.match(env_name) or env_name in RESERVED_ENVS:
        raise ValueError(f"非法环境名: {env_name}")
    if not p.is_file():
        raise ValueError(f"环境 {env_name} 不存在")
    p.unlink()
    adapter.envs.pop(env_name, None)
