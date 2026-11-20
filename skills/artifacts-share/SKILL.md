---
name: artifacts-share
description: Publish or update HTML, built site directories, and ZIP bundles through the Artifacts Share API. Use when the user wants an Artifacts Share link, wants to find an existing artifact or version, or asks to change its private, public, or access-code sharing settings.
---

# Artifacts Share

Use the admin origin for authenticated requests. For this repository's deployment, the origin is `https://share.334700.xyz`. Set `ARTIFACTS_SHARE_URL` to the intended admin origin and use an `ARTIFACTS_SHARE_TOKEN` already provided through the environment. The user can create a token in the admin UI under **API tokens**. Keep the token out of command arguments, output, and source files.

## Publish or update

1. Identify the HTML file, ZIP, or built output directory the user wants to publish. For directories and ZIPs, run a dry run and review the manifest for unintended files or secrets. Build from source first when the user wants a runnable site.
2. Use the commands below with `<skill-dir>` replaced by the folder containing this file. New artifacts default to `private`. Pass `--visibility public` or `--visibility password` when the user requests that access. Set `--entry` only when the entry needs to be explicit. Set `--spa-fallback` for client-side routing when needed.
3. For an update, pass the internal `id` from the authenticated API as `--artifact-id`. A share URL contains the public ID, which may differ from the internal ID after a link has been regenerated. If given a share URL or title, use `list --query` and follow `next_cursor` as needed. Match the exact `url` or `public_id` for links and resolve ambiguous title matches before writing. Leave visibility and other metadata unset to preserve them on updates.
4. Return the API's `url`, current version, and visibility. A private link requires owner login. For access-code shares, use `--include-access-code` when the user wants the code or an auto-unlock link. Append `?pwd=<URL-encoded code>` only if requested.

```bash
python3 <skill-dir>/scripts/artifacts_share.py publish dist/ --dry-run
python3 <skill-dir>/scripts/artifacts_share.py publish dist/ --visibility password
python3 <skill-dir>/scripts/artifacts_share.py publish dist/ --artifact-id <id>
python3 <skill-dir>/scripts/artifacts_share.py list --query 'Project demo'
python3 <skill-dir>/scripts/artifacts_share.py get <id>
python3 <skill-dir>/scripts/artifacts_share.py patch <id> --visibility private
python3 <skill-dir>/scripts/artifacts_share.py versions <id>
```

If commit fails or the result is unclear, use the reported artifact ID and version to check what happened before retrying. The server can store a superseded version without making it current.

Read [the API reference](references/api.md) for version activation, code or link rotation, downloads, deletion, and direct HTTP requests.
