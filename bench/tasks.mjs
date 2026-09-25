// The same 3 tasks on every Tier-2 stack. Assertions are URL + DOM and only true AFTER the work.
export const TASKS = {
  T1: { name: "T1-login", start: "/login", maxSteps: 8,
    inputs: { email: "demo@bench.test", password: "Bench123!" },
    goal: "Log in as demo@bench.test",
    done: "The user is logged in and sees the welcome page.",
    expectUrl: "/home\\?u=", expect: ["Welcome, demo@bench.test"] },
  T2: { name: "T2-form", start: "/form", maxSteps: 14,
    inputs: { name: "Orion" },
    goal: "Create a project named Orion on the Enterprise plan: fill the project name, choose the Enterprise plan, accept the terms, then submit.",
    done: "The project Orion has been created on the Enterprise plan.",
    expectUrl: "/success\\?name=Orion&plan=Enterprise", expect: ["Created project Orion on plan Enterprise"] },
  T3: { name: "T3-deep-row", start: "/customers", maxSteps: 8,
    goal: "Open the detail page of the customer Quentin Harlow.",
    done: "The detail page of Quentin Harlow is open.",
    expectUrl: "/customers/57$", expect: ["Customer detail: Quentin Harlow"] },
};
