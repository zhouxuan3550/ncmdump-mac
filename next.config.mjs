/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  outputFileTracingRoot: process.cwd(),
  images: {
    unoptimized: true
  }
};

export default nextConfig;
