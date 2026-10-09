# Production admin bootstrap

Development bootstrap is disabled in production. For first production access, run the explicit CLI once from the backend directory or an equivalent trusted admin shell.

```bash
CONFIRM_PRODUCTION_BOOTSTRAP=yes \
MONGODB_URI='mongodb://...' \
BOOTSTRAP_ADMIN_EMAIL='admin@example.com' \
BOOTSTRAP_ADMIN_PASSWORD='long-temporary-password' \
node scripts/admin-bootstrap-production.mjs
```

The created Admin is Active and has `mustChangePassword: true`. Rotate/remove the temporary shell environment after use. If the email already exists but is not an Active Admin, the script fails instead of mutating that account silently.
