# Shared agent launch profiles

## Goal

Persist a user's reusable agent launch combinations in happy-server so web and mobile clients share one source of truth.

## Requirements

- A profile belongs to exactly one authenticated account.
- A profile stores a name, agent, optional model, and worktree-enabled flag.
- At most one profile per account is active.
- Creating a profile activates it by default; clients may opt out.
- Activating, updating, and deleting profiles never affects another account.
- Deleting the active profile activates the most recently updated remaining profile.
- API mutations return the resulting profile state for immediate client reconciliation.

## Non-goals

- Environment-variable injection profiles removed from the legacy Happy app.
- Organization-shared profiles.
- Permission and effort settings not present in the approved UI contract.
