# Audit Access Product Improvement Plan

## Goal

Make Project Audit an administrative view. Project owners and admins can review
the complete Project Audit; members and viewers cannot read it. Reuse the
existing Project role model and `admin` permission so the product has one clear
authorization path.

## Non-goals

- New roles, permissions, or a general RBAC system.
- A personal or self-only Audit view for members and viewers.
- Per-event, per-field, or resource-specific Audit permissions.
- Changes to Audit event creation, retention, filtering, pagination, or detail
  sanitization.
- New governance workflows, reports, exports, approval steps, or release gates.

## Product boundary

| Project role | Audit events | Audit identity directory |
| --- | --- | --- |
| Owner | Full Project access | Full Project access |
| Admin | Full Project access | Full Project access |
| Member | No access | No access |
| Viewer | No access | No access |

Audit remains Project-scoped. Owners and admins see the existing event data and
filters without a second restricted representation.

## Server and API behavior

- The AgentSmith server is the authorization authority.
- Both Audit reads require the existing Project membership `admin` permission:
  - `GET /api/v1/projects/{projectId}/audit`
  - `GET /api/v1/projects/{projectId}/audit/identities`
- This is a read authorization check, not a writable-lifecycle check. Owners and
  admins retain Audit access when the Project or Workspace is archived; the
  implementation must not reject the read merely because either resource is
  not active.
- A member or viewer calling either endpoint receives the existing `403`
  forbidden response.
- The change does not add request parameters, response fields, capability
  objects, or alternate endpoints.
- Update the existing API contract to describe both reads as owner/admin-only;
  it must no longer state that Project viewers can read Audit.

## Web behavior

- Show the Project Audit navigation item only to owners and admins.
- Determine visibility from the server-authoritative `memberRole` already
  returned by the Project overview read. Do not infer authorization from the
  URL, cached navigation state, or a writable capability that becomes false
  when the Project is archived.
- A member or viewer who opens a saved or manually entered Audit URL sees the
  existing access-denied experience; the Web must not emulate authorization by
  filtering Audit data.
- Do not add disabled Audit navigation, upgrade prompts, or placeholder pages.

## Alerts deep links

- Show any Alert link whose destination is Project Audit only when the current
  user is an owner or admin. This includes both the per-alert history link and
  the primary investigation links for provider and Sandbox failures.
- Members and viewers can continue to use the Alert information already
  available to their role, but must not receive a link to an Audit page they
  cannot access.
- A stale Audit deep link remains safe because the server returns `403`.

## Migration and compatibility

AgentSmith Lite is not released. Remove the old viewer-access behavior directly:

- no compatibility flag or transition period;
- no preservation of viewer Audit responses;
- no data migration, because stored Audit events and their schema do not change;
- existing owner and admin URLs, filters, cursors, and response shapes remain
  unchanged.

## Minimum acceptance criteria

1. Owner and admin users can open Project Audit, use its existing filters, open
   event details, and follow eligible Alert links for active and archived
   Projects.
2. Member and viewer requests to both Audit endpoints return `403` and no Audit
   event or identity data.
3. Member and viewer Project navigation does not show Audit.
4. Member and viewer Alert views expose neither per-alert history links nor
   provider/Sandbox failure investigation links that target Audit.
5. Direct and stale Audit URLs cannot bypass the server-side role check.
6. The API contract no longer describes Audit as viewer-readable.
7. No new role, endpoint, response field, capability, Audit representation, or
   governance workflow is introduced.

## Implementation order

1. Require the existing Project membership `admin` permission in both Audit
   service reads without applying an active-lifecycle write check.
2. Correct the existing API contract's Audit access statement.
3. Reuse the existing Project overview `memberRole` in the Web shell to hide
   the Audit navigation item for members and viewers.
4. Apply the same role condition to every Alert-to-Audit deep link.
5. Check the four existing Project roles, including an archived Project,
   against the minimum acceptance criteria with focused service/API and manual
   Web checks.
