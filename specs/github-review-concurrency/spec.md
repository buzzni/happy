# GitHub review concurrency

Drain queued AgentTask reviews without a 15-minute delay or a one-worker-per-tick ramp. Preserve the machine-wide eight-worker limit, three dispatch attempts per tick, and writer locks. Stop immediate retries on empty dispatch or failure.
