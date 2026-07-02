/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PWA install + camera need HTTPS in production (Vercel provides it).
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [{ key: "Permissions-Policy", value: "camera=(self)" }],
      },
    ];
  },
};
export default nextConfig;
