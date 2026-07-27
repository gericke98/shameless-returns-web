import { HtmlLang } from "@/components/htmlLang";

/**
 * Exists only to declare the dashboard's language. The root layout labels the
 * document with the customer's portal locale, which is usually "es" for the
 * shop owner — but every string under /dashboard is English.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <HtmlLang lang="en" />
      {children}
    </>
  );
}
