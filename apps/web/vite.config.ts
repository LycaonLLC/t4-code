import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  base: mode === "demo" ? "/demo/" : "./",
  plugins: [
    react(),
    tailwindcss(),
    ...(mode === "demo"
      ? [
          {
            name: "t4-demo-document-root",
            transformIndexHtml: (html: string) =>
              html.replace("<head>", '<head>\n    <base href="/demo/">').replaceAll('="./', '="/demo/'),
          },
        ]
      : []),
  ],
}));
