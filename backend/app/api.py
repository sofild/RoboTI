"""REST API 路由。"""

import functools
import io
import json
import pickle
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .adapters import Adapter, load_adapters
from .config import settings
from .copilot import (
    delete_generated, generate, list_generated, read_generated,
)
from .jobs import JobManager
from .metrics import read_scalars

router = APIRouter(prefix="/api")

adapters = load_adapters(settings.adapters_dir)
job_manager = JobManager(adapters)


class TrainRequest(BaseModel):
    env: str
    task: str
    num_timesteps: int = Field(gt=0)


class GenerateRequest(BaseModel):
    requirement: str
    env_name_hint: str | None = None


def _adapter(name: str) -> Adapter:
    a = adapters.get(name)
    if a is None:
        raise HTTPException(404, f"项目不存在: {name}")
    # 重扫 Copilot 生成环境目录，保证运行中新生成的环境立即可用
    a.register_generated_envs()
    return a


def _job(job_id: str):
    j = job_manager.get(job_id)
    if j is None:
        raise HTTPException(404, f"任务不存在: {job_id}")
    return j


# ---------------------------------------------------------------- 项目

@router.get("/projects")
def list_projects():
    out = []
    for a in adapters.values():
        a.register_generated_envs()  # 保证新生成的环境出现在下拉中
        out.append({
            "name": a.name,
            "display_name": a.display_name,
            "description": a.description,
            "envs": a.envs,
            "default_timesteps": a.default_timesteps,
        })
    return out


@router.get("/projects/{name}")
def project_detail(name: str):
    a = _adapter(name)
    return {
        "name": a.name,
        "display_name": a.display_name,
        "description": a.description,
        "envs": a.envs,
        "default_timesteps": a.default_timesteps,
        "xmls": a.list_xmls(),
        "entry_xmls": a.entry_xmls(),
        "jobs": [j.to_public() for j in job_manager.list_jobs(name)[:20]],
    }


@router.get("/checkpoints")
def all_checkpoints():
    """聚合全部项目的 ONNX 策略 run（模型广场用）。"""
    out = []
    jobs_dir = Path(settings.data_dir) / "jobs"
    for a in adapters.values():
        a.register_generated_envs()
        base = a.repo_root / "checkpoints" / "platform"
        if not base.is_dir():
            continue
        for run_dir in sorted(base.iterdir(), reverse=True):
            if not run_dir.is_dir():
                continue
            files = [
                {"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime}
                for p in sorted(run_dir.glob("*.onnx"), key=lambda p: p.name)
            ]
            if not files:
                continue
            env, num_timesteps = "", 0
            job_file = jobs_dir / run_dir.name / "job.json"
            if job_file.is_file():
                try:
                    d = json.loads(job_file.read_text(encoding="utf-8"))
                    env = d.get("env", "")
                    num_timesteps = d.get("num_timesteps", 0)
                except Exception:  # noqa: BLE001
                    pass
            out.append({
                "project": a.name,
                "display_name": a.display_name,
                "run": run_dir.name,
                "env": env,
                "num_timesteps": num_timesteps,
                "files": files,
            })
    return out


@router.get("/projects/{name}/xmls.zip")
def project_xmls_zip(name: str):
    """打包整个 xmls 目录（含 assets），供前端 MuJoCo WASM 查看器加载。"""
    a = _adapter(name)
    if not a.xmls_dir.is_dir():
        raise HTTPException(404, f"xmls 目录不存在: {a.xmls_dir}")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(a.xmls_dir.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(a.xmls_dir).as_posix())
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'inline; filename="{name}_xmls.zip"'},
    )


# ---------------------------------------------------------------- Copilot（M2）

@router.post("/projects/{name}/copilot/generate")
def copilot_generate(name: str, req: GenerateRequest):
    """LLM 生成训练环境：生成 → 写文件 → 静态检查 → 注册。耗时约 1-5 分钟。"""
    a = _adapter(name)
    try:
        result = generate(a, req.requirement, req.env_name_hint)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return result


@router.get("/projects/{name}/copilot/generated")
def copilot_list(name: str):
    return list_generated(_adapter(name))


@router.get("/projects/{name}/copilot/generated/{env}")
def copilot_read(name: str, env: str):
    try:
        return {"env_name": env, "code": read_generated(_adapter(name), env)}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.delete("/projects/{name}/copilot/generated/{env}")
def copilot_delete(name: str, env: str):
    try:
        delete_generated(_adapter(name), env)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


# ---------------------------------------------------------------- 训练任务

@router.post("/projects/{name}/train")
def start_training(name: str, req: TrainRequest):
    a = _adapter(name)
    try:
        job = job_manager.submit(a, req.env, req.task, req.num_timesteps)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return job.to_public()


@router.get("/jobs")
def list_jobs(project: str | None = None):
    return [j.to_public() for j in job_manager.list_jobs(project)]


@router.get("/jobs/{job_id}")
def job_detail(job_id: str):
    return _job(job_id).to_public()


@router.get("/jobs/{job_id}/log")
def job_log(job_id: str, tail: int = 300):
    job = _job(job_id)
    return {"status": job.status, "log": job_manager.read_log(job, tail)}


@router.post("/jobs/{job_id}/stop")
def stop_job(job_id: str):
    job_manager.stop(job_id)
    return _job(job_id).to_public()


@router.get("/jobs/{job_id}/metrics")
def job_metrics(job_id: str):
    """解析该 job 输出目录下的 TensorBoard 事件，返回标量曲线。"""
    job = _job(job_id)
    a = _adapter(job.project)
    out_dir = a.repo_root / job.output_dir
    return read_scalars(out_dir)


@router.get("/jobs/{job_id}/artifacts")
def job_artifacts(job_id: str):
    """列出该 job 的 checkpoint 目录与导出的 onnx 模型。"""
    job = _job(job_id)
    a = _adapter(job.project)
    out_dir = a.repo_root / job.output_dir
    checkpoints, onnx_models = [], []
    if out_dir.is_dir():
        for p in sorted(out_dir.iterdir()):
            if p.is_dir():
                checkpoints.append({
                    "name": p.name,
                    "mtime": p.stat().st_mtime,
                    "n_files": sum(1 for _ in p.rglob("*") if _.is_file()),
                })
            elif p.suffix == ".onnx":
                onnx_models.append({
                    "name": p.name,
                    "size": p.stat().st_size,
                    "mtime": p.stat().st_mtime,
                })
    return {"checkpoints": checkpoints, "onnx": onnx_models}


@router.get("/jobs/{job_id}/download/{filename}")
def download_artifact(job_id: str, filename: str):
    """下载 job 产物文件（当前支持 onnx 导出）。"""
    job = _job(job_id)
    a = _adapter(job.project)
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "非法文件名")
    p: Path = a.repo_root / job.output_dir / filename
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(p, filename=filename)


# ---------------------------------------------------------------- 策略推理（ONNX）

@functools.lru_cache(maxsize=8)
def _phase_period(pkl_path: str, mtime: float) -> int:
    """读取参考运动 pickle，返回步态相位周期步数 nb_steps_in_period。"""
    with open(pkl_path, "rb") as f:
        d = pickle.load(f)
    first = next(iter(d.values()))
    return int(first["period"] * first["fps"])


@router.get("/projects/{name}/policy/checkpoints")
def policy_checkpoints(name: str):
    """列出 checkpoints/platform 下各训练 run 导出的 ONNX 策略。"""
    a = _adapter(name)
    base = a.repo_root / "checkpoints" / "platform"
    jobs_dir = Path(settings.data_dir) / "jobs"
    runs = []
    if base.is_dir():
        for run_dir in sorted(base.iterdir(), reverse=True):
            if not run_dir.is_dir():
                continue
            files = [
                {"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime}
                for p in sorted(run_dir.glob("*.onnx"), key=lambda p: p.name)
            ]
            if files:
                # 训练环境（用于前端判断 obs 布局是否兼容，读不到则留空）
                env = ""
                job_file = jobs_dir / run_dir.name / "job.json"
                if job_file.is_file():
                    try:
                        env = json.loads(job_file.read_text(encoding="utf-8")).get("env", "")
                    except Exception:  # noqa: BLE001
                        pass
                runs.append({"run": run_dir.name, "files": files, "env": env})
    return runs


@router.post("/projects/{name}/policy/upload")
async def policy_upload(name: str, file: UploadFile):
    """上传外部 ONNX 策略，保存到 checkpoints/platform/uploaded/，纳入下拉选择。"""
    a = _adapter(name)
    if not file.filename or not file.filename.lower().endswith(".onnx"):
        raise HTTPException(400, "仅支持 .onnx 文件")
    fname = Path(file.filename).name
    dst_dir = a.repo_root / "checkpoints" / "platform" / "uploaded"
    dst_dir.mkdir(parents=True, exist_ok=True)
    with open(dst_dir / fname, "wb") as f:
        f.write(await file.read())
    return {"ok": True, "run": "uploaded", "file": fname}


@router.get("/projects/{name}/policy/onnx/{run}/{filename}")
def policy_onnx(name: str, run: str, filename: str):
    """下载指定 run 的 ONNX 策略文件。"""
    a = _adapter(name)
    if any(bad in run + filename for bad in ("/", "\\", "..")):
        raise HTTPException(400, "非法路径")
    p = a.repo_root / "checkpoints" / "platform" / run / filename
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    return FileResponse(p, media_type="application/octet-stream")


@router.get("/projects/{name}/policy/phase-period")
def policy_phase_period(name: str):
    """参考运动步态相位周期步数（行走模式 imitation_phase 用）。"""
    a = _adapter(name)
    rel = a.raw.get("reference_motion")
    if not rel:
        raise HTTPException(404, "该项目未配置参考运动数据")
    p = a.repo_root / rel
    if not p.is_file():
        raise HTTPException(404, f"参考运动数据不存在: {rel}")
    return {"nb_steps_in_period": _phase_period(str(p), p.stat().st_mtime)}
