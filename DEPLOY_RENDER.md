# Deploy the Muse Mirror team demo to Render

This deployment is an internal smoke-test setup, not a production environment. The checked-in Blueprint creates one Singapore Docker web service on Render's Free plan. It creates no database, Key Value instance, persistent disk, autoscaling rule, or preview environment.

## Deploy with the Blueprint

1. Push the deployment branch to GitHub.
2. In Render Dashboard, choose **New > Blueprint**.
3. Connect `AndyZhaoly/Muse_Mirror` and select `render.yaml`.
4. Confirm the service is `muse-mirror-team-demo`, region is Singapore, runtime is Docker, and plan is Free.
5. Enter every secret value requested by the Blueprint. Never paste secrets into Git files.
6. Apply the Blueprint and wait for the Docker build and `/healthz` check to pass.
7. Open `https://<service>.onrender.com/healthz`, then open the root URL and sign in with the team access code.

The Blueprint is pinned to `codex/render-team-demo-deploy` for this deployment PR. After merging and validating the PR, change `branch` to `main` if `main` should become the deployment source.

## Required secrets

Set these in Render's secret environment-variable form:

```text
OPENAI_API_KEY
MUSE_TEAM_DEMO_ACCESS_CODE
MUSE_TEAM_DEMO_SESSION_SECRET
VOLC_SPEECH_APP_ID
VOLC_SPEECH_APP_KEY
VOLC_SPEECH_ACCESS_KEY
```

`MUSE_TEAM_DEMO_SESSION_SECRET` should be a new high-entropy random string. The team access code is shared with testers; the session secret is never shared and only signs HttpOnly cookies.

The Volcengine account can use the modern app-key path without a legacy app ID. If the enabled resource requires only `VOLC_SPEECH_APP_KEY`, leave unused credential fields empty in Render. Keep `VOLC_ASR_RESOURCE_ID`, `VOLC_TTS_RESOURCE_ID`, and `VOLC_TTS_SPEAKER_ID` aligned with capabilities enabled in the Volcengine console.

## Local Docker smoke test

Build without embedding any credentials:

```bash
docker build -t muse-mirror-team-demo .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  muse-mirror-team-demo
```

In another terminal:

```bash
curl -i http://localhost:8080/healthz
curl -I http://localhost:8080/
```

To test the access gate locally, restart the container with both access variables. Use test-only values, not deployment secrets:

```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e NODE_ENV=production \
  -e MUSE_TEAM_DEMO_ACCESS_CODE=test-only-code \
  -e MUSE_TEAM_DEMO_SESSION_SECRET=test-only-signing-secret \
  muse-mirror-team-demo
```

`GET /healthz` must remain public. An unauthenticated request to `/api/fashion/status` must return `401`.

## Online smoke test

1. Confirm `/healthz` returns `200` without logging in.
2. Confirm the root page uses HTTPS and displays the access-code gate.
3. Log in and send a text message. Final-answer deltas should stream before the completed result.
4. Enable the mirror, grant camera permission, and ask a question that needs the current frame.
5. Enable voice, grant microphone permission, and verify ASR partial text, one final submission, Muse text, and TTS playback.
6. In a different browser or private window, verify conversations and memories do not appear from the first browser.
7. While logged out, verify Agent HTTP/SSE calls and ASR/TTS WebSocket upgrades are rejected.

The browser derives WebSocket URLs from the page protocol: HTTPS pages use `wss://`; local HTTP pages use `ws://`. HTTP, SSE, static assets, and both speech WebSockets share the same Render service and public port.

## Logs, redeploy, and rollback

- **Logs:** open the service in Render Dashboard and select **Logs**. Startup logs show only the port, provider names, capability booleans, access-gate state, output directory, and version.
- **Manual redeploy:** choose **Manual Deploy > Deploy latest commit**.
- **Rollback:** open **Deploys**, select a previously successful deploy, and choose **Rollback**. Do not reuse a deploy if its secrets have since been revoked.

Never post OpenAI, Volcengine, access-code, session-cookie, image base64, or user-photo data in logs or issue comments.

## Free-plan limitations

- The service can spin down while idle, so the first request after inactivity can be slow.
- The filesystem is ephemeral. Container replacement, restart, redeploy, or free-service lifecycle events can remove conversations, memories, captured frames, and generated files under `/app/out`.
- WebSocket connections can close during instance replacement or network interruption.
- A single Free instance has limited CPU and memory; concurrent vision, image generation, and voice sessions can increase latency.
- This configuration is for team evaluation only and must not be described as production-ready.

Before a persistent or external beta, reassess a paid instance plus durable storage. If using a Render persistent disk, keep one clearly owned mount path and migrate both `FASHION_AGENT_OUTPUT_DIR` and `FASHION_AGENT_MEMORY_DATA` deliberately. A database/object store is preferable once multiple instances or stronger user isolation are required.
