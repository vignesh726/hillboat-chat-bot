import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Forward /api calls to the Express server so the API key never reaches the browser
    proxy: { "/api": "http://localhost:3001" },
  },
});
