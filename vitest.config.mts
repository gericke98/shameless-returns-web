import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Next compiles JSX with the automatic runtime; esbuild defaults to the
  // classic one, which needs React in scope and fails with "React is not
  // defined" the moment a test renders a component.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
