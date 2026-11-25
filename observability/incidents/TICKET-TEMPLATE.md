# Ticket for the service owners

Write one of these per incident. The owners of the service will read it without having seen your investigation, so it must stand on its own.

```markdown
## [service name] One sentence that says what the service does wrong

**To:** owners of the `<service>` service
**From:** <your name>, on-call
**Incident:** INC-____
**Trace id:** <a trace id that shows the problem>

### What happens
What the customer or the business sees, when it happens and when it does not
(which customers, which products, which kind of request).

### What we found
The path of the request through the services, step by step, with the log lines
that prove each step. Quote the lines: service, time, message.

- What service A sent to service B (and the log line that says so).
- What service B received and did with it (and the log line that says so).
- The exact step where a value, a name or a duration stops being right.

### Why it is your service
Why the cause is in this service and not in the one that logged the error or
returned the bad answer.

### Suggested fix
What should change, and where. If another service could also protect itself
against this, say so as a second, optional item.

### How to check the fix
The request to send and what the logs should say once it is fixed.
```
