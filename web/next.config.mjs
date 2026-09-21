/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Server Actions default to a 1MB request-body cap, which is smaller
    // than the 4MB file/sketch attachment limit ported from the prototype
    // (see TASK_ATTACHMENT_MAX_BYTES in lib/storage.ts) — raised just above
    // that so a max-size upload's multipart FormData (file bytes plus a
    // little overhead) fits.
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },
};

export default nextConfig;
