import { createClient } from "@/lib/supabase/server";
import { getWorkspaceData } from "@/lib/tasks-data";
import { buildRows, VOCAB_BY_TEMPLATE } from "@/lib/list-view";
import { TasksWorkspace } from "@/components/tasks-workspace";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const data = await getWorkspaceData(user.id);

  if (!data) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24">
        <h1 className="text-xl font-semibold">No workspace yet</h1>
        <p className="mt-2 text-graphite-500">
          Your account isn&apos;t a member of any org yet — run <code>seed.sql</code> (see the README) to create one.
        </p>
      </main>
    );
  }

  const rows = buildRows({
    tasks: data.tasks,
    statuses: data.statuses,
    teams: data.teams,
    links: data.links,
    tagsByTask: data.tagsByTask,
    docCountByTask: data.docCountByTask,
    assigneeNameById: data.assigneeNameById,
    assets: data.assets,
  });

  const vocab = VOCAB_BY_TEMPLATE[data.orgTemplate] ?? VOCAB_BY_TEMPLATE.core;

  return (
    <main>
      <TasksWorkspace
        rows={rows}
        links={data.links}
        statuses={data.statuses}
        transitions={data.transitions}
        workflows={data.workflows}
        teams={data.teams}
        projects={data.projects}
        members={data.members}
        orgId={data.orgId}
        currentUserRole={data.currentUserRole}
        vocabTask={vocab.task}
        vocabTeam={vocab.team}
        docs={data.docs}
        docIdsByTask={data.docIdsByTask}
        taskIdsByDoc={data.taskIdsByDoc}
        taskObjects={data.taskObjects}
        checklistItemsByObject={data.checklistItemsByObject}
        taskObjectFileByObjectId={data.taskObjectFileByObjectId}
        formTemplates={data.formTemplates}
        formTemplateUsage={data.formTemplateUsage}
        assets={data.assets}
        currentUserId={data.currentUserId}
        customFieldDefs={data.customFieldDefs}
        customFieldValuesByTask={data.customFieldValuesByTask}
        activityLog={data.activityLog}
        contactNameById={data.contactNameById}
        contactById={data.contactById}
        ticketMessages={data.ticketMessages}
        ticketMessageAttachmentsByMessageId={data.ticketMessageAttachmentsByMessageId}
        invites={data.invites}
        orgName={data.orgName}
        orgSlug={data.orgSlug}
        orgCustomDomain={data.orgCustomDomain}
        orgSubscriptionStatus={data.orgSubscriptionStatus}
        orgStripePriceId={data.orgStripePriceId}
        orgSubscriptionPeriodEnd={data.orgSubscriptionPeriodEnd}
        orgTeamAllocationEnabled={data.orgTeamAllocationEnabled}
        slaFirstResponseHours={data.slaFirstResponseHours}
        slaResolutionDays={data.slaResolutionDays}
        teamMemberIdsByTeam={data.teamMemberIdsByTeam}
        devTools={data.devTools}
      />
    </main>
  );
}
