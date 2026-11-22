import { defineConfig } from "vite";

export default defineConfig({
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
