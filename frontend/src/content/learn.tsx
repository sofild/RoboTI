/** 学习中心课程内容（结构化 JSX，正文结合本平台实际能力）。 */
import type { ReactNode } from "react";

export interface LabLink {
  label: string;
  to: string;
}

export interface Lesson {
  id: string;
  title: string;
  minutes: number; // 预计学习时长
  summary: string;
  tags: string[];
  sections: { heading: string; body: ReactNode }[];
  labs: LabLink[]; // 动手实验入口
}

const P = ({ children }: { children: ReactNode }) => <p style={{ lineHeight: 1.9 }}>{children}</p>;
const UL = ({ children }: { children: ReactNode }) => (
  <ul style={{ lineHeight: 1.9, paddingLeft: 20 }}>{children}</ul>
);
const LI = ({ children }: { children: ReactNode }) => <li style={{ marginBottom: 4 }}>{children}</li>;
const Key = ({ children }: { children: ReactNode }) => (
  <code style={{ background: "#15323a", padding: "1px 6px", borderRadius: 4, color: "#5edede" }}>{children}</code>
);

export const LESSONS: Lesson[] = [
  {
    id: "overview",
    title: "平台导览：从仿真到部署的完整链路",
    minutes: 10,
    summary: "了解机器人训推一体化平台的全貌：模型如何被加载、策略如何被训练、训练成果如何回到浏览器里跑起来。",
    tags: ["入门", "必读"],
    sections: [
      {
        heading: "平台解决什么问题",
        body: (
          <>
            <P>
              让机器人学会走路，传统做法需要实体样机反复调试。本平台把这条链路搬到了浏览器 + 本地训练环境里：
              在 MuJoCo 物理仿真中训练策略，训练完成后一键加载回浏览器实时查看效果——这就是"训推一体"。
            </P>
            <P>整个平台由五个栏目组成，各司其职：</P>
            <UL>
              <LI><Key>机器人项目</Key>：项目主页，查看模型、启动训练、加载策略试跑。</LI>
              <LI><Key>学习中心</Key>：就是你现在所在的地方，系列课程 + 动手实验。</LI>
              <LI><Key>交互实验室</Key>：键盘/手柄遥操作、实时观测可视化，亲手"驾驶"机器人。</LI>
              <LI><Key>模型广场</Key>：所有训练成果集中展示，一键回放试跑。</LI>
              <LI><Key>环境工坊</Key>：用 AI 生成新的训练环境代码，扩展机器人能力。</LI>
            </UL>
          </>
        ),
      },
      {
        heading: "一次完整训练的生命周期",
        body: (
          <>
            <P>以让小鸭子行走为例，一次完整的流程是：</P>
            <UL>
              <LI><b>1. 定义环境</b>：训练环境（如 <Key>joystick</Key>）描述了机器人的观测空间、动作空间和奖励函数，是策略的"教科书"。</LI>
              <LI><b>2. 启动训练</b>：平台在本地训练环境（WSL）中启动 PPO 训练进程，实时回流 reward 曲线等指标。</LI>
              <LI><b>3. 产出检查点</b>：训练过程中定期保存 checkpoint，包含策略网络权重。</LI>
              <LI><b>4. 导出 ONNX</b>：checkpoint 被转换为 ONNX 格式，浏览器中的 onnxruntime-web 可以直接推理。</LI>
              <LI><b>5. 浏览器试跑</b>：MuJoCo WASM 负责物理仿真，ONNX 策略每 0.02 秒推理一次动作，机器人就动起来了。</LI>
            </UL>
          </>
        ),
      },
      {
        heading: "为什么浏览器也能跑物理仿真",
        body: (
          <>
            <P>
              平台把 MuJoCo 物理引擎编译成了 WebAssembly（<Key>mujoco.wasm</Key>），
              配合 Three.js 做三维渲染。浏览器的主循环里每帧执行：读真实时间差 → 按固定步长推进物理 →
              每 10 个物理步（0.02s 策略周期）构建一次观测 → ONNX 推理出动作 → 写回关节控制量。
              这与训练时的仿真管线完全一致，所以训练出的策略在浏览器里表现不会有偏差。
            </P>
          </>
        ),
      },
    ],
    labs: [
      { label: "打开机器人项目，试跑一个已训练的模型", to: "/projects" },
      { label: "去交互实验室亲手操控机器人", to: "/lab" },
    ],
  },
  {
    id: "mjcf",
    title: "MJCF 模型结构入门",
    minutes: 15,
    summary: "读懂 MuJoCo 的 MJCF 模型文件：body / joint / geom / actuator 是什么，小鸭子模型是怎么组装起来的。",
    tags: ["仿真", "模型"],
    sections: [
      {
        heading: "MJCF 是什么",
        body: (
          <>
            <P>
              MJCF（MuJoCo Collada-like Format）是 MuJoCo 物理引擎的原生模型格式，本质是 XML。
              它描述了一个机器人的所有物理属性：连杆怎么连、关节怎么转、碰撞体是什么形状、电机驱动哪些关节。
              平台里的 <Key>xmls/</Key> 目录就是小鸭子机器人的 MJCF 模型。
            </P>
            <P>
              大型模型通常拆成多个文件，主文件用 <Key>&lt;include file="..."/&gt;</Key> 引入子文件，
              平台查看器加载时会自动递归展开这些 include。
            </P>
          </>
        ),
      },
      {
        heading: "四大核心元素",
        body: (
          <UL>
            <LI>
              <b>body（刚体）</b>：机器人的骨骼。body 之间形成树状层级——根 body 是躯干（自由浮动），
              腿、脖子都挂在它下面。每个 body 有质量、质心、惯性。
            </LI>
            <LI>
              <b>joint（关节）</b>：定义 body 相对父级的运动方式。<Key>free</Key> 关节 = 6 自由度浮动（用于躯干），
              <Key>hinge</Key> = 单轴旋转（用于腿和脖子）。关节限位、阻尼都写在这里。
            </LI>
            <LI>
              <b>geom（几何体）</b>：负责碰撞和显示，可以是 capsule、box、mesh 等。
              小鸭子的外观就是一堆 STL mesh，碰撞体则是简化的 capsule——精确外观和高效碰撞各司其职。
            </LI>
            <LI>
              <b>actuator（执行器）</b>：把策略输出的"动作"映射到关节力矩。每个 actuator 绑定一个关节，
              带 <Key>ctrlrange</Key> 限幅。策略输出的维度 = actuator 数量。
            </LI>
          </UL>
        ),
      },
      {
        heading: "关键帧与初始姿态",
        body: (
          <>
            <P>
              MJCF 里的 <Key>&lt;key name="home"&gt;</Key> 定义了一组初始关节角。机器人 reset 时回到这个姿态，
              策略观测里的"关节位置偏差"也是相对它计算的（<Key>qpos - default_ctrl</Key>）。
              换句话说，keyframe 是策略眼中的"零点姿态"。
            </P>
          </>
        ),
      },
      {
        heading: "实践建议",
        body: (
          <UL>
            <LI>在机器人项目页可以浏览模型的 XML 文件树，对照本课概念逐个认领。</LI>
            <LI>查看器里的"运行物理"按钮会从 home 姿态开始自由仿真——没有策略时机器人会瘫倒，这正是没有控制的真实物理。</LI>
            <LI>注意坐标系：MuJoCo 是 z 轴朝上，这与 Three.js 默认的 y 轴朝上不同，渲染层做了整体旋转适配。</LI>
          </UL>
        ),
      },
    ],
    labs: [
      { label: "打开项目查看模型 XML 与 3D 预览", to: "/projects" },
    ],
  },
  {
    id: "obs-action",
    title: "观测与动作空间解析",
    minutes: 20,
    summary: "策略网络的输入是什么？输出是什么？拆解 101 维 joystick 布局与 85 维 standing 布局的每个分块。",
    tags: ["核心概念", "策略"],
    sections: [
      {
        heading: "策略网络的输入输出",
        body: (
          <>
            <P>
              强化学习策略是一个神经网络：输入是<b>观测向量</b>（机器人对自身状态的感知），输出是<b>动作向量</b>
              （各电机的目标偏移量）。本平台的小鸭子有 12 个电机，所以动作是 12 维；而观测根据任务不同有两种布局。
            </P>
          </>
        ),
      },
      {
        heading: "joystick 布局（101 维）",
        body: (
          <>
            <P>行走任务使用，按顺序分块：</P>
            <UL>
              <LI><b>陀螺仪 3 维</b>：躯干角速度（gyro 传感器）。</LI>
              <LI><b>加速度计 3 维</b>：躯干线加速度（部署管线带 +1.3 的 x 偏移，与真实 IMU 安装误差对齐）。</LI>
              <LI><b>指令 7 维</b>：vx、vy、ω（期望速度）+ 脖子 4 个关节期望角——来自操控台的滑条或手柄。</LI>
              <LI><b>关节位置 12 维</b>：相对 home 姿态的偏差。</LI>
              <LI><b>关节速度 12 维</b>：乘 0.05 缩放。</LI>
              <LI><b>历史动作 3×12 维</b>：最近三拍的策略输出，让网络感知自身动作的时序。</LI>
              <LI><b>motor_targets 12 维</b>：上一拍写入电机的最终目标角。</LI>
              <LI><b>足端接触 2 维</b>：左/右脚是否触地（0/1）。</LI>
              <LI><b>步态相位 2 维</b>：cos/sin 编码的周期相位，驱动双腿按节拍交替。</LI>
            </UL>
            <P>合计 3+3+7+12×6+2+2 = 101 维。</P>
          </>
        ),
      },
      {
        heading: "standing 布局（85 维）",
        body: (
          <>
            <P>
              站立类任务（如 <Key>standing_with_head_swing</Key>）不需要步态相位和 motor_targets 块，
              观测少了 16 维变成 85 维。这就是为什么两个环境的模型不能混用——
              平台查看器会按 ONNX 输入维度自动判定布局并校验兼容性。
            </P>
          </>
        ),
      },
      {
        heading: "动作如何变成运动",
        body: (
          <>
            <P>
              策略输出 12 维动作后并非直接驱动电机：
              <Key>motor_target = home姿态 + 0.25 × 动作</Key>。
              0.25 是动作缩放系数，保证策略输出不会瞬间产生过猛的力矩。joystick 部署管线还会按电机限速
              （5.24 rad/s）对目标角做斜率限制，模拟真实电机的转速上限——这是 sim-to-real 的重要一环。
            </P>
          </>
        ),
      },
      {
        heading: "为什么要理解观测布局",
        body: (
          <UL>
            <LI>调试策略行为时，知道每一维观测的含义才能定位"机器人看到了什么导致这个动作"。</LI>
            <LI>自己设计新训练环境时，观测布局必须与部署管线严格一致，否则训练好的策略无法部署。</LI>
            <LI>交互实验室的"观测可视化器"把每个分块实时画出来，是理解本课最直观的方式。</LI>
          </UL>
        ),
      },
    ],
    labs: [
      { label: "去实验室实时观看观测分块", to: "/lab" },
    ],
  },
  {
    id: "rl-ppo",
    title: "强化学习基础：PPO 与奖励设计",
    minutes: 25,
    summary: "PPO 算法直觉、奖励函数如何塑造行为、为什么训练步数动辄数千万。",
    tags: ["强化学习", "核心概念"],
    sections: [
      {
        heading: "强化学习在解决什么问题",
        body: (
          <>
            <P>
              我们不给机器人写"先迈左脚再迈右脚"的规则，而是定义一个<b>奖励函数</b>（什么行为得分高），
              让策略网络通过海量试错自己学出运动方式。每一集（episode）里，机器人从初始姿态出发执行动作、
              累积奖励、摔倒或到达时限后结束。PPO 算法根据"哪些动作带来了高于预期的奖励"来更新网络参数。
            </P>
          </>
        ),
      },
      {
        heading: "PPO 的核心直觉",
        body: (
          <UL>
            <LI><b>策略梯度</b>：奖励高的动作序列增大其发生概率，奖励低的则减小。</LI>
            <LI><b>优势估计（GAE）</b>：不是看绝对奖励，而是看"比预期好多少"，让学习信号更稳定。</LI>
            <LI><b>裁剪更新（Clip）</b>：单次更新不让策略变化过大，避免学崩。这是 PPO 稳定易用的关键。</LI>
            <LI><b>并行采样</b>：训练时上千个仿真环境同时跑，每人各走各的，极大加快数据采集——这也是为什么训练几千万步是可行的。</LI>
          </UL>
        ),
      },
      {
        heading: "奖励函数：行为的雕刻刀",
        body: (
          <>
            <P>小鸭子行走任务的奖励大致由几类项加权求和：</P>
            <UL>
              <LI><b>任务项</b>：跟踪期望速度（vx、vy、ω 与指令的偏差越小越好）——告诉机器人"要往哪走"。</LI>
              <LI><b>姿态项</b>：躯干保持直立、朝上，高度接近目标——防止趴着蹭分。</LI>
              <LI><b>步态项</b>：与相位发生器对齐的足部轨迹——让双腿按节拍迈步。</LI>
              <LI><b>惩罚项</b>：动作幅度、关节加速度、足底打滑、非足端触地——抑制抖动和诡异动作。</LI>
            </UL>
            <P>
              权重就是"行为偏好的表达"：把能耗惩罚调大，机器人会更省力但可能走得慢；
              把速度跟踪调得过高，可能出现前倾狂奔。奖励设计是一门需要反复实验的手艺。
            </P>
          </>
        ),
      },
      {
        heading: "训练多少步才够",
        body: (
          <>
            <P>
              经验参考：本平台的鸭子模型约 <b>3000 万步</b>能走出基本的行走模式，
              <b>3 亿步</b>以上才有稳定流畅的步态。训练曲线（reward）前期陡升、后期缓慢爬升是正常现象；
              如果 reward 长期不涨或突然崩塌，通常是奖励项冲突或超参问题。
            </P>
          </>
        ),
      },
    ],
    labs: [
      { label: "启动一次训练，观察 reward 曲线", to: "/projects" },
      { label: "去模型广场对比不同训练步数的成果", to: "/models" },
    ],
  },
  {
    id: "sim2real",
    title: "Domain Randomization 与 Sim-to-Real",
    minutes: 15,
    summary: "为什么仿真里学会的策略能搬到真实机器人？随机化训练条件让策略更皮实。",
    tags: ["进阶", "部署"],
    sections: [
      {
        heading: "Reality Gap：仿真与现实之间的鸿沟",
        body: (
          <>
            <P>
              再精确的仿真也有误差：摩擦系数、电机响应、质量分布、传感器噪声都与真实世界有偏差。
              只在单一条件下训练的策略会把这些"仿真特性"当成世界规律，一上真机就失效。
            </P>
          </>
        ),
      },
      {
        heading: "核心思想：训练时故意制造随机",
        body: (
          <>
            <P>
              Domain Randomization 的做法是：每个 episode 重置时随机化环境参数——
              地面摩擦 ±20%、机器人质量 ±10%、电机强度抖动、传感器加噪声、甚至给躯干随机初速度和随机推力。
              策略无法分辨自己处在哪种条件下，只能学出对所有条件都稳健的"鲁棒策略"。
            </P>
            <P>
              直觉类比：在三种不同地面都练过走路的人，换到第四种地面也能走。随机化的本质是
              <b>用训练时的困难换取部署时的从容</b>。
            </P>
          </>
        ),
      },
      {
        heading: "本平台中的体现",
        body: (
          <UL>
            <LI>训练环境代码中的 friction/mass/noise 随机化范围就是 domain randomization 的配置。</LI>
            <LI>部署管线的加速度计 +1.3 偏移、电机限速 5.24 rad/s，都是为了让浏览器仿真与真实部署条件一致。</LI>
            <LI>观察模型广场中的不同 checkpoint：随机化更强的策略初期 reward 更低，但试跑时更抗推扰。</LI>
          </UL>
        ),
      },
    ],
    labs: [
      { label: "在实验室用手柄推搡机器人，感受策略鲁棒性", to: "/lab" },
    ],
  },
  {
    id: "deploy",
    title: "从 Checkpoint 到 ONNX 部署",
    minutes: 15,
    summary: "训练产出的 checkpoint 是什么，为什么转成 ONNX，浏览器推理管线的完整数据流。",
    tags: ["部署", "工程"],
    sections: [
      {
        heading: "Checkpoint 与 ONNX 的关系",
        body: (
          <>
            <P>
              训练框架保存的 checkpoint 通常绑定训练框架本身（如 PyTorch 的 state_dict）。
              <b>ONNX</b> 是开放的模型交换格式：把网络结构 + 权重序列化成一个文件，
              任何支持 ONNX Runtime 的环境都能推理——包括浏览器里的 <Key>onnxruntime-web</Key>。
              训练结束后平台自动把策略网络导出为 ONNX 放进对应 run 目录。
            </P>
          </>
        ),
      },
      {
        heading: "浏览器推理数据流",
        body: (
          <>
            <P>每当策略推理 tick 到来（每 0.02 秒），浏览器里发生的事：</P>
            <UL>
              <LI><b>1. 读状态</b>：从 MuJoCo WASM 的 MjData 里取传感器、关节角度与速度。</LI>
              <LI><b>2. 拼观测</b>：按当前布局（joystick 101 / standing 85）把各分块拼成 Float32Array。</LI>
              <LI><b>3. 推理</b>：创建 ort.Tensor，调用 session.run() 异步执行。</LI>
              <LI><b>4. 后处理</b>：动作 × 0.25 + home 姿态 = motor_targets，joystick 布局再做电机限速裁剪。</LI>
              <LI><b>5. 写控制</b>：写入 data.ctrl，接下来的 10 个物理步按此力矩仿真。</LI>
            </UL>
          </>
        ),
      },
      {
        heading: "外部策略文件",
        body: (
          <>
            <P>
              你也可以上传自己的 ONNX 策略文件（模型广场或项目页的上传入口）。上传后它会出现在
              <Key>uploaded</Key> run 里，平台会按输入维度校验布局兼容性——不匹配的模型会明确报错而不是跑飞。
              这是你把自己训练的模型拿到平台上展示的最快路径。
            </P>
          </>
        ),
      },
    ],
    labs: [
      { label: "去模型广场看各 run 的 ONNX 产物", to: "/models" },
      { label: "上传自己的 ONNX 策略试跑", to: "/projects" },
    ],
  },
];
