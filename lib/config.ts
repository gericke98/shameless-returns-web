export const getBaseUrl = () => {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.NEXTAUTH_URL || "http://localhost:3000";
};

export const siteConfig = {
  name: "Shameless Collective",
  description: "Returns & Exchanges",
  baseUrl: getBaseUrl(),
};
