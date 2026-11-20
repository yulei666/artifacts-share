---
name: artifacts-share
description: Publish or update HTML, Markdown, built site directories, and ZIP bundles through the Artifacts Share API. Use when the user wants an Artifacts Share link, wants to find an existing artifact or version, or asks to change its private, public, or access-code sharing settings.
---

# Artifacts Share

Use the instance's admin origin for authenticated requests, such as `https://share.example.com`. The user can create a token in the admin UI under **API tokens**.

For sessions without shell environment variables, use `~/.config/artifacts-share/config.json`:

```json
{
  "url": "https://share.example.com",
  "token": "<API token>"
}
```

Keep the file outside the repository and restrict it to the account running the skill (`chmod 600` on macOS/Linux). `ARTIFACTS_SHARE_CONFIG` can select another file. Non-empty `ARTIFACTS_SHARE_URL` and `ARTIFACTS_SHARE_TOKEN` override their matching fields. When overriding a configured URL with a different origin, supply that origin's token through `ARTIFACTS_SHARE_TOKEN` as well. Keep token values out of command arguments and output.

## Publish or update

1. Identify the HTML or Markdown file, ZIP, or built output directory the user wants to publish. For directories and ZIPs, run a dry run and review the manifest for unintended files or secrets. Build from source first when the user wants a runnable site.
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
