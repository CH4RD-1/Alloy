To Start up server:

Open Docker

In Vs code:
<in root folder>
npx supabase start
<in root/web folder>
npm run dev

links:
Alloy Dashboard:
http://localhost:3000/dashboard

Alloy Login:
http://localhost:3000/portal/acme

Mailbox:
http://127.0.0.1:54324/view/5tEU7jwEPY7rLrCJbZJQOY

SQL Editor:
http://127.0.0.1:54323/project/default/sql/new

Create a Supabase project.
Run ../schema.sql against it (SQL editor, or psql), then work through the "Row Level Security" section at the bottom of that file — enable RLS and add a tenant-isolation policy on every org-scoped table before storing real data (only projects and tasks are done as worked examples there).
Copy .env.example to .env.local and fill in your Supabase project URL + keys (Project Settings → API).
npm install
npm run dev — http://localhost:3000


To wipe Data:
In Vs code:
<in root folder>
npx supabase stop --no-backup

npx supabase start
