// Same-origin iframe stack: the top page is a shell; the login form, the project form and the
// customer list live inside <iframe src="/frame/...">. Success navigates the TOP window.
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
const app = document.getElementById("app");
const p = location.pathname, q = new URLSearchParams(location.search);
const top_ = (u) => window.top.location.assign(u);
const NAV = `<nav><a href="/home">Home</a><a href="/customers">Customers</a><a href="/form">New project</a></nav>`;

if (!p.startsWith("/frame/")) {
  const framed = { "/": "login", "/login": "login", "/form": "form", "/customers": "customers" }[p];
  if (framed) { document.body.insertAdjacentHTML("afterbegin", NAV);
    app.innerHTML = `<h1>Portal</h1><iframe title="${framed}" src="/frame/${framed}"></iframe>`; }
  else if (p === "/home") app.innerHTML = NAV + (q.get("u") ? `<h1>Welcome, ${q.get("u")}</h1>` : `<h1>Home</h1>`);
  else if (p === "/success") app.innerHTML = NAV + `<h1>${successText(q.get("name"), q.get("plan"))}</h1>`;
  else if (/^\/customers\/\d+$/.test(p)) {
    const c = CUSTOMERS.find((x) => x.id === Number(p.split("/")[2]));
    app.innerHTML = NAV + `<h1>Customer detail: ${c.name}</h1>`;
  }
} else if (p === "/frame/login") {
  app.innerHTML = `<h2>Sign in</h2><form id="f">
    <label for="email">Email</label><input id="email" type="email">
    <label for="pw">Password</label><input id="pw" type="password">
    <p><button type="submit">Sign in</button></p><p class="err" id="err"></p></form>`;
  document.getElementById("f").onsubmit = (e) => { e.preventDefault();
    if (email.value === CREDS.email && pw.value === CREDS.password) top_("/home?u=" + encodeURIComponent(email.value));
    else err.textContent = "Invalid email or password"; };
} else if (p === "/frame/form") {
  app.innerHTML = `<h2>New project</h2><form id="f">
    <label for="name">Project name</label><input id="name">
    <label for="plan">Plan</label><select id="plan"><option value="">Choose a plan…</option>
      ${PLANS.map((x) => `<option>${x}</option>`).join("")}</select>
    <p><input type="checkbox" id="terms"><label for="terms" style="display:inline">I accept the terms</label></p>
    <p><button type="submit">Create project</button></p><p class="err" id="err"></p></form>`;
  document.getElementById("f").onsubmit = (e) => { e.preventDefault();
    const n = document.getElementById("name").value, pl = document.getElementById("plan").value;
    if (!n) return (err.textContent = "Project name is required");
    if (!pl) return (err.textContent = "Please choose a plan");
    if (!terms.checked) return (err.textContent = "Please accept the terms");
    top_(`/success?name=${encodeURIComponent(n)}&plan=${encodeURIComponent(pl)}&terms=yes`); };
} else if (p === "/frame/customers") {
  app.innerHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>City</th></tr></thead><tbody>
    ${CUSTOMERS.map((c) => `<tr><td><a target="_top" href="/customers/${c.id}">${c.name}</a></td><td>${c.email}</td><td>${c.city}</td></tr>`).join("")}
    </tbody></table>`;
}
