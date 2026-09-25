import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout, Menu, Form, Input, Button, Select, Checkbox, Alert, Table, Typography } from "antd";
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
import { nav, link } from "../shared/router.js";
import { useRoute } from "../shared/useRoute.js";

function Login() {
  const [err, setErr] = useState("");
  const finish = (v) => { if (v.email === CREDS.email && v.password === CREDS.password) nav("/home?u=" + encodeURIComponent(v.email));
    else setErr("Invalid email or password"); };
  return <Form layout="vertical" style={{ maxWidth: 360 }} onFinish={finish}>
    <Typography.Title>Sign in</Typography.Title>
    <Form.Item label="Email" name="email"><Input /></Form.Item>
    <Form.Item label="Password" name="password"><Input.Password /></Form.Item>
    <Button type="primary" htmlType="submit">Sign in</Button>
    {err && <Alert type="error" title={err} message={err} />}</Form>;
}
function ProjectForm() {
  const [err, setErr] = useState("");
  const finish = (v) => {
    if (!v.name) return setErr("Project name is required");
    if (!v.plan) return setErr("Please choose a plan");
    if (!v.terms) return setErr("Please accept the terms");
    nav(`/success?name=${encodeURIComponent(v.name)}&plan=${encodeURIComponent(v.plan)}&terms=yes`); };
  return <Form layout="vertical" style={{ maxWidth: 360 }} onFinish={finish}>
    <Typography.Title>New project</Typography.Title>
    <Form.Item label="Project name" name="name"><Input /></Form.Item>
    <Form.Item label="Plan" name="plan"><Select placeholder="Choose a plan" options={PLANS.map((p) => ({ value: p, label: p }))} /></Form.Item>
    <Form.Item name="terms" valuePropName="checked"><Checkbox>I accept the terms</Checkbox></Form.Item>
    <Button type="primary" htmlType="submit">Create project</Button>
    {err && <Alert type="error" title={err} message={err} />}</Form>;
}
const cols = [
  { title: "Name", dataIndex: "name", render: (t, c) => <a href={`/customers/${c.id}`} onClick={link(`/customers/${c.id}`)}>{t}</a> },
  { title: "Email", dataIndex: "email" }, { title: "City", dataIndex: "city" }];
function App() {
  const { path, q } = useRoute();
  let body;
  if (path === "/login" || path === "/") body = <Login />;
  else if (path === "/home") body = <Typography.Title>{q.get("u") ? `Welcome, ${q.get("u")}` : "Home"}</Typography.Title>;
  else if (path === "/form") body = <ProjectForm />;
  else if (path === "/success") body = <Typography.Title>{successText(q.get("name"), q.get("plan"))}</Typography.Title>;
  else if (path === "/customers") body = <><Typography.Title>Customers</Typography.Title>
    <Table rowKey="id" size="small" pagination={false} columns={cols} dataSource={CUSTOMERS} /></>;
  else { const c = CUSTOMERS.find((x) => `/customers/${x.id}` === path);
    body = c ? <Typography.Title>Customer detail: {c.name}</Typography.Title> : "Not found"; }
  const items = [["/home", "Home"], ["/customers", "Customers"], ["/form", "New project"]]
    .map(([k, l]) => ({ key: k, label: <a href={k} onClick={link(k)}>{l}</a> }));
  return <Layout><Layout.Header><Menu theme="dark" mode="horizontal" selectable={false} items={items} /></Layout.Header>
    <Layout.Content style={{ padding: 24 }}>{body}</Layout.Content></Layout>;
}
createRoot(document.getElementById("root")).render(<App />);
