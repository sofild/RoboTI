/**
 * MJCF 浏览器查看器
 *
 * 架构：mujoco WASM（npm 包，模型解析 + 物理仿真，不含渲染）
 *      + Three.js 渲染（每帧从 MjData 读 body 世界位姿驱动 Three 对象）。
 *
 * 加载流程：后端 zip 打包 xmls 目录 → fflate 解压 → include 递归内联展开
 *          → parseXMLString + mj_compile（mesh 从 wasm FS 读取）。
 *
 * 坐标系：MuJoCo 为 z-up，Three.js 默认 y-up。
 *         所有 MuJoCo 对象挂在 rootGroup（rotation.x = -π/2）下，
 *         位姿/几何直接使用 MuJoCo 原始数值，无需逐个换算。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { unzipSync } from "fflate";
import * as ort from "onnxruntime-web";
import loadMujoco from "@mujoco/mujoco";
// wasm 由 vite 插件复制到 public/（见 vite.config.ts）
const mujocoWasmUrl = "/mujoco.wasm";

// onnxruntime-web：本地 wasm + 单线程（服务器无 COOP/COEP 跨域隔离头）
ort.env.wasm.wasmPaths = "/";
ort.env.wasm.numThreads = 1;

export interface PolicyConfig {
  data: Uint8Array; // onnx 模型字节
  standing: boolean; // 站立模式：步态相位恒为 0
  nbStepsInPeriod: number; // 行走模式相位周期步数（PRM）
  commandsRef: React.MutableRefObject<number[]>; // 7 维指令 vx,vy,ω,neck,headP,headY,headR
}

export interface MjcfViewerHandle {
  setRunning: (v: boolean) => void;
  /** 加载策略，返回实际 obs 布局（按 ONNX 输入维度判定） */
  setPolicy: (cfg: PolicyConfig | null) => Promise<"joystick" | "standing">;
}

interface Props {
  project: string;
  entryXml: string;
  /** 每次构建观测后外发（约 10Hz 节流），供交互实验室做观测可视化 */
  onObs?: (obs: number[], layout: "joystick" | "standing") => void;
}

// mjtObj 数值常量（mj_name2id 用）
const mjOBJ_BODY = 1;
const mjOBJ_SENSOR = 20;
const mjOBJ_KEY = 24;

// mjtGeom 常量
const mjGEOM_PLANE = 0;
const mjGEOM_HFIELD = 1;
const mjGEOM_SPHERE = 2;
const mjGEOM_CAPSULE = 3;
const mjGEOM_ELLIPSOID = 4;
const mjGEOM_CYLINDER = 5;
const mjGEOM_BOX = 6;
const mjGEOM_MESH = 7;

/** 已编译模型中推导出的策略管线索引（对应 playground/open_duck_mini_v2/mujoco_infer_base.py）。 */
interface MjInfo {
  nu: number;
  dt: number; // model.opt.timestep
  decimation: number; // 每次策略推理间隔的物理步数（0.02s 策略周期）
  gyroAdr: number;
  accelAdr: number;
  qposAdr: Int32Array; // actuator → joint qpos 地址
  dofAdr: Int32Array; // actuator → joint dof 地址
  defaultCtrl: Float32Array; // keyframe "home" 的 ctrl
  footL: number; // foot_assembly body id
  footR: number; // foot_assembly_2 body id
  floor: number;
}

/** 策略运行时状态（对应 mujoco_infer.py MjInfer）。 */
interface PolicyRuntime {
  session: ort.InferenceSession;
  /** obs 布局：joystick=101 维（含 motor_targets+phase），standing=85 维（站立系环境） */
  layout: "joystick" | "standing";
  standing: boolean;
  nbStepsInPeriod: number;
  commandsRef: React.MutableRefObject<number[]>;
  last: Float32Array;
  lastLast: Float32Array;
  lastLastLast: Float32Array;
  motorTargets: Float32Array;
  prevMotorTargets: Float32Array;
  imitationI: number;
  busy: boolean;
}

/** 递归展开 MJCF 的 <include>（parseXMLString 不解析外部文件）。 */
function expandIncludes(xmlText: string, dir: string, files: Record<string, Uint8Array>): string {
  // 先剥掉 XML 注释，避免注释掉的 <include> 被正则误匹配
  const cleaned = xmlText.replace(/<!--[\s\S]*?-->/g, "");
  return cleaned.replace(/<include\s+file="([^"]+)"\s*\/>/g, (_, file: string) => {
    const path = dir ? `${dir}/${file}` : file;
    const bytes = files[path];
    if (!bytes) throw new Error(`include 文件缺失: ${path}`);
    const sub = new TextDecoder().decode(bytes);
    const inner = sub.replace(/<\?xml[^>]*\?>/g, "").replace(/<\/?mujoco[^>]*>/g, "");
    return expandIncludes(inner, dir, files);
  });
}

const MjcfViewer = forwardRef<MjcfViewerHandle, Props>(function MjcfViewer(
  { project, entryXml, onObs },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);
  const mjInfoRef = useRef<MjInfo | null>(null);
  const policyRef = useRef<PolicyRuntime | null>(null);
  const resetHomeRef = useRef<(() => void) | null>(null); // useEffect 内注入：重置到 home 姿态
  const onObsRef = useRef<Props["onObs"]>(undefined); // 观测外发回调（ref 持有避免重挂载）
  onObsRef.current = onObs;
  const [status, setStatus] = useState("加载中…");
  const [error, setError] = useState("");

  useImperativeHandle(ref, () => ({
    setRunning: (v: boolean) => { runningRef.current = v; },
    setPolicy: async (cfg: PolicyConfig | null) => {
      if (!cfg) {
        policyRef.current = null;
        return "joystick";
      }
      const session = await ort.InferenceSession.create(cfg.data, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      const info = mjInfoRef.current;
      const nu = info?.nu ?? 14;
      // 按观测维度判定布局：joystick=6*nu+17（101，含 motor_targets+phase），standing=5*nu+15（85，无这两块）
      const meta = session.inputMetadata?.[0];
      const shape = meta && meta.isTensor ? meta.shape : [];
      const lastDim = shape.length > 0 && typeof shape[shape.length - 1] === "number"
        ? (shape[shape.length - 1] as number)
        : 0;
      let layout: "joystick" | "standing";
      if (lastDim === 5 * nu + 15) layout = "standing";
      else if (lastDim === 6 * nu + 17) layout = "joystick";
      else {
        session.release().catch(() => { /* ignore */ });
        throw new Error(
          `该 checkpoint 的观测为 ${lastDim || "?"} 维，查看器仅支持 ${6 * nu + 17}（joystick）或 ${5 * nu + 15}（standing）布局的模型`
        );
      }
      policyRef.current = {
        session,
        layout,
        standing: cfg.standing,
        nbStepsInPeriod: cfg.nbStepsInPeriod,
        commandsRef: cfg.commandsRef,
        last: new Float32Array(nu),
        lastLast: new Float32Array(nu),
        lastLastLast: new Float32Array(nu),
        motorTargets: (info?.defaultCtrl ?? new Float32Array(nu)).slice(),
        prevMotorTargets: (info?.defaultCtrl ?? new Float32Array(nu)).slice(),
        imitationI: 0,
        busy: false,
      };
      // 重置到 home 姿态：加载前无策略支撑，机器人可能已偏离平衡（home 非静态稳定），
      // 带着倾倒状态让策略接手会直接翻倒（详见 resetHomeRef 处注释）。
      // ORT wasm 首次推理有秒级 JIT 开销，由调用方延迟启动物理来避开（物理暂停时 tick 不跑，无失控风险）
      resetHomeRef.current?.();
      return layout;
    },
  }));

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;

    (async () => {
      try {
        // 1. 拉取并解压 xmls 包
        setStatus("下载模型资源…");
        const zipBuf = await fetch(`/api/projects/${project}/xmls.zip`).then((r) => {
          if (!r.ok) throw new Error(`获取 xmls.zip 失败 (${r.status})`);
          return r.arrayBuffer();
        });
        const files = unzipSync(new Uint8Array(zipBuf));

        // 2. 初始化 wasm，资产写入 FS
        setStatus("初始化 MuJoCo…");
        const mujoco: any = await loadMujoco({ locateFile: () => mujocoWasmUrl });
        if (disposed) return;
        const FS = mujoco.FS;
        FS.mkdirTree("/robot");
        for (const [path, data] of Object.entries(files)) {
          const full = `/robot/${path}`;
          const dir = full.slice(0, full.lastIndexOf("/"));
          try { FS.mkdirTree(dir); } catch { /* 已存在 */ }
          FS.writeFile(full, data as Uint8Array);
        }

        // 3. 解析模型：include 展开 → spec → compile
        setStatus(`加载 ${entryXml}…`);
        const entryDir = entryXml.includes("/") ? entryXml.slice(0, entryXml.lastIndexOf("/")) : "";
        const entryText = new TextDecoder().decode(files[entryXml]);
        const expanded = expandIncludes(entryText, entryDir, files);
        const spec = mujoco.parseXMLString(expanded);
        try { spec.modelfiledir = "/robot"; } catch { /* 旧版无此属性 */ }
        const model = mujoco.mj_compile(spec);
        if (!model || model.nbody === 0) throw new Error("模型解析失败");
        const data = new mujoco.MjData(model);

        // 4. 复位到 keyframe（home）
        if (model.nkey > 0) {
          data.qpos.set(model.key_qpos.slice(0, model.nq));
          data.ctrl.set(model.key_ctrl.slice(0, model.nu));
        }
        mujoco.mj_forward(model, data);

        // 4b. 策略推理所需的模型索引（对应 mujoco_infer_base.py 的地址推导）
        const name2id = (type: number, n: string): number =>
          mujoco.mj_name2id(model, type, n) as number;
        const nu: number = model.nu;
        const gyroAdr: number = model.sensor_adr[name2id(mjOBJ_SENSOR, "gyro")];
        const accelAdr: number = model.sensor_adr[name2id(mjOBJ_SENSOR, "accelerometer")];
        const qposAdr = new Int32Array(nu);
        const dofAdr = new Int32Array(nu);
        for (let k = 0; k < nu; k++) {
          const jid = model.actuator_trnid[2 * k] as number; // position actuator → joint
          qposAdr[k] = model.jnt_qposadr[jid];
          dofAdr[k] = model.jnt_dofadr[jid];
        }
        let homeKey = 0;
        if (model.nkey > 0) {
          const id = name2id(mjOBJ_KEY, "home");
          if (id >= 0) homeKey = id;
        }
        const defaultCtrl = new Float32Array(nu);
        for (let k = 0; k < nu; k++) defaultCtrl[k] = model.key_ctrl[homeKey * nu + k];
        const dt: number = model.opt.timestep;
        const decimation = Math.max(1, Math.round(0.02 / dt)); // 策略周期 50Hz
        const footL = name2id(mjOBJ_BODY, "foot_assembly");
        const footR = name2id(mjOBJ_BODY, "foot_assembly_2");
        const floor = name2id(mjOBJ_BODY, "floor");
        mjInfoRef.current = {
          nu, dt, decimation, gyroAdr, accelAdr, qposAdr, dofAdr, defaultCtrl,
          footL, footR, floor,
        };
        // 调试句柄：控制台可通过 __mjViewer 读取仿真状态
        (window as any).__mjViewer = { model, data };
        // 供 setPolicy 在加载策略时重置到 home（修复非静态平衡起跑翻倒问题）。
        // 除了 qpos/qvel/ctrl，还必须：清掉旧状态的求解器热启动（warmstart 残留
        // 会让重置后第一步的约束力被污染），并 mj_forward 重算派生量与传感器，
        // 保证第一拍观测是干净的静止态（否则 gyro/accel 还是倾倒时的旧值）。
        resetHomeRef.current = () => {
          if (model.nkey > 0) {
            data.qpos.set(model.key_qpos.slice(0, model.nq));
            data.qvel.fill(0);
            data.ctrl.set(model.key_ctrl.slice(0, model.nu));
          }
          data.qacc_warmstart?.fill(0);
          mujoco.mj_forward(model, data);
          physCount = 0; // 节拍相位归零：恢复后第一拍即从 home 静止态观测（对齐训练管线）
        };

        // 5. Three.js 场景
        const container = containerRef.current!;
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(container.clientWidth, 480);
        renderer.shadowMap.enabled = false;
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x141c24);
        scene.fog = new THREE.Fog(0x141c24, 6, 24);

        const camera = new THREE.PerspectiveCamera(
          60, container.clientWidth / 480, 0.01, 100
        );
        const extent = model.stat?.extent || 1;
        camera.position.set(1.1 * extent, 0.7 * extent, 1.3 * extent);
        camera.lookAt(0, 0.1, 0);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, 0.1, 0);
        controls.enableDamping = true;

        scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        dirLight.position.set(2, 4, 2);
        scene.add(dirLight);
        const dirLight2 = new THREE.DirectionalLight(0x8fb4ff, 0.5);
        dirLight2.position.set(-3, 2, -2);
        scene.add(dirLight2);

        const grid = new THREE.GridHelper(20, 40, 0x3a4a5a, 0x28323c);
        scene.add(grid);

        // MuJoCo 世界（z-up）挂在 rootGroup 下，一次性完成坐标系转换
        const rootGroup = new THREE.Group();
        rootGroup.rotation.x = -Math.PI / 2;
        scene.add(rootGroup);

        // 6. mesh 名称 → STL 几何（顺序 = XML 中出现顺序 = meshid）
        const stlLoader = new STLLoader();
        const meshGeoms: (THREE.BufferGeometry | null)[] = [];
        const collectMeshes = (xmlText: string) => {
          const doc = new DOMParser().parseFromString(xmlText, "text/xml");
          for (const meshEl of doc.getElementsByTagName("mesh")) {
            const file = meshEl.getAttribute("file");
            if (!file) { meshGeoms.push(null); continue; }
            // compiler meshdir（默认 "assets"）+ file
            let bytes: Uint8Array | undefined;
            for (const cand of [`assets/${file}`, file, `${entryDir}/assets/${file}`, `${entryDir}/${file}`]) {
              if (files[cand]) { bytes = files[cand]; break; }
            }
            if (!bytes) { meshGeoms.push(null); continue; }
            try {
              const ab = new ArrayBuffer(bytes.byteLength);
              new Uint8Array(ab).set(bytes);
              meshGeoms.push(stlLoader.parse(ab));
            } catch {
              meshGeoms.push(null);
            }
          }
        };
        collectMeshes(expanded);

        // 7. 按 body 建组，遍历 geom 生成 Three 网格
        const bodyGroups: THREE.Group[] = [];
        for (let b = 0; b < model.nbody; b++) {
          const g = new THREE.Group();
          bodyGroups.push(g);
          rootGroup.add(g);
        }

        const makeMaterial = (rgba: ArrayLike<number>) =>
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
            transparent: rgba[3] < 0.999,
            opacity: rgba[3],
            roughness: 0.55,
            metalness: 0.1,
          });

        const tmpQuat = new THREE.Quaternion();
        const setPosQuat = (
          obj: THREE.Object3D,
          pos: ArrayLike<number>, posOff: number,
          quat: ArrayLike<number>, quatOff: number
        ) => {
          obj.position.set(pos[posOff], pos[posOff + 1], pos[posOff + 2]);
          // MuJoCo 四元数存储为 wxyz；THREE 构造参数为 xyzw
          tmpQuat.set(quat[quatOff + 1], quat[quatOff + 2], quat[quatOff + 3], quat[quatOff]);
          obj.quaternion.copy(tmpQuat);
        };

        for (let i = 0; i < model.ngeom; i++) {
          const gtype = model.geom_type[i] as number;
          const bodyid = model.geom_bodyid[i] as number;
          const size = model.geom_size.subarray(3 * i, 3 * i + 3);
          const rgba = model.geom_rgba.subarray(4 * i, 4 * i + 4);
          const group = bodyGroups[bodyid];

          const holder = new THREE.Group();
          setPosQuat(holder, model.geom_pos, 3 * i, model.geom_quat, 4 * i);
          group.add(holder);

          let mesh: THREE.Mesh | null = null;
          if (gtype === mjGEOM_SPHERE) {
            mesh = new THREE.Mesh(new THREE.SphereGeometry(size[0], 24, 16), makeMaterial(rgba));
          } else if (gtype === mjGEOM_CAPSULE) {
            mesh = new THREE.Mesh(new THREE.CapsuleGeometry(size[0], 2 * size[1], 6, 16), makeMaterial(rgba));
          } else if (gtype === mjGEOM_CYLINDER) {
            mesh = new THREE.Mesh(new THREE.CylinderGeometry(size[0], size[0], 2 * size[1], 20), makeMaterial(rgba));
          } else if (gtype === mjGEOM_BOX) {
            mesh = new THREE.Mesh(new THREE.BoxGeometry(2 * size[0], 2 * size[1], 2 * size[2]), makeMaterial(rgba));
          } else if (gtype === mjGEOM_ELLIPSOID) {
            mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), makeMaterial(rgba));
            mesh.scale.set(size[0], size[1], size[2]);
          } else if (gtype === mjGEOM_PLANE) {
            // PlaneGeometry 本身在 XY 平面、法向 +z，与 MuJoCo z-up 一致，无需旋转
            const plane = new THREE.Mesh(
              new THREE.PlaneGeometry(2 * (size[0] || 10), 2 * (size[1] || 10)),
              new THREE.MeshStandardMaterial({ color: 0x39434d, roughness: 0.95 })
            );
            mesh = plane;
          } else if (gtype === mjGEOM_HFIELD) {
            const hfId = model.geom_dataid[i] as number;
            const nrow = model.hfield_nrow[hfId];
            const ncol = model.hfield_ncol[hfId];
            const hsize = model.hfield_size.subarray(4 * hfId, 4 * hfId + 4);
            const adr = model.hfield_adr[hfId];
            const hdata = model.hfield_data.subarray(adr, adr + nrow * ncol);
            const g = new THREE.PlaneGeometry(2 * hsize[0], 2 * hsize[1], ncol - 1, nrow - 1);
            const pos = g.attributes.position as THREE.BufferAttribute;
            // hfield 数据 v = row*ncol + col（row0 → -y，col0 → -x），
            // 表面高度 = hdata * hsize[2]（hfield_size = (x, y, z_top, z_bottom)）；
            // PlaneGeometry 顶点 iy=0 行在 +y，行序需翻转对应
            for (let v = 0; v < nrow * ncol; v++) {
              const iy = Math.floor(v / ncol);
              const ix = v % ncol;
              pos.setZ(v, hdata[(nrow - 1 - iy) * ncol + ix] * hsize[2]);
            }
            g.computeVertexNormals();
            const hfMesh = new THREE.Mesh(
              g, new THREE.MeshStandardMaterial({ color: 0x5b6b5b, roughness: 0.95 })
            );
            mesh = hfMesh;
          } else if (gtype === mjGEOM_MESH) {
            const meshId = model.geom_dataid[i] as number;
            const geom = meshGeoms[meshId];
            if (geom) {
              // mesh 帧修正：mesh_pos/mesh_quat 是 mesh 帧相对 STL 原始坐标的位姿，
              // STL 顶点在原始坐标系，需取逆变换（v_mesh = R^T (v - p)）
              const mp = model.mesh_pos, mq = model.mesh_quat;
              const inner = new THREE.Group();
              tmpQuat.set(-mq[4 * meshId + 1], -mq[4 * meshId + 2], -mq[4 * meshId + 3], mq[4 * meshId]);
              inner.quaternion.copy(tmpQuat);
              inner.position.set(-mp[3 * meshId], -mp[3 * meshId + 1], -mp[3 * meshId + 2])
                .applyQuaternion(inner.quaternion);
              inner.add(new THREE.Mesh(geom, makeMaterial(rgba)));
              holder.add(inner);
            }
          }

          if (mesh) {
            // capsule/cylinder 轴向：THREE +y → MuJoCo 局部 +z
            if (gtype === mjGEOM_CAPSULE || gtype === mjGEOM_CYLINDER) {
              mesh.rotation.x = Math.PI / 2;
            }
            holder.add(mesh);
          }
        }

        // 8. 策略推理 tick：每 decimation 步构建观测（joystick=101 维 / standing=85 维）
        //    → ORT 异步推理 → 写 ctrl
        //    （观测布局对齐 playground/open_duck_mini_v2/mujoco_infer.py get_obs）
        let physCount = 0;
        let lastObsEmit = 0; // 观测外发节流（10Hz）
        const tickPolicy = () => {
          const pol = policyRef.current;
          if (!pol || pol.busy) return;
          pol.busy = true;
          (window as any).__policyTicks = ((window as any).__policyTicks || 0) + 1;
          try {
            // 足端与地面接触
            let left = false;
            let right = false;
            const ncon = data.contact.size();
            for (let i = 0; i < ncon; i++) {
              const c = data.contact.get(i);
              if (!c) continue;
              const b1 = model.geom_bodyid[c.geom1] as number;
              const b2 = model.geom_bodyid[c.geom2] as number;
              if ((b1 === footL && b2 === floor) || (b1 === floor && b2 === footL)) left = true;
              if ((b1 === footR && b2 === floor) || (b1 === floor && b2 === footR)) right = true;
            }

            const standingLayout = pol.layout === "standing";
            const obsSize = standingLayout ? 5 * nu + 15 : 6 * nu + 17;
            const obs = new Float32Array(obsSize);
            let o = 0;
            for (let i = 0; i < 3; i++) obs[o++] = data.sensordata[gyroAdr + i];
            // accel：joystick 部署管线带 +1.3 偏移（mujoco_infer.py）；standing 按训练环境原值
            for (let i = 0; i < 3; i++) {
              obs[o++] = data.sensordata[accelAdr + i] + (!standingLayout && i === 0 ? 1.3 : 0);
            }
            const cmds = pol.commandsRef.current;
            for (let i = 0; i < 7; i++) obs[o++] = cmds[i] ?? 0;
            for (let k = 0; k < nu; k++) obs[o++] = data.qpos[qposAdr[k]] - defaultCtrl[k];
            for (let k = 0; k < nu; k++) obs[o++] = data.qvel[dofAdr[k]] * 0.05;
            for (let k = 0; k < nu; k++) obs[o++] = pol.last[k];
            for (let k = 0; k < nu; k++) obs[o++] = pol.lastLast[k];
            for (let k = 0; k < nu; k++) obs[o++] = pol.lastLastLast[k];
            if (!standingLayout) {
              // joystick 专有块，块顺序对齐 mujoco_infer.py get_obs：motor_targets → contacts → phase
              for (let k = 0; k < nu; k++) obs[o++] = pol.motorTargets[k];
              obs[o++] = left ? 1 : 0;
              obs[o++] = right ? 1 : 0;
              // 步态相位（站立恒 0；行走 = i/nb·2π 的 cos/sin，先自增再取值，与 Python 一致）
              if (!pol.standing && pol.nbStepsInPeriod > 0) {
                pol.imitationI = (pol.imitationI + 1) % pol.nbStepsInPeriod;
                const ang = (pol.imitationI / pol.nbStepsInPeriod) * 2 * Math.PI;
                obs[o++] = Math.cos(ang);
                obs[o++] = Math.sin(ang);
              } else {
                obs[o++] = 0;
                obs[o++] = 0;
              }
            } else {
              // standing 布局无 motor_targets/phase 块，足端接触在观测末尾
              obs[o++] = left ? 1 : 0;
              obs[o++] = right ? 1 : 0;
            }

            const input = new ort.Tensor("float32", obs, [1, obsSize]);
            // 观测外发（10Hz 节流，交互实验室观测可视化用）
            const nowMs = performance.now();
            if (onObsRef.current && nowMs - lastObsEmit > 100) {
              lastObsEmit = nowMs;
              try { onObsRef.current(Array.from(obs), pol.layout); } catch { /* 回调异常不影响仿真 */ }
            }
            pol.session
              .run({ [pol.session.inputNames[0]]: input })
              .then((res: Record<string, ort.Tensor>) => {
                (window as any).__policyRuns = ((window as any).__policyRuns || 0) + 1;
                const action = res[pol.session.outputNames[0]].data as Float32Array;
                pol.lastLastLast.set(pol.lastLast);
                pol.lastLast.set(pol.last);
                pol.last.set(action);
                // motor_targets = default + 0.25·action；
                // joystick 部署管线另按电机限速 5.24 rad/s 裁剪，standing 无限速（与训练环境一致）
                for (let k = 0; k < nu; k++) {
                  pol.motorTargets[k] = defaultCtrl[k] + action[k] * 0.25;
                }
                if (!standingLayout) {
                  const limit = 5.24 * dt * decimation;
                  for (let k = 0; k < nu; k++) {
                    pol.motorTargets[k] = Math.max(pol.prevMotorTargets[k] - limit,
                      Math.min(pol.motorTargets[k], pol.prevMotorTargets[k] + limit));
                  }
                  pol.prevMotorTargets.set(pol.motorTargets);
                }
                data.ctrl.set(pol.motorTargets);
              })
              .catch((err: unknown) => { console.warn("[policy] infer failed", err); })
              .finally(() => { pol.busy = false; });
          } catch (err) {
            console.warn("[policy] obs build failed", err);
            pol.busy = false;
          }
        };

        // 9. 动画循环：按真实时间步进（接近实时），每 decimation 步触发一次策略推理
        let simAcc = 0;
        let lastT = 0;
        const step = (now: number) => {
          if (disposed) return;
          if (runningRef.current) {
            if (!lastT) lastT = now;
            simAcc += Math.min((now - lastT) / 1000, 0.1);
            lastT = now;
            let n = Math.min(Math.floor(simAcc / dt), 20);
            simAcc = Math.max(0, Math.min(simAcc - n * dt, dt));
            for (let i = 0; i < n; i++) {
              // 观测在前、步进在后：对齐训练/部署管线的 obs → action → ctrl → mj_step×N 时序
              if (physCount % decimation === 0) tickPolicy();
              mujoco.mj_step(model, data);
              physCount++;
            }
          } else {
            lastT = 0;
            simAcc = 0;
          }
          for (let b = 0; b < model.nbody; b++) {
            const g = bodyGroups[b];
            g.position.set(data.xpos[3 * b], data.xpos[3 * b + 1], data.xpos[3 * b + 2]);
            tmpQuat.set(
              data.xquat[4 * b + 1], data.xquat[4 * b + 2],
              data.xquat[4 * b + 3], data.xquat[4 * b]
            );
            g.quaternion.copy(tmpQuat);
          }
          controls?.update();
          renderer?.render(scene, camera);
          raf = requestAnimationFrame(step);
        };
        setStatus("");
        raf = requestAnimationFrame(step);
      } catch (e: any) {
        if (!disposed) setError(String(e?.message || e));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      controls?.dispose();
      renderer?.dispose();
      if (renderer?.domElement.parentElement === containerRef.current) {
        containerRef.current?.removeChild(renderer.domElement);
      }
      mjInfoRef.current = null;
      policyRef.current?.session.release().catch(() => { /* ignore */ });
      policyRef.current = null;
    };
  }, [project, entryXml]);

  return (
    <div className="viewer-container" ref={containerRef}>
      {status && <div className="viewer-overlay">{status}</div>}
      {error && (
        <div style={{ padding: 24, color: "#ff7875" }}>加载失败: {error}</div>
      )}
    </div>
  );
});

export default MjcfViewer;
