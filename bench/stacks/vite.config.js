// One config, one app per build: STACK=<dir> vite build. Output: dist/<dir>.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

const stack = process.env.STACK;
if (!stack) throw new Error("set STACK=<app dir>");
const plugins = { mui: [react()], antd: [react()], radix: [react()], "vue-ep": [vue()] }[stack] || [];

export default defineConfig({
  root: path.resolve(import.meta.dirname, stack),
  base: "/",
  plugins,
  logLevel: "warn",
  build: { outDir: path.resolve(import.meta.dirname, "dist", stack), emptyOutDir: true, sourcemap: false },
});
