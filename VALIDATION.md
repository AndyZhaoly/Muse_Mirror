# Validation

Validated locally for this package:

```bash
npm run validate:skills
npm run validate:ui
npm run typecheck
npm test
npm run build
npm run demo:services
npm --prefix web run typecheck
npm --prefix web run build
```

The React shell is Mock-first and does not require credentials.

Real OpenAI and Gemini provider requests require user-supplied credentials and must not be claimed as tested unless actual network calls were executed.
