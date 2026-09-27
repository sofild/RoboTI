import { useState } from "react";
import { Button, Card, Col, Row, Space, Tag, Typography } from "antd";
import { ArrowLeftOutlined, PlayCircleOutlined, ReadOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { LESSONS } from "../content/learn";

export default function Learn() {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const lesson = LESSONS.find((l) => l.id === currentId) ?? null;

  // ---- 课程详情 ----
  if (lesson) {
    return (
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <Button icon={<ArrowLeftOutlined />} type="text" style={{ marginBottom: 12 }} onClick={() => setCurrentId(null)}>
          返回课程列表
        </Button>
        <Typography.Title level={4} style={{ color: "#eee", marginTop: 0 }}>{lesson.title}</Typography.Title>
        <Space wrap style={{ marginBottom: 16 }}>
          {lesson.tags.map((t) => <Tag key={t} color="cyan">{t}</Tag>)}
          <Tag>约 {lesson.minutes} 分钟</Tag>
        </Space>

        {lesson.sections.map((s, i) => (
          <Card key={i} size="small" title={`${i + 1}. ${s.heading}`} style={{ marginBottom: 12 }}>
            <div style={{ color: "#cfd8dc" }}>{s.body}</div>
          </Card>
        ))}

        {lesson.labs.length > 0 && (
          <Card size="small" title="动手实验" style={{ marginBottom: 24 }}>
            <Space direction="vertical" style={{ width: "100%" }}>
              {lesson.labs.map((lab) => (
                <Link key={lab.to + lab.label} to={lab.to}>
                  <Button type="primary" ghost icon={<PlayCircleOutlined />} block style={{ textAlign: "left" }}>
                    {lab.label}
                  </Button>
                </Link>
              ))}
            </Space>
          </Card>
        )}
      </div>
    );
  }

  // ---- 课程列表 ----
  return (
    <>
      <Typography.Title level={4} style={{ color: "#eee" }}>学习中心</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 720 }}>
        系列课程带你理解机器人强化学习从建模、训练到部署的每个环节。课程内容全部结合本平台的真实模型与训练管线，
        每课末尾都有"动手实验"，学完即可上手验证。
      </Typography.Paragraph>
      <Row gutter={[16, 16]}>
        {LESSONS.map((l, i) => (
          <Col key={l.id} xs={24} md={12} lg={8}>
            <Card hoverable onClick={() => setCurrentId(l.id)} title={<span><ReadOutlined /> {i + 1}. {l.title}</span>}>
              <p style={{ minHeight: 66, color: "#bbb" }}>{l.summary}</p>
              <Space wrap size={4}>
                <Tag>约 {l.minutes} 分钟</Tag>
                {l.tags.map((t) => <Tag key={t} color="cyan" style={{ marginInlineEnd: 0 }}>{t}</Tag>)}
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </>
  );
}
