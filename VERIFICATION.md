# Verification

The implemented flow is nickname join → protected room → message POST → database save → room-scoped SSE → another user's rendered message.

## Results

| Boundary | Evidence |
| --- | --- |
| Source diagnostics | `astro check`: 0 errors, 0 warnings, 0 hints. |
| Production build | `astro build`: completed successfully with the Node standalone adapter. HTMX emits its upstream eval warning during bundling. |
| Full tests | `node --test tests/chat.test.mjs tests/order.test.mjs`: 12 passed, 0 failed, about 65 seconds. |
| Two identities | Browser joined as Alice on 127.0.0.1 and Bob on localhost, using independent cookie hosts. Both appeared online. |
| Live rendering | Bob selected Alice from the mention menu with Tab and sent with Enter. Alice received the message and unread mention without a refresh. |
| Room updates | Creating Creative corner navigated Alice there and added it to Bob's sidebar immediately. |
| Notifications | Alice's dropdown showed Bob's mention. Mark all read cleared the unread badge. |
| Responsive layout | Desktop room/sidebar/member layout and 390 × 844 phone chat/directory checked visually. |
| Theme | Light and dark themes checked in the browser. |
| Durable state | Automated test stopped and restarted the actual production Node process and verified users, rooms, messages and unread notifications survived. |
| Ephemeral state | Automated test verified typing expiry, unique-user presence, refresh grace cancellation, the full 60-second departure grace, and a 30-second heartbeat. |
| Authorization | Automated tests verified protected routes, System cannot authenticate, actor IDs in bodies are ignored, cross-origin mutations are rejected, and notifications are recipient-scoped. |
| Pagination | Automated tests verified no duplicate or missing history with tied timestamps. A separate check compares client ordering with SQLite ordering for mixed-case IDs. |

## Limits

- PostgreSQL adapter and schema are implemented; no PostgreSQL instance was available for live testing.
- The app has not been deployed to a hosting provider.
- Audible output was not verified by listening. Audio behavior depends on browser user-gesture rules.
- Test data is isolated under ignored `test-results/`. Browser QA created Alice, Bob, a Creative corner room and a few messages in the local development database.
- Temporary preview and test servers were stopped after verification.

See `README.md` for startup, database and production hosting instructions.
