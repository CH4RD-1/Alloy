import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold">Alloy</h1>
      <p className="text-graphite-500">
        Scaffold — wire up your Supabase env vars, then head to{" "}
        <Link href="/login" className="text-accent hover:underline">
          sign in
        </Link>{" "}
        or a tenant&apos;s{" "}
        <Link href="/portal/acme" className="text-accent hover:underline">
          portal
        </Link>
        .
      </p>
    </main>
  );
}
