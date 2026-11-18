import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#111719",
        panel: "#192124",
        line: "#303a3d",
        muted: "#a6b0ae",
        ember: "#f0a24b",
        signal: "#e7624c",
      },
    },
  },
  plugins: [],
};

export default config;
