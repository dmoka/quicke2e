// Shared fixture data for every Tier-2 stack. Same names, same target, same credentials.
const FIRST = ["Ada","Bram","Cora","Dmitri","Elise","Farid","Greta","Hugo","Ines","Jonas","Kira","Lars","Mira","Nils","Olga","Pavel","Quinn","Rosa","Sven","Tara"];
const LAST = ["Abbott","Brandt","Castell","Dorsey","Egan","Falk","Gruber","Hale","Ivers","Jansen","Keller","Lund","Moser","Novak","Orr"];
export const CUSTOMERS = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
  email: `customer${i + 1}@example.test`,
  city: ["Berlin", "Lisbon", "Oslo", "Porto", "Graz", "Turin"][i % 6],
}));
// Row 57 of 60: near the bottom, a unique name the goal can mention.
CUSTOMERS[56].name = "Quentin Harlow";
export const TARGET_ID = 57;
export const PLANS = ["Starter", "Team", "Growth", "Business", "Enterprise"];
export const CREDS = { email: "demo@bench.test", password: "Bench123!" };
export const successText = (name, plan) => `Created project ${name} on plan ${plan}`;
