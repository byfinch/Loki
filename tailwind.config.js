/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['Geist Mono', 'monospace'],
      },
      colors: {
        dark: {
          bg: '#000',
          surface: '#0f0f0f',
          border: 'rgba(255,255,255,0.1)',
        }
      }
    },
  },
  plugins: [],
}
