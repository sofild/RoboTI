"""平台配置加载。"""

from pathlib import Path
from typing import Any

import yaml

# 平台根目录（robot-ti-platform/）
PLATFORM_DIR = Path(__file__).resolve().parents[2]


class Settings:
    def __init__(self) -> None:
        cfg_path = PLATFORM_DIR / "platform.yaml"
        with open(cfg_path, "r", encoding="utf-8") as f:
            self.cfg: dict[str, Any] = yaml.safe_load(f)

        server = self.cfg.get("server", {})
        self.host: str = server.get("host", "127.0.0.1")
        self.port: int = int(server.get("port", 8000))

        training = self.cfg.get("training", {})
        self.train_mode: str = training.get("mode", "local")
        self.wsl_distro: str = training.get("wsl_distro", "Ubuntu-22.04")

        self.adapters_dir: Path = PLATFORM_DIR / self.cfg.get("adapters_dir", "adapters")
        self.data_dir: Path = PLATFORM_DIR / self.cfg.get("data_dir", "data")

        llm = self.cfg.get("llm", {}) or {}
        self.llm_base_url: str = str(llm.get("base_url", "") or "").strip().rstrip("/")
        self.llm_api_key: str = str(llm.get("api_key", "") or "").strip()
        self.llm_model: str = str(llm.get("model", "") or "").strip()
        self.llm_temperature: float = float(llm.get("temperature", 0.2))
        self.llm_timeout: int = int(llm.get("timeout_seconds", 300))
        self.llm_max_tokens: int = int(llm.get("max_tokens", 16000))

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_api_key and self.llm_model)


settings = Settings()
