import { Layout, Menu } from "antd";
import {
  AppstoreOutlined, BookOutlined, RobotOutlined, ThunderboltOutlined, ToolOutlined,
} from "@ant-design/icons";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import ProjectList from "./pages/ProjectList";
import RobotView from "./pages/RobotView";
import JobView from "./pages/JobView";
import Learn from "./pages/Learn";
import Lab from "./pages/Lab";
import ModelHub from "./pages/ModelHub";
import Workshop from "./pages/Workshop";

const MENU_ITEMS = [
  {
    key: "/projects",
    icon: <RobotOutlined />,
    label: <Link to="/projects">机器人项目</Link>,
  },
  {
    key: "/learn",
    icon: <BookOutlined />,
    label: <Link to="/learn">学习中心</Link>,
  },
  {
    key: "/lab",
    icon: <ThunderboltOutlined />,
    label: <Link to="/lab">交互实验室</Link>,
  },
  {
    key: "/models",
    icon: <AppstoreOutlined />,
    label: <Link to="/models">模型广场</Link>,
  },
  {
    key: "/workshop",
    icon: <ToolOutlined />,
    label: <Link to="/workshop">环境工坊</Link>,
  },
];

export default function App() {
  const loc = useLocation();
  const selected = MENU_ITEMS.find((m) => loc.pathname.startsWith(m.key))?.key ?? "/projects";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Sider width={220} theme="dark">
        <div className="logo">机器人训推平台</div>
        <Menu theme="dark" mode="inline" selectedKeys={[selected]} items={MENU_ITEMS} />
      </Layout.Sider>
      <Layout.Content style={{ padding: 16, overflow: "auto", maxHeight: "100vh" }}>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectList />} />
          <Route path="/projects/:name" element={<RobotView />} />
          <Route path="/jobs/:id" element={<JobView />} />
          <Route path="/learn" element={<Learn />} />
          <Route path="/lab" element={<Lab />} />
          <Route path="/models" element={<ModelHub />} />
          <Route path="/workshop" element={<Workshop />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}
