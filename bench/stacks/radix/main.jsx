// shadcn/ui is copy-paste Radix + Tailwind classes; this is the same Radix primitives with the
// shadcn component structure (Select trigger/portal/content/item, Checkbox button role=checkbox).
import { useState } from "react";
import { createRoot } from "react-dom/client";
import * as Select from "@radix-ui/react-select";
import * as Checkbox from "@radix-ui/react-checkbox";
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
import { nav, link } from "../shared/router.js";
import { useRoute } from "../shared/useRoute.js";
import "./style.css";

function Login() {
  const [email, setEmail] = useState(""), [pw, setPw] = useState(""), [err, setErr] = useState("");
  const submit = (e) => { e.preventDefault();
    if (email === CREDS.email && pw === CREDS.password) nav("/home?u=" + encodeURIComponent(email));
    else setErr("Invalid email or password"); };
  return <form className="card" onSubmit={submit}><h1>Sign in</h1>
    <label htmlFor="email">Email</label><input id="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
    <label htmlFor="password">Password</label><input id="password" type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} />
    <button className="btn" type="submit">Sign in</button>{err && <p role="alert" className="err">{err}</p>}</form>;
}
function ProjectForm() {
  const [name, setName] = useState(""), [plan, setPlan] = useState(""), [terms, setTerms] = useState(false), [err, setErr] = useState("");
  const submit = (e) => { e.preventDefault();
    if (!name) return setErr("Project name is required");
    if (!plan) return setErr("Please choose a plan");
    if (!terms) return setErr("Please accept the terms");
    nav(`/success?name=${encodeURIComponent(name)}&plan=${encodeURIComponent(plan)}&terms=yes`); };
  return <form className="card" onSubmit={submit}><h1>New project</h1>
    <label htmlFor="name">Project name</label><input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
    <label htmlFor="plan">Plan</label>
    <Select.Root value={plan} onValueChange={setPlan} name="plan">
      <Select.Trigger id="plan" className="trigger" aria-label="Plan"><Select.Value placeholder="Choose a plan" /><Select.Icon>▾</Select.Icon></Select.Trigger>
      <Select.Portal><Select.Content className="content" position="popper" sideOffset={4}><Select.Viewport>
        {PLANS.map((p) => <Select.Item key={p} value={p} className="item"><Select.ItemText>{p}</Select.ItemText></Select.Item>)}
      </Select.Viewport></Select.Content></Select.Portal></Select.Root>
    <div className="row"><Checkbox.Root id="terms" className="cb" checked={terms} onCheckedChange={(v) => setTerms(v === true)}>
      <Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root><label htmlFor="terms">I accept the terms</label></div>
    <button className="btn" type="submit">Create project</button>{err && <p role="alert" className="err">{err}</p>}</form>;
}
function App() {
  const { path, q } = useRoute();
  let body;
  if (path === "/login" || path === "/") body = <Login />;
  else if (path === "/home") body = <h1>{q.get("u") ? `Welcome, ${q.get("u")}` : "Home"}</h1>;
  else if (path === "/form") body = <ProjectForm />;
  else if (path === "/success") body = <h1>{successText(q.get("name"), q.get("plan"))}</h1>;
  else if (path === "/customers") body = <><h1>Customers</h1><table className="tbl"><thead><tr><th>Name</th><th>Email</th><th>City</th></tr></thead>
    <tbody>{CUSTOMERS.map((c) => <tr key={c.id}><td><a href={`/customers/${c.id}`} onClick={link(`/customers/${c.id}`)}>{c.name}</a></td>
      <td>{c.email}</td><td>{c.city}</td></tr>)}</tbody></table></>;
  else { const c = CUSTOMERS.find((x) => `/customers/${x.id}` === path);
    body = c ? <h1>Customer detail: {c.name}</h1> : "Not found"; }
  return <><nav className="nav">{[["/home", "Home"], ["/customers", "Customers"], ["/form", "New project"]]
    .map(([k, l]) => <a key={k} href={k} onClick={link(k)}>{l}</a>)}</nav><main className="main">{body}</main></>;
}
createRoot(document.getElementById("root")).render(<App />);
