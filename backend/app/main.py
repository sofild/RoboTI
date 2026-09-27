"""FastAPI 入口。

开发模式：uvicorn app.main:app --reload（前端走 vite dev server 代理 /api）
生产模式：构建前端后（frontend/dist），由本服务直接托管静态页面
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .api import router
from .config import settings

app = FastAPI(title="Robot TI Platform", version="0.1.0")


@app.middleware("http")
async def coop_coep(request, call_next):
    """启用 crossOriginIsolated，允许浏览器端 SharedArrayBuffer（mujoco wasm pthread 需要）。"""
    resp = await call_next(request)
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    resp.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return resp


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

# 生产模式：托管前端构建产物
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        # API 路由已优先注册；此处兜底返回 SPA 页面
        if full_path.startswith("api/"):
            return FileResponse(_dist / "index.html")
        candidate = _dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port)
