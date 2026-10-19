# Lesson store lock recovery

Status: done — merged in #858 (2026-10-17), released in happy-cli `1.1.10-aplus.339`; the Desktop pin is at `.342` (checked 2026-10-19). Open follow-up: Desktop does not map `settings_busy` yet (see Residual risks).

## Problem

`LessonReviewBudget` (review ledger) and the lesson settings store guarded their files with `open(<file>.lock, 'wx')` and deliberately never stole a lock. A process that died while holding one left the lock behind, and on that machine every later review claim answered `busy` and every settings save `runtime_error`, forever and without any visible sign.

## Decision

Both stores use one helper, `src/memory/ownedFileLock.ts` (`withOwnedFileLock`). The checkpoint store lock is git-ref based and could not be reused for plain files.

1. **A lock is published already naming its owner.** The owner record (pid, process start time, acquire time, random token) is written to `<lock>.<token>.pending` and hard-linked to `<lock>`; `link()` fails with `EEXIST` if a lock is there. So there is no moment in which a held lock is empty and could look abandoned.
   - Rejected: create empty with `O_EXCL`, then write the owner, then re-check the inode. Cross review reproduced two holders: A creates and stalls past the ownerless limit, B takes the reclaim guard and confirms the lock unchanged, A records itself and passes its inode check, B then removes the lock and takes it again. No extra check closes that window because recording the owner is not covered by the reclaim guard.
2. **Only provable death frees an owned lock.** An owned lock is reclaimed when its pid is gone (`ESRCH`) or now belongs to a process that started after the lock was taken (2 s slack for whole-second `ps` times). A live pid whose start time cannot be read stays `unverified` (busy) however old the lock is: a live owner may only be stalled.
3. **Ownerless locks come only from older versions.** They are reclaimed once untouched for 10 minutes (`UNOWNED_LOCK_STALE_MS`) and are busy before that. Real holds are one read plus one small fsync'd write, milliseconds.
4. **Reclaiming is serialized per lock instance.** The reclaimer takes `<lock>.reclaim-<instance>` (itself an owned lock), re-reads the lock, and removes it only if it is still the instance it judged. Each reclaim is written to the file log.
5. **Reasons.** The ledger keeps `busy`; the settings store returns the new `settings_busy` instead of a generic `runtime_error`. The lock path is unchanged, so old and new processes still exclude each other.

## Verification

- Barrier tests fix the cross-review order at both levels: a counter work (lost-update check, max holders 1) and `LessonReviewBudget.claimSession` (the second claim is `busy`, ledger holds only the first). Both failed on the previous code (2 holders; the second claim wrote the ledger while the first held the lock).
- Several contenders reclaiming one dead/abandoned lock at once let exactly one in; removing the guard makes this fail.

## Residual risks

- A pid reused within about 3 s of its owner's death cannot be told apart (whole-second `ps`); the lock stays busy while that process lives.
- An older-version holder stalled for more than 10 minutes can still be reclaimed from under it, and if it releases while the reclaim is in flight, the reclaimer may remove the next holder's lock. Old code records no owner, so this cannot be fixed here.
- A crash between writing and removing `<lock>.<token>.pending`, or a reclaimer dying three times in a row, leaves small files nobody removes.
- Filesystems without hard links would fail every acquire; the store lives under the daemon home, where this is not expected.
- Desktop maps unknown reasons to `runtime_error` and logs the original as `hostReason`, so `settings_busy` is safe but shows the generic message until Desktop maps it. As of 2026-10-19 the pin is bumped, but Desktop has no `settings_busy` mapping yet.
