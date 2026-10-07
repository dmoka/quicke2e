// ONE definition of "looks like a secret", shared by the loop, the in-page snapshot and codegen.
// A key or a label matching this never has its value sent to an engine or written into a file.
export const SECRET_SRC = String.raw`pass|pwd|\bpw\b|secret|token|api.?key|access.?key|license.?key|\bpin\b|cvc|cvv|card|iban|otp|2fa|\bssn\b|social.?security|\bauth\b|bearer|credential|private|recovery|mnemonic|seed.?phrase|account.?number|session`;
export const SECRET = new RegExp(SECRET_SRC, "i");
// "card" means the card NUMBER; the holder's name, and the card type are not secrets (a gift-card code stays secret: it is money)
// (wave-2 tests E, W5: "name on card" forced an env var in every emitted spec)
const NOT_SECRET = /(name|holder|owner|type|brand)\b.*card|card.?(holder|owner|name|type|brand)/i;
export const isSecretKey = (k) => SECRET.test(k || "") && !(/card/i.test(k || "") && NOT_SECRET.test(k || "") && !/(number|no|num|cvc|cvv|pin)\b/i.test(k || ""));

// A STRONG secret (10+ chars, 2+ character classes) cannot be confused with page words, so it is
// scrubbed fuzzily everywhere. A WEAK one ("admin", "password", "test1234" -- typical seed values) is
// indistinguishable from ordinary labels: scrubbing it from page text turned the field label
// "Password" and the links "Admin"/"Administrators" into "<password>" (audit FP1/FP2), broke runs and
// emitted `name: /^/`. Weak secrets are therefore scrubbed only from the SPEC's own text (goal, done).
export function isStrong(v) {
  const t = String(v ?? "");
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length;
  const digits = (t.match(/\d/g) || []).length;
  // mixed classes, or a long number (card, account, recovery code) -- neither looks like a page word
  return (t.length >= 10 && classes >= 2) || (/^[\d\s-]+$/.test(t) && digits >= 10);
}
export function weakSecretKeys(inputs) {
  return Object.entries(inputs || {}).filter(([k, v]) => isSecretKey(k) && v != null && String(v).length >= 3 && !isStrong(v)).map(([k]) => k);
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const classesOf = (t) => [/[a-z]/i, /\d/, /[^A-Za-z0-9\s]/].filter((r) => r.test(t)).length;
function secretPatterns(inputs, { weak = false, weakKeys = [], keepWeak = [] } = {}) {
  const out = [], partial = [];   // partial forms run LAST, after the whole value had its chance
  for (const [k, v] of Object.entries(inputs || {})) {
    if (!isSecretKey(k) || v == null) continue;
    const val = String(v).trim().replace(/\s+/g, " ");
    if (val.length < 3) continue;
    if (!isStrong(val)) {
      // weak: only the exact value as a whole word -- in spec text always; in page text only for
      // `weakKeys`, the keys the loop has seen ECHOED (typed, and not on any page before typing)
      if ((weak && !keepWeak.includes(k)) || weakKeys.includes(k)) out.push({ k, re: new RegExp(`(?<![A-Za-z0-9])${esc(val)}(?![A-Za-z0-9])`, "gi") });
      continue;
    }
    // strong: whole value, plus an 8-char head for a TRUNCATED echo -- but only when the head itself
    // mixes letters with digits/symbols ("Password" alone would collide with the field label)
    const forms = [val];
    const head = val.slice(0, 8);
    if (val.length > 8 && classesOf(head) >= 2) forms.push(head);
    // A card is commonly DISPLAYED masked, by its last 4 digits ("ending 6789", "•••• 6789",
    // "x6789"). That masked form is scrubbed. A bare 4-digit number is NOT: the audit's card ending
    // 2026 turned "2026 report" into "<card number> report" and the flow picked 2025 (r7).
    const digits = val.replace(/\D/g, "");
    if (/^[\d\s-]+$/.test(val) && digits.length >= 12)
      partial.push({ k, re: new RegExp(`((?:ending(?:\\s+in)?|ends\\s+in|last\\s*(?:4|four)(?:\\s+digits)?)\\s*[:#-]?\\s*|[•*·xX]{1,}[\\s-]?)${digits.slice(-4)}(?!\\d)`, "gi"), keepPrefix: true });
    const formEnc = (t) => new URLSearchParams({ x: t }).toString().slice(2);
    for (const f of forms) for (const form of new Set([f, encodeURIComponent(f), formEnc(f)])) {
      // separator-flexible between every character (a grouped card number "4111-2222-...")
      const chars = [...form.replace(/[\s+]+/g, "")];
      out.push({ k, re: new RegExp(chars.map(esc).join("[\\s\\-./+]*") + "[^\\s&?#\"'<>]*", "gi") });
    }
  }
  return out.concat(partial);
}
// Placeholders are applied through sentinels, so a later pattern can never match inside an earlier
// replacement ("<password>").
function apply(text, pats) {
  let t = String(text);
  pats.forEach(({ re, keepPrefix }, i) => {
    t = t.replace(re, keepPrefix ? (m, pre) => `${pre}\u0001${i}\u0001` : `\u0001${i}\u0001`);
  });
  return t.replace(/\u0001(\d+)\u0001/g, (_, i) => `<${pats[Number(i)].k}>`);
}
// Page-derived text: strong secrets only.
export function scrubText(text, inputs, opts) { return apply(text ?? "", secretPatterns(inputs, opts)); }
// The spec's own words (goal, done): strong AND weak secrets.
export function scrubSpecText(text, inputs, { keepWeak = [] } = {}) { return apply(text ?? "", secretPatterns(inputs, { weak: true, keepWeak })); }
export function containsSecret(text, inputs, opts) { return scrubText(text, inputs, opts) !== String(text ?? ""); }
export function scrub(payload, inputs, opts) {
  const pats = secretPatterns(inputs, opts);
  if (!pats.length) return payload;
  const walk = (x) => typeof x === "string" ? apply(x, pats)
    : Array.isArray(x) ? x.map(walk)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([a, b]) => [walk(a), walk(b)])) : x;
  return walk(payload);
}

// DECLARED REDACTION. Page content reaches the engine by design -- the engine chooses by what the
// page says, like any browser agent. Content that must never leave the page is DECLARED in the spec:
//   redact: [/recovery code \S+/i, /\b\d{4}-[A-Z0-9]{4,}\b/]   // text patterns
//   redact: ["[data-sensitive]", ".backup-code"]                 // CSS selectors (see loop.mjs)
// An automatic "looks like a code" rule was built and measured first (audit r7): it broke four flows
// that worked (newest order, version picker, SKU picker, a year next to a card) because codes carry
// ordering and identity, and it still leaked four other code shapes. A declaration has neither problem.
export function redactPatterns(payload, patterns = []) {
  const res = patterns.filter((p) => p instanceof RegExp).map((p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"));
  if (!res.length) return payload;
  const walk = (x) => typeof x === "string" ? res.reduce((t, re) => t.replace(re, "<redacted>"), x)
    : Array.isArray(x) ? x.map(walk)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([a, b]) => [walk(a), walk(b)])) : x;
  return walk(payload);
}
