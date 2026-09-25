// /events/42/checkout -> /events/:id/checkout. Numeric, uuid-ish and long mixed slugs are ids.
export function pattern(u) {
  const url = new URL(u);
  const segs = url.pathname.split("/").map((s) =>
    /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(s) || /^[0-9a-f]{12,}$/i.test(s)
      || (s.length >= 16 && /\d/.test(s) && /[a-z]/i.test(s)) ? ":id" : s);
  return segs.join("/") || "/";
}
