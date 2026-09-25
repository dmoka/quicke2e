// Web Components stack: Shoelace (open shadow DOM form controls) + Lit elements for nav and list.
// Every interactive element lives inside a shadow root.
import "@shoelace-style/shoelace/dist/themes/light.css";
import "@shoelace-style/shoelace/dist/components/input/input.js";
import "@shoelace-style/shoelace/dist/components/button/button.js";
import "@shoelace-style/shoelace/dist/components/select/select.js";
import "@shoelace-style/shoelace/dist/components/option/option.js";
import "@shoelace-style/shoelace/dist/components/checkbox/checkbox.js";
import "@shoelace-style/shoelace/dist/components/alert/alert.js";
import { LitElement, html, css } from "lit";
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";

class AppNav extends LitElement {
  static styles = css`nav{background:#1e293b;padding:10px 20px;display:flex;gap:16px} a{color:#fff}`;
  render() { return html`<nav><a href="/home">Home</a><a href="/customers">Customers</a><a href="/form">New project</a></nav>`; }
}
customElements.define("app-nav", AppNav);

class CustomerTable extends LitElement {
  static styles = css`table{border-collapse:collapse} td,th{border-bottom:1px solid #ddd;padding:4px 10px;text-align:left}`;
  render() {
    return html`<table><thead><tr><th>Name</th><th>Email</th><th>City</th></tr></thead><tbody>
      ${CUSTOMERS.map((c) => html`<tr><td><a href="/customers/${c.id}">${c.name}</a></td><td>${c.email}</td><td>${c.city}</td></tr>`)}
    </tbody></table>`;
  }
}
customElements.define("customer-table", CustomerTable);

const app = document.getElementById("app");
const p = location.pathname, q = new URLSearchParams(location.search);
const $ = (s) => app.querySelector(s);
const fail = (m) => { const a = $("#err"); a.textContent = m; a.open = true; };

if (p === "/login" || p === "/") {
  app.innerHTML = `<h1>Sign in</h1><div class="stack">
    <sl-input id="email" label="Email"></sl-input>
    <sl-input id="pw" label="Password" type="password"></sl-input>
    <sl-button id="go" variant="primary">Sign in</sl-button>
    <sl-alert id="err" variant="danger"></sl-alert></div>`;
  $("#go").addEventListener("click", () => {
    if ($("#email").value === CREDS.email && $("#pw").value === CREDS.password) location.assign("/home?u=" + encodeURIComponent($("#email").value));
    else fail("Invalid email or password");
  });
} else if (p === "/home") {
  app.innerHTML = q.get("u") ? `<h1>Welcome, ${q.get("u")}</h1>` : `<h1>Home</h1>`;
} else if (p === "/form") {
  app.innerHTML = `<h1>New project</h1><div class="stack">
    <sl-input id="name" label="Project name"></sl-input>
    <sl-select id="plan" label="Plan" placeholder="Choose a plan">
      ${PLANS.map((x) => `<sl-option value="${x}">${x}</sl-option>`).join("")}</sl-select>
    <sl-checkbox id="terms">I accept the terms</sl-checkbox>
    <sl-button id="go" variant="primary">Create project</sl-button>
    <sl-alert id="err" variant="danger"></sl-alert></div>`;
  $("#go").addEventListener("click", () => {
    const n = $("#name").value, pl = $("#plan").value;
    if (!n) return fail("Project name is required");
    if (!pl) return fail("Please choose a plan");
    if (!$("#terms").checked) return fail("Please accept the terms");
    location.assign(`/success?name=${encodeURIComponent(n)}&plan=${encodeURIComponent(pl)}&terms=yes`);
  });
} else if (p === "/success") {
  app.innerHTML = `<h1>${successText(q.get("name"), q.get("plan"))}</h1>`;
} else if (p === "/customers") {
  app.innerHTML = `<h1>Customers</h1><customer-table></customer-table>`;
} else if (/^\/customers\/\d+$/.test(p)) {
  const c = CUSTOMERS.find((x) => x.id === Number(p.split("/")[2]));
  app.innerHTML = `<h1>Customer detail: ${c.name}</h1>`;
}
