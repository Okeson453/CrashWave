# Admin Dashboard

Next.js UI for the multi-tenant control plane.

## Run

```bash
export CONTROL_PLANE_URL=http://127.0.0.1:8081
export ADMIN_API_TOKEN=<same as control plane>
cd admin-dashboard
npm install
npm run dev
```

Requires the control plane (`PLATFORM_MODE=control-plane`) to be running.
