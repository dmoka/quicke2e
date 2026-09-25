// Tiny pushState router shared by the SPA stacks. No router dependency.
export const here = () => location.pathname + location.search;
export function nav(to) { history.pushState(null, "", to); dispatchEvent(new Event("nav")); }
export function onNav(fn) {
  addEventListener("popstate", fn); addEventListener("nav", fn);
  return () => { removeEventListener("popstate", fn); removeEventListener("nav", fn); };
}
export const link = (to) => (e) => { e.preventDefault(); nav(to); };
