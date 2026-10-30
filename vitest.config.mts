import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Next compiles JSX with the automatic runtime; esbuild defaults to the
  // classic one, which needs React in scope and fails with "React is not
  // defined" the moment a test renders a component.
  esbuild: { jsx: "automatic" },
  // `server-only` throws unless resolved under Next's `react-server`
  // condition, which a plain node test run never sets. Resolve it the way the
  // server bundle does: to the package's own empty module.
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // `.tsx` so component tests can live here too. They opt into a DOM with a
    // `// @vitest-environment jsdom` docblock rather than switching the whole
    // suite: everything else is pure logic that runs faster, and more honestly,
    // without one.
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
