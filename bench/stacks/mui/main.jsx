import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppBar, Toolbar, Button, Container, TextField, Typography, Select, MenuItem, FormControl,
  InputLabel, FormControlLabel, Checkbox, Alert, Table, TableHead, TableBody, TableRow, TableCell, Link, Stack } from "@mui/material";
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
import { nav, link } from "../shared/router.js";
import { useRoute } from "../shared/useRoute.js";

function Login() {
  const [email, setEmail] = useState(""), [pw, setPw] = useState(""), [err, setErr] = useState("");
  const submit = (e) => { e.preventDefault();
    if (email === CREDS.email && pw === CREDS.password) nav("/home?u=" + encodeURIComponent(email));
    else setErr("Invalid email or password"); };
  return <form onSubmit={submit}><Stack spacing={2} sx={{ maxWidth: 360 }}>
    <Typography variant="h4">Sign in</Typography>
    <TextField label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
    <TextField label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
    <Button type="submit" variant="contained">Sign in</Button>
    {err && <Alert severity="error">{err}</Alert>}</Stack></form>;
}
function ProjectForm() {
  const [name, setName] = useState(""), [plan, setPlan] = useState(""), [terms, setTerms] = useState(false), [err, setErr] = useState("");
  const submit = (e) => { e.preventDefault();
    if (!name) return setErr("Project name is required");
    if (!plan) return setErr("Please choose a plan");
    if (!terms) return setErr("Please accept the terms");
    nav(`/success?name=${encodeURIComponent(name)}&plan=${encodeURIComponent(plan)}&terms=yes`); };
  return <form onSubmit={submit}><Stack spacing={2} sx={{ maxWidth: 360 }}>
    <Typography variant="h4">New project</Typography>
    <TextField label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
    <FormControl><InputLabel id="plan-l">Plan</InputLabel>
      <Select labelId="plan-l" label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
        {PLANS.map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}</Select></FormControl>
    <FormControlLabel control={<Checkbox checked={terms} onChange={(e) => setTerms(e.target.checked)} />} label="I accept the terms" />
    <Button type="submit" variant="contained">Create project</Button>
    {err && <Alert severity="error">{err}</Alert>}</Stack></form>;
}
function Customers() {
  return <><Typography variant="h4">Customers</Typography><Table size="small"><TableHead><TableRow>
    <TableCell>Name</TableCell><TableCell>Email</TableCell><TableCell>City</TableCell></TableRow></TableHead>
    <TableBody>{CUSTOMERS.map((c) => <TableRow key={c.id}>
      <TableCell><Link href={`/customers/${c.id}`} onClick={link(`/customers/${c.id}`)}>{c.name}</Link></TableCell>
      <TableCell>{c.email}</TableCell><TableCell>{c.city}</TableCell></TableRow>)}</TableBody></Table></>;
}
function App() {
  const { path, q } = useRoute();
  let body;
  if (path === "/login" || path === "/") body = <Login />;
  else if (path === "/home") body = <Typography variant="h4">{q.get("u") ? `Welcome, ${q.get("u")}` : "Home"}</Typography>;
  else if (path === "/form") body = <ProjectForm />;
  else if (path === "/success") body = <Typography variant="h4">{successText(q.get("name"), q.get("plan"))}</Typography>;
  else if (path === "/customers") body = <Customers />;
  else { const c = CUSTOMERS.find((x) => `/customers/${x.id}` === path);
    body = c ? <Typography variant="h4">Customer detail: {c.name}</Typography> : "Not found"; }
  return <><AppBar position="static"><Toolbar>
    <Button color="inherit" href="/home" onClick={link("/home")}>Home</Button>
    <Button color="inherit" href="/customers" onClick={link("/customers")}>Customers</Button>
    <Button color="inherit" href="/form" onClick={link("/form")}>New project</Button></Toolbar></AppBar>
    <Container sx={{ py: 3 }}>{body}</Container></>;
}
createRoot(document.getElementById("root")).render(<App />);
