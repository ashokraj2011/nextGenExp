import MarkdownIt from "markdown-it";
import { defineConfig, normalizePath } from "vite";

const guideMarkdown = new MarkdownIt({ html: false });

export default defineConfig({
  plugins: [{
    name: "developer-guide-markdown",
    enforce: "pre",
    transform(source, id) {
      if (!/\/docs\/developers\/[^/]+\.md$/.test(normalizePath(id))) return;
      return { code: "export default " + JSON.stringify(guideMarkdown.render(source)), map: null };
    },
  }],
  build: {
    target: "es2022",
    rolldownOptions: {
      onwarn(warning, warn) {
        // This entry is client-only. RSC directives from dependencies have no runtime effect.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" && warning.message.includes('"use client"')) return;
        warn(warning);
      },
      output: {
        codeSplitting: {
          groups: [
            { name: "a2ui", test: /node_modules[\\/](?:@a2ui|zod)[\\/]/ },
            { name: "assistant-ui", test: /node_modules[\\/](?:@assistant-ui|@radix-ui)[\\/]/ },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    include: ["@a2ui/react", "@a2ui/web_core/v1_0", "@assistant-ui/react", "lucide-react"],
  },
});
