import type { MemberSummary } from "@/lib/tasks-data";

// Shared by task-panel.tsx and new-task-panel.tsx's Assignee dropdowns.
// Ported from the prototype's team-allocation Assignee-narrowing rule
// (v0.13): while orgTeamAllocationEnabled is on, only a task's own team's
// registered members are offered — except the task's *current* assignee
// (existingAssigneeId) always stays in the list even if not a member,
// flagged so the caller can render "(not on this team)" rather than
// silently hiding who a task is assigned to; and a team with zero
// registered members falls back to showing everyone rather than producing
// an empty, unusable dropdown. When the toggle is off, or the task has no
// team yet, every org member is eligible — today's behavior, unchanged.
export interface EligibleAssignee {
  member: MemberSummary;
  isTeamMember: boolean;
}

export function eligibleAssignees(
  members: MemberSummary[],
  teamId: string | null,
  teamMemberIdsByTeam: Map<string, string[]>,
  enabled: boolean,
  existingAssigneeId: string | null
): EligibleAssignee[] {
  if (!enabled || !teamId) {
    return members.map((member) => ({ member, isTeamMember: true }));
  }

  const teamMemberIds = teamMemberIdsByTeam.get(teamId) ?? [];
  if (teamMemberIds.length === 0) {
    // No one's registered on this team yet — an empty dropdown would be
    // worse than an unfiltered one, so fall back to everyone.
    return members.map((member) => ({ member, isTeamMember: true }));
  }

  const memberIdSet = new Set(teamMemberIds);
  const result: EligibleAssignee[] = members
    .filter((m) => memberIdSet.has(m.userId))
    .map((member) => ({ member, isTeamMember: true }));

  if (existingAssigneeId && !memberIdSet.has(existingAssigneeId)) {
    const current = members.find((m) => m.userId === existingAssigneeId);
    if (current) result.push({ member: current, isTeamMember: false });
  }

  return result;
}
