// Legacy stack: layout tables, labels as bare <td> text (no <label>, no aria), jQuery handlers,
// javascript: links, <input type=button> submits. Fields are named, not labelled.
import $ from "jquery";
import { CUSTOMERS, PLANS, CREDS, successText } from "../shared/data.js";
window.$ = window.jQuery = $;
const p = location.pathname, q = new URLSearchParams(location.search);
$(document).on("click", "[data-go]", function () { location.href = $(this).data("go"); });

if (p === "/login" || p === "/") {
  $("#app").html(`<b>Log on</b><table>
    <tr><td>E-mail:</td><td><input name="email" size="30"></td></tr>
    <tr><td>Password:</td><td><input name="password" type="password" size="30"></td></tr>
    <tr><td></td><td><input type="button" class="btn" id="logon" value="Log On"></td></tr></table><div class="err"></div>`);
  $("#logon").on("click", () => {
    const e = $("input[name=email]").val(), pw = $("input[name=password]").val();
    if (e === CREDS.email && pw === CREDS.password) location.href = "/home?u=" + encodeURIComponent(e);
    else $(".err").text("Logon failed");
  });
} else if (p === "/home") {
  $("#app").html(q.get("u") ? `<h2>Welcome, ${q.get("u")}</h2>` : "<h2>Home</h2>");
} else if (p === "/form") {
  $("#app").html(`<b>New project</b><table>
    <tr><td>Project name:</td><td><input name="projectname" size="30"></td></tr>
    <tr><td>Plan:</td><td><select name="plan"><option value="">-- select --</option>
      ${PLANS.map((x) => `<option value="${x}">${x}</option>`).join("")}</select></td></tr>
    <tr><td></td><td><input type="checkbox" name="terms"> I accept the terms</td></tr>
    <tr><td></td><td><input type="button" class="btn" id="save" value="Create project"></td></tr></table><div class="err"></div>`);
  $("#save").on("click", () => {
    const n = $("input[name=projectname]").val(), pl = $("select[name=plan]").val();
    if (!n) return $(".err").text("Project name is required");
    if (!pl) return $(".err").text("Please choose a plan");
    if (!$("input[name=terms]").is(":checked")) return $(".err").text("Please accept the terms");
    location.href = `/success?name=${encodeURIComponent(n)}&plan=${encodeURIComponent(pl)}&terms=yes`;
  });
} else if (p === "/success") {
  $("#app").html(`<h2>${successText(q.get("name"), q.get("plan"))}</h2>`);
} else if (p === "/customers") {
  $("#app").html(`<b>Customers</b><table class="grid" cellspacing="0"><tr><th>Name</th><th>E-mail</th><th>City</th></tr>
    ${CUSTOMERS.map((c) => `<tr><td><a href="#" data-id="${c.id}" class="cust">${c.name}</a></td><td>${c.email}</td><td>${c.city}</td></tr>`).join("")}</table>`);
  $(".cust").on("click", function (ev) { ev.preventDefault(); location.href = "/customers/" + $(this).data("id"); });
} else if (/^\/customers\/\d+$/.test(p)) {
  const c = CUSTOMERS.find((x) => x.id === Number(p.split("/")[2]));
  $("#app").html(`<h2>Customer detail: ${c.name}</h2>`);
}
