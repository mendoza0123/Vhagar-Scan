import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#0e4d92", dark: "#0a3a6e" },
        accent: "#137a63",
      },
    },
  },
  plugins: [],
};
export default config;
