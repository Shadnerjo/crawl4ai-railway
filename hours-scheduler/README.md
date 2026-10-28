# Research hours controller

Controls only the three explicit Crawl4AI project services. It verifies a production-environment project token before sending any mutation, calls Railway's history-preserving deploymentStop/deploymentRestart operations, and checks actual private HTTP reachability twice after each action. It never removes deployments or changes source.

Eastern schedule: Monday–Friday 17:00 until the following 02:00; Saturday–Sunday 16:00 until the following 03:00. Use Railway cron `*/5 * * * *`. Each run calculates whether research should be open in America/New_York, including DST, and reconciles each fixed service against its actual private HTTP endpoint. Healthy services are not restarted during open hours. Outside hours, services that no longer respond are verified offline without another stop mutation; any HTTP response, including an error, requires a stop attempt. Lookup or operation failures on one service do not prevent the other services from being reconciled. No deployment records are removed.

Reconciliation normally catches new deployments and recovers missed boundaries on the next five-minute run. Railway does not guarantee cron execution to the minute, and startup or shutdown verification also takes time; do not treat this as exact-time container shutdown. The gateway separately rejects new tool calls outside the allowed hours. Failed scheduler runs require attention in Railway. Builds still in progress are left alone and are controlled on a later run once they reach a stable state.

Set `RAILWAY_PROJECT_TOKEN` only on this service. The credential has access throughout this one project environment, including its variables; possession would permit deploying arbitrary code there. The service needs no public domain and must use restart policy NEVER.

`TEST_CYCLE_UNTIL` is an expiring test authorization: an epoch-millisecond deadline less than fifteen minutes ahead permits a disruptive verification cycle. The cycle stops and verifies all three services, then restores and verifies all three in a finally block. Set this only during an explicitly authorized test and clear it immediately afterward with orchestration cleanup. It is disabled when unset, zero, expired, or too far in the future. No cron should be enabled during the test.

The clock and controller tests use simulated API and HTTP results without live network calls or mutations.
