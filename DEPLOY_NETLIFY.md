# Deploying Safety Scan to Netlify

This app needs both:

- the static frontend in `dist`
- the serverless InsightX API function in `netlify/functions`

Do not deploy only the `dist` folder if you want scans to work.

## Recommended: Netlify CLI

1. Install the Netlify CLI:

```powershell
npm install -g netlify-cli
```

2. Log in:

```powershell
netlify login
```

3. In Netlify, add this environment variable to the site:

```text
INSIGHTX_API_KEY=your_key_here
```

4. Deploy from this project folder:

```powershell
cd "C:\Users\USER\Desktop\safety scan"
npm run deploy:netlify
```

If Netlify asks whether to link to an existing site, choose the site you already created.

## Git Deploy Option

Push this whole project to GitHub and connect the repo in Netlify.

Use these settings:

```text
Build command: npm run build
Publish directory: dist
Functions directory: netlify/functions
```

Also add:

```text
INSIGHTX_API_KEY=your_key_here
```

## Health Check

After deployment, open:

```text
https://YOUR-SITE.netlify.app/api/insightx/health
```

Working output should include:

```json
{"configured":true}
```

If it returns `404`, the function was not deployed.
If it returns `configured:false`, the function deployed but `INSIGHTX_API_KEY` is missing.
