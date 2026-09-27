"""子项目适配器：加载 adapters/*.yaml，封装对子项目的访问。"""

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .config import PLATFORM_DIR


@dataclass
class Adapter:
    name: str
    display_name: str
    description: str
    repo_root: Path
    xmls_dir: Path
    train_command: str
    default_timesteps: int
    envs: dict[str, list[str]]
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def wsl_repo_root(self) -> str:
        """repo_root 的 WSL 路径（D:\\a\\b -> /mnt/d/a/b），可在 adapter yaml 中用 wsl_repo_root 覆盖。"""
        override = self.raw.get("wsl_repo_root")
        if override:
            return override
        p = str(self.repo_root.resolve())
        drive = p[0].lower()
        return "/mnt/" + drive + p[2:].replace("\\", "/")

    def list_xmls(self) -> list[str]:
        """xmls 目录下所有 .xml 文件（相对路径，正斜杠）。"""
        if not self.xmls_dir.is_dir():
            return []
        return sorted(
            p.relative_to(self.xmls_dir).as_posix()
            for p in self.xmls_dir.rglob("*.xml")
        )

    def entry_xmls(self) -> list[str]:
        """可作为查看器入口的 xml：根元素为 <mujoco> 且未被其他 xml include。"""
        included: set[str] = set()
        for rel in self.list_xmls():
            try:
                tree = ET.parse(self.xmls_dir / rel)
            except ET.ParseError:
                continue
            parent = Path(rel).parent
            for inc in tree.getroot().iter("include"):
                f = inc.get("file")
                if f:
                    included.add((parent / f).as_posix())
        entries = []
        for rel in self.list_xmls():
            if rel in included:
                continue
            try:
                root = ET.parse(self.xmls_dir / rel).getroot()
            except ET.ParseError:
                continue
            if root.tag == "mujoco":
                entries.append(rel)
        return entries

    def output_dir_for(self, job_id: str) -> str:
        """该 job 的训练输出目录（相对仓库根）。"""
        return f"checkpoints/platform/{job_id}"

    def output_dir_abs(self, job_id: str) -> Path:
        return self.repo_root / self.output_dir_for(job_id)

    @property
    def generated_envs_dir(self) -> Path | None:
        """Copilot 生成环境目录（绝对路径），未配置则 None。"""
        cfg = self.raw.get("generated_envs") or {}
        d = cfg.get("dir")
        return self.repo_root / d if d else None

    def register_generated_envs(self) -> list[str]:
        """扫描生成目录，把 *.py（排除 _ 开头）注册为可用环境，返回环境名列表。"""
        gen_dir = self.generated_envs_dir
        if gen_dir is None or not gen_dir.is_dir():
            return []
        cfg = self.raw.get("generated_envs") or {}
        ref_env = cfg.get("tasks_from")
        tasks = self.envs.get(ref_env) if ref_env else None
        if tasks is None:
            tasks = next(iter(self.envs.values()), [])
        names = []
        for p in sorted(gen_dir.glob("*.py")):
            if p.stem.startswith("_") or p.stem == "__init__":
                continue
            self.envs[p.stem] = list(tasks)
            names.append(p.stem)
        return names


def _load_adapter(path: Path) -> Adapter:
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    repo_root = (PLATFORM_DIR / raw["repo_root"]).resolve()
    return Adapter(
        name=raw["name"],
        display_name=raw.get("display_name", raw["name"]),
        description=raw.get("description", ""),
        repo_root=repo_root,
        xmls_dir=repo_root / raw["xmls_dir"],
        train_command=raw["train_command"].strip(),
        default_timesteps=int(raw.get("default_timesteps", 30_000_000)),
        envs=raw.get("envs", {}),
        raw=raw,
    )


def load_adapters(adapters_dir: Path) -> dict[str, Adapter]:
    adapters: dict[str, Adapter] = {}
    if not adapters_dir.is_dir():
        return adapters
    for p in sorted(adapters_dir.glob("*.yaml")):
        a = _load_adapter(p)
        a.register_generated_envs()
        adapters[a.name] = a
    return adapters
