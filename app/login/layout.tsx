import { HtmlLang } from "@/components/htmlLang";

/** English admin login under a Spanish-default root layout — see dashboard/layout.tsx. */
export default function LoginLayout({
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
