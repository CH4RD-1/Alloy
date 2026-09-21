import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Example authenticated API route. No manual org_id filter on GET — RLS
// (see schema.sql) means this only ever returns rows the signed-in user's
// org membership allows.
export async function GET() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status_id, project_id, due_date")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ tasks: data });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      org_id: body.org_id,
      project_id: body.project_id,
      title: body.title,
      status_id: body.status_id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ task: data }, { status: 201 });
}
