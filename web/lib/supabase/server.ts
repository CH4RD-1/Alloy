import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// Use in Server Components, Route Handlers, and Server Actions. Runs with
// the signed-in user's session, so RLS policies (see schema.sql) apply —
// this is what makes "just query the table" safe across tenants.
//
// Async because Next.js 15 made `cookies()` an async dynamic API — calling
// it synchronously logs a "should be awaited" warning on every request (and
// a future Next.js version turns that into a hard error), so every caller
// below awaits this.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Called from a Server Component — the middleware handles
            // session refresh, so this can be safely ignored here.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // Same as above.
          }
        },
      },
    }
  );
}

// A service-role client for privileged server-only work (webhook intake,
// admin scripts) that must bypass RLS on purpose. Never expose this to the
// browser, and never use it to serve a request on a real user's behalf.
export function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
