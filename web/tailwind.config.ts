import type { Config } from "tailwindcss";

// Brand tokens carried over from the Alloy prototype: graphite-grey neutrals
// + an orange accent. Extend/rename freely — this just seeds the palette so
// the rebuilt UI doesn't start from Tailwind's defaults.
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: "#f97316", strong: "#ea580c" },
        graphite: {
          50: "#f7f7f8",
          100: "#eeeef0",
          200: "#d9d9de",
          300: "#b6b7bf",
          400: "#8b8d99",
          500: "#6b6d7a",
          600: "#54565f",
          700: "#43444c",
          800: "#2c2d33",
          900: "#1c1d21",
        },
      },
    },
  },
  plugins: [],
};

export default config;
