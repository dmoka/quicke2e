import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
const app = document.getElementById("app");
const p = location.pathname, q = new URLSearchParams(location.search);
const go = (u) => location.assign(u);

if (p === "/login" || p === "/") {
  app.innerHTML = `<h1>Sign in</h1><form id="f">
    <label for="email">Email</label><input id="email" type="email">
    <label for="pw">Password</label><input id="pw" type="password">
    <p><button type="submit">Sign in</button></p><p class="err" id="err"></p></form>`;
  document.getElementById("f").onsubmit = (e) => {
    e.preventDefault();
    if (email.value === CREDS.email && pw.value === CREDS.password) go("/home?u=" + encodeURIComponent(email.value));
    else err.textContent = "Invalid email or password";
  };
} else if (p === "/home") {
  app.innerHTML = q.get("u") ? `<h1>Welcome, ${q.get("u")}</h1>` : `<h1>Home</h1><p>Not signed in.</p>`;
} else if (p === "/form") {
  app.innerHTML = `<h1>New project</h1><form id="f">
    <label for="name">Project name</label><input id="name">
    <label for="plan">Plan</label><select id="plan"><option value="">Choose a plan…</option>
      ${PLANS.map((x) => `<option>${x}</option>`).join("")}</select>
    <p><input type="checkbox" id="terms"><label for="terms" style="display:inline">I accept the terms</label></p>
    <p><button type="submit">Create project</button></p><p class="err" id="err"></p></form>`;
  document.getElementById("f").onsubmit = (e) => {
    e.preventDefault();
    const n = document.getElementById("name").value, pl = document.getElementById("plan").value;
    if (!n) return (err.textContent = "Project name is required");
    if (!pl) return (err.textContent = "Please choose a plan");
    if (!terms.checked) return (err.textContent = "Please accept the terms");
    go(`/success?name=${encodeURIComponent(n)}&plan=${encodeURIComponent(pl)}&terms=yes`);
  };
} else if (p === "/success") {
  app.innerHTML = `<h1>${successText(q.get("name"), q.get("plan"))}</h1>`;
} else if (p === "/customers") {
  app.innerHTML = `<h1>Customers</h1><table><thead><tr><th>Name</th><th>Email</th><th>City</th></tr></thead><tbody>
    ${CUSTOMERS.map((c) => `<tr><td><a href="/customers/${c.id}">${c.name}</a></td><td>${c.email}</td><td>${c.city}</td></tr>`).join("")}
    </tbody></table>`;
} else if (/^\/customers\/\d+$/.test(p)) {
  const c = CUSTOMERS.find((x) => x.id === Number(p.split("/")[2]));
  app.innerHTML = `<h1>Customer detail: ${c.name}</h1><p>${c.email} · ${c.city}</p>`;
}
