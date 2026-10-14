# Ordinary Chat schedules

Approved 2026-10-14: new Chat schedules append ordinary encrypted user messages to one client-bound interactive session. Existing web UI must read that session and accept manual follow-ups. Historical schedules/runs are not migrated. Project/script schedules remain unchanged.

Validate target ownership, local keys/directory, live claim and sequence; unknown ACKs must replay the same run identity. Unsupported clients must never reinterpret this mode as a new-session schedule. Delivery acknowledgement is separate from AI response completion. No schema change or external publication is authorized.

## Chat lifecycle extension (approved 2026-10-14)

Deleting a Chat cancels definitions and active claims and requests its running session to stop. Archiving pauses definitions; restoration never resumes them automatically. Preserve ciphertext and run history. Require both Happy ownership and CAL1 server proof minted after Studio/local Chat ownership checks; an ambient company token is insufficient. No DB schema change or external release is included.
