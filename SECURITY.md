# Security policy

## Reporting a problem

If you find a security or privacy problem in Shelf, please email **autoshelfs@gmail.com** with "Security" in the subject. Don't open a public issue.

Include what you found, the steps to reproduce it, and what someone could do with it. You'll get a reply within a week. Please give us a reasonable time to fix it before you share it publicly.

Only test with your own accounts and data. Don't access other people's data, and don't run load tests against Shelf's servers.

## What the extension promises

- It sends nothing anywhere unless you sign in.
- Signed in, it talks only to the sign-in service and Shelf's API; the manifest's security policy enforces this.
- Shared spaces are encrypted in the browser before upload; the server stores only encrypted data.
- Links open only as `http`, `https` or local `file` addresses.

A way around any of these is a security problem, and we want to hear about it.
