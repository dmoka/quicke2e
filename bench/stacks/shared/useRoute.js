import { useEffect, useState } from "react";
import { here, onNav } from "./router.js";
export function useRoute() {
  const [r, setR] = useState(here());
  useEffect(() => onNav(() => setR(here())), []);
  const u = new URL(r, location.origin);
  return { path: u.pathname, q: u.searchParams };
}
