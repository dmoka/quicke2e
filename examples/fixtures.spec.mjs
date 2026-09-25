// Try jevtester with no app of your own: these flows run against the bundled fixture pages.
//   node fixtures/serve.mjs 8899 &
//   node bin/jevtester.mjs run examples/fixtures.spec.mjs --base http://127.0.0.1:8899
export default [
  { name: "login", start: "/login.html", maxSteps: 8,
    inputs: { email: "member@example.test", password: "Demo-Pass-42!" },
    goal: "Sign in with the email and password.",
    done: "The dashboard is shown.",
    expectUrl: "login-done\\.html", expect: ["Signed in as"] },
  { name: "choose-a-plan", start: "/select.html", maxSteps: 8,
    inputs: { team: "Acme", plan: "Growth" },
    goal: "Set the team name to Acme, choose the Growth plan, and save the subscription.",
    done: "The subscription is saved with the Growth plan.",
    expectUrl: "done\\.html\\?Team=Acme&Plan=Growth", expect: ["Plan: Growth"] },
  { name: "weekly-digest-toast", start: "/toast.html", maxSteps: 8,
    goal: "Turn on the weekly digest and save the settings.",
    done: "The settings are saved with the weekly digest on.",
    expectSeen: ["Settings saved: weekly digest on"] },
];
