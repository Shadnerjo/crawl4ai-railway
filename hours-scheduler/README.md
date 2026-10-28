# Research hours controller

Controls only the three explicit Crawl4AI project services. It verifies a production-environment project token before sending any mutation, calls Railway's history-preserving deploymentStop/deploymentRestart operations, and checks actual private HTTP reachability twice after each action. It never removes deployments or changes source.

Eastern schedule: Monday–Friday 17:00 until the following 02:00; Saturday–Sunday 16:00 until the following 03:00. Railway cron is UTC: use `0 6,7,8,20,21,22 * * *`. The local America/New_York boundary gate selects two operations per day across DST. It permits up to 14 minutes of cron delay; execution is not guaranteed to the minute. The gateway separately rejects new tool calls outside the allowed hours. Failed scheduler runs require attention in Railway.

Set `RAILWAY_PROJECT_TOKEN` only on this service. The credential has access throughout this one project environment, including its variables; possession would permit deploying arbitrary code there. The service needs no public domain and must use restart policy NEVER.

`TEST_CYCLE_UNTIL` is an expiring test authorization: an epoch-millisecond deadline less than fifteen minutes ahead permits a disruptive verification cycle. The cycle stops and verifies all three services, then restores and verifies all three in a finally block. Set this only during an explicitly authorized test and clear it immediately afterward with orchestration cleanup. It is disabled when unset, zero, expired, or too far in the future. No cron should be enabled during the test.

`npm test` tests the Eastern calendar boundaries without network calls or mutations.
