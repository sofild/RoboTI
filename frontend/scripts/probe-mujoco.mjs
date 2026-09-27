// 验证 include 内联展开 + spec.modelfiledir 加载 mesh 的完整链路
import loadMujoco from "@mujoco/mujoco";
import { readFileSync } from "node:fs";

const m = await loadMujoco();
const FS = m.FS;

const XML_DIR = "D:/opencode/Open_Duck_Playground/playground/open_duck_mini_v2/xmls";

// 模拟前端：把 include 递归内联展开
function expandIncludes(xmlText, dir) {
  return xmlText.replace(/<include\s+file="([^"]+)"\s*\/>/g, (_, file) => {
    const sub = readFileSync(`${dir}/${file}`, "utf-8");
    const inner = sub.replace(/<\?xml[^>]*\?>/g, "").replace(/<\/?mujoco[^>]*>/g, "");
    return expandIncludes(inner, dir);
  });
}

const xml = readFileSync(`${XML_DIR}/scene_flat_terrain.xml`, "utf-8");
const expanded = expandIncludes(xml, XML_DIR);

// 把 mesh 资产写入 FS（全部资产）
import { readdirSync } from "node:fs";
FS.mkdirTree("/robot/assets");
for (const f of readdirSync(`${XML_DIR}/assets`)) {
  FS.writeFile(`/robot/assets/${f}`, new Uint8Array(readFileSync(`${XML_DIR}/assets/${f}`)));
}

const spec = m.parseXMLString(expanded);
try { spec.modelfiledir = "/robot"; } catch (e) { console.log("set modelfiledir failed:", e); }
const model = m.mj_compile(spec);
if (!model || model.nbody === 0) {
  console.error("duck compile FAILED");
} else {
  console.log("duck nbody:", model.nbody, "ngeom:", model.ngeom, "nmesh:", model.nmesh, "nq:", model.nq, "nu:", model.nu, "nkey:", model.nkey);
  const data = new m.MjData(model);
  data.qpos.set(model.key_qpos.slice(0, model.nq));
  data.ctrl.set(model.key_ctrl.slice(0, model.nu));
  m.mj_forward(model, data);
  console.log("trunk xpos:", Array.from(data.xpos.subarray(3, 6)));
  for (let i = 0; i < 500; i++) m.mj_step(model, data);
  console.log("after 500 steps xpos:", Array.from(data.xpos.subarray(3, 6).map((v) => v.toFixed(3))), "time:", data.time.toFixed(2));
  console.log("geom types:", Array.from(model.geom_type).join(","));
  console.log("nlight:", model.nlight);
}
