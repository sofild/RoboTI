import { useEffect, useState } from "react";
import { Card, Col, Row, Tag, Typography } from "antd";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Project } from "../types";

export default function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e.message)));
  }, []);

  if (error) return <Typography.Text type="danger">加载失败: {error}</Typography.Text>;

  return (
    <>
      <Typography.Title level={4} style={{ color: "#eee" }}>机器人项目</Typography.Title>
      <Row gutter={[16, 16]}>
        {projects.map((p) => (
          <Col key={p.name} xs={24} md={12} lg={8}>
            <Link to={`/projects/${p.name}`}>
              <Card hoverable title={p.display_name}>
                <p style={{ minHeight: 40, color: "#bbb" }}>{p.description}</p>
                {Object.entries(p.envs).map(([env, tasks]) => (
                  <div key={env} style={{ marginBottom: 6 }}>
                    <Tag color="cyan">{env}</Tag>
                    {tasks.map((t) => (
                      <Tag key={t} style={{ marginInlineEnd: 4 }}>{t}</Tag>
                    ))}
                  </div>
                ))}
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
    </>
  );
}
