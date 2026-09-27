import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const ROOT = __dirname;

/** 把 mujoco wasm 复制到 public/（包 exports 未暴露该文件，deep import 不可用）。 */
function copyMujocoWasm() {
  return {
    name: "copy-mujoco-wasm",
    buildStart() {
      const src = path.resolve(ROOT, "node_modules/@mujoco/mujoco/mujoco.wasm");
      const dst = path.resolve(ROOT, "public/mujoco.wasm");
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    },
  };
}

/** 把 onnxruntime-web 的 wasm/mjs 复制到 public/（运行时按 wasmPaths="/" 加载）。 */
function copyOrtWasm() {
  return {
    name: "copy-ort-wasm",
    buildStart() {
      const srcDir = path.resolve(ROOT, "node_modules/onnxruntime-web/dist");
      const dstDir = path.resolve(ROOT, "public");
      for (const f of [
        "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs",
        "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.mjs",
      ]) {
        const src = path.join(srcDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f));
      }
    },
  };
}

/** dev 下 onnxruntime-web 会以动态 import 加载 public/ 里的 .mjs（带 ?import query），
 *  vite dev 会拒绝 transform public 文件而返回 500；此中间件在其之前按静态文件原样返回。 */
function serveOrtWasm() {
  return {
    name: "serve-ort-wasm",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/(ort-wasm-simd-threaded[^?]*)(\?.*)?$/);
        if (m) {
          const p = path.resolve(ROOT, "public", m[1]);
          if (fs.existsSync(p)) {
            res.setHeader("Content-Type", m[1].endsWith(".mjs") ? "text/javascript" : "application/wasm");
            fs.createReadStream(p).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), copyMujocoWasm(), copyOrtWasm(), serveOrtWasm()],
  // mujoco.js（Emscripten）含 top-level await，需要 es2022 target
  build: {
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  // mujoco 为 Emscripten 产物，不做预打包，保持 wasm 加载原样
  optimizeDeps: {
    exclude: ["@mujoco/mujoco"],
  },
});
