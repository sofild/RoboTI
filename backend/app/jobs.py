"""训练任务管理：提交（WSL/本机执行）、日志采集、状态跟踪、持久化。

WSL 模式下训练进程通过 nohup 在 WSL 内独立运行（父进程为 WSL init），
平台后端重启不会终止训练；后端通过轮询 PID 存活 + 退出码文件跟踪状态，
重启后自动重新挂载监控。
"""

import json
import re
import shlex
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from .adapters import Adapter
from .config import settings

POLL_INTERVAL = 3.0  # WSL 存活轮询间隔（秒）


@dataclass
class Job:
    id: str
    project: str
    env: str
    task: str
    num_timesteps: int
    command: str
    status: str  # running / finished / failed / stopped / stopping
    created_at: str
    output_dir: str  # 相对仓库根
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    pid: int | None = None  # WSL 模式：nohup bash 的 PID；本机模式：Popen pid
    log_rel: str = ""  # 日志文件（相对平台 data 目录）
    _proc: subprocess.Popen | None = field(default=None, repr=False, compare=False)
    _stop_requested: bool = field(default=False, repr=False, compare=False)

    def to_public(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("_proc", None)
        d.pop("_stop_requested", None)
        return d


def _to_wsl_path(p: Path) -> str:
    """Windows 绝对路径 → WSL 挂载路径（D:\\a\\b → /mnt/d/a/b）。"""
    s = str(p.resolve())
    m = re.match(r"^([A-Za-z]):[/\\](.*)$", s)
    if not m:
        return s
    return f"/mnt/{m.group(1).lower()}/{m.group(2).replace(chr(92), '/')}"


class JobManager:
    def __init__(self, adapters: dict[str, Adapter]) -> None:
        self.adapters = adapters
        self.data_dir: Path = settings.data_dir
        self.jobs_dir = self.data_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._load_existing()

    # ------------------------------------------------------------------ 持久化

    def _job_dir(self, job_id: str) -> Path:
        return self.jobs_dir / job_id

    def _save(self, job: Job) -> None:
        d = self._job_dir(job.id)
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "job.json", "w", encoding="utf-8") as f:
            json.dump(job.to_public(), f, ensure_ascii=False, indent=2)

    def _exit_code_path(self, job: Job) -> Path:
        return self._job_dir(job.id) / "exit_code"

    def _log_path(self, job: Job) -> Path:
        return self.data_dir / job.log_rel

    def _load_existing(self) -> None:
        for jf in sorted(self.jobs_dir.glob("*/job.json")):
            try:
                with open(jf, "r", encoding="utf-8") as f:
                    d = json.load(f)
                job = Job(**{k: v for k, v in d.items() if k in Job.__dataclass_fields__})
            except (json.JSONDecodeError, TypeError):
                continue
            # 后端重启：WSL 训练进程由 systemd 独立托管，重新挂载监控
            if job.status in ("running", "stopping"):
                if settings.train_mode == "wsl":
                    probe = self._probe_wsl(job)
                    if probe == "ALIVE":
                        threading.Thread(
                            target=self._watch_wsl, args=(job,), daemon=True
                        ).start()
                    else:
                        self._finalize_wsl(job, probe)
                else:
                    # 本机模式：进程句柄随后端丢失
                    job.status = "stopped"
                    job.finished_at = job.finished_at or datetime.now().isoformat(timespec="seconds")
                    self._save(job)
            self.jobs[job.id] = job

    # ------------------------------------------------------------------ WSL 辅助

    def _wsl_argv(self, script: str, cwd: str | None = None) -> list[str]:
        argv = ["wsl.exe", "--distribution", settings.wsl_distro]
        if cwd:
            argv += ["--cd", cwd]
        return argv + ["--exec", "bash", "-lc", script]

    def _unit_name(self, job_id: str) -> str:
        return f"rtip-{job_id}"

    def _probe_wsl(self, job: Job) -> str:
        """探测 WSL 内训练 systemd unit 状态：ALIVE / 退出码数字 / NOEXIT（无退出码文件）。"""
        ec = _to_wsl_path(self._exit_code_path(job))
        script = (
            f"st=$(systemctl --user is-active {self._unit_name(job.id)} 2>/dev/null); "
            f"if [ \"$st\" = active ] || [ \"$st\" = activating ] || [ \"$st\" = reloading ]; then echo ALIVE; "
            f"elif [ -f '{ec}' ]; then cat '{ec}'; else echo NOEXIT; fi"
        )
        try:
            r = subprocess.run(
                self._wsl_argv(script), capture_output=True, timeout=15
            )
            out = r.stdout.decode("utf-8", errors="replace").strip()
        except (subprocess.TimeoutExpired, OSError):
            return "NOEXIT"
        if out == "ALIVE" or out == "NOEXIT":
            return out
        try:
            return str(int(out))
        except ValueError:
            return "NOEXIT"

    @staticmethod
    def _to_wsl(p: Path) -> str:
        return _to_wsl_path(p)

    def _finalize_wsl(self, job: Job, probe: str) -> None:
        """根据探测结果确定终态。"""
        if probe not in ("ALIVE", "NOEXIT"):
            try:
                job.exit_code = int(probe)
            except ValueError:
                job.exit_code = None
        job.finished_at = datetime.now().isoformat(timespec="seconds")
        if job._stop_requested or job.status == "stopping":
            job.status = "stopped"
        elif job.exit_code == 0:
            job.status = "finished"
        else:
            job.status = "failed" if job.exit_code is not None else "stopped"
        self._save(job)

    def _watch_wsl(self, job: Job) -> None:
        """轮询 WSL 训练进程存活，结束后读取退出码并更新状态。"""
        while True:
            time.sleep(POLL_INTERVAL)
            probe = self._probe_wsl(job)
            if probe != "ALIVE":
                # 等待退出码文件落盘（bash 写 echo 后才退出）
                for _ in range(3):
                    if probe not in ("ALIVE", "NOEXIT"):
                        break
                    time.sleep(1.0)
                    probe = self._probe_wsl(job)
                self._finalize_wsl(job, probe)
                return

    # ------------------------------------------------------------------ 提交

    def submit(self, adapter: Adapter, env: str, task: str, num_timesteps: int) -> Job:
        if env not in adapter.envs:
            raise ValueError(f"未知环境: {env}，可用: {list(adapter.envs)}")
        if task not in adapter.envs[env]:
            raise ValueError(f"环境 {env} 下未知任务: {task}")

        job_id = datetime.now().strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
        output_dir = adapter.output_dir_for(job_id)
        cmd_str = adapter.train_command.format(
            env=env, task=task, num_timesteps=num_timesteps, output_dir=output_dir
        )

        now = datetime.now().isoformat(timespec="seconds")
        job = Job(
            id=job_id, project=adapter.name, env=env, task=task,
            num_timesteps=num_timesteps, command=cmd_str,
            status="running", created_at=now, started_at=now,
            output_dir=output_dir,
            log_rel=f"jobs/{job_id}/train.log",
        )
        log_path = self._log_path(job)
        exit_path = self._exit_code_path(job)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        if settings.train_mode == "wsl":
            # systemd-run --user 托管：训练进程归 WSL 内 user systemd 管理，
            # 不随后端/wsl.exe 退出而终止；日志由 systemd 追加写入，退出码落文件。
            wsl_log = _to_wsl_path(log_path)
            wsl_exit = _to_wsl_path(exit_path)
            inner = f"{cmd_str}; echo $? > '{wsl_exit}'"
            launcher = (
                f"systemd-run --user --collect --unit={self._unit_name(job_id)} "
                f"--property=StandardOutput=append:{wsl_log} "
                f"--property=StandardError=append:{wsl_log} "
                f"--property=WorkingDirectory={adapter.wsl_repo_root} "
                f"bash -lc {shlex.quote(inner)}"
            )
            try:
                r = subprocess.run(
                    self._wsl_argv(launcher, cwd=adapter.wsl_repo_root),
                    capture_output=True, timeout=60,
                )
            except (subprocess.TimeoutExpired, OSError) as e:
                raise RuntimeError(f"WSL 启动失败: {e}") from e
            if r.returncode != 0:
                msg = r.stdout.decode("utf-8", errors="replace") + r.stderr.decode(
                    "utf-16le", errors="replace"
                )
                raise RuntimeError(f"WSL systemd-run 失败: {msg.strip()[:300]}")
            job.pid = None
            with self._lock:
                self.jobs[job_id] = job
            self._save(job)
            threading.Thread(target=self._watch_wsl, args=(job,), daemon=True).start()
        else:
            proc = subprocess.Popen(
                cmd_str, shell=True, cwd=str(adapter.repo_root),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            job.pid = proc.pid
            with self._lock:
                self.jobs[job_id] = job
            self._save(job)
            threading.Thread(target=self._drain, args=(job, proc), daemon=True).start()
        return job

    def _drain(self, job: Job, proc: subprocess.Popen) -> None:
        """本机模式：转发进程输出到日志文件并等待退出。"""
        log_path = self._log_path(job)
        try:
            with open(log_path, "wb") as f:
                for line in iter(proc.stdout.readline, b""):  # type: ignore[union-attr]
                    f.write(line)
                    f.flush()
            proc.wait()
            rc = proc.returncode
        except Exception:
            rc = -1
        finally:
            job._proc = None
            job.exit_code = rc
            job.finished_at = datetime.now().isoformat(timespec="seconds")
            if job._stop_requested:
                job.status = "stopped"
            else:
                job.status = "finished" if rc == 0 else "failed"
            self._save(job)

    # ------------------------------------------------------------------ 控制

    def stop(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if job is None or job.status != "running":
            return
        job._stop_requested = True
        if settings.train_mode == "wsl":
            # systemd 停止整个 cgroup（uv/python 全部子进程）+ pkill 兜底
            subprocess.run(
                self._wsl_argv(
                    f"systemctl --user stop {self._unit_name(job.id)} 2>/dev/null; "
                    f"pkill -f 'platform/{job.id}' || true"
                ),
                capture_output=True, timeout=30,
            )
        else:
            if job._proc is not None:
                try:
                    job._proc.kill()
                except OSError:
                    pass
        job.status = "stopping"
        self._save(job)

    # ------------------------------------------------------------------ 查询

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list_jobs(self, project: str | None = None) -> list[Job]:
        jobs = sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)
        if project:
            jobs = [j for j in jobs if j.project == project]
        return jobs

    def read_log(self, job: Job, tail_lines: int = 300) -> str:
        """返回日志尾部文本。"""
        log_path = self._log_path(job)
        if not log_path.is_file():
            return ""
        data = log_path.read_bytes()
        # wsl.exe 自身错误消息为 UTF-16LE，其余为 UTF-8；统一容错解码
        text = data.decode("utf-8", errors="replace").replace("\x00", "")
        lines = text.splitlines()
        return "\n".join(lines[-tail_lines:])
