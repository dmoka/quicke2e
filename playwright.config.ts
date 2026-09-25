import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./codegen",
  timeout: 30000,
  reporter: [["list"]],
  use: { viewport: { width: 1280, height: 900 } },
});
