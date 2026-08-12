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
    // `.tsx` so component tests can live here too. They opt into a DOM with a
    // `// @vitest-environment jsdom` docblock rather than switching the whole
    // suite: everything else is pure logic that runs faster, and more honestly,
    // without one.
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
