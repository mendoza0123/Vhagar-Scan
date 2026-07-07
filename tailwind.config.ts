import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#22322A", dark: "#1A2620" }, // Vhagar Nomad Green
        accent: "#5E1A20", // Wild Garnet
      },
    },
  },
  plugins: [],
};
export default config;
